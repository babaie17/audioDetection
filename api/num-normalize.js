// api/num-normalize.js
// Explicit Node runtime so npm packages are allowed
export const config = { runtime: 'nodejs18.x' };

// NOTE: use dynamic imports so this works regardless of package.json "type"
async function loadLibs() {
  const { wordsToNumbers } = await import('words-to-numbers');
  const { toWords } = await import('number-to-words');
  return { wordsToNumbers, toWords };
}

function normalizeForWords(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[,]+/g, '')       // remove commas
    .replace(/\s*-\s*/g, '-')   // normalize hyphens
    .replace(/\s+/g, ' ');      // collapse spaces
}

export default async function handler(req, res) {
  try {
    // Build absolute URL for query parsing
    const origin = `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', origin);
    const raw = (url.searchParams.get('text') || '').trim();

    let digitForm = null;
    let wordForm  = null;

    if (!raw) {
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    const { wordsToNumbers, toWords } = await loadLibs();

    // Case 1: already digits
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      digitForm = String(n);
      try { wordForm = toWords(n).replace(/,/g, ''); } catch { wordForm = null; }
      res.setHeader('content-type', 'application/json');
      return res.status(200).send(JSON.stringify({ digitForm, wordForm }));
    }

    // Case 2: words → digits (fuzzy)
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
    // Return JSON instead of crashing
    res.setHeader('content-type', 'application/json');
    return res.status(200).send(JSON.stringify({
      digitForm: null,
      wordForm: null,
      error: String(err?.message || err)
    }));
  }
}
