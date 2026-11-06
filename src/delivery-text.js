// Review A4 + C16: what the faculty member reads after something went to students. Real counts from the Hub's publish
// ack (`deliveries[]`: state, opened, emailed, emailFailed), never a bare "Sent". Dependency-free, plain words, no
// system names. One format for every path (a plain post, “notify everyone”, a class cancellation, a held post, an
// @assistant post, a meeting offer, a quiz notice):
//
//   class:   "Sent to your 25 students: 1 got it in the app, 24 were emailed because they aren't online."
//   some:    "Sent to 2 students: 1 got it in the app, 1 was emailed because they aren't online."
//   one:     "Sent to 1 student — they got it in the app."   (the Faculty view shows the name in place of "1 student";
//            the stored text never names a student: the chat is saved and pushed to every page)
//   email failed too: "…; 24 aren't online yet and the email couldn't be sent — they'll get it when they're online."
//
// "Got it in the app" = the Student agent confirmed the inbox entry (delivered or opened). "Emailed" = still queued for
// the app, and CHRS's campus mail stand-in took the email. Anything else is said as it is (on its way / not delivered).
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
    const how = {
      app: 'they got it in the app.',
      emailed: "they aren't online, so it was emailed.",
      waiting: "they aren't online yet and the email couldn't be sent; they'll get it when they're online.",
      failed: 'it could not be delivered.',
      sending: "it's still on its way; I'll keep checking.",
    }[k];
    return `Sent to 1 student — ${how}`;
  }
  const n = c.total;
  const all = (x) => x === n && n > 1;
  const parts = [];
  if (c.app) parts.push(all(c.app) ? `all ${n} got it in the app` : `${c.app} got it in the app`);
  if (c.emailed) parts.push(all(c.emailed) ? `all ${n} were emailed because they aren't online` : `${c.emailed} ${c.emailed === 1 ? 'was' : 'were'} emailed because they aren't online`);
  if (c.sending) parts.push(`${c.sending} ${c.sending === 1 ? 'is' : 'are'} still on the way`);
  if (c.failed) parts.push(`${c.failed} could not be delivered`);
  let text = parts.join(', ');
  if (c.waiting) {
    const w = `${all(c.waiting) ? `all ${n}` : c.waiting} ${c.waiting === 1 ? "isn't" : "aren't"} online yet and the email couldn't be sent — they'll get it when they're online`;
    text = text ? `${text}; ${w}` : w;
  }
  return `${audience === 'all' ? `Sent to your ${n} ${n === 1 ? 'student' : 'students'}` : `Sent to ${n} students`}: ${text}.`;
}
