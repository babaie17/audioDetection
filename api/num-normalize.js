// api/num-normalize.js
export const config = { runtime: 'nodejs' };

// Both deps are CommonJS; default-import and then pull the functions safely.
import wtnMod from 'words-to-numbers';
import ntwMod from 'number-to-words';

const wordsToNumbers = typeof wtnMod === 'function' ? wtnMod : wtnMod?.wordsToNumbers;
const toWords        = typeof ntwMod === 'function' ? ntwMod : ntwMod?.toWords;

function assertDeps() {
  if (typeof wordsToNumbers !== 'function') {
    throw new Error('words-to-numbers import failed');
  }
  if (typeof toWords !== 'function') {
    throw new Error('number-to-words import failed');
  }
}

// Remove leading/trailing quotes and a single trailing sentence/clause punctuation
function stripEnds(s) {
  return (s || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\.。！？!?…，,；;：:]+$/u, '')
    .trim();
}

// Normalize for word parsing (keep hyphens, collapse spaces, lowercase)
function normalizeForWords(s) {
  return stripEnds(s)
    .toLowerCase()
    .replace(/[,]+/g, '')       // remove commas
    .replace(/\s*-\s*/g, '-')   // tidy hyphens
    .replace(/\s+/g, ' ');      // collapse spaces
}

export default async function handler(req, res) {
  try {
    assertDeps();

    const origin = `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', origin);

    const raw0 = (url.searchParams.get('text') || '');
    const raw  = stripEnds(raw0);

    let digitForm = null;
    let wordForm  = null;

    if (!raw) {
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Case A: already digits (handles "144." → "144" via stripEnds)
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      digitForm = String(n);
      try { wordForm = toWords(n).replace(/,/g, ''); } catch { wordForm = null; }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Case B: words → digits (tolerant)
    const text = normalizeForWords(raw);
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
