export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const form = await request.formData();
    const file = form.get('audio');
    const language = (form.get('language') || 'en-US').toString();
    const provider = (form.get('provider') || 'azure').toString().toLowerCase();

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No audio uploaded' }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());

    if (provider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return json({ error: 'OPENAI_API_KEY missing' }, 500);

      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: file.type || 'audio/webm' }), 'speech.webm');
      fd.append('model', 'gpt-4o-transcribe');
      // Optional: lock language: fd.append('language', language);

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });

      const body = await safeBody(r);
      console.log('[OPENAI RAW]', body); // TEMP: remove after testing
      if (!r.ok) return json({ error: body?.error || body?.message || 'OpenAI error' }, r.status);

      const text = (body?.text || '').trim();
      const candidates = text ? [text] : [];
      return json({ provider: 'openai', candidates }, 200);
    }

    // ---- Azure path (Top-5) ----
    const azKey = process.env.AZURE_SPEECH_KEY;
    const azRegion = process.env.AZURE_REGION || 'eastus';
    if (!azKey) return json({ error: 'AZURE_SPEECH_KEY missing' }, 500);

    // conversation endpoint; 'format=detailed' requests NBest
    const url = `https://${azRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azKey,
        'Content-Type': file.type || 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: buf
    });

    const body = await safeBody(r);
    console.log('[AZURE RAW]', body); // TEMP: remove after testing
    if (!r.ok) return json({ error: body?.error || body?.Message || 'Azure error' }, r.status);

    // Normalize candidates across shapes
    const candidates = extractAzureCandidates(body).filter(s => s && s.trim().length > 0).slice(0, 5);

    // Optional fallback: single DisplayText if present
    if (candidates.length === 0) {
      const display = (body?.DisplayText || body?.Display || '').trim();
      if (display) candidates.push(display);
    }

    return json({ provider: 'azure', candidates }, 200);

  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function safeBody(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await r.json();
  const text = await r.text();
  return { message: text };
}

// Azure can return several shapes; collect all plausible text fields
function extractAzureCandidates(data) {
  let nbest = [];
  if (Array.isArray(data?.NBest)) nbest = data.NBest;
  else if (Array.isArray(data?.results) && Array.isArray(data.results[0]?.NBest)) nbest = data.results[0].NBest;
  else if (Array.isArray(data?.RecognitionStatus)) {
    // unlikely; placeholder for odd shapes
  }

  const fields = ['lexical', 'display', 'itn', 'maskedITN', 'transcript', 'NormalizedText', 'Display'];
  const out = [];

  if (Array.isArray(nbest)) {
    for (const item of nbest) {
      for (const f of fields) {
        const v = (item?.[f] || '').toString().trim();
        if (v) { out.push(v); break; }
      }
    }
  }

  // Some regions return { DisplayText, RecognitionStatus }
  const dt = (data?.DisplayText || '').toString().trim();
  if (dt) out.push(dt);

  return out;
}
