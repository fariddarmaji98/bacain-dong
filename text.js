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
