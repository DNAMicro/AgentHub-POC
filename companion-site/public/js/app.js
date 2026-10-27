// The companion site: routing (#/intro, #/step/3/a), navigation, progress, keyboard and presentation
// mode, and the page templates. Content lives in content.js; the diagram in diagram.js; walkthroughs in
// player.js. Text from content is set with textContent (inline <code>/<em> only through `rich`).
import { ARCH, PAGES, STEPS } from './content.js';
import { NODES, EDGES, VIEW, renderDiagram } from './diagram.js';
import { createPlayer } from './player.js';

const $ = (s, r = document) => r.querySelector(s);
const main = $('#page');
let current = null;
let cleanup = [];
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- diffs between architecture snapshots ---------------------------------------------------------
// A snapshot: { nodes: {id: {title?, sub?}}, edges: {id: {label?}}, modified?: [ids] }. Statuses are
// computed: in b only → added; in a only → removed (drawn as a ghost); in both → modified when listed
// (behaviour changed) or when its text changed; otherwise unchanged.
export function diff(a, b, { explicit = true } = {}) {
  const out = { nodes: {}, edges: {} };
  for (const kind of ['nodes', 'edges']) {
    const A = a?.[kind] ?? {};
    const B = b[kind];
    for (const [id, v] of Object.entries(B)) {
      const before = A[id];
      const changed = before && JSON.stringify(before) !== JSON.stringify(v);
      out[kind][id] = { ...v, status: !before ? 'added' : (explicit && b.modified?.includes(id)) || changed ? 'modified' : 'unchanged' };
    }
    for (const [id, v] of Object.entries(A)) if (!(id in B)) out[kind][id] = { ...v, status: 'removed' };
  }
  return out;
}
const plain = (s) => ({ nodes: Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => [k, { ...v, status: 'unchanged' }])), edges: Object.fromEntries(Object.entries(s.edges).map(([k, v]) => [k, { ...v, status: 'unchanged' }])) });

// ---- small DOM helpers ------------------------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return n;
}
// `code` spans and *emphasis* in content strings, built as DOM nodes (never innerHTML).
function rich(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(`[^`]+`|\*[^*]+\*)/)) {
    if (!part) continue;
    if (part.startsWith('`')) frag.append(h('code', { text: part.slice(1, -1) }));
    else if (part.startsWith('*')) frag.append(h('em', { text: part.slice(1, -1) }));
    else frag.append(part);
  }
  return frag;
}
const p = (text, cls) => h('p', { class: cls }, rich(text));

// ---- architecture comparison (Page A) -----------------------------------------------------------------
let svgId = 0;
function legend() {
  const items = [['added', '+ NEW', 'added in this step'], ['modified', '~ CHANGED', 'changed in this step'], ['removed', '✕ REMOVED', 'removed in this step'], ['unchanged', '', 'unchanged']];
  const kinds = [['a2a', 'A2A protocol (JSON-RPC)'], ['http', 'HTTP (browser ↔ UI server)'], ['sse', 'Server-sent events (watch-only telemetry)'], ['https', 'HTTPS model call'], ['file', 'File on disk']];
  return h('div', { class: 'legend' },
    h('ul', { class: 'legend-status', 'aria-label': 'Change markers' }, ...items.map(([st, tag, label]) => h('li', { class: `lg st-${st}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, tag || '—'), label))),
    h('ul', { class: 'legend-kinds', 'aria-label': 'Connection types' }, ...kinds.map(([k, label]) => h('li', {}, h('svg', { class: `lg-line k-${k}`, viewBox: '0 0 40 10', 'aria-hidden': 'true' }), label))));
}
function compare(step, { extra } = {}) {
  const prev = step > 1 ? ARCH[step - 1] : null;
  const cur = ARCH[step];
  // One height for every view of this comparison, so switching views never makes the page jump.
  const height = extra === 'start-final' || prev?.nodes.storage || cur.nodes.storage ? VIEW.h : VIEW.short;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = `cmp-${++svgId}`;
  svg.setAttribute('role', 'img');
  const frame = h('div', { class: 'diagram-frame' }, svg);
  const caption = h('p', { class: 'compare-caption', 'aria-live': 'polite' });
  const views = {
    prev: () => {
      if (!prev) { renderDiagram(svg, { nodes: {}, edges: {} }, { height }); caption.textContent = 'Before Step 1: nothing yet — an empty repository.'; return 'Before Step 1: empty.'; }
      renderDiagram(svg, plain(prev), { height });
      caption.textContent = `Step ${step - 1}, as it was before this step.`;
      return `Architecture after step ${step - 1}`;
    },
    cur: (animate = false) => {
      renderDiagram(svg, diff(prev, cur), { animate: animate && !reducedMotion(), height });
      caption.textContent = `Step ${step}: + NEW, ~ CHANGED and ✕ REMOVED mark what this step did.`;
      return `Architecture after step ${step}, with changes marked`;
    },
  };
  if (extra === 'start-final') {
    views.start = () => { renderDiagram(svg, plain(ARCH[1]), { height }); caption.textContent = 'Where we started: Step 1.'; return 'Architecture at step 1'; };
    views.final = (animate = false) => { renderDiagram(svg, diff(ARCH[1], ARCH[9], { explicit: false }), { animate: animate && !reducedMotion(), height }); caption.textContent = 'Step 1 → Step 9: everything marked + NEW was added along the way; ~ CHANGED pieces kept their place but grew new jobs.'; return 'Architecture at step 9 compared with step 1'; };
  }
  const buttons = [];
  const set = (name, ...args) => {
    svg.setAttribute('aria-label', views[name](...args));
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  };
  const seg = (label, name) => { const b = h('button', { type: 'button', 'data-view': name, onclick: () => set(name) }, label); buttons.push(b); return b; };
  let t1 = null;
  const animateChange = (from, to) => () => {
    clearTimeout(t1);
    set(from);
    t1 = setTimeout(() => set(to, true), reducedMotion() ? 0 : 900);
  };
  const controls = h('div', { class: 'compare-controls', role: 'group', 'aria-label': 'Compare architecture' },
    seg(step > 1 ? `Previous: Step ${step - 1}` : 'Before Step 1', 'prev'), seg(`This step: Step ${step}`, 'cur'),
    h('button', { type: 'button', class: 'play-change', onclick: animateChange('prev', 'cur') }, h('span', { 'aria-hidden': 'true' }, '▶ '), 'Animate the change'));
  if (extra === 'start-final') controls.append(seg('Step 1', 'start'), h('button', { type: 'button', class: 'play-change', onclick: animateChange('start', 'final') }, h('span', { 'aria-hidden': 'true' }, '▶ '), 'Step 1 → Step 9'));
  cleanup.push(() => clearTimeout(t1));
  set('cur');
  return h('figure', { class: 'compare' }, controls, frame, caption, legend());
}

// ---- screenshots (real, from the running app; click to enlarge) -----------------------------------------
function shot(s) {
  if (!s) return null;
  const img = h('img', { src: s.src, alt: s.alt, loading: 'lazy' });
  const open = () => {
    const dlg = h('dialog', { class: 'lightbox', 'aria-label': s.alt },
      h('img', { src: s.src, alt: s.alt }), h('p', {}, rich(s.caption)),
      h('button', { type: 'button', class: 'close', onclick: () => dlg.close() }, 'Close'));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
  };
  return h('figure', { class: `shot${s.kind === 'reconstruction' ? ' recon' : ''}` },
    h('button', { type: 'button', class: 'shot-open', onclick: open, 'aria-label': `Enlarge: ${s.alt}` }, img),
    h('figcaption', {}, h('span', { class: 'shot-kind' }, s.kind === 'reconstruction' ? 'Illustrative reconstruction' : 'Actual screenshot'), ' ', rich(s.caption), h('span', { class: 'shot-hint' }, ' (click to enlarge)')));
}

function sources(list) {
  return h('details', { class: 'sources' }, h('summary', {}, 'Sources for this page'),
    h('ul', {}, ...list.map((s) => h('li', {}, rich(s)))));
}
function techTable(tech, noTech) {
  if (!tech?.length) return h('div', { class: 'no-tech' }, h('h3', { text: 'No new technology' }), p(noTech));
  return h('div', { class: 'tech' }, h('h3', { text: 'Technologies introduced' }),
    h('ul', { class: 'tech-list' }, ...tech.map((t) => h('li', {},
      h('span', { class: `kind kind-${t.kind}` }, t.kind), ' ', h('strong', {}, rich(t.name)), h('span', { class: 'role' }, ' — ', rich(t.role)), t.why ? h('span', { class: 'why' }, rich(` Why: ${t.why}`)) : null))));
}

// ---- page templates --------------------------------------------------------------------------------
function introPage(pg) {
  const roadmap = h('ol', { class: 'roadmap' }, ...STEPS.map((s) => h('li', {}, h('a', { href: `#/step/${s.n}/a` }, h('span', { class: 'num' }, String(s.n)), h('span', { class: 'rm-title', text: s.short }), h('span', { class: 'rm-add', text: s.adds })))));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = `final-${++svgId}`;
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Final architecture after Step 9: Browser, Student Agent, University Hub, Tutor, Library and Marketing 101 Professor agents, the Anthropic API and data files.');
  renderDiagram(svg, plain(ARCH[9]));
  return h('article', { class: 'page intro' },
    h('header', { class: 'page-head' }, h('div', { class: 'head-text' }, h('p', { class: 'eyebrow', text: pg.eyebrow }), h('h1', { tabindex: '-1', text: pg.title }), p(pg.lead, 'lead')), sources(pg.sources)),
    h('div', { class: 'intro-grid' },
      h('section', { class: 'intro-text' },
        ...pg.blocks.map((b) => h('div', { class: 'block' }, h('h2', { text: b.h }), b.list ? h('ul', {}, ...b.list.map((x) => h('li', {}, rich(x)))) : p(b.text)))),
      h('section', { class: 'intro-visual' }, h('h2', { text: 'Where Step 9 ends up' }), h('div', { class: 'diagram-frame' }, svg), h('h2', { text: 'The nine steps' }), roadmap)));
}

function pageA(pg) {
  const s = STEPS[pg.step - 1];
  return h('article', { class: 'page page-a' },
    h('header', { class: 'page-head' }, h('div', { class: 'head-text' }, h('p', { class: 'eyebrow', text: `Step ${s.n} of 9 · What changed and why` }), h('h1', { tabindex: '-1', text: pg.title })), sources(pg.sources)),
    h('div', { class: 'a-grid' },
      h('div', { class: 'a-visual' }, compare(pg.step, { extra: pg.step === 9 ? 'start-final' : undefined }), shot(pg.shot)),
      h('section', { class: 'a-text' },
        h('div', { class: 'block goal' }, h('h2', { text: 'Before this step' }), p(pg.before, 'before'), h('h2', { text: 'Goal' }), p(pg.goal)),
        h('div', { class: 'block cap' }, h('h2', { text: 'New capability' }), p(pg.capability)),
        techTable(pg.tech, pg.noTech))));
}

function pageB(pg) {
  const s = STEPS[pg.step - 1];
  const playerRoot = h('section', { class: 'walk', tabindex: '-1', 'aria-label': `Walkthrough: ${pg.walk.title}` });
  const player = createPlayer(playerRoot, { state: ARCH[pg.step], events: pg.walk.events, title: pg.walk.title });
  cleanup.push(() => player.destroy());
  return h('article', { class: 'page page-b' },
    h('header', { class: 'page-head' }, h('div', { class: 'head-text' }, h('p', { class: 'eyebrow', text: `Step ${s.n} of 9 · How to build it and how it works` }), h('h1', { tabindex: '-1', text: pg.title })), sources(pg.sources)),
    h('div', { class: 'b-grid' },
      playerRoot,
      h('section', { class: 'b-text' },
        h('div', { class: 'block build' }, h('h2', { text: 'Build it, in this order' }), h('ol', {}, ...pg.build.map((x) => h('li', {}, rich(x))))),
        pg.code ? h('figure', { class: 'code' }, h('figcaption', {}, rich(pg.code.caption)), h('pre', {}, h('code', { text: pg.code.text }))) : null,
        h('div', { class: 'block test' }, h('h2', { text: 'Test it' }), h('pre', { class: 'cmd' }, h('code', { text: pg.test.cmd })), p(pg.test.expect)),
        pg.recap ? h('div', { class: 'block recap' }, h('h2', { text: 'Recap: nine steps' }), h('ol', { class: 'recap-list' }, ...pg.recap.map((x) => h('li', {}, rich(x))))) : null,
        h('div', { class: 'pair' },
          h('div', { class: 'block pitfall' }, h('h2', { text: 'Pitfall' }), p(pg.pitfall)),
          h('div', { class: 'block next' }, h('h2', { text: pg.step < 9 ? 'Takeaway → next step' : 'Takeaway' }), p(pg.takeaway))))));
}

// ---- navigation ------------------------------------------------------------------------------------
const routeOf = (pg) => (pg.id === 'intro' ? '#/intro' : `#/step/${pg.step}/${pg.type.toLowerCase()}`);
function pageFromHash() {
  const m = location.hash.match(/^#\/step\/([1-9])\/([ab])$/i);
  if (m) return PAGES.find((x) => x.step === Number(m[1]) && x.type.toLowerCase() === m[2].toLowerCase()) ?? null;
  return location.hash === '' || location.hash === '#/' || location.hash === '#/intro' ? PAGES[0] : null;
}
function navTo(i) { if (PAGES[i]) location.hash = routeOf(PAGES[i]); }

function renderNav() {
  const nav = $('#steps-nav');
  nav.replaceChildren(h('ol', {}, h('li', {}, h('a', { href: '#/intro', class: 'nav-intro', 'data-id': 'intro' }, 'Intro')),
    ...STEPS.map((s) => h('li', { class: 'nav-step' },
      h('a', { href: `#/step/${s.n}/a`, 'data-id': `${s.n}a`, title: `Step ${s.n}: ${s.short} — what changed and why` }, h('span', { class: 'n', text: String(s.n) }), h('span', { class: 'nav-short', text: s.short })),
      PAGES.some((x) => x.step === s.n && x.type === 'B') ? h('a', { href: `#/step/${s.n}/b`, 'data-id': `${s.n}b`, class: 'nav-b', title: `Step ${s.n}: how to build it and how it works`, 'aria-label': `Step ${s.n}, page B: how it works` }, 'B') : null))));
}
function render() {
  const pg = pageFromHash();
  if (!pg) { location.replace('#/intro'); return; }
  for (const f of cleanup) f();
  cleanup = [];
  current = PAGES.indexOf(pg);
  const page = pg.type === 'intro' ? introPage(pg) : pg.type === 'A' ? pageA(pg) : pageB(pg);
  main.replaceChildren(page);
  document.title = `${pg.type === 'intro' ? 'Introduction' : `Step ${pg.step}${pg.type}`} · AgentHub-POC, step by step`;
  for (const a of document.querySelectorAll('#steps-nav a')) a.toggleAttribute('aria-current', a.dataset.id === pg.id);
  $('#progress-bar').style.width = `${((current + 1) / PAGES.length) * 100}%`;
  $('#progress-text').textContent = `Page ${current + 1} of ${PAGES.length}`;
  $('#progress').setAttribute('aria-valuenow', String(current + 1));
  $('#prev').disabled = current === 0;
  $('#next').disabled = current === PAGES.length - 1;
  $('#prev-label').textContent = current > 0 ? labelOf(PAGES[current - 1]) : '';
  $('#next-label').textContent = current < PAGES.length - 1 ? labelOf(PAGES[current + 1]) : '';
  window.scrollTo(0, 0);
  main.scrollTop = 0;
  $('h1', main)?.focus({ preventScroll: true });
}
const labelOf = (pg) => (pg.type === 'intro' ? 'Introduction' : `Step ${pg.step}${pg.type === 'A' ? '' : ' · how it works'}`);

$('#prev').addEventListener('click', () => navTo(current - 1));
$('#next').addEventListener('click', () => navTo(current + 1));
$('#present').addEventListener('click', togglePresent);

// ---- theme: Auto (follow the system) → Light → Dark, remembered in this browser -------------------------
const THEMES = ['auto', 'light', 'dark'];
const THEME_UI = { auto: ['◐', 'Auto', 'follows your system setting'], light: ['☀', 'Light', 'light'], dark: ['☾', 'Dark', 'dark'] };
const savedTheme = () => { try { const t = localStorage.getItem('companion-theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; } };
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const [icon, label, says] = THEME_UI[t];
  $('#theme .theme-icon').textContent = icon;
  $('#theme-label').textContent = label;
  $('#theme').setAttribute('aria-label', `Theme: ${label} (${says}). Press to change.`);
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(themeNow) + 1) % THEMES.length]; // in memory: works even if storage is blocked
  try { if (next === 'auto') localStorage.removeItem('companion-theme'); else localStorage.setItem('companion-theme', next); } catch { /* storage blocked: this page only */ }
  applyTheme(next);
  themeNow = next;
}
let themeNow = savedTheme();
applyTheme(themeNow);
$('#theme').addEventListener('click', cycleTheme);
function togglePresent() {
  const on = !document.body.classList.contains('presenting');
  document.body.classList.toggle('presenting', on);
  $('#present').setAttribute('aria-pressed', String(on));
  if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('presenting')) { document.body.classList.remove('presenting'); $('#present').setAttribute('aria-pressed', 'false'); } });
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); navTo(current + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); navTo(current - 1); }
  else if (e.key === 'Home') { e.preventDefault(); navTo(0); }
  else if (e.key === 'End') { e.preventDefault(); navTo(PAGES.length - 1); }
  else if (e.key === 'f' || e.key === 'F') togglePresent();
  else if (e.key === 't' || e.key === 'T') cycleTheme();
  else if (e.key === 'Escape' && document.body.classList.contains('presenting')) togglePresent();
});
// Swipe left/right on touch screens (not inside a diagram, which may scroll sideways on phones).
let touch = null;
main.addEventListener('touchstart', (e) => { touch = e.target.closest('.diagram-frame, pre') ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
main.addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy)) navTo(current + (dx < 0 ? 1 : -1));
  touch = null;
});

$('#progress').setAttribute('aria-valuemax', String(PAGES.length));
renderNav();
window.addEventListener('hashchange', render);
render();

// Exposed for the check script (structure only).
window.__site = { PAGES, STEPS, ARCH, NODES, EDGES };
