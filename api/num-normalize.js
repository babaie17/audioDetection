// api/num-normalize.js
export const config = { runtime: 'nodejs' };

import { wordsToNumbers } from 'words-to-numbers';
import { toWords } from 'number-to-words';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const text = (url.searchParams.get('text') || '').trim();

    let digitForm = null;
    let wordForm  = null;

    if (/^\d+$/.test(text)) {
      // digits -> words
      const n = parseInt(text, 10);
      digitForm = String(n);
      try { wordForm = toWords(n).replace(/,/g, ''); } catch { wordForm = null; }
    } else if (text) {
      // words -> digits (fuzzy)
      const converted = wordsToNumbers(text, { fuzzy: true });
      if (typeof converted === 'number' || /^\d+$/.test(String(converted))) {
        digitForm = String(converted);
        try { wordForm = toWords(converted).replace(/,/g, ''); } catch { wordForm = null; }
      }
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).send(JSON.stringify({ digitForm, wordForm }));
  } catch (err) {
    res.setHeader('content-type', 'application/json');
    res.status(200).send(JSON.stringify({ digitForm: null, wordForm: null, error: String(err?.message || err) }));
  }
}
