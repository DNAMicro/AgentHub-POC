// Word matching for the labelled MOCK heuristics (Tutor scope check, Library mock answers).
// Not used in live mode, where the model reads the text itself.

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

// Levenshtein distance, giving up early once it exceeds `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Typo tolerance: 1 edit for words of 6–8 letters, 2 for longer ("derivitive" ~ "derivative").
// Short words must match exactly, or "limit" would match "light".
const typoOk = (w, t) => {
  const n = Math.min(w.length, t.length);
  return n >= 6 && editDistance(w, t, n >= 9 ? 2 : 1) <= (n >= 9 ? 2 : 1);
};

// `minPrefix(w, t)` is each caller's existing stemming rule; plural/stem forms of a typo
// ("derivitives") are covered by also comparing with a trailing "s"/"es" removed.
const stem = (w) => w.replace(/(es|s)$/, '');
export const nearWord = (w, t, minPrefix) =>
  w === t || commonPrefix(w, t) >= minPrefix(w, t) || typoOk(w, t) || typoOk(stem(w), stem(t));

export { commonPrefix };
