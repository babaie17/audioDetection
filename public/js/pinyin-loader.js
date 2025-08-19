<script>
// --- pinyin shard loader (client-side) ---
const shardCache = new Map(); // base syllable -> JSON object

// key: "hao" or "hao3"; files live at /pinyin-index/hao.json
async function loadHanziForPinyin(key) {
  const base = key.replace(/[1-5]$/, '');   // shard name without tone
  if (!shardCache.has(base)) {
    // fetch once; browser/CDN will cache aggressively
    const resp = await fetch(`/pinyin-index/${base}.json`);
    const obj = resp.ok ? await resp.json() : {};
    shardCache.set(base, obj);
  }
  const shard = shardCache.get(base) || {};
  return shard[key] || shard[base] || [];
}

// Helpers to normalize user/ASR inputs
function toPinyinKey(s) {
  // Accept "hǎo", "hao3", or "hao" -> return "hao3" or "hao"
  const toneMap = {
    'ā':'a1','á':'a2','ǎ':'a3','à':'a4',
    'ē':'e1','é':'e2','ě':'e3','è':'e4',
    'ī':'i1','í':'i2','ǐ':'i3','ì':'i4',
    'ō':'o1','ó':'o2','ǒ':'o3','ò':'o4',
    'ū':'u1','ú':'u2','ǔ':'u3','ù':'u4',
    'ǖ':'v1','ǘ':'v2','ǚ':'v3','ǜ':'v4','ü':'v'
  };
  let t = (s||'').trim().toLowerCase();
  t = t.replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/g, m => toneMap[m] || m);
  // keep "hao3" if present, else "hao"
  return /^[a-z]+[1-5]$/.test(t) ? t : t.replace(/[^a-z]/g,'');
}

// Example usage:
// 1) From a recognized single Hanzi → list homophones of its pinyin
async function homophonesFromHanzi(ch, prettyPinyinNum /* e.g., 'hao3' from your map */) {
  const key = toPinyinKey(prettyPinyinNum);
  return await loadHanziForPinyin(key || '');
}

// 2) From a recognized single pinyin syllable (e.g., "hǎo" or "hao3")
async function homophonesFromPinyin(syllable) {
  const key = toPinyinKey(syllable);
  return await loadHanziForPinyin(key || '');
}
</script>