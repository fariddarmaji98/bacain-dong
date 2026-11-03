// Bacain Dong — text helpers, injected before content.js.
// Function declarations only: this file may be injected again into the same page.

// Split text into speakable chunks of at most `max` chars, preferring sentence ends.
function splitText(text, max) {
  // A sentence ends at . ! ? … followed by whitespace, so "3.14", "v1.2" and "example.com" stay whole.
  const sentences = text.match(/.+?(?:[.!?…]+["'”’)\]]*(?:\s+|$)|$)/g) || [text];
  const chunks = [];
  let cur = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      if (cur) chunks.push(cur);
      cur = '';
      chunks.push(...splitLong(s, max));
    } else if (cur && cur.length + 1 + s.length > max) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Cut one over-long sentence at spaces (hard cut when a word alone exceeds the limit).
function splitLong(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// "id" -> "id-ID", "en" -> "en-US", "pt_br" -> "pt-BR"; unknown tags are returned as given.
function normalizeLang(tag) {
  const t = String(tag || '').trim();
  const regional = t.match(/^([a-z]{2,3})[-_]([a-z]{2})$/i);
  if (regional) return `${regional[1].toLowerCase() === 'in' ? 'id' : regional[1].toLowerCase()}-${regional[2].toUpperCase()}`; // 'in' = legacy code for Indonesian
  const defaults = { in: 'id-ID', id: 'id-ID', en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', pt: 'pt-BR', it: 'it-IT', nl: 'nl-NL', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU' };
  return defaults[t.toLowerCase()] || t;
}

// Indonesian pages often carry no <html lang> or a wrong one, so look at the words first.
function guessLanguage(sample, htmlLang) {
  const ID = ' yang yg dan di ke dari untuk dengan ini itu adalah pada dalam tidak gak nggak akan juga atau karena sebagai oleh saya kami anda bisa dapat sudah udah telah lebih mereka ada namun tetapi kalau jika masih sangat banget semua harus antara setelah sebelum ketika saat bahwa kepada ';
  const EN = ' the and of to is in that for it with as on was are this be by at or from have not you but we ';
  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  let id = 0;
  let en = 0;
  for (const w of words) {
    if (ID.includes(` ${w} `)) id++;
    else if (EN.includes(` ${w} `)) en++;
  }
  if (words.length >= 10 && id >= 3 && id > en && id / words.length > 0.08) return 'id-ID';
  return normalizeLang(htmlLang) || 'en-US';
}
