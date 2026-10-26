// FICTIONAL SAMPLE DATA for the Library Agent. Not a real library, real policies, or real
// availability. The agent gives guidance from this fixture; it performs no transactions.
export const LIBRARY_NAME = 'Sample Library (fictional)';
export const SAMPLE_NOTE = 'Sample data for this demo only — not a real library’s policy or catalog.';

const HOURS = [
  ['Monday–Thursday', '8:00–22:00'],
  ['Friday', '8:00–18:00'],
  ['Saturday', '10:00–18:00'],
  ['Sunday', '12:00–20:00'],
];

const CATALOG = [
  { title: 'Calculus: Concepts and Exercises (sample entry)', subjects: ['calculus', 'derivatives', 'integrals', 'limits', 'textbook', 'math'], callNumber: 'QA303 .S25', location: 'Floor 2, Mathematics' },
  { title: 'A First Course in Linear Algebra (sample entry)', subjects: ['algebra', 'linear', 'matrices', 'textbook', 'math'], callNumber: 'QA184 .S10', location: 'Floor 2, Mathematics' },
  { title: 'Physics for Beginners (sample entry)', subjects: ['physics', 'mechanics', 'textbook'], callNumber: 'QC21 .S77', location: 'Floor 3, Sciences' },
  { title: 'Writing a Research Paper (sample entry)', subjects: ['writing', 'research', 'guide'], callNumber: 'LB2369 .S04', location: 'Floor 1, Study Skills' },
];

const STOP = new Set('where can find finding locate looking book books about textbook textbooks resource resources library the a an for on in of to i me my do does is are any have has there get'.split(' '));

// Each handler: when it applies, and what it answers — fixture facts only.
export const LIBRARY_HANDLER_IMPLS = {
  'library-hours': {
    label: 'Opening hours from the sample fixture',
    matches: (q) => /\b(hours?|open|opening|close[sd]?|closing|weekends?|saturday|sunday)\b/.test(q),
    respond: () => `${LIBRARY_NAME} hours:\n${HOURS.map(([d, h]) => `• ${d}: ${h}`).join('\n')}`,
  },
  'borrowing-guidance': {
    label: 'Borrowing rules from the sample fixture',
    matches: (q) => /\b(borrow\w*|check ?out|checking out|loans?|lend\w*|library card)\b/.test(q),
    respond: () => 'Borrowing at the sample library: bring your library card to the front desk or a self-checkout station. Standard loans are 21 days; course-reserve items are 2-hour, in-library use only; up to 10 items at a time.',
  },
  'renewal-guidance': {
    label: 'Renewal guidance (cannot renew anything itself)',
    matches: (q) => /\b(renew\w*|extend\w*)\b/.test(q),
    respond: () => 'Renewing at the sample library: you can renew an item up to 2 times, 21 days each, if nobody has placed a hold on it — through your library account page or at the front desk. I can’t see your account or renew anything for you.',
  },
  'returns-guidance': {
    label: 'Returns guidance from the sample fixture',
    matches: (q) => /\b(return\w*|drop ?box|book drop|overdue|late fees?)\b/.test(q),
    respond: () => 'Returning items at the sample library: use the front desk during opening hours or the 24-hour book drop by the main entrance. Overdue items are charged a sample fee of $0.25 per day.',
  },
  'resource-finding': {
    label: 'Search of the small sample catalog (no live availability)',
    matches: (q) => /\b(find\w*|locate|looking for|where can i (get|find)|textbooks?|books? (on|about)|catalog\w*|resources?)\b/.test(q),
    respond: (q) => {
      const words = q.split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
      const hits = CATALOG.filter((item) => words.some((w) => item.subjects.includes(w) || item.title.toLowerCase().includes(w)));
      if (!hits.length) return `I didn’t find a match in the sample catalog for that. Try a subject such as calculus, algebra, physics, or research writing.`;
      return `From the sample catalog (availability isn’t tracked — check the real catalog before you go):\n${hits.map((h) => `• ${h.title} — ${h.callNumber}, ${h.location}`).join('\n')}`;
    },
  },
};

// Pick handler(s) for a question. Mentions of borrowing inside a renewal/return question are context.
export function matchHandlers(question) {
  const q = question.toLowerCase();
  let found = Object.entries(LIBRARY_HANDLER_IMPLS).filter(([, h]) => h.matches(q)).map(([id]) => id);
  if (found.includes('renewal-guidance') || found.includes('returns-guidance')) found = found.filter((id) => id !== 'borrowing-guidance');
  return found;
}
