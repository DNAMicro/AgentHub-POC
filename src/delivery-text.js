// Review A4 + C16: what the faculty member reads after something went to students. Real counts from the Hub's publish
// ack (`deliveries[]`: state, opened, emailed, emailFailed), never a bare "Sent". Dependency-free, plain words, no
// system names. Owner, 2026-11-05: "Lets just say 25 students notified we dont need to say how" — a student who got it
// in the app and one who was emailed are both "notified"; only what did NOT reach someone is said separately.
//
//   class:   "25 students notified."
//   one:     "1 student notified."   (the Faculty view shows the name: "Alex Student notified."; the stored text never
//            names a student: the chat is saved and pushed to every page)
//   not everyone reached: "24 students notified. 1 student isn't online and will be notified when they are."
//
const kindOf = (d) => {
  const state = d?.state ?? d?.status; // the Hub's ack says `state`; the quiz card's summary says `status`
  if (d?.opened || state === 'delivered') return 'app';
  if (state === 'queued') return d.emailed ? 'emailed' : 'waiting';
  if (state === 'failed') return 'failed';
  return 'sending'; // uncertain, sending, anything not yet confirmed
};

export function deliveryCounts(list) {
  const c = { total: 0, app: 0, emailed: 0, waiting: 0, failed: 0, sending: 0 };
  for (const d of Array.isArray(list) ? list : []) { c.total += 1; c[kindOf(d)] += 1; }
  return c;
}

// → the sentence, or null when there is nothing to count (the Hub hasn't confirmed the post: no claim at all).
// audience: 'all' (the whole class) or the post's own audience (one id, or several comma-separated).
// `audience` is kept for callers; the wording no longer depends on it (a tagged student reads like the class).
export function deliveredText(list, { audience = 'all' } = {}) { // eslint-disable-line no-unused-vars
  const c = deliveryCounts(list);
  if (!c.total) return null;
  const students = (x) => `${x} ${x === 1 ? 'student' : 'students'}`;
  const notified = c.app + c.emailed;
  const out = [];
  if (notified) out.push(`${students(notified)} notified.`);
  if (c.waiting) out.push(c.waiting === 1 ? "1 student isn't online and will be notified when they are." : `${students(c.waiting)} aren't online and will be notified when they are.`);
  if (c.sending) out.push(`${students(c.sending)} ${c.sending === 1 ? 'is' : 'are'} still being notified.`);
  if (c.failed) out.push(`${students(c.failed)} couldn't be notified.`);
  return out.join(' ');
}
