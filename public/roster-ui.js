// Part 17: the "Class roster" card in the Faculty view (approved mockup
// docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html, screen 1). The chat entry carries only a reference
// ({ rosterId, count, at }); the rows are fetched from GET /api/professor/roster when the card is drawn, kept in this
// element only, and never written to a stream, a log or the student's page. Everything is drawn with textContent.
export const ROSTER_GONE = 'Ask again to see your roster.';
// Review #5: only the fields the faculty member's tasks need (no email, no pronouns; IDs arrive masked to the last 4 digits).
export const FOOTER = 'Fictional demo records. Only what you need is shown; IDs are masked. Every roster lookup is logged. Student records are private (FERPA).';
export const ROSTER_COLUMNS = ['', 'Name', 'ID', 'Academic Level', 'Program and Plan', 'Units'];

export function createRosterUi({ el, api, bubble, isShowing }) {
  const cards = new Map(); // chat entry id -> { li, body }  (kept in place across redraws, like the quiz and HR cards)

  const dash = (v) => (v === undefined || v === null ? '' : String(v));
  function head(cls) {
    const meet = el('table', { className: 'cr-meet' },
      el('tr', {}, ...['Days and Times', 'Room', 'Instructor', 'Dates'].map((t) => el('th', { textContent: t }))),
      el('tr', {}, ...[cls.daysAndTimes, cls.room, cls.instructor, cls.dates].map((t) => el('td', { textContent: dash(t) }))));
    return el('div', { className: 'cr-head' },
      el('div', { className: 'cr-title', textContent: 'Class Roster' }),
      el('div', { className: 'cr-term', textContent: [cls.term, cls.session, cls.institution, cls.career].filter(Boolean).join(' · ') }),
      el('div', { className: 'cr-class' }, el('b', { textContent: `${dash(cls.code)} (${dash(cls.classNumber)})` }), ` ${dash(cls.title)}`),
      meet,
      el('div', { className: 'cr-counts' },
        ...[['Enrollment Status', cls.enrollmentStatus], ['Enrollment Capacity', cls.capacity], ['Enrolled', cls.enrolled]].map(([k, v]) => el('span', {}, el('b', { textContent: k }), dash(v)))));
  }
  function grid(rows) {
    const thead = el('thead', {}, el('tr', {}, ...ROSTER_COLUMNS.map((c) => el('th', { textContent: c, className: c === 'Units' ? 'r' : '' }))));
    // Only a masked ID is ever drawn (“•••••1234”); anything else in the field is not shown.
    const masked = (v) => (typeof v === 'string' && /^•{5}\d{4}$/.test(v) ? v : '');
    const tbody = el('tbody', {}, ...rows.map((r, i) => el('tr', { dataset: { student: r.studentId } },
      el('td', { className: 'n', textContent: String(i + 1) }),
      el('td', {}, el('span', { className: 'lnk', textContent: dash(r.name) })),
      el('td', { className: 'mono', textContent: masked(r.maskedId) }),
      el('td', { textContent: dash(r.level) }),
      el('td', {}, `${dash(r.program)} -`, el('br'), `${dash(r.plan)}`, el('span', { className: 'deg', textContent: dash(r.degree) })),
      el('td', { className: 'r', textContent: dash(r.units) }))));
    return el('div', { className: 'roster-scroll' }, el('table', { className: 'roster' }, thead, tbody));
  }
  function fill(c, entry, view) {
    const roster = view.roster;
    if (view.rosterId !== entry.roster.rosterId || !roster?.rows?.length || !roster.class) return gone(c);
    const table = grid(roster.rows); // the .roster-scroll box around the table
    c.body.replaceChildren(head(roster.class), el('div', { className: 'cr-grid-title', textContent: 'Enrolled Students' }), table, el('p', { className: 'roster-foot', textContent: FOOTER }));
    c.li.dataset.state = 'ready';
    // A details question (“what's Mariana Aguilar's email?”): that student's row is marked and scrolled into view inside the
    // card's own scroll box (the chat itself is not scrolled). Round 2 (R4): a level / major question (“who are my seniors?”)
    // marks every matching row; which rows comes only with the rows themselves (view.highlight), never in the chat entry.
    const hl = Array.isArray(view.highlight) && view.highlight.length ? view.highlight : entry.roster.highlight ? [entry.roster.highlight] : [];
    const marked = [...table.querySelectorAll('tbody tr')].filter((tr) => hl.includes(tr.dataset.student));
    for (const tr of marked) { tr.classList.add('cr-hi'); tr.setAttribute('aria-current', 'true'); }
    const row = marked[0] ?? null;
    if (row) {
      c.li.dataset.highlight = hl.length === 1 ? hl[0] : String(marked.length);
      const place = () => {
        const head = table.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        table.scrollTop += row.getBoundingClientRect().top - table.getBoundingClientRect().top - head - 8;
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(place); else place();
    }
  }
  function gone(c) {
    c.body.replaceChildren(el('p', { className: 'msg-text', textContent: ROSTER_GONE }));
    c.li.dataset.state = 'gone';
  }
  const WAIT = 'Loading the roster…';
  // Rows are fetched only while the Faculty view is on screen, and leave the page when another tab shows (the student's page
  // also holds the hidden Faculty view and must never fetch or keep them).
  function unload(c) {
    if (!c.loaded && !c.loading) return;
    c.loaded = false; c.loading = false; c.token += 1;
    c.body.replaceChildren(el('p', { className: 'msg-text', textContent: WAIT }));
    c.li.dataset.state = 'loading';
  }
  async function load(c, entry) {
    c.loading = true;
    const token = c.token;
    const r = await api('/api/professor/roster');
    if (token !== c.token) return; // the view was left (or the card dropped) while the rows were on their way
    c.loading = false; c.loaded = true;
    if (!r || r.status === 502) c.loaded = false; // a failed load tries again on the next render
    if (r?.ok && r.json) fill(c, entry, r.json);
    else if (r && r.status !== 404 && r.status !== 502) c.body.replaceChildren(el('p', { className: 'msg-text', textContent: ROSTER_GONE }));
    else if (r?.status === 404) gone(c);
    else c.body.replaceChildren(el('p', { className: 'msg-text', textContent: 'The roster can’t be loaded right now. Ask again in a moment.' }));
    if (c.li.dataset.state === 'loading') c.li.dataset.state = 'gone';
  }

  return {
    // The card for one chat entry: the same element every redraw.
    entry(m) {
      let c = cards.get(m.id);
      if (!c) {
        const li = bubble({ dir: 'received', speaker: 'chrs', label: 'Class roster', at: m.at, text: '' });
        li.classList.add('roster-card');
        li.dataset.rosterId = m.roster.rosterId;
        li.dataset.state = 'loading';
        li.querySelector('.msg-text')?.remove();
        const body = el('div', { className: 'roster-body' }, el('p', { className: 'msg-text', textContent: WAIT }));
        li.append(body);
        c = { li, body, loaded: false, loading: false, token: 0 };
        cards.set(m.id, c);
      }
      if (!isShowing()) unload(c);
      else if (!c.loaded && !c.loading) load(c, m);
      return c.li;
    },
    kept: () => [...cards.values()].map((c) => c.li),
    sync(chat) { const ids = new Set(chat.map((m) => m.id)); for (const [k, c] of cards) if (!ids.has(k)) { c.token += 1; cards.delete(k); } },
  };
}
