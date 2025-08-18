// api/transcribe.js
// Vercel Edge Function — no npm deps required.
export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    // Handle CORS preflight only if you're calling from another origin.
    // If frontend + backend are on the same Vercel project, you can delete this block.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    const form = await request.formData();
    const file = form.get('audio');                 // Blob from MediaRecorder
    const language = (form.get('language') || 'en-US').toString();
    const provider = (form.get('provider') || 'azure').toString().toLowerCase();

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No audio uploaded' }, 400);
    }

    // -------- OpenAI path (1-best) --------
    if (provider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return json({ error: 'OPENAI_API_KEY missing' }, 500);

      const fd = new FormData();
      // Pass the original blob directly; no Buffer needed in Edge runtime.
      fd.append('file', file, 'speech.webm'); // name is arbitrary; type is taken from Blob
      fd.append('model', 'gpt-4o-transcribe');
      // Optional: lock language if you want. Whisper usually auto-detects.
      // fd.append('language', language);

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });

      const body = await safeBody(r);
      if (!r.ok) return json({ error: errString(body, 'OpenAI error') }, r.status);

      const text = (body?.text || '').trim();
      const candidates = text ? [text] : [];
      return json({ provider: 'openai', candidates }, 200);
    }

    // -------- Azure path (Top-5 via format=detailed) --------
    // Right after: const file = form.get('audio')
    const size = file.size || 0;
    const type = file.type || '(none)';
    if (size < 2000) {
      return json({ error: `Audio too small (${size} bytes). type=${type}` }, 400);
    }
    
    const azKey = process.env.AZURE_SPEECH_KEY;
    const azRegion = process.env.AZURE_REGION || 'eastus';
    if (!azKey) return json({ error: 'AZURE_SPEECH_KEY missing' }, 500);

    // REST "conversation" short-audio endpoint (<= 60s).
    // 'format=detailed' requests NBest hypotheses.
    const url = `https://${azRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    // IMPORTANT: send the blob as-is and set Content-Type to the blob's type.
    // Prefer OGG/Opus on the frontend; otherwise WebM/Opus also works in many regions.
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azKey,
        'Content-Type': file.type || 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: file
    });

    const body = await safeBody(r);
    //if (!r.ok) return json({ error: errString(body, 'Azure error') }, r.status);
    return json({ debug:true, sent:{size, type, contentType: (file.type||'octet')}, azure:{status:r.status, ok:r.ok, body} }, r.ok ? 200 : r.status);

    const candidates = extractAzureCandidates(body)
      .map(s => (s || '').trim())
      .filter(s => s.length > 0)
      .slice(0, 5);

    // Fallback: some shapes return DisplayText only
    if (candidates.length === 0) {
      const dt = (body?.DisplayText || body?.Display || '').toString().trim();
      if (dt) candidates.push(dt);
    }

    return json({ provider: 'azure', candidates }, 200);

  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

/* ---------- helpers ---------- */
function errString(body, fallback = 'Unknown error') {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  // Common OpenAI/Azure shapes:
  const m = body?.error?.message || body?.message || body?.Message;
  if (typeof m === 'string') return m;
  try { return JSON.stringify(body); } catch { return fallback; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // If using a different frontend origin, set a specific allowed origin here.
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// Try JSON first; if not JSON, read text and wrap it so we always return JSON to the client.
async function safeBody(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await r.json();
  const text = await r.text();
  return { message: text };
}

// Normalize Azure STT result shapes and pull out best textual fields.
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


