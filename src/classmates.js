// Owner, 2026-11-06 (“I thought you fixed the student so they can ask questions about their class”, then “Names, count
// and major/year”, then “the student should be able to get the email as well and contact the students”): a STUDENT of
// Marketing 351 asking about classmates gets an answer from the class roster — names, the count, each classmate's year
// (academic level), major (plan) and campus email, so they can contact them. Never a student ID, phone, address,
// pronouns or grades. Answered in code from rows the Campus Agent returned for the signed purpose 'classmates'; no model.
//
// classmatesAnswer(question, rows, studentId) → { kind, text, count }
//   rows: [{ studentId, name: 'Last,First', level, plan, email }] (the Campus Agent's classmates roster)
//   studentId: the Hub-verified asker; only a student on the roster gets the class list.
// Dependency-free (fictional demo data only).

const COURSE = 'Marketing 351';
const s = (t) => String(t ?? '').replace(/[’]/g, '\'').replace(/\s+/g, ' ').trim();

export const CLASSMATES_FAILED_TEXT = 'I couldn’t get the class list just now. Try again in a moment.';
export const NOT_ENROLLED_TEXT = `Only students enrolled in ${COURSE} can see its class list.`;
export const PRIVATE_DETAIL_TEXT = 'I can’t share another student’s student ID, phone number, address, pronouns or grades — those stay private. I can share classmates’ names, emails, year and major.';

const PRIVATE = /\b(?:student\s+id|id\s+number|cwid|\bid\b|phone|cell|number|address|pronouns?|grades?|scores?|gpa|marks?|transcript|birthday|age)\b/i;
const COUNT = /\bhow\s+(?:many|big|large|full)\b/i;
const EMAIL = /\be-?mails?\b|\bcontact\b|\breach\b|\bget\s+in\s+touch\b/i;
const LEVELS = [['freshman', /\bfreshm[ae]n\b|\bfirst[- ]years?\b/i], ['sophomore', /\bsophomores?\b/i], ['junior', /\bjuniors?\b/i], ['senior', /\bseniors?\b/i]];
const MAJOR = /\b([a-z]+(?:\s+[a-z]+)?)\s+majors?\b|\bmajoring\s+in\s+([a-z]+(?:\s+[a-z]+)?)\b|\bstudying\s+([a-z]+)\b/i;
const NOT_MAJOR = new Set(['what', 'which', 'any', 'the', 'my', 'other', 'their', 'your', 'are', 'is', 'of', 'all', 'how', 'many', 'who']);
const NAMED = /\b([A-Z][a-z'’-]+)(?:\s+([A-Z][a-z'’-]+))?(?='s\b|\s+(?:in|taking|enrolled|registered|a|an|on|still|also)\b|\?|$)/g;
const NOT_A_NAME = new Set(['Is', 'Are', 'Who', 'What', 'Which', 'How', 'Does', 'Do', 'Can', 'Could', 'Will', 'Would', 'Should', 'Did', 'Has',
  'Have', 'I', 'My', 'The', 'Marketing', 'Mktg', 'Dr', 'Dabirian', 'Canvas', 'Hi', 'Hey', 'Please', 'Thanks', 'Anyone', 'Anybody', 'Everyone',
  'Tell', 'Give', 'Show', 'List', 'Send', 'Find', 'Where', 'When', 'Why', 'In', 'Class', 'Professor', 'Mihaylo', 'Hall']);

// A private detail (ID, phone, grades …) needs no class list: answered without reading the roster.
export const asksPrivateDetail = (question) => PRIVATE.test(s(question));
export const nameOf = (row) => { const [last = '', first = ''] = String(row?.name ?? '').split(','); return `${first.trim()} ${last.trim()}`.trim(); };
const majorOf = (row) => { const p = String(row?.plan ?? '').trim(); const i = p.lastIndexOf(' - '); return i >= 0 ? p.slice(i + 3).trim() : p; };
const levelOf = (row) => String(row?.level ?? '').trim();
const detail = (row) => [levelOf(row), majorOf(row)].filter(Boolean).join(', ');
const line = (row) => `- ${nameOf(row)} — ${detail(row)}${row.email ? ` · ${row.email}` : ''}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The names a question types (“Is Mariana Aguilar in my class?”, “What's Sam Student's email?”, “is Owen in class”).
function typedNames(t) {
  const out = [];
  for (const m of t.matchAll(NAMED)) {
    const words = [m[1], m[2]].filter(Boolean).map((w) => w.replace(/['’]s$/, ''));
    const kept = words.filter((w) => !NOT_A_NAME.has(w));
    if (kept.length) out.push(kept.join(' '));
  }
  return out;
}
function matchName(name, rows) {
  const want = name.toLowerCase().split(/\s+/);
  const parts = (r) => { const [last = '', first = ''] = String(r.name ?? '').toLowerCase().split(','); return { first: first.trim(), last: last.trim() }; };
  const full = rows.filter((r) => { const p = parts(r); const j = want.join(' '); return j === `${p.first} ${p.last}` || j === `${p.last} ${p.first}`; });
  if (full.length || want.length !== 1) return full;
  return rows.filter((r) => { const p = parts(r); return p.first === want[0] || p.last === want[0]; });
}
function groupOf(t) {
  const level = LEVELS.find(([, re]) => re.test(t))?.[0] ?? null;
  const m = MAJOR.exec(t);
  const raw = m ? (m[1] ?? m[2] ?? m[3]).toLowerCase() : null;
  const major = raw ? raw.split(/\s+/).filter((w) => !NOT_MAJOR.has(w)).join(' ') || null : null;
  return level || major ? { level, major } : null;
}
const inGroup = (g) => (r) => (!g.level || levelOf(r).toLowerCase() === g.level) && (!g.major || majorOf(r).toLowerCase().includes(g.major) || String(r.plan ?? '').toLowerCase().includes(g.major));
const groupWords = (g, n) => {
  const lvl = g.level ? (n === 1 ? g.level : g.level === 'freshman' ? 'freshmen' : `${g.level}s`) : null;
  const maj = g.major ? `${g.major.replace(/\b\w/g, (c) => c.toUpperCase())} ${n === 1 ? 'major' : 'majors'}` : null;
  return lvl && maj ? `${lvl} who ${n === 1 ? 'is a' : 'are'} ${maj}` : lvl ?? maj;
};

export function classmatesAnswer(question, rows, studentId) {
  const t = s(question);
  if (!Array.isArray(rows) || !rows.length) return { kind: 'failed', text: CLASSMATES_FAILED_TEXT, count: 0 };
  if (!rows.some((r) => r.studentId === studentId)) return { kind: 'not_enrolled', text: NOT_ENROLLED_TEXT, count: 0 };
  const others = rows.filter((r) => r.studentId !== studentId);
  const total = rows.length;
  // A private detail (ID, phone, grades …) is never shared, whoever it is about.
  if (PRIVATE.test(t)) return { kind: 'private', text: PRIVATE_DETAIL_TEXT, count: 0 };

  // One named classmate: are they in the class, and how to reach them.
  const names = typedNames(t);
  if (names.length) {
    const found = [...new Map(names.flatMap((n) => matchName(n, rows)).map((r) => [r.studentId, r])).values()];
    if (!found.length) return { kind: 'not_found', text: `I don’t see ${names[0]} in ${COURSE}.`, count: 0 };
    if (found.length > 1 && names.length === 1) {
      return { kind: 'several', text: `${found.length} students in ${COURSE} match “${names[0]}”:\n\n${found.map(line).join('\n')}`, count: found.length };
    }
    const text = found.map((r) => (r.studentId === studentId
      ? `That’s you — you’re enrolled in ${COURSE}.`
      : EMAIL.test(t)
        ? `${nameOf(r)}’s campus email is ${r.email ?? '(not available)'}. They’re a ${levelOf(r).toLowerCase()} majoring in ${majorOf(r)}.`
        : `Yes — ${nameOf(r)} is in ${COURSE} (${detail(r)}). Their campus email is ${r.email ?? '(not available)'}.`)).join('\n\n');
    return { kind: 'named', text, count: found.length };
  }

  // A group: by year and/or major.
  const g = groupOf(t);
  if (g) {
    const hit = others.filter(inGroup(g));
    if (!hit.length) return { kind: 'group', text: `None of your classmates in ${COURSE} are ${groupWords(g, 2)}.`, count: 0 };
    if (COUNT.test(t)) return { kind: 'group_count', text: `${plural(hit.length, 'classmate', 'classmates')} in ${COURSE} ${hit.length === 1 ? 'is' : 'are'} ${hit.length === 1 ? `a ${groupWords(g, 1)}` : groupWords(g, 2)}.`, count: hit.length };
    return { kind: 'group', text: `${plural(hit.length, 'classmate', 'classmates')} in ${COURSE} ${hit.length === 1 ? 'is' : 'are'} ${hit.length === 1 ? `a ${groupWords(g, 1)}` : groupWords(g, 2)}:\n\n${hit.map(line).join('\n')}`, count: hit.length };
  }

  if (COUNT.test(t) && !EMAIL.test(t)) return { kind: 'count', text: `${plural(total, 'student is', 'students are')} enrolled in ${COURSE} — you and ${plural(others.length, 'classmate', 'classmates')}.`, count: total };

  // Everyone: names, year, major and email.
  return { kind: 'list', text: `${COURSE} has ${total} students — you and ${plural(others.length, 'classmate', 'classmates')}:\n\n${others.map(line).join('\n')}`, count: others.length };
}
