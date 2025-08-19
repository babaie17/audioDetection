// api/transcribe.js
export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    // CORS (safe for same-origin too)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only', candidates: [] }, 405);
    }

    const form = await request.formData();
    const file = form.get('audio');                 // Blob from client
    const language = (form.get('language') || 'en-US').toString();
    const provider = (form.get('provider') || 'azure').toString().toLowerCase();
    const debug = (form.get('debug') || '').toString() === '1';

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No audio uploaded', candidates: [] }, 400);
    }

    // Guard: tiny/empty uploads
    const size = Number(file.size || 0);
    const type = (file.type || '(none)').toString();
    if (size < 2000) {
      return json({ error: `Audio too small (${size} bytes). type=${type}`, candidates: [] }, 400);
    }

    // ---------- OpenAI path (1-best) ----------
    if (provider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return json({ error: 'OPENAI_API_KEY missing', candidates: [] }, 500);

      const fd = new FormData();
      //fd.append('file', file, 'speech.webm'); // filename is arbitrary; MIME comes from Blob

      const t = (file.type || '');
      const name =
        t.includes('wav')  ? 'speech.wav' :
        t.includes('ogg')  ? 'speech.ogg' :
        t.includes('webm') ? 'speech.webm' : 'audio.bin';
      fd.append('file', file, name);
      // Force language for OpenAI:
      fd.append('language', toWhisperLang(language));
      fd.append('model', 'gpt-4o-transcribe');

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });
      const body = await safeBody(r);

      if (debug) {
        return json(
          { provider: 'openai', status: r.status, ok: r.ok, upstream: body, candidates: [] },
          r.ok ? 200 : r.status
        );
      }
      if (!r.ok) return json({ error: errString(body, 'OpenAI error'), candidates: [] }, r.status);

      const text = (body?.text || '').trim();
      
      //candidates = strictLanguageFilter(candidates, language);
      
      return json({ provider: 'openai', candidates: text ? [text] : [] }, 200);
    }

    // ---------- Azure path (Top-5 via format=detailed) ----------
    const azKey = process.env.AZURE_SPEECH_KEY;
    const azRegion = process.env.AZURE_REGION || 'eastus';
    if (!azKey) return json({ error: 'AZURE_SPEECH_KEY missing', candidates: [] }, 500);

    // Prefer using the actual client MIME; normalize to common Azure-accepted types
    const blobType = (file.type || '').toLowerCase();
    const contentType =
      blobType.includes('ogg')  ? 'audio/ogg; codecs=opus' :
      blobType.includes('webm') ? 'audio/webm; codecs=opus' :
      blobType.includes('wav')  ? 'audio/wav' :
      'application/octet-stream';

    const endpoints = [
      'recognition/conversation/cognitiveservices/v1',
      'recognition/interactive/cognitiveservices/v1',
      'recognition/dictation/cognitiveservices/v1'
    ];

    const attempts = [];
    let lastErr = null;

    for (const path of endpoints) {
      const url = `https://${azRegion}.stt.speech.microsoft.com/speech/${path}?language=${encodeURIComponent(language)}&format=detailed`;

      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': azKey,
          'Content-Type': contentType,
          'Accept': 'application/json'
        },
        body: file // send Blob directly
      });

      const body = await safeBody(r);

      // Collect diagnostics if debug enabled
      if (debug) {
        attempts.push({ endpoint: path, status: r.status, ok: r.ok, body });
      }

      if (!r.ok) {
        lastErr = errString(body, 'Azure error');
        continue; // try next endpoint
      }

      // Extract candidates
      let candidates = extractAzureCandidates(body)
        .map(s => (s || '').trim())
        .filter(Boolean)
        .slice(0, 5);
      
      // 1) Filter NBest by target language (drop Latin-only when zh/ja/ko)
      candidates = strictLanguageFilter(candidates, language);
      
      // 2) If NBest was empty (or got filtered out), try DisplayText fallback…
      if (candidates.length === 0) {
        const dt = (body?.DisplayText || body?.Display || '').toString().trim();
        // …and also enforce strict language on the fallback text
        const fb = dt ? strictLanguageFilter([dt], language) : [];
        if (fb.length > 0) candidates = fb;
      }
      
      if (candidates.length > 0) {
        // success: return immediately
        return json({
          provider: 'azure',
          endpoint: path.split('/')[1],
          contentType,
          candidates
        }, 200);
      }
      
      // No candidates—try next endpoint
      lastErr = errString(body, 'No speech recognized');
    }

    // If we got here, all endpoints failed or yielded no text
    if (debug) {
      return json({
        debug: true,
        sent: { size, type, contentType },
        triedEndpoints: endpoints,
        attempts,
        error: lastErr || 'No speech recognized',
        candidates: []
      }, 200);
    }

    return json({ provider: 'azure', error: lastErr || 'No speech recognized', candidates: [] }, 200);

  } catch (err) {
    return json({ error: String(err?.message || err), candidates: [] }, 500);
  }
}

/* ---------- helpers ---------- */
function looksLikeLatinOnly(s) {
  // True if string has letters but no CJK/JP/KR scripts
  const hasLetter = /[A-Za-z]/.test(s);
  const hasCJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
  return hasLetter && !hasCJK;
}

function strictLanguageFilter(cands, bcp47) {
  const primary = bcp47.split('-')[0].toLowerCase();
  if (['zh', 'ja', 'ko'].includes(primary)) {
    // For CJK, drop Latin-only outputs
    const filtered = cands.filter(t => !looksLikeLatinOnly(t));
    return filtered.length ? filtered : [];
  }
  return cands;
}

// Map your UI’s BCP-47 to Whisper’s expected ISO-639
function toWhisperLang(bcp47) {
  const map = {
    'zh-CN': 'zh', 'zh-TW': 'zh',
    'ja-JP': 'ja', 'ko-KR': 'ko',
    'en-US': 'en', 'es-ES': 'es'
  };
  return map[bcp47] || bcp47.split('-')[0]; // fallback: take primary subtag
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function errString(body, fallback = 'Unknown error') {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  const m = body?.error?.message || body?.message || body?.Message || body?.RecognitionStatus;
  if (typeof m === 'string') return m;
  try { return JSON.stringify(body); } catch { return fallback; }
}

// JSON if possible; otherwise return {message: rawText}
async function safeBody(r) {
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) return await r.json();
  const text = await r.text();
  return { message: text };
}

// Pull plausible text fields from Azure result shapes
function extractAzureCandidates(data) {
  let nbest = [];
  if (Array.isArray(data?.NBest)) {
    nbest = data.NBest;
  } else if (Array.isArray(data?.results) && Array.isArray(data.results[0]?.NBest)) {
    nbest = data.results[0].NBest;
  }

  const out = [];
  const fields = ['lexical', 'display', 'itn', 'maskedITN', 'transcript', 'NormalizedText', 'Display'];

  for (const item of nbest || []) {
    for (const f of fields) {
      const v = (item?.[f] || '').toString().trim();
      if (v) { out.push(v); break; }
    }
  }
  return out;
}



