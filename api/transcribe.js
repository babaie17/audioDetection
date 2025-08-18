import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

function readForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = require("busboy")({ headers: req.headers });
    const form = { fields: {}, file: null, fileName: "clip.webm" };
    req.pipe(busboy);
    busboy.on("file", (_name, file, info) => {
      const chunks = [];
      form.fileName = info.filename || "clip.webm";
      file.on("data", d => chunks.push(d));
      file.on("end", () => form.file = Buffer.concat(chunks));
    });
    busboy.on("field", (name, val) => form.fields[name] = val);
    busboy.on("finish", () => resolve(form));
    busboy.on("error", reject);
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const form = await readForm(req);
    const provider = (form.fields.provider || "azure").toLowerCase();
    const language = (form.fields.language || "en-US").trim();

    if (!form.file) return res.status(400).json({ error: "No audio" });

    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

      const fd = new (require("form-data"))();
      fd.append("file", form.file, { filename: form.fileName, contentType: "audio/webm" });
      fd.append("model", "gpt-4o-transcribe");

      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      const text = (data.text || "").trim();
      return res.json({ provider: "openai", candidates: text ? [text] : [] });
    }

    // Azure path
    const azKey = process.env.AZURE_SPEECH_KEY;
    const azRegion = process.env.AZURE_REGION || "eastus";
    if (!azKey) return res.status(500).json({ error: "AZURE_SPEECH_KEY missing" });

    const url = `https://${azRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": azKey,
        "Content-Type": "audio/webm; codecs=opus",
        "Accept": "application/json"
      },
      body: form.file
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    let nbest = [];
    if (Array.isArray(data?.NBest)) nbest = data.NBest;
    else if (Array.isArray(data?.results) && Array.isArray(data.results[0]?.NBest)) nbest = data.results[0].NBest;

    const candidates = (nbest || []).map(x => (x.lexical || x.display || x.itn || x.transcript || "").trim()).filter(Boolean).slice(0, 5);
    if (candidates.length === 0 && typeof data?.DisplayText === "string") candidates.push(data.DisplayText.trim());

    return res.json({ provider: "azure", candidates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}