// Review A4 + C16: what the faculty member reads after something went to students. Real counts from the Hub's publish
// ack (`deliveries[]`: state, opened, emailed, emailFailed), never a bare "Sent". Dependency-free, plain words, no
// system names, one fact per sentence (owner, 2026-11-05: "they got it in the app" read awkwardly). One format for
// every path (a plain post, "notify everyone", a class cancellation, a held post, an @assistant post, a meeting offer,
// a quiz notice):
//
//   class:   "Sent to your 25 students. 1 student received it in the app. 24 students aren't online, so they were emailed."
//   all app: "Sent to your 3 students. All 3 received it in the app."
//   one:     "Sent to 1 student, who received it in the app."   (the Faculty view shows the name in place of
//            "1 student"; the stored text never names a student: the chat is saved and pushed to every page)
//   email failed too: "… 24 students aren't online, and the email couldn't be sent. They'll receive it when they're online."
//
// "Received it in the app" = the Student agent confirmed the inbox entry (delivered or opened). "Emailed" = still
// queued for the app, and CHRS's campus mail stand-in took the email. Anything else is said as it is.
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
export function deliveredText(list, { audience = 'all' } = {}) {
  const c = deliveryCounts(list);
  if (!c.total) return null;
  if (audience !== 'all' && c.total === 1) {
    const k = Object.keys(c).find((key) => key !== 'total' && c[key] === 1);
    return {
      app: 'Sent to 1 student, who received it in the app.',
      emailed: "Sent to 1 student. They aren't online, so they were emailed.",
      waiting: "Sent to 1 student. They aren't online, and the email couldn't be sent. They'll receive it when they're online.",
      failed: "Sent to 1 student, but it couldn't be delivered.",
      sending: "Sent to 1 student. It's still on its way; I'll keep checking.",
    }[k];
  }
  const n = c.total;
  const all = (x) => x === n && n > 1;
  const students = (x) => `${x} ${x === 1 ? 'student' : 'students'}`;
  const isnt = (x) => (x === 1 ? "isn't" : "aren't");
  const out = [];
  if (c.app) out.push(all(c.app) ? `All ${n} received it in the app.` : `${students(c.app)} received it in the app.`);
  if (c.emailed) out.push(all(c.emailed) ? `None of them are online, so all ${n} were emailed.` : `${students(c.emailed)} ${isnt(c.emailed)} online, so they were emailed.`);
  if (c.sending) out.push(`It's still on its way to ${students(c.sending)}.`);
  if (c.failed) out.push(`It couldn't be delivered to ${students(c.failed)}.`);
  if (c.waiting) out.push(`${all(c.waiting) ? `None of them are online, and` : `${students(c.waiting)} ${isnt(c.waiting)} online, and`} the email couldn't be sent. They'll receive it when they're online.`);
  return `${audience === 'all' ? `Sent to your ${students(n)}.` : `Sent to ${students(n)}.`} ${out.join(' ')}`;
}
