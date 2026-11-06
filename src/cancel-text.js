// Review #3 (second review): the class cancellation's wording, shared by the Faculty agent (which sends it) and the Faculty
// view's preview card (which shows it before he sends), so the preview is exactly what students get. Dependency-free: the
// browser loads this file from /shared/cancel-text.js.
export const NOTE_MAX = 500;

// His note as students read it: spaces tidied, wrapping quotes removed, a capital first letter and an end mark. Empty → null.
export function cancelNoteText(raw) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  if (!t) return null;
  t = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// The code-built sentence plus, if he added one, his note as its own paragraph (“From Dr. Dabirian: …”).
export const withCancelNote = (base, professorName, note) => (note ? `${base}\n\nFrom ${professorName}: ${note}` : base);
