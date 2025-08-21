// api/num-normalize.js
export const config = { runtime: 'nodejs' };

import { wordsToNumbers } from 'words-to-numbers';
import { toWords } from 'number-to-words';

function normalizeForWords(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[,]+/g, '')          // remove commas
    .replace(/\s*-\s*/g, '-')      // normalize hyphens
    .replace(/\s+/g, ' ');         // collapse spaces
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const raw = (url.searchParams.get('text') || '').trim();

    let digitForm = null;
    let wordForm  = null;

    if (!raw) {
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // If it's already all digits, just produce the word form.
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      digitForm = String(n);
      try { wordForm = toWords(n).replace(/,/g, ''); } catch { wordForm = null; }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Otherwise, try to interpret as words (case/spacing/punctuation tolerant).
    const text = normalizeForWords(raw);
    // wordsToNumbers can return a number OR leave the string as-is; use fuzzy to be lenient.
    const converted = wordsToNumbers(text, { fuzzy: true });

    // If it's a number (or a numeric-looking string), fill both forms.
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
