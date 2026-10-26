// Part 7: the live topology — a switchboard of the four agents. Student on the left, the university
// Hub in the centre, the Tutor and Library behind it. Each agent has its own small model box: the agent
// picks its own mode and model and calls the provider from its own process with its own key, so these
// are separate connections, not one shared service. Those lines are HTTPS calls, drawn dashed, not A2A.
// There is no Student↔specialist line.
//
// What moves is evidence, not decoration: a pulse is drawn only for an event the UI server labelled
// with an edge, a direction, a category and a phase (src/topology.js). Replayed history fills the
// event list and node states without animating. Live events wait briefly in a buffer and play in the
// order the agents timestamped them (their feeds reach us on separate connections). Only IDs and
// short fixed labels are shown here — never message text, emails, notes or form values.
const SVG = 'http://www.w3.org/2000/svg';

const NODES = {
  student: { x: 130, y: 260, r: 60, name: 'Student agent', role: 'You' },
  hub: { x: 450, y: 260, r: 76, name: 'University Hub', role: 'Front door and router' },
  tutor: { x: 770, y: 118, r: 60, name: 'Tutor Agent', role: 'Tutoring specialist' },
  library: { x: 770, y: 402, r: 60, name: 'Library Agent', role: 'Library specialist' },
  // One model box per agent (owner). Server labels say 'model'; the browser draws it at the caller's box.
  'llm-student': { x: 130, y: 62, w: 184, h: 74, owner: 'student', name: 'Student’s model' },
  'llm-hub': { x: 450, y: 62, w: 184, h: 74, owner: 'hub', name: 'Hub router’s model' },
  'llm-tutor': { x: 985, y: 118, w: 184, h: 74, owner: 'tutor', name: 'Tutor’s model' },
  'llm-library': { x: 985, y: 402, w: 184, h: 74, owner: 'library', name: 'Library’s model' },
};
const EDGES = {
  'student-hub': ['student', 'hub'], 'hub-tutor': ['hub', 'tutor'], 'hub-library': ['hub', 'library'],
  'student-model': ['student', 'llm-student'], 'hub-model': ['hub', 'llm-hub'], 'tutor-model': ['tutor', 'llm-tutor'], 'library-model': ['library', 'llm-library'],
};
const MODEL_USES = { student: 'clarifying unclear questions and choosing which university capability a non-obvious one needs', hub: 'deciding where each question goes', tutor: 'answers, scope checks and form review', library: 'answers from saved content and form review' };
const EDGE_KIND = (id) => (id.endsWith('-model') ? 'model' : 'a2a');
const LANE = 9; // each connection has one lane per direction
const STATUS = {
  ready: ['✓', 'Ready', 'ok'],
  stale: ['⚠', 'Heartbeat late', 'warn'],
  unreachable: ['✕', 'Unreachable', 'bad'],
  disconnected: ['○', 'Not registered', 'muted'],
  disabled: ['⏸', 'Disabled', 'muted'],
  invalid_card: ['✕', 'Card refused', 'bad'],
  unknown: ['?', 'Unknown', 'muted'],
};
const PHASE_TEXT = { attempted: 'sent', accepted: 'received', processing: 'working', completed: 'result returned', failed: 'failed', unknown: 'outcome unknown' };
const CATEGORY_TEXT = { request: 'question/answer', form: 'form', registration: 'registration', heartbeat: 'heartbeat', card: 'Agent Card', routing: 'routing', model: 'model call' };
const BUFFER_MS = 350;
const STAGGER_MS = 170;
const MAX_LIST = 300;

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
};
const html = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

// Distance from a node's centre to its border along (ux, uy): circles for agents, boxes for models.
const reach = (n, ux, uy) => (n.w ? Math.min(n.w / 2 / (Math.abs(ux) || 1e-9), n.h / 2 / (Math.abs(uy) || 1e-9)) : n.r);

// Geometry: a lane is the a→b segment between the two shapes, shifted sideways by ±LANE.
function lane(edge, from) {
  const [a, b] = EDGES[edge];
  const forward = from === a;
  const p = NODES[forward ? a : b];
  const q = NODES[forward ? b : a];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular offset measured on the a→b direction, so the two lanes sit on opposite sides.
  const side = forward ? 1 : -1;
  const cx = forward ? ux : -ux;
  const cy = forward ? uy : -uy;
  const ox = -cy * LANE * side;
  const oy = cx * LANE * side;
  return {
    x1: p.x + ux * (reach(p, ux, uy) + 6) + ox, y1: p.y + uy * (reach(p, ux, uy) + 6) + oy,
    x2: q.x - ux * (reach(q, ux, uy) + 10) + ox, y2: q.y - uy * (reach(q, ux, uy) + 10) + oy,
  };
}

function shape(category, phase, color) {
  const fill = phase === 'attempted' ? 'none' : phase === 'failed' ? 'var(--bad)' : phase === 'unknown' ? 'var(--warn)' : color;
  const stroke = phase === 'failed' ? 'var(--bad)' : phase === 'unknown' ? 'var(--warn)' : color;
  const common = { fill, stroke, 'stroke-width': 2.4, ...(phase === 'unknown' ? { 'stroke-dasharray': '3 2' } : {}), ...(phase === 'completed' ? { filter: 'url(#glow)' } : {}) };
  switch (category) {
    case 'form': return el('rect', { x: -6.5, y: -6.5, width: 13, height: 13, rx: 2, ...common });
    case 'registration': return el('path', { d: 'M0,-8 L8,0 L0,8 L-8,0 Z', ...common });
    case 'card': return el('path', { d: 'M0,-8 L8,6 L-8,6 Z', ...common });
    case 'heartbeat': return el('circle', { r: 3.6, ...common, 'stroke-width': 1.6 });
    case 'model': return el('path', { d: 'M0,-8 L2.4,-2.4 L8,0 L2.4,2.4 L0,8 L-2.4,2.4 L-8,0 L-2.4,-2.4 Z', ...common });
    default: return el('circle', { r: 7, ...common });
  }
}

export function createTopology({ svg, detail, list, count, traceSelect, truncatedNote, clockEl, controls, onActivity = () => {}, agentColor }) {
  const edgesLayer = svg.querySelector('#topo-edges');
  const pulseLayer = svg.querySelector('#topo-pulses');
  const nodesLayer = svg.querySelector('#topo-nodes');
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = {
    live: false, hubFeed: false, snapshot: null, student: { busy: false, cardValid: null },
    specialists: {}, // agentId → snapshot entry (status, heartbeat, skills…)
    active: { tutor: 0, library: 0 },
    // Each agent's own model: its reported mode, and the calls we saw it make.
    modes: { student: null, hub: null, tutor: null, library: null }, // { mode, model, keyConfigured }
    provider: Object.fromEntries(['student', 'hub', 'tutor', 'library'].map((a) => [a, { inFlight: 0, calls: 0, failures: 0, last: null }])),
    traces: new Map(), // runId → { n, kind, at, destination, outcome, edges:Set, nodes:Set, events:[] }
    edgeEvents: Object.fromEntries(Object.keys(EDGES).map((id) => [id, []])),
    selected: null, // { kind: 'node'|'edge'|'trace', id }
    traceFilter: '',
    queue: [],
    listed: 0,
  };
  const reduced = () => controls.reduce.checked || reducedQuery.matches;
  if (reducedQuery.matches) controls.reduce.checked = true;
  const color = (node) => (NODES[node]?.owner ? agentColor('model') : agentColor(node));

  // ---- static drawing --------------------------------------------------------------------
  const edgeEls = {};
  for (const [id, [a, b]] of Object.entries(EDGES)) {
    const f = lane(id, a);
    const r = lane(id, b);
    const kind = EDGE_KIND(id);
    const g = el('g', { class: 'edge', 'data-edge': id, 'data-kind': kind, tabindex: '0', role: 'button', 'aria-label': `Connection ${NODES[a].name} ↔ ${NODES[b].name} (${kind === 'model' ? 'HTTPS model API calls' : 'A2A JSON-RPC'}). Open its event timeline.` });
    const laneF = el('line', { class: 'lane', 'data-dir': 'out', x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, 'marker-end': 'url(#arrow)' });
    const laneR = el('line', { class: 'lane', 'data-dir': 'back', x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, 'marker-end': 'url(#arrow)' });
    const hit = el('line', { class: 'hit', x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y });
    const mx = (NODES[a].x + NODES[b].x) / 2;
    const my = (NODES[a].y + NODES[b].y) / 2;
    const vertical = Math.abs(NODES[a].x - NODES[b].x) < Math.abs(NODES[a].y - NODES[b].y);
    const label = el('text', { class: 'edge-label', x: vertical ? mx + 18 : mx, y: vertical ? my : my - 18, 'text-anchor': vertical ? 'start' : 'middle' }, kind === 'model' ? 'HTTPS' : 'A2A');
    g.append(hit, laneF, laneR, label);
    edgesLayer.append(g);
    edgeEls[id] = { g, out: laneF, back: laneR };
    g.addEventListener('click', () => select({ kind: 'edge', id }));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'edge', id }); } });
  }

  const nodeEls = {};
  for (const [id, n] of Object.entries(NODES)) {
    if (n.owner) {
      // A model box: name, model ID, and a status line (no pill, so lanes stay clear).
      const g = el('g', { class: 'node service', 'data-node': id, 'data-owner': n.owner, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', style: `--node: ${color(id)}` });
      const box = (pad, cls) => el('rect', { class: cls, x: -n.w / 2 - pad, y: -n.h / 2 - pad, width: n.w + 2 * pad, height: n.h + 2 * pad, rx: 12 + pad });
      const name = el('text', { class: 'node-name', y: -12, 'text-anchor': 'middle' }, n.name);
      const extra = el('text', { class: 'node-extra', y: 6, 'text-anchor': 'middle' }, '');
      const statusG = el('g', { class: 'node-status' });
      const statusText = el('text', { class: 'status-text', y: 25, 'text-anchor': 'middle' }, '');
      statusG.append(statusText);
      const caption = el('text', { class: 'node-caption', y: -(n.h / 2 + 10), 'text-anchor': 'middle' }, '');
      g.append(box(7, 'halo'), box(3, 'orbit'), box(0, 'disc'), name, extra, statusG, caption);
      nodesLayer.append(g);
      nodeEls[id] = { g, extra, statusText, statusG, caption, captionTimer: null };
      g.addEventListener('click', () => select({ kind: 'node', id }));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'node', id }); } });
      continue;
    }
    const g = el('g', { class: 'node', 'data-node': id, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', style: `--node: ${color(id)}` });
    const halo = el('circle', { class: 'halo', r: n.r + 10 });
    const orbit = el('circle', { class: 'orbit', r: n.r + 5 });
    const disc = el('circle', { class: 'disc', r: n.r });
    const name = el('text', { class: 'node-name', y: id === 'hub' ? -14 : -6, 'text-anchor': 'middle' }, n.name);
    const sub = el('text', { class: 'node-sub', y: id === 'hub' ? 6 : 13, 'text-anchor': 'middle' }, n.role);
    const extra = el('text', { class: 'node-extra', y: id === 'hub' ? 26 : 31, 'text-anchor': 'middle' }, '');
    const statusG = el('g', { class: 'node-status', transform: `translate(0 ${n.r + 26})` });
    const statusBg = el('rect', { class: 'status-pill', x: -62, y: -13, width: 124, height: 24, rx: 12 });
    const statusText = el('text', { class: 'status-text', y: 4, 'text-anchor': 'middle' }, '');
    statusG.append(statusBg, statusText);
    const caption = el('text', { class: 'node-caption', y: -(n.r + 18), 'text-anchor': 'middle' }, '');
    g.append(halo, orbit, disc, name, sub, extra, statusG, caption);
    nodesLayer.append(g);
    nodeEls[id] = { g, extra, statusText, statusG, caption, captionTimer: null };
    g.addEventListener('click', () => select({ kind: 'node', id }));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'node', id }); } });
  }

  // ---- node states ------------------------------------------------------------------------
  // An agent's own model box, from the mode the agent itself reported and the calls it really made.
  function modelState(owner) {
    const m = state.modes[owner];
    const p = state.provider[owner];
    if (!state.live || !m) return { text: '? Unknown', tone: 'muted', model: m?.model ?? '', status: 'unknown' };
    if (m.mode === 'off') return { text: '○ Off', tone: 'muted', model: 'no model in use', status: 'disabled' };
    if (m.mode !== 'live') return { text: '○ In-process, no network', tone: 'muted', model: m.model ?? `${m.mode} mode`, status: 'disabled' };
    const model = m.model ?? 'model not reported';
    if (m.keyConfigured === false) return { text: '⚠ No API key set', tone: 'warn', model, status: 'stale' };
    if (p.inFlight) return { text: `↻ Call in flight${p.inFlight > 1 ? ` (${p.inFlight})` : ''}`, tone: 'busy', model, status: 'ready' };
    if (!p.last) return { text: '○ No calls yet', tone: 'muted', model, status: 'ready' };
    if (p.last.ok) return { text: '✓ Last call answered', tone: 'ok', model, status: 'ready' };
    return p.last.code === 'timeout' ? { text: '? Last call timed out', tone: 'warn', model, status: 'stale' } : { text: '✕ Last call failed', tone: 'bad', model, status: 'unreachable' };
  }
  function nodeStatus(id) {
    if (!state.live) return 'unknown';
    if (NODES[id].owner) return modelState(NODES[id].owner).status;
    if (id === 'student') return 'ready';
    if (id === 'hub') return state.hubFeed ? 'ready' : 'unreachable';
    if (!state.hubFeed) return 'unknown'; // we only learn specialist health through the Hub
    return state.specialists[id]?.status ?? 'unknown';
  }
  function renderNodes() {
    for (const id of Object.keys(NODES)) {
      if (NODES[id].owner) {
        const { owner } = NODES[id];
        const n = nodeEls[id];
        const ms = modelState(owner);
        n.statusText.textContent = ms.text;
        n.statusG.dataset.tone = ms.tone;
        n.g.dataset.status = ms.status;
        n.g.dataset.busy = String(ms.tone === 'busy');
        n.extra.textContent = ms.model;
        const edge = edgeEls[`${owner}-model`];
        if (edge) edge.g.dataset.unused = String(state.modes[owner]?.mode !== 'live');
        n.g.setAttribute('aria-label', `${NODES[id].name}: ${ms.model ? `${ms.model}, ` : ''}${ms.text.replace(/^\S+ /, '')}. Open details.`);
        continue;
      }
      const s = nodeStatus(id);
      const [icon, text, tone] = STATUS[s] ?? STATUS.unknown;
      const n = nodeEls[id];
      const busy = id === 'student' ? state.student.busy : id === 'hub' ? (state.active.tutor + state.active.library) > 0 : state.active[id] > 0;
      let label = `${icon} ${text}`;
      if (id === 'student' && state.live) label = busy ? '↻ Waiting for reply' : state.student.cardValid === false ? '⚠ University card not verified' : '✓ Online';
      if (id === 'hub' && state.hubFeed && busy) label = `↻ Relaying (${state.active.tutor + state.active.library})`;
      if ((id === 'tutor' || id === 'library') && busy && s === 'ready') label = `↻ Working (${state.active[id]})`;
      n.statusText.textContent = label;
      n.statusG.dataset.tone = busy && (s === 'ready' || id === 'student') ? 'busy' : id === 'student' && state.student.cardValid === false ? 'warn' : tone;
      n.g.dataset.status = s;
      n.g.dataset.busy = String(busy);
      const spec = state.specialists[id];
      if (id === 'hub') n.extra.textContent = state.snapshot?.hub?.router ? `router: ${state.snapshot.hub.router.mode}` : '';
      else if (spec) n.extra.textContent = spec.lastHeartbeatAt ? `♥ ${ago(spec.lastHeartbeatAt)}` : 'no heartbeat yet';
      else if (id === 'student') n.extra.textContent = 'student-alex';
      n.g.setAttribute('aria-label', `${NODES[id].name}: ${label.slice(2)}. Open details.`);
    }
    svg.classList.toggle('offline', !state.live);
    if (state.selected?.kind === 'node') renderDetail();
  }
  setInterval(() => {
    for (const id of ['tutor', 'library']) {
      const spec = state.specialists[id];
      if (spec?.lastHeartbeatAt) nodeEls[id].extra.textContent = `♥ ${ago(spec.lastHeartbeatAt)}`;
    }
    clockEl.textContent = state.live ? `live · ${new Date().toLocaleTimeString([], { hour12: false })}` : 'not live';
  }, 1000);

  function caption(node, text) {
    const n = nodeEls[node];
    n.caption.textContent = text;
    n.g.classList.add('flash');
    clearTimeout(n.captionTimer);
    n.captionTimer = setTimeout(() => {
      n.caption.textContent = '';
      n.g.classList.remove('flash');
    }, 1400);
  }

  // ---- pulses -----------------------------------------------------------------------------
  function pulse(ev) {
    const t = ev.topo;
    onActivity();
    if (!t.edge) return caption(t.node, t.label);
    const g = edgeEls[t.edge];
    const dirLane = t.from === EDGES[t.edge][0] ? g.out : g.back;
    dirLane.classList.add('lit');
    dirLane.style.setProperty('--lit', color(t.from));
    setTimeout(() => dirLane.classList.remove('lit'), 900);
    const L = lane(t.edge, t.from);
    const mark = el('g', { class: 'pulse', 'data-phase': t.phase, 'data-category': t.category });
    mark.append(shape(t.category, t.phase, color(t.from)));
    const stopAt = t.phase === 'failed' || t.phase === 'unknown' ? 0.55 : 1;
    const place = (k) => mark.setAttribute('transform', `translate(${L.x1 + (L.x2 - L.x1) * k} ${L.y1 + (L.y2 - L.y1) * k})`);
    pulseLayer.append(mark);
    const finish = () => {
      if (t.phase === 'failed' || t.phase === 'unknown') {
        mark.append(el('text', { class: 'pulse-mark', y: -12, 'text-anchor': 'middle' }, t.phase === 'failed' ? '✕' : '?'));
        setTimeout(() => mark.remove(), 2200);
      } else {
        if (t.phase === 'completed' || t.phase === 'accepted') caption(t.to, t.label);
        mark.remove();
      }
    };
    if (reduced()) {
      // No travel: show the mark at the lane's middle, with the lane lit, then remove it.
      place(stopAt === 1 ? 0.5 : stopAt);
      setTimeout(finish, 900);
      return;
    }
    const duration = t.category === 'heartbeat' ? 650 : 950;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - k) ** 3;
      place(eased * stopAt);
      if (k < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  }

  // Live events play in agent-timestamp order after a short buffer, staggered so order is visible.
  setInterval(() => {
    if (controls.pause.checked || !state.queue.length) return;
    const cutoff = performance.now() - BUFFER_MS;
    const ready = state.queue.filter((q) => q.arrived <= cutoff);
    if (!ready.length) return;
    state.queue = state.queue.filter((q) => q.arrived > cutoff);
    ready.sort((a, b) => (a.ev.at < b.ev.at ? -1 : a.ev.at > b.ev.at ? 1 : a.ev.seq - b.ev.seq));
    ready.forEach((q, i) => setTimeout(() => pulse(q.ev), i * STAGGER_MS));
  }, 100);
  controls.pause.addEventListener('change', () => { if (!controls.pause.checked) state.queue = state.queue.slice(-12); });

  // ---- traces, edges and the event list -----------------------------------------------------
  function trace(runId) {
    let tr = state.traces.get(runId);
    if (!tr) {
      tr = { n: state.traces.size + 1, kind: 'chat', at: null, destination: null, outcome: null, edges: new Set(), nodes: new Set(), events: [] };
      state.traces.set(runId, tr);
    }
    return tr;
  }
  const traceName = (runId) => {
    const tr = state.traces.get(runId);
    if (!tr) return runId.slice(0, 8);
    const what = tr.kind === 'form_action' ? `Form action${tr.action ? ` “${tr.action}”` : ''}` : 'Chat';
    return `${what} #${tr.n}${tr.destination ? ` → ${tr.destination}` : ''}${tr.outcome ? ` · ${tr.outcome}` : ''}`;
  };
  function renderTraceOptions() {
    const current = traceSelect.value;
    const options = [...state.traces.entries()].slice(-25).reverse().map(([runId]) => html('option', { value: runId, textContent: `${traceName(runId)} · ${runId.slice(0, 8)}` }));
    traceSelect.replaceChildren(html('option', { value: '', textContent: 'All traffic' }), ...options);
    traceSelect.value = state.traces.has(current) ? current : '';
  }
  traceSelect.addEventListener('change', () => (traceSelect.value ? select({ kind: 'trace', id: traceSelect.value }) : select(null)));

  const route = (t) => (t.edge ? `${NODES[t.from].name} → ${NODES[t.to].name}` : `inside ${NODES[t.node].name}`);
  function listItem(ev) {
    const t = ev.topo;
    const li = html('li', { dataset: { phase: t.phase, category: t.category, run: ev.runId ?? '' } },
      html('time', { dateTime: ev.at, textContent: clock(ev.at) }),
      html('span', { className: 'ev-route', textContent: route(t) }),
      html('span', { className: 'glyph', dataset: { shape: t.category, phase: t.phase }, style: `--c: ${color(t.from)}` }),
      html('span', { className: 'ev-label', textContent: t.label }),
      html('span', { className: 'ev-phase', textContent: `${CATEGORY_TEXT[t.category] ?? t.category}, ${PHASE_TEXT[t.phase] ?? t.phase}` }),
      ev.runId ? html('button', { type: 'button', className: 'ev-trace', textContent: traceName(ev.runId), title: 'Highlight this trace' }) : null);
    li.querySelector('.ev-trace')?.addEventListener('click', () => select({ kind: 'trace', id: ev.runId }));
    return li;
  }
  function addToList(ev) {
    const t = ev.topo;
    if (t.category === 'heartbeat' && !controls.heartbeats.checked) return;
    if (state.traceFilter && ev.runId !== state.traceFilter) return;
    // Newest first, in the order the agents timestamped the events (feeds arrive on separate connections).
    const li = listItem(ev);
    li.dataset.at = ev.at;
    const after = [...list.children].find((x) => x.dataset.at <= ev.at);
    list.insertBefore(li, after ?? null);
    while (list.children.length > MAX_LIST) list.lastChild.remove();
    state.listed += 1;
    count.textContent = `(${list.children.length} shown)`;
  }
  const allEvents = []; // labelled events kept for re-filtering (bounded)
  function refilter() {
    list.replaceChildren();
    for (const ev of allEvents) addToList(ev);
  }
  controls.heartbeats.addEventListener('change', refilter);

  // ---- selection and details --------------------------------------------------------------
  function select(sel) {
    state.selected = sel;
    state.traceFilter = sel?.kind === 'trace' ? sel.id : '';
    traceSelect.value = state.traceFilter;
    const tr = sel?.kind === 'trace' ? state.traces.get(sel.id) : null;
    svg.classList.toggle('tracing', Boolean(tr));
    for (const [id, e] of Object.entries(edgeEls)) {
      e.g.classList.toggle('in-trace', Boolean(tr?.edges.has(id)));
      e.g.classList.toggle('selected', sel?.kind === 'edge' && sel.id === id);
    }
    for (const [id, n] of Object.entries(nodeEls)) {
      n.g.classList.toggle('in-trace', Boolean(tr?.nodes.has(id)));
      n.g.classList.toggle('selected', sel?.kind === 'node' && sel.id === id);
    }
    refilter();
    renderDetail();
  }

  const dl = (rows) => {
    const d = html('dl', { className: 'kv' });
    for (const [k, v] of rows) if (v !== undefined && v !== null && v !== '') d.append(html('dt', { textContent: k }), html('dd', { textContent: String(v) }));
    return d;
  };
  const timeline = (events) => html('ol', { className: 'mini-timeline' }, ...events.slice(-40).map((ev) => html('li', { dataset: { phase: ev.topo.phase } },
    html('time', { textContent: clock(ev.at) }), html('span', { textContent: `${route(ev.topo)} — ${ev.topo.label}` }))));

  function renderDetail() {
    const sel = state.selected;
    if (!sel) {
      detail.replaceChildren(html('p', { className: 'hint', textContent: 'Select a node, a connection or a trace. Everything here comes from events the agents reported.' }));
      return;
    }
    if (sel.kind === 'node') {
      const id = sel.id;
      const [, text] = STATUS[nodeStatus(id)] ?? STATUS.unknown;
      const head = html('h3', { textContent: NODES[id].name, style: `color: ${color(id)}` });
      if (NODES[id].owner) {
        const { owner } = NODES[id];
        const m = state.modes[owner];
        const pr = state.provider[owner];
        const live = m?.mode === 'live';
        detail.replaceChildren(head, dl([['used by', NODES[owner].name], ['used for', MODEL_USES[owner]], ['mode', m ? m.mode : 'not reported yet'],
          ['model', m ? (live ? m.model : m.mode === 'off' ? 'none (turned off: STUDENT_MODE=off)' : `${m.model ?? 'none'} (runs inside the agent, no network)`) : null], ['provider', live ? 'Anthropic Messages API (HTTPS)' : m ? 'none in this mode' : null],
          ['API key', live ? (m.keyConfigured === false ? 'not set in this agent’s environment' : 'set in this agent’s own environment (never shown)') : null],
          ['calls seen', pr.calls], ['in flight', pr.inFlight], ['failures', pr.failures],
          ['last call', pr.last ? `${pr.last.purpose}, ${pr.last.ok ? 'answered' : `failed (${pr.last.code})`}${pr.last.latencyMs ? ` in ${(pr.last.latencyMs / 1000).toFixed(1)} s` : ''}${pr.last.usage ? `, ${pr.last.usage.inputTokens} in / ${pr.last.usage.outputTokens} out tokens` : ''}` : 'none yet']]),
          html('p', { className: 'hint', textContent: 'Each agent has its own model connection: it chooses its own mode, holds its own key in its own server process, and calls the provider directly. Nothing here is shared with the other agents, and the browser never contacts the provider. Status comes only from calls that really happened — nothing is sent just to check.' }));
      } else if (id === 'student') {
        detail.replaceChildren(head, dl([['status', text], ['identity', 'student-alex (fictional demo student)'], ['connects to', 'the university Hub only'], ['university card', state.student.cardValid === null ? 'not checked yet' : state.student.cardValid ? 'verified (name, endpoint, protocol)' : 'not verified'], ['live view', state.live ? 'connected' : 'disconnected']]));
      } else if (id === 'hub') {
        const hub = state.snapshot?.hub;
        const dests = html('ul', { className: 'dest-list' }, ...(hub?.destinations ?? []).map((d) => html('li', {}, html('strong', { textContent: d.destination }), ` → ${d.workerName} `, html('span', { className: 'hint', textContent: `(${STATUS[state.specialists[d.worker]?.status]?.[1] ?? 'unknown'})` }))));
        detail.replaceChildren(head, dl([['status', text], ['public name', hub?.name], ['router', hub?.router ? `${hub.router.mode}${hub.router.model ? ` (${hub.router.model})` : ''}` : null], ['relaying now', state.active.tutor + state.active.library], ['telemetry', state.hubFeed ? 'connected' : 'lost']]),
          html('h4', { textContent: 'Destinations (server-owned)' }), dests,
          html('p', { className: 'hint', textContent: state.snapshot?.trust ?? '' }));
      } else {
        const s = state.specialists[id] ?? {};
        detail.replaceChildren(head, dl([['status', text], ['registered', s.registered === undefined ? null : s.registered ? 'yes' : 'no'], ['enabled', s.enabled === null || s.enabled === undefined ? null : s.enabled ? 'yes' : 'no'], ['reachable', s.reachable === null || s.reachable === undefined ? 'not checked yet' : s.reachable ? 'yes' : 'no'],
          ['last heartbeat', s.lastHeartbeatAt ? `${clock(s.lastHeartbeatAt)} (${ago(s.lastHeartbeatAt)})` : 'none'], ['card revision', s.revision], ['instance', s.instance], ['in flight', state.active[id]], ['last error', s.lastError]]),
          html('h4', { textContent: 'Skills the Hub routes on' }), html('ul', { className: 'dest-list' }, ...(s.skills ?? []).map((k) => html('li', { textContent: k.name }))));
      }
    } else if (sel.kind === 'edge') {
      const [a, b] = EDGES[sel.id];
      const events = state.edgeEvents[sel.id];
      detail.replaceChildren(html('h3', { textContent: `${NODES[a].name} ↔ ${NODES[b].name}` }), html('p', { className: 'hint', textContent: EDGE_KIND(sel.id) === 'model' ? 'HTTPS calls from the agent to its model provider (not A2A). Latest events on this connection:' : 'A2A JSON-RPC over localhost. Latest events on this connection:' }),
        events.length ? timeline(events) : html('p', { className: 'hint', textContent: 'No traffic on this connection yet.' }));
    } else {
      const tr = state.traces.get(sel.id);
      if (!tr) return select(null);
      detail.replaceChildren(html('h3', { textContent: traceName(sel.id) }), dl([['trace (run) ID', sel.id], ['connections used', [...tr.edges].map((e) => EDGES[e].map((n) => NODES[n].name).join(' ↔ ')).join('; ') || 'none yet']]),
        timeline(tr.events), html('button', { type: 'button', className: 'inline-action', textContent: 'Show all traffic', onclick: () => select(null) }));
    }
  }

  // ---- inputs from app.js ------------------------------------------------------------------
  return {
    // hello / snapshot from the Hub
    snapshot(snap) {
      if (!snap) return;
      state.snapshot = snap;
      for (const s of snap.specialists ?? []) state.specialists[s.agentId] = { ...state.specialists[s.agentId], ...s };
      for (const s of snap.specialists ?? []) state.active[s.agentId] = s.active ?? 0;
      renderNodes();
    },
    // An agent's reported mode ({ mode, model, keyConfigured }); the Hub's comes from its router status.
    agentMode(agentId, info) {
      if (!(agentId in state.modes)) return;
      state.modes[agentId] = info;
      renderNodes();
    },
    liveView(connected) {
      state.live = connected;
      if (!connected) state.queue = [];
      renderNodes();
    },
    hubFeed(connected) {
      state.hubFeed = connected;
      renderNodes();
    },
    studentBusy(busy) {
      state.student.busy = busy;
      renderNodes();
    },
    studentCard(valid) {
      state.student.cardValid = valid;
      renderNodes();
    },
    truncated({ missed, kept }) {
      truncatedNote.hidden = false;
      truncatedNote.textContent = `${missed} earlier event${missed === 1 ? '' : 's'} are no longer in the server’s history; showing the last ${kept}.`;
    },
    reset() {
      state.traces.clear();
      for (const k of Object.keys(state.edgeEvents)) state.edgeEvents[k] = [];
      allEvents.length = 0;
      list.replaceChildren();
      count.textContent = '';
      truncatedNote.hidden = true;
      renderTraceOptions();
      select(null);
    },
    runStarted(runId, data) {
      const tr = trace(runId);
      tr.kind = data.kind;
      tr.action = data.actionName ?? null;
      renderTraceOptions();
    },
    runState(runId, s) {
      if (!state.traces.has(runId)) return;
      if (['completed', 'failed', 'uncertain'].includes(s)) {
        state.traces.get(runId).outcome = s;
        renderTraceOptions();
      }
    },
    // A labelled telemetry event. live=false for replayed history (no animation).
    event(ev, { live }) {
      // A provider hop is labelled 'model' by the server; draw it at the calling agent's own model box.
      if (ev.topo?.edge?.endsWith('-model')) {
        const box = EDGES[ev.topo.edge][1];
        ev.topo = { ...ev.topo, from: ev.topo.from === 'model' ? box : ev.topo.from, to: ev.topo.to === 'model' ? box : ev.topo.to };
      }
      const t = ev.topo;
      // Node state updates that come with events.
      if (ev.source === 'hub' && ev.type === 'registry_status') {
        state.specialists[ev.data.agentId] = { ...state.specialists[ev.data.agentId], ...ev.data };
        if (ev.data.status !== 'ready') state.active[ev.data.agentId] = 0;
      }
      if (ev.source === 'hub' && ev.type === 'heartbeat' && state.specialists[ev.data.agentId]) state.specialists[ev.data.agentId].lastHeartbeatAt = ev.at;
      if (ev.source === 'hub' && ev.type === 'card_refreshed' && ev.data.changed && state.specialists[ev.data.agentId]) state.specialists[ev.data.agentId].revision = ev.data.revision;
      if (ev.source === 'hub' && (ev.type === 'forward_attempted' || ev.type === 'form_forwarded')) state.active[ev.data.agentId] = (state.active[ev.data.agentId] ?? 0) + 1;
      if (ev.source === 'hub' && ['forward_completed', 'forward_failed', 'form_result_relayed', 'form_forward_failed'].includes(ev.type)) state.active[ev.data.agentId] = Math.max(0, (state.active[ev.data.agentId] ?? 0) - 1);
      // Model calls, counted on the calling agent's own model box.
      if (t?.edge?.endsWith('-model')) {
        const pr = state.provider[NODES[EDGES[t.edge][1]].owner];
        if (t.phase === 'attempted') {
          pr.inFlight += 1;
          pr.calls += 1;
        } else {
          pr.inFlight = Math.max(0, pr.inFlight - 1);
          const ok = t.phase === 'completed';
          if (!ok) pr.failures += 1;
          pr.last = { ok, code: ev.data?.code ?? null, purpose: ev.data?.purpose ?? (ev.type === 'scope_checked' ? 'scope check' : 'answer'), latencyMs: ev.data?.latencyMs ?? null, usage: ev.data?.usage ?? null, at: ev.at };
        }
      }
      if (ev.source === 'hub' && ev.type === 'route_decided' && ev.runId) {
        const tr = trace(ev.runId);
        tr.destination = ev.data.decision === 'route' ? ev.data.destination : `not routed (${ev.data.decision})`;
        renderTraceOptions();
      }
      renderNodes();
      if (!t) return;
      // Hidden heartbeats update the node (above) but never crowd real traffic out of the buffers.
      if (t.category === 'heartbeat' && !controls.heartbeats.checked) return;
      if (ev.runId) {
        const tr = trace(ev.runId);
        tr.events.push(ev);
        if (t.edge) tr.edges.add(t.edge);
        tr.nodes.add(t.from).add(t.to);
        if (state.selected?.kind === 'trace' && state.selected.id === ev.runId) {
          for (const [id, e] of Object.entries(edgeEls)) e.g.classList.toggle('in-trace', tr.edges.has(id));
          for (const [id, n] of Object.entries(nodeEls)) n.g.classList.toggle('in-trace', tr.nodes.has(id));
          renderDetail();
        }
      }
      if (t.edge) {
        const arr = state.edgeEvents[t.edge];
        arr.push(ev);
        if (arr.length > 200) arr.shift();
        if (state.selected?.kind === 'edge' && state.selected.id === t.edge) renderDetail();
      }
      allEvents.push(ev);
      if (allEvents.length > MAX_LIST * 2) allEvents.shift();
      addToList(ev);
      if (!live) return;
      if (t.category === 'heartbeat' && !controls.heartbeats.checked) return;
      if (state.traceFilter && ev.runId !== state.traceFilter) return;
      state.queue.push({ ev, arrived: performance.now() });
    },
  };
}
