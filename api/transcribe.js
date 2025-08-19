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
    const file = form.get('audio'); // Blob from client
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

      const t = (file.type || '');
      const name =
        t.includes('wav')  ? 'speech.wav' :
        t.includes('ogg')  ? 'speech.ogg' :
        t.includes('webm') ? 'speech.webm' : 'audio.bin';

      const fd = new FormData();
      fd.append('file', file, name);
      fd.append('language', toWhisperLang(language));   // force language for Whisper
      fd.append('model', 'gpt-4o-transcribe');

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });
      const body = await safeBody(r);

      if (debug && !r.ok) {
        return json({ provider: 'openai', status: r.status, ok: r.ok, upstream: body, candidates: [] }, r.status);
      }
      if (!r.ok) return json({ error: errString(body, 'OpenAI error'), candidates: [] }, r.status);

      const text = (body?.text || '').trim();
      let candidates = text ? [text] : [];
      candidates = strictLanguageFilter(candidates, language);

      // NEW: zh homophone augmentation (single char or single pinyin)
      const zh = await buildZhHomophones(request, candidates, language);

      return json({ provider: 'openai', candidates, zhAugment: zh }, 200);
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

      if (debug) attempts.push({ endpoint: path, status: r.status, ok: r.ok, body });

      if (!r.ok) { lastErr = errString(body, 'Azure error'); continue; }

      // Extract candidates (NBest) then fallback to DisplayText
      let candidates = extractAzureCandidates(body)
        .map(s => (s || '').trim())
        .filter(Boolean)
        .slice(0, 5);

      // Drop Latin-only when zh/ja/ko is selected
      candidates = strictLanguageFilter(candidates, language);

      if (candidates.length === 0) {
        const dt = (body?.DisplayText || body?.Display || '').toString().trim();
        const fb = dt ? strictLanguageFilter([dt], language) : [];
        if (fb.length > 0) candidates = fb;
      }

      if (candidates.length > 0) {
        const zh = await buildZhHomophones(request, candidates, language);
        return json({
          provider: 'azure',
          endpoint: path.split('/')[1],
          contentType,
          candidates,
          zhAugment: zh
        }, 200);
      }

      lastErr = errString(body, 'No speech recognized');
    }

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

/* ======================= zh homophones (server-side) ======================= */
// If language starts with zh and the top candidate is either:
// - exactly one Han character -> look up its pinyin (ignoring tone) and return all homophones from /pinyin-index/<base>.json
// - a single pinyin syllable (e.g., "hǎo"/"hao3"/"hao") -> return all chars for that base
async function buildZhHomophones(request, candidates, bcp47) {
  try {
    const primary = (bcp47 || '').split('-')[0].toLowerCase();
    if (primary !== 'zh') return null;

    const top = (candidates && candidates[0]) ? candidates[0].trim() : '';
    if (!top) return null;

    const isSingleHan = [...top].filter(ch => /\p{Script=Han}/u.test(ch)).length === 1;
    const singlePinyin = detectSinglePinyin(top); // returns normalized pinyin (might include tone num) or null

    // Compute base URL for same-origin fetches
    const base = new URL(request.url);
    const origin = `${base.protocol}//${base.host}`;

    // Case A: recognized exactly one Han character
    if (isSingleHan) {
      const ch = [...top].find(c => /\p{Script=Han}/u.test(c));

      // Try to get its readings from a map (prefer /public/hanzi_to_pinyin.json)
      const readings = await lookupHanziReadings(origin, ch); // [{sound,tone,pretty}] or []
      // Gather all base sounds (ignore tone)
      const bases = [...new Set(readings.map(r => (r.sound || '').toLowerCase()).filter(Boolean))];

      // If no reading map available, we can’t resolve the base → homophones
      if (bases.length === 0) return { mode: 'singleChar', input: ch, homophones: [] };

      // Union homophones across all bases (polyphonic chars like “重”)
      const homophonesSet = new Set();
      for (const b of bases) {
        const shard = await loadPinyinShard(origin, b);
        for (const char of (shard[b] || [])) homophonesSet.add(char);
      }
      const homophones = Array.from(homophonesSet);

      return {
        mode: 'singleChar',
        input: ch,
        bases,
        homophones
      };
    }

    // Case B: recognized a single pinyin syllable
    if (singlePinyin) {
      const baseKey = singlePinyin.replace(/[1-5]$/,''); // ignore tone for this feature
      const shard = await loadPinyinShard(origin, baseKey);
      const homophones = (shard[baseKey] || []).slice();
      return {
        mode: 'singlePinyin',
        input: top,
        bases: [baseKey],
        homophones
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Cache (module-scope) for performance across invocations
let HANZI_MAP = null;              // { "好":[{sound:"hao",tone:3,pretty:"hǎo"}], ... }
const SHARD_CACHE = new Map();     // "hao" -> { hao:[...], hao1:[...], ... }

async function lookupHanziReadings(origin, ch) {
  if (!HANZI_MAP) {
    // Prefer /hanzi_to_pinyin.json in public
    let url = `${origin}/hanzi_to_pinyin.json`;
    let r = await fetch(url);
    if (!r.ok) {
      // Fallback to /api/data/hanzi_to_pinyin.json if you kept it there
      url = `${origin}/api/data/hanzi_to_pinyin.json`;
      r = await fetch(url);
      if (!r.ok) return [];
    }
    HANZI_MAP = await r.json();
  }
  return HANZI_MAP[ch] || [];
}

async function loadPinyinShard(origin, base) {
  if (SHARD_CACHE.has(base)) return SHARD_CACHE.get(base);
  const url = `${origin}/pinyin-index/${base}.json`; // served from /public/pinyin-index/
  const r = await fetch(url);
  const obj = r.ok ? await r.json() : {};
  SHARD_CACHE.set(base, obj);
  return obj;
}

/* ======================= helpers ======================= */

// Detect a single pinyin syllable like "hao", "hǎo", "hao3"
function detectSinglePinyin(s) {
  const toneMap = {
    'ā':'a1','á':'a2','ǎ':'a3','à':'a4',
    'ē':'e1','é':'e2','ě':'e3','è':'e4',
    'ī':'i1','í':'i2','ǐ':'i3','ì':'i4',
    'ō':'o1','ó':'o2','ǒ':'o3','ò':'o4',
    'ū':'u1','ú':'u2','ǔ':'u3','ù':'u4',
    'ǖ':'v1','ǘ':'v2','ǚ':'v3','ǜ':'v4','ü':'v'
  };
  let t = (s||'').trim().toLowerCase();
  if (!t || t.includes(' ')) return null;
  t = t.replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/g, m => toneMap[m] || m);
  if (!/^[a-z]+[1-5]?$/.test(t)) return null;
  if (t.length > 6) return null;
  return t;
}

function looksLikeLatinOnly(s) {
  const hasLetter = /[A-Za-z]/.test(s);
  const hasCJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
  return hasLetter && !hasCJK;
}
function strictLanguageFilter(cands, bcp47) {
  const primary = bcp47.split('-')[0].toLowerCase();
  if (['zh', 'ja', 'ko'].includes(primary)) {
    const filtered = cands.filter(t => !looksLikeLatinOnly(t));
    return filtered.length ? filtered : [];
  }
  return cands;
}

// Map BCP-47 to Whisper’s expected ISO-639
function toWhisperLang(bcp47) {
  const map = {
    'zh-CN': 'zh', 'zh-TW': 'zh',
    'ja-JP': 'ja', 'ko-KR': 'ko',
    'en-US': 'en', 'es-ES': 'es'
  };
  return map[bcp47] || bcp47.split('-')[0];
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
