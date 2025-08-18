export const config = { runtime: 'edge' }; // Edge Function

export default async function handler(request) {
  try {
    // Parse multipart with Web API:
    const form = await request.formData();
    const file = form.get('audio');
    const language = (form.get('language') || 'en-US').toString();
    const provider = (form.get('provider') || 'azure').toString().toLowerCase();

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No audio uploaded' }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());

    if (provider === 'openai') {
      // ---- OpenAI 1-best (optional path) ----
      const key = process.env.OPENAI_API_KEY;
      if (!key) return json({ error: 'OPENAI_API_KEY missing' }, 500);

      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: file.type || 'audio/webm' }), 'speech.webm');
      fd.append('model', 'gpt-4o-transcribe');
      // Optional: fd.append('language', language);

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });

      const text = await safeJson(r);
      if (!r.ok) return json(text, r.status);

      const one = (text?.text || '').trim();
      return json({ provider: 'openai', candidates: one ? [one] : [] }, 200);
    }

    // ---- Azure Top-5 path ----
    const azKey = process.env.AZURE_SPEECH_KEY;
    const azRegion = process.env.AZURE_REGION || 'eastus';
    if (!azKey) return json({ error: 'AZURE_SPEECH_KEY missing' }, 500);

    const url = `https://${azRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azKey,
        // application/octet-stream is broadly accepted if the exact mime is finicky
        'Content-Type': file.type || 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: buf
    });

    const data = await safeJson(r);
    if (!r.ok) return json(data, r.status);

    let nbest = [];
    if (Array.isArray(data?.NBest)) nbest = data.NBest;
    else if (Array.isArray(data?.results) && Array.isArray(data.results[0]?.NBest)) nbest = data.results[0].NBest;

    const candidates = (nbest || [])
      .map(x => (x.lexical || x.display || x.itn || x.transcript || '').trim())
      .filter(Boolean)
      .slice(0, 5);

    if (candidates.length === 0 && typeof data?.DisplayText === 'string') {
      candidates.push(data.DisplayText.trim());
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

// Try JSON first; if not JSON, return text so we can relay it
async function safeJson(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await r.json();
  const text = await r.text();
  // return a shaped object, so client still gets JSON
  return { message: text };
}
