// api/num-normalize.js
export const config = { runtime: 'nodejs' };

import { wordsToNumbers } from 'words-to-numbers';
import { toWords } from 'number-to-words';

// Remove leading/trailing quotes and trailing sentence punctuation
function stripEnds(s) {
  return (s || '')
    .trim()
    // drop surrounding quotes/backticks
    .replace(/^["'`]+|["'`]+$/g, '')
    // drop ONE trailing sentence/clause ender if present
    .replace(/[\.。！？!?…，,；;：:]+$/u, '')
    .trim();
}

// Normalize for word parsing (keep hyphens, collapse spaces, lowercase)
function normalizeForWords(s) {
  return stripEnds(s)
    .toLowerCase()
    .replace(/[,]+/g, '')       // commas inside words
    .replace(/\s*-\s*/g, '-')   // tidy hyphens
    .replace(/\s+/g, ' ');      // collapse spaces
}

export default async function handler(req, res) {
  try {
    const origin = `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', origin);

    const raw0 = (url.searchParams.get('text') || '');
    const raw = stripEnds(raw0);

    let digitForm = null;
    let wordForm  = null;

    if (!raw) {
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Case A: already digits (handle "144." cleaned to "144")
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      digitForm = String(n);
      try { wordForm = toWords(n).replace(/,/g, ''); } catch { wordForm = null; }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Case B: words → digits (tolerant)
    const text = normalizeForWords(raw);
    // wordsToNumbers may return a number or the original string depending on content/options.
    const converted = wordsToNumbers(text, { fuzzy: true });

    const maybeNum =
      (typeof converted === 'number' && Number.isFinite(converted))
        ? converted
        : (/^\d+$/.test(String(converted)) ? parseInt(String(converted), 10) : null);

    if (maybeNum !== null) {
      digitForm = String(maybeNum);
      try { wordForm = toWords(maybeNum).replace(/,/g, ''); } catch { wordForm = null; }
    }

    res.setHeader('content-type', 'application/json');
    return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
  } catch (err) {
    res.setHeader('content-type', 'application/json');
    return res.status(200).send(JSON.stringify({
      digitForm: null,
      wordForm: null,
      error: String(err?.message || err)
    }));
  }
}
