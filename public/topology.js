// Part 7: the live topology — a switchboard of the agents. Student on the left, the university
// Hub in the centre, the Tutor, the Library, the Marketing 351 Faculty (Part 9) and the HR Agent (staff
// only — the Professor agent reaches it for the professor himself, never a student) behind it. Each agent has its own small model box: the agent
// picks its own mode and model and calls the provider from its own process with its own key, so these
// are separate connections, not one shared service. Those lines are HTTPS calls, drawn dashed, not A2A.
// There is no Student↔specialist line. Part 15/16: in the right column, under HR's model sits PeopleSoft and under
// Faculty's model sits Canvas LMS (both demo stand-ins), each reached only by its own agent (HR, Faculty) over MCP
// (dash-dot line). A system is not an agent: a tile with an icon (no circle, no orbit, no model box); its own AI
// shows only as the tile's sparkle and light sweep while a tool call runs.
//
// What moves is evidence, not decoration: a pulse is drawn only for an event the UI server labelled
// with an edge, a direction, a category and a phase (src/topology.js). Replayed history fills the
// event list and node states without animating. Live events wait briefly in a buffer and play in the
// order the agents timestamped them (their feeds reach us on separate connections). Only IDs and
// short fixed labels are shown here — never message text, emails, notes or form values.
import { FUNCTIONS, inFunction, frameOf, turnParts } from './topology-focus.js';

const SVG = 'http://www.w3.org/2000/svg';

// Part 21 layout (viewBox 0 0 845 959; owner-approved mockup docs/superpowers/specs/2026-11-20-topology-readable-mockup.html,
// Way 4): Student and Hub on the left, five specialists in a column at x 530, 184 apart. Each record system sits beside the
// agent that uses it (short MCP line); each agent's model is a small box up and to the right of it (above, for Student and Hub).
// `big` is the name as drawn in the circle, on one or two lines.
const NODES = {
  student: { x: 105, y: 468, r: 60, name: 'Student agent', big: ['Student', 'agent'], role: 'You' },
  hub: { x: 312, y: 468, r: 76, name: 'University Hub', big: ['University', 'Hub'], role: 'Front door and router' },
  tutor: { x: 530, y: 100, r: 56, name: 'Tutor Agent', big: ['Tutor', 'Agent'], role: 'Tutoring specialist' },
  library: { x: 530, y: 284, r: 56, name: 'Library Agent', big: ['Library', 'Agent'], role: 'Library specialist' },
  professor: { x: 530, y: 468, r: 56, name: 'Faculty', big: ['Faculty'], role: 'Marketing 351' },
  hr: { x: 530, y: 652, r: 56, name: 'HR Agent', big: ['HR', 'Agent'], role: 'Staff only' },
  chrs: { x: 530, y: 836, r: 56, name: 'Campus Agent', big: ['Campus', 'Agent'], role: 'Staff only' },
  // Systems, not agents (design F: tile + icon + sparkle + sweep). Part 15 PeopleSoft, Part 16 Canvas LMS.
  canvas: { x: 744, y: 468, w: 184, h: 80, kind: 'system', name: 'Canvas LMS', role: 'MCP server' },
  peoplesoft: { x: 744, y: 652, w: 184, h: 80, kind: 'system', name: 'PeopleSoft CHRS (HR)', lines: ['PeopleSoft CHRS', 'HR'], role: 'MCP server' },
  studentdb: { x: 744, y: 836, w: 184, h: 80, kind: 'system', name: 'PeopleSoft Campus Solutions', lines: ['PeopleSoft', 'Campus Solutions'], role: 'MCP server' },
  // One small model box per agent (owner): it says only “Model”. Server labels say 'model'; the browser draws it at the caller's box.
  'llm-student': { x: 105, y: 319, w: 86, h: 34, owner: 'student', name: 'Student’s model' },
  'llm-hub': { x: 312, y: 301, w: 86, h: 34, owner: 'hub', name: 'Hub router’s model' },
  'llm-tutor': { x: 675, y: 26, w: 86, h: 34, owner: 'tutor', name: 'Tutor’s model' },
  'llm-library': { x: 675, y: 210, w: 86, h: 34, owner: 'library', name: 'Library’s model' },
  'llm-professor': { x: 675, y: 394, w: 86, h: 34, owner: 'professor', name: 'Faculty’s model' },
  'llm-hr': { x: 675, y: 578, w: 86, h: 34, owner: 'hr', name: 'HR’s model' },
  'llm-chrs': { x: 675, y: 762, w: 86, h: 34, owner: 'chrs', name: 'Campus Agent’s model' },
};
const EDGES = {
  'student-hub': ['student', 'hub'], 'hub-tutor': ['hub', 'tutor'], 'hub-professor': ['hub', 'professor'], 'hub-library': ['hub', 'library'], 'hub-hr': ['hub', 'hr'], 'hub-chrs': ['hub', 'chrs'],
  'student-model': ['student', 'llm-student'], 'hub-model': ['hub', 'llm-hub'], 'tutor-model': ['tutor', 'llm-tutor'], 'professor-model': ['professor', 'llm-professor'], 'library-model': ['library', 'llm-library'], 'hr-model': ['hr', 'llm-hr'], 'chrs-model': ['chrs', 'llm-chrs'],
  'hr-peoplesoft': ['hr', 'peoplesoft'], 'professor-canvas': ['professor', 'canvas'], 'chrs-studentdb': ['chrs', 'studentdb'],
};
const MODEL_USES = { student: 'clarifying unclear questions and choosing which university capability a non-obvious one needs', hub: 'deciding where each question goes', tutor: 'answers, scope checks and form review', library: 'answers from saved content and form review', professor: 'answering questions from the course pack and its lessons, and telling the faculty member’s own HR requests from class messages', hr: 'reading the absence name from a staff member’s words (code checks it and decides dates and hours)', chrs: 'choosing which student-records tool to call for a class roster (code builds the arguments and checks the answer)' };
const SPECIALIST_IDS = ['tutor', 'library', 'professor', 'hr', 'chrs'];
const relaying = (active) => SPECIALIST_IDS.reduce((n, id) => n + (active[id] ?? 0), 0);
const EDGE_KIND = (id) => (id.endsWith('-model') ? 'model' : id === 'hr-peoplesoft' || id === 'professor-canvas' || id === 'chrs-studentdb' ? 'mcp' : 'a2a');
const EDGE_TEXT = { model: 'HTTPS', mcp: 'MCP', a2a: 'A2A' };
const LANE = 9; // each connection has one lane per direction
const LANE_MCP = 7; // the short MCP lines (mockup)
// A lane leaving an agent straight down starts below its status pill (r + 26 + 13 + 4), not at the circle.
const PILL_CLEAR = 43;
// The systems (demo stand-ins): their MCP tools, edge, colour variable, session states and the busy/saved timings.
const SYSTEMS = {
  peoplesoft: { edge: 'hr-peoplesoft', sessionEvent: 'peoplesoft_session', color: '--ps', cls: '', icon: 'db', title: 'PeopleSoft CHRS (HR) — demo stand-in', reachedBy: 'the HR Agent', tools: ['get_leave_balances', 'list_absence_requests', 'create_absence_request'], saved: /^Saved/ },
  canvas: { edge: 'professor-canvas', sessionEvent: 'canvas_session', color: '--lms', cls: ' lms', icon: 'quiz', title: 'Canvas LMS — demo stand-in', reachedBy: 'the Faculty agent', tools: ['create_quiz', 'publish_quiz'], saved: /^(Saved|Published)/ },
  // Part 17: the same PeopleSoft look for its student records, reached only by CHRS. A roster read saves nothing: no “Saved” flash.
  studentdb: { edge: 'chrs-studentdb', sessionEvent: 'studentdb_session', color: '--ps', cls: '', icon: 'db', title: 'PeopleSoft Campus Solutions — demo stand-in', reachedBy: 'the Campus Agent', tools: ['get_class_roster'], saved: /^(?!)/ },
};
const SYSTEM_OF_EDGE = Object.fromEntries(Object.entries(SYSTEMS).map(([id, v]) => [v.edge, id]));
const SESSION = { connected: ['✓ Connected', 'ok'], unreachable: ['✕ Unreachable', 'bad'], not_configured: ['○ Not configured', 'muted'], none: ['○ Not connected yet', 'muted'] };
const BUSY_MIN_MS = 1200; // a mock call answers in milliseconds: keep the busy look long enough to be seen
const BUSY_MAX_MS = 30000; // no answer seen: stop showing busy
const SAVED_MS = 3000;
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
const CATEGORY_TEXT = { request: 'question/answer', form: 'form', registration: 'registration', heartbeat: 'heartbeat', card: 'Agent Card', routing: 'routing', model: 'model call', tool: 'MCP tool call' };
const BUFFER_MS = 350;
const STAGGER_MS = 170;
const MAX_LIST = 300;
// Part 21 (focus): a part a request touched keeps its small lines written out this long after the last hop, while
// nothing is still working; with something still working it waits, but never longer than RUN_MAX_MS.
const RUN_LINGER_MS = 6000;
const RUN_MAX_MS = 45000;
const ZOOM_MS = 550;
const SPARK = 'M0,-10 C1.5,-2 2,-1.5 10,0 C2,1.5 1.5,2 0,10 C-1.5,2 -2,1.5 -10,0 C-2,-1.5 -1.5,-2 0,-10 Z';

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

// Distance from a node's centre to its border along (ux, uy): circles for agents, boxes for models and systems.
// Straight down from an agent, the lane clears the agent's status pill.
const reach = (n, ux, uy) => (n.w ? Math.min(n.w / 2 / (Math.abs(ux) || 1e-9), n.h / 2 / (Math.abs(uy) || 1e-9)) : n.r + (uy > 0.95 ? PILL_CLEAR : 0));

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
  const gap = EDGE_KIND(edge) === 'mcp' ? LANE_MCP : LANE;
  const ox = -cy * gap * side;
  const oy = cx * gap * side;
  return {
    x1: p.x + ux * (reach(p, ux, uy) + 6) + ox, y1: p.y + uy * (reach(p, ux, uy) + 6) + oy,
    x2: q.x - ux * (reach(q, -ux, -uy) + 10) + ox, y2: q.y - uy * (reach(q, -ux, -uy) + 10) + oy, // from q's side
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
    case 'lesson': return el('path', { d: 'M-6,-8 L6,-8 L6,8 L0,3.5 L-6,8 Z', ...common }); // a bookmark
    case 'heartbeat': return el('circle', { r: 3.6, ...common, 'stroke-width': 1.6 });
    case 'model': return el('path', { d: 'M0,-8 L2.4,-2.4 L8,0 L2.4,2.4 L0,8 L-2.4,2.4 L-8,0 L-2.4,-2.4 Z', ...common });
    case 'tool': return el('path', { d: 'M-4,-7 L4,-7 L8,0 L4,7 L-4,7 L-8,0 Z', ...common }); // MCP tool call: a hexagon
    default: return el('circle', { r: 7, ...common });
  }
}

export function createTopology({ svg, detail, list, count, traceSelect, truncatedNote, clockEl, controls, functionButtons = [], onActivity = () => {}, agentColor }) {
  const edgesLayer = svg.querySelector('#topo-edges');
  const pulseLayer = svg.querySelector('#topo-pulses');
  const nodesLayer = svg.querySelector('#topo-nodes');
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = {
    live: false, hubFeed: false, snapshot: null, student: { busy: false, cardValid: null },
    specialists: {}, // agentId → snapshot entry (status, heartbeat, skills…)
    // Each system (demo stand-in): the MCP session its agent reported, calls in flight (from the live pulses) and the last call.
    sys: Object.fromEntries(Object.keys(SYSTEMS).map((id) => [id, { session: null, inFlight: 0, since: 0, savedUntil: 0, last: null, maxTimer: null, savedTimer: null }])),
    active: { tutor: 0, professor: 0, library: 0, hr: 0, chrs: 0 },
    // Each agent's own model: its reported mode, and the calls we saw it make.
    modes: { student: null, hub: null, tutor: null, professor: null, library: null, hr: null, chrs: null }, // { mode, model, keyConfigured }
    provider: Object.fromEntries(['student', 'hub', ...SPECIALIST_IDS].map((a) => [a, { inFlight: 0, calls: 0, failures: 0, last: null }])),
    traces: new Map(), // runId → { n, kind, at, destination, outcome, edges:Set, nodes:Set, events:[] }
    edgeEvents: Object.fromEntries(Object.keys(EDGES).map((id) => [id, []])),
    selected: null, // { kind: 'node'|'edge'|'trace', id }
    traceFilter: '',
    queue: [],
    listed: 0,
  };
  const reduced = () => controls.reduce.checked || reducedQuery.matches;
  if (reducedQuery.matches) controls.reduce.checked = true;
  const color = (node) => (SYSTEMS[node] ? `var(${SYSTEMS[node].color})` : NODES[node]?.owner ? agentColor('model') : agentColor(node));

  // ---- static drawing --------------------------------------------------------------------
  const edgeEls = {};
  for (const [id, [a, b]] of Object.entries(EDGES)) {
    const f = lane(id, a);
    const r = lane(id, b);
    const kind = EDGE_KIND(id);
    const g = el('g', { class: 'edge', 'data-edge': id, 'data-kind': kind, tabindex: '0', role: 'button', 'aria-label': `Connection ${NODES[a].name} ↔ ${NODES[b].name} (${kind === 'model' ? 'HTTPS model API calls' : kind === 'mcp' ? 'MCP tool calls' : 'A2A JSON-RPC'}). Open its event timeline.` });
    const laneF = el('line', { class: 'lane', 'data-dir': 'out', x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, 'marker-end': 'url(#arrow)' });
    const laneR = el('line', { class: 'lane', 'data-dir': 'back', x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, 'marker-end': 'url(#arrow)' });
    const hit = el('line', { class: 'hit', x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y });
    // Labels (mockup): MCP sits just below the middle of the outgoing lane; an HTTPS line that runs diagonally has its label
    // above the middle of the return lane (clear of both arrowheads); other lines keep the middle of the connection.
    const diagonal = Math.abs(NODES[a].x - NODES[b].x) > 5 && Math.abs(NODES[a].y - NODES[b].y) > 5;
    const vertical = Math.abs(NODES[a].x - NODES[b].x) < Math.abs(NODES[a].y - NODES[b].y);
    let lx; let ly; let anchor = 'middle';
    if (kind === 'mcp') { lx = Math.round((f.x1 + f.x2) / 2 - 6); ly = Math.round((f.y1 + f.y2) / 2 + 30); }
    else if (kind === 'model' && diagonal) { lx = Math.round((r.x1 + r.x2) / 2); ly = Math.round((r.y1 + r.y2) / 2 - 12); }
    else {
      const mx = (NODES[a].x + NODES[b].x) / 2;
      const my = (NODES[a].y + NODES[b].y) / 2;
      lx = vertical ? mx + 18 : mx; ly = vertical ? my : my - 18; anchor = vertical ? 'start' : 'middle';
    }
    const label = el('text', { class: 'edge-label q', x: lx, y: ly, 'text-anchor': anchor }, EDGE_TEXT[kind]);
    g.append(hit, laneF, laneR, label);
    edgesLayer.append(g);
    edgeEls[id] = { g, out: laneF, back: laneR };
    g.addEventListener('click', () => select({ kind: 'edge', id }));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'edge', id }); } });
  }

  // Captions sit in their own top layer, so a long one is never covered by a neighbouring shape.
  const captionsLayer = el('g', { id: 'topo-captions' });
  svg.append(captionsLayer);
  const captionAt = (x, y, anchor) => { const t = el('text', { class: 'node-caption', x, y, 'text-anchor': anchor }, ''); captionsLayer.append(t); return t; };
  const open = (g, id) => {
    g.addEventListener('click', () => select({ kind: 'node', id }));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'node', id }); } });
  };
  // What is written on a part (Part 21): at rest only its name and a green “ready” dot. The small lines (class `q`:
  // status pill, “MCP SERVER”; `node-more`: role and heartbeat) wait until the part is revealed — see paintFocus.
  const nodeEls = {};
  for (const [id, n] of Object.entries(NODES)) {
    if (n.kind === 'system') {
      // PeopleSoft and Canvas LMS, design F (owner-approved mockup): a tile with an icon (database / quiz clipboard) on the left, the name shifted
      // right, an AI sparkle top-right and a light sweep clipped to the tile; the status pill below. Animated
      // parts sit inside a positioned <g>, so the CSS animation's transform doesn't replace the position.
      const sys = SYSTEMS[id];
      const g = el('g', { class: `node system${sys.cls}`, 'data-node': id, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', style: `--node: ${color(id)}` });
      const tile = { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 16 };
      const clip = el('clipPath', { id: `${id}-tile-clip` }, el('rect', tile));
      const grad = el('linearGradient', { id: `${id}-sweep-grad`, x1: 0, x2: 1, y1: 0, y2: 0 },
        el('stop', { offset: '0', 'stop-color': `var(${sys.color})`, 'stop-opacity': '0' }),
        el('stop', { offset: '.5', 'stop-color': `var(${sys.color})`, 'stop-opacity': '.22' }),
        el('stop', { offset: '1', 'stop-color': `var(${sys.color})`, 'stop-opacity': '0' }));
      const halo = el('rect', { class: 'halo', x: -n.w / 2 - 7, y: -n.h / 2 - 7, width: n.w + 14, height: n.h + 14, rx: 23 });
      const sweep = el('g', { 'clip-path': `url(#${id}-tile-clip)` }, el('rect', { class: 'sweep', x: -30, y: -n.h / 2, width: 60, height: n.h, fill: `url(#${id}-sweep-grad)` }));
      const icon = sys.icon === 'quiz'
        ? el('g', { class: 'quiz-icon', transform: 'translate(-62 0)' },
          el('rect', { class: 'qi-board', x: -13, y: -16, width: 26, height: 32, rx: 4 }),
          el('rect', { class: 'qi-clip', x: -6, y: -19, width: 12, height: 6, rx: 2 }),
          el('path', { class: 'qi-tick', d: 'M-8,-5 l3,3 l5,-6 M-8,7 l3,3 l5,-6' }),
          el('path', { class: 'qi-line', d: 'M3,-4 h5 M3,8 h5' }))
        : el('g', { class: 'db-icon', transform: 'translate(-64 2)' },
          el('path', { class: 'db', d: 'M-14,-13 A14,4.5 0 0 0 14,-13 L14,13 A14,4.5 0 0 1 -14,13 Z' }),
          el('ellipse', { class: 'db', cx: 0, cy: -13, rx: 14, ry: 4.5 }),
          el('path', { class: 'db-line', d: 'M-14,-4 A14,4.5 0 0 0 14,-4 M-14,5 A14,4.5 0 0 0 14,5' }));
      const spark = el('g', { transform: `translate(${n.w / 2 - 18} -24)` }, el('path', { class: 'spark', d: SPARK, transform: 'scale(0.8)' }));
      // A long name (PeopleSoft Campus Solutions) is drawn on two lines so it stays inside the tile.
      const words = n.lines
        ? el('g', { transform: 'translate(26 0)' },
          el('text', { class: 'node-name two-line', y: -6, 'text-anchor': 'middle' }, n.lines[0]),
          el('text', { class: 'node-name two-line', y: 11, 'text-anchor': 'middle' }, n.lines[1]),
          el('text', { class: 'node-sub q', y: 28, 'text-anchor': 'middle' }, n.role.toUpperCase()))
        : el('g', { transform: 'translate(16 0)' },
          el('text', { class: 'node-name', y: 5, 'text-anchor': 'middle' }, n.name),
          el('text', { class: 'node-sub q', y: 24, 'text-anchor': 'middle' }, n.role.toUpperCase()));
      const statusG = el('g', { class: 'node-status q', transform: 'translate(0 64)' });
      const statusText = el('text', { class: 'status-text', y: 4, 'text-anchor': 'middle' }, '');
      statusG.append(el('rect', { class: 'status-pill', x: -62, y: -13, width: 124, height: 24, rx: 12 }), statusText);
      const okDot = el('circle', { class: 'ok-dot', cx: -n.w / 2 + 5, cy: -n.h / 2 + 5, r: 6.5 });
      // Captions (e.g. “MCP session open”) above the tile, ending at its right edge.
      const caption = captionAt(n.x + n.w / 2, n.y - (n.h / 2 + 10), 'end');
      g.append(clip, grad, halo, el('rect', { class: 'tile', ...tile }), sweep, icon, spark, words, statusG, okDot);
      nodesLayer.append(g);
      nodeEls[id] = { g, extra: null, statusText, statusG, caption, captionTimer: null };
      open(g, id);
      continue;
    }
    if (n.owner) {
      // A model box: small, and it says only “Model”. Its model name and call state are in its label and the details
      // panel; a problem shows as the box's colour. The elements renderNodes writes to are kept off the map.
      const g = el('g', { class: 'node service', 'data-node': id, 'data-owner': n.owner, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', style: `--node: ${color(id)}` });
      const box = (pad, cls) => el('rect', { class: cls, x: -n.w / 2 - pad, y: -n.h / 2 - pad, width: n.w + 2 * pad, height: n.h + 2 * pad, rx: 12 + pad });
      const mark = el('g', { transform: 'translate(-26 0)' }, el('path', { class: 'model-spark', d: SPARK, transform: 'scale(0.8)' }));
      const name = el('text', { class: 'node-name', x: 10, y: 5, 'text-anchor': 'middle' }, 'Model');
      g.append(box(7, 'halo'), box(3, 'orbit'), box(0, 'disc'), mark, name);
      nodesLayer.append(g);
      nodeEls[id] = { g, extra: el('text'), statusText: el('text'), statusG: el('g'), caption: null, captionTimer: null };
      open(g, id);
      continue;
    }
    const g = el('g', { class: 'node', 'data-node': id, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', style: `--node: ${color(id)}` });
    const halo = el('circle', { class: 'halo', r: n.r + 10 });
    const orbit = el('circle', { class: 'orbit', r: n.r + 5 });
    const disc = el('circle', { class: 'disc', r: n.r });
    const two = n.big.length === 2;
    const names = n.big.map((line, i) => el('text', { class: 'node-name', y: two ? (i ? (id === 'hub' ? 22 : 20) : -3) : 7, 'text-anchor': 'middle' }, line));
    // Role and heartbeat on one line under the pill (shown on pointing, selection, a chosen function or “Show all details”).
    const sub = el('tspan', { class: 'node-sub' }, n.role);
    const sep = el('tspan', {}, '');
    const extra = el('tspan', { class: 'node-extra' }, '');
    const more = el('text', { class: 'node-more', y: n.r + 56, 'text-anchor': 'middle' }, sub, sep, extra);
    const statusG = el('g', { class: 'node-status q', transform: `translate(0 ${n.r + 26})` });
    const statusBg = el('rect', { class: 'status-pill', x: -62, y: -13, width: 124, height: 24, rx: 12 });
    const statusText = el('text', { class: 'status-text', y: 4, 'text-anchor': 'middle' }, '');
    statusG.append(statusBg, statusText);
    const okDot = el('circle', { class: 'ok-dot', cx: -Math.round(n.r * 0.71), cy: -Math.round(n.r * 0.71), r: 6.5 });
    // The Student sits at the left edge: its caption starts at the edge instead of being centred (a long one would be cut).
    const caption = id === 'student' ? captionAt(10, n.y - (n.r + 18), 'start') : captionAt(n.x, n.y - (n.r + 18), 'middle');
    g.append(halo, orbit, disc, ...names, statusG, more, okDot);
    nodesLayer.append(g);
    nodeEls[id] = { g, extra, sep, statusText, statusG, caption, captionTimer: null };
    open(g, id);
  }

  // ---- focus: what is written out, what steps back, and the frame (Part 21) -------------------------
  // The whole campus is always drawn, connected and in colour. A part is REVEALED (its small lines written out) when a
  // request really touched it (from the pulses drawn, never a heartbeat), when it is not healthy, when it is selected,
  // when it belongs to the chosen function, or when “Show all details” is ticked; pointing at it does the same in CSS.
  // Choosing a function also fades the other parts and closes the frame in on the function's parts. Only the SVG's
  // viewBox moves, so pulses, lanes, pills and click targets are untouched. Nothing here is inferred ahead of an event.
  const FULL = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
  const focus = { fn: null, follow: false, auto: true, // “Follow the conversation” is the mode the page opens in (owner, 2026-11-21)
    manual: false, trail: new Set(), hot: new Set(), hotEdges: new Set(), lastTouch: 0, lastBusy: 0, view: FULL.slice(), goal: FULL.join(' '), raf: 0 };
  const known = (ids) => [...ids].filter((id) => NODES[id]);
  const busyNow = () => state.student.busy || relaying(state.active) > 0 || Object.values(state.provider).some((p) => p.inFlight > 0) || Object.values(state.sys).some((p) => p.inFlight > 0);
  function zoomTo(box) {
    const key = box.join(' ');
    if (key === focus.goal) return;
    focus.goal = key;
    cancelAnimationFrame(focus.raf);
    const from = focus.view.slice();
    const set = (v) => { focus.view = v; svg.setAttribute('viewBox', v.map((n) => Math.round(n * 10) / 10).join(' ')); };
    if (reduced()) return set(box.slice());
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / ZOOM_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
      set(from.map((v, i) => v + (box[i] - v) * e));
      if (k < 1) focus.raf = requestAnimationFrame(step);
      else set(box.slice());
    };
    focus.raf = requestAnimationFrame(step);
  }
  function paintFocus() {
    const { fn, auto } = focus;
    const all = controls.details?.checked === true;
    const sel = state.selected?.kind === 'node' ? state.selected.id : null;
    svg.dataset.focus = fn ? 'function' : focus.hot.size ? 'run' : 'rest';
    for (const [id, n] of Object.entries(nodeEls)) {
      const st = n.g.dataset.status;
      // A model box shows a problem by its colour; any other part that is not ready always writes its status out.
      const problem = NODES[id].owner ? st === 'stale' || st === 'unreachable' : st !== 'ready';
      const picked = !auto && Boolean(fn) && inFunction(fn, id, NODES);
      const hot = focus.hot.has(id);
      n.g.dataset.reveal = String(all || hot || problem || picked || sel === id);
      n.g.dataset.more = String(all || picked || sel === id);
      // Outside the chosen function a part is a silhouette whatever its status (owner, 2026-11-20); only real use brings it back.
      // “Follow the conversation” (owner, 2026-11-21): everything is a silhouette until a request really touches it.
      n.g.dataset.quiet = String(auto ? !hot && sel !== id : Boolean(fn) && !picked && !hot);
    }
    for (const [id, e] of Object.entries(edgeEls)) {
      const picked = !auto && Boolean(fn) && EDGES[id].every((part) => inFunction(fn, part, NODES));
      const hot = focus.hotEdges.has(id);
      e.g.dataset.reveal = String(all || hot || picked);
      e.g.dataset.quiet = String(auto ? !hot : Boolean(fn) && !picked && !hot);
    }
    if (focus.manual) return; // the presenter's own zoom holds until Fit or a filter button
    // The frame: the function's parts. In “Follow the conversation”, before one function fits: the one specialist in
    // play with everything it connects to (turnParts), else the whole campus — the frame must not chase every hop
    // (2026-11-21: a quiz publish moved it four times in six seconds, and a topic pick filled the panel with Faculty).
    // One specialist wins over a function there: Faculty + Canvas alone "fit" Course and quizzes, whose frame would
    // widen to the Student for nothing. Two specialists (Faculty + HR) need the function's frame.
    const turn = auto && focus.trail.size ? turnParts(focus.trail, NODES, EDGES, SPECIALIST_IDS) : null;
    zoomTo(turn ? frameOf(turn, NODES, FULL) : fn ? frameOf(Object.keys(NODES).filter((id) => inFunction(fn, id, NODES)), NODES, FULL) : FULL);
  }
  function showFunction(id) {
    focus.fn = id && FUNCTIONS[id] ? id : null;
    pressButtons();
    paintFocus();
  }
  const keyOf = (b) => b.dataset.mode ?? (b.dataset.function || null);
  function pressButtons() {
    const on = focus.auto ? 'auto' : focus.fn;
    for (const b of functionButtons) b.setAttribute('aria-pressed', String(keyOf(b) === on));
  }
  // The presenter's own choice. Pressing the chosen function again, or Everything, shows the whole campus and stops
  // following; choosing a function starts following (below).
  function setFunction(id) {
    const next = id && FUNCTIONS[id] && (focus.auto || id !== focus.fn) ? id : null;
    focus.auto = false;
    focus.manual = false;
    focus.follow = Boolean(next);
    focus.trail.clear();
    showFunction(next);
  }
  // Once the presenter has chosen a function, the filter FOLLOWS what really happens (owner, 2026-11-20): when a
  // drawn pulse, or a selected trace, touches a part outside the chosen function, the filter moves to the one function
  // those parts fit. While several fit, or none does, the whole campus shows, so a part in use is never outside the
  // frame; the filter keeps following and closes in again as soon as one function fits.
  // “Follow the conversation” (owner, 2026-11-21): at rest the whole campus is zoomed out and grey. A request colours
  // only the parts it really touches and the frame closes in on them: on the parts touched so far, then on the one
  // function they fit. When the request is over (restFocus) it is zoomed out and grey again. Pressing it again, or
  // any other button, leaves the mode.
  function setAuto(on) {
    focus.auto = on;
    focus.manual = false;
    focus.follow = false;
    focus.fn = null;
    focus.trail.clear();
    pressButtons();
    paintFocus();
  }
  const fitting = (ids) => Object.keys(FUNCTIONS).filter((fn) => [...ids].every((id) => inFunction(fn, id, NODES)));
  function followTo(ids, housekeeping = false) {
    if (focus.auto) {
      if (housekeeping) return; // a sign-in colours its parts but never moves the frame
      for (const id of ids) focus.trail.add(id);
      // A part touched in a turn stays in colour, and in the frame, until the whole turn ends (owner, 2026-11-21):
      // nothing is forgotten here; only restFocus puts the map back.
      const fits = fitting(focus.trail);
      focus.fn = fits.length === 1 ? fits[0] : null;
      return;
    }
    if (!focus.follow) return;
    // A sign-in, sign-out or card change is not a request: it never picks a function, it only opens the frame.
    if (housekeeping) { if (focus.fn && !ids.every((id) => inFunction(focus.fn, id, NODES))) showFunction(null); return; }
    for (const id of ids) focus.trail.add(id);
    let fits = fitting(focus.trail);
    if (!fits.length) { focus.trail = new Set(ids); fits = fitting(ids); } // a new request: forget the last one's parts
    const next = fits.includes(focus.fn) ? focus.fn : fits.length === 1 ? fits[0] : null;
    if (next !== focus.fn) showFunction(next);
  }
  const leaveFunctionUnless = (ids) => { if (ids.length && !focus.auto) { focus.trail.clear(); followTo(ids); } };
  function touch(ids, edge, housekeeping) {
    const parts = known(ids);
    if (!parts.length) return;
    followTo(parts, housekeeping);
    for (const id of parts) focus.hot.add(id);
    if (edge) focus.hotEdges.add(edge);
    focus.lastTouch = performance.now();
    paintFocus();
  }
  function restFocus() {
    if (!focus.hot.size) return;
    focus.hot.clear();
    focus.hotEdges.clear();
    focus.trail.clear();
    if (focus.auto) focus.fn = null;
    paintFocus();
  }
  setInterval(() => {
    if (!focus.hot.size) return;
    const now = performance.now();
    // The linger counts from the last hop AND from the moment the work stopped. The "finished" event arrives about
    // 350 ms before its pulses are drawn (the buffer), so after a long silent wait the turn would otherwise rest in
    // that gap and its last hops would relight a map that had just gone grey (seen live, 2026-11-21: a loans request).
    if (busyNow()) focus.lastBusy = now;
    if (now - focus.lastTouch > RUN_MAX_MS || (now - Math.max(focus.lastTouch, focus.lastBusy) > RUN_LINGER_MS && !busyNow())) restFocus();
  }, 400);
  for (const b of functionButtons) b.addEventListener('click', () => (b.dataset.mode === 'auto' ? setAuto(!focus.auto) : setFunction(b.dataset.function || null)));
  controls.details?.addEventListener('change', paintFocus);
  pressButtons();

  // ---- the presenter's own zoom, like a map (owner, 2026-11-21): + and −, the mouse wheel, drag to move ----------
  // It only moves the viewBox, inside the full drawing, and holds until Fit or a filter button is pressed.
  const MIN_W = 240;
  function manualView([x, y, w, h]) {
    const k = Math.min(1, FULL[2] / w, FULL[3] / h); // never wider or taller than the drawing
    w *= k; h *= k;
    x = Math.min(Math.max(x, FULL[0]), FULL[0] + FULL[2] - w);
    y = Math.min(Math.max(y, FULL[1]), FULL[1] + FULL[3] - h);
    cancelAnimationFrame(focus.raf);
    focus.manual = true;
    focus.goal = 'manual';
    focus.view = [x, y, w, h];
    svg.setAttribute('viewBox', focus.view.map((n) => Math.round(n * 10) / 10).join(' '));
  }
  const pointIn = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
  function zoomBy(f, at) {
    const [x, y, w, h] = focus.view;
    const k = Math.max(MIN_W / w, f); // f < 1 zooms in
    const c = at ?? { x: x + w / 2, y: y + h / 2 };
    manualView([c.x - (c.x - x) * k, c.y - (c.y - y) * k, w * k, h * k]);
  }
  function fit() {
    focus.manual = false;
    focus.goal = '';
    paintFocus();
  }
  controls.zoomIn?.addEventListener('click', () => zoomBy(1 / 1.3));
  controls.zoomOut?.addEventListener('click', () => zoomBy(1.3));
  controls.zoomFit?.addEventListener('click', fit);
  svg.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomBy(Math.exp(Math.max(-60, Math.min(60, ev.deltaY)) * 0.004), pointIn(ev)); }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { if (ev.button === 0) drag = { x: ev.clientX, y: ev.clientY, view: focus.view.slice(), moved: false }; });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (drag.view[2] >= FULL[2] && drag.view[3] >= FULL[3]) return; // nothing to move at full size
    if (!drag.moved) { drag.moved = true; svg.setPointerCapture(ev.pointerId); svg.dataset.dragging = 'true'; document.activeElement?.blur?.(); }
    const m = svg.getScreenCTM();
    manualView([drag.view[0] - dx / m.a, drag.view[1] - dy / m.d, drag.view[2], drag.view[3]]);
  });
  const endDrag = () => {
    if (drag?.moved) {
      delete svg.dataset.dragging;
      svg.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true }); // a drag is not a click on a part
    }
    drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  paintFocus();

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
  // A system's pill: working while a tool call runs, “Saved” for a moment after a filing, else the MCP session.
  function sysState(id) {
    const p = state.sys[id];
    if (!state.live) return { text: '? Unknown', tone: 'muted', status: 'unknown', busy: false };
    if (p.inFlight > 0) return { text: '● Working…', tone: 'busy', status: 'ready', busy: true };
    if (p.savedUntil > Date.now()) return { text: '✓ Saved', tone: 'ok', status: 'ready', busy: false };
    const [text, tone] = SESSION[p.session ?? 'none'];
    return { text, tone, status: p.session === 'connected' ? 'ready' : p.session === 'unreachable' ? 'unreachable' : 'disconnected', busy: false };
  }
  function nodeStatus(id) {
    if (!state.live) return 'unknown';
    if (SYSTEMS[id]) return sysState(id).status;
    if (NODES[id].owner) return modelState(NODES[id].owner).status;
    if (id === 'student') return 'ready';
    if (id === 'hub') return state.hubFeed ? 'ready' : 'unreachable';
    if (!state.hubFeed) return 'unknown'; // we only learn specialist health through the Hub
    return state.specialists[id]?.status ?? 'unknown';
  }
  function renderNodes() {
    for (const id of Object.keys(NODES)) {
      if (NODES[id].kind === 'system') {
        const n = nodeEls[id];
        const ps = sysState(id);
        n.statusText.textContent = ps.text;
        n.statusG.dataset.tone = ps.tone;
        n.g.dataset.status = ps.status;
        n.g.dataset.busy = String(ps.busy);
        n.g.classList.toggle('busy', ps.busy);
        n.g.classList.toggle('still', reduced());
        n.g.setAttribute('aria-label', `${NODES[id].name} (demo stand-in, MCP server): ${ps.text.replace(/^\S+ /, '')}. Open details.`);
        continue;
      }
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
      const busy = id === 'student' ? state.student.busy : id === 'hub' ? relaying(state.active) > 0 : state.active[id] > 0;
      let label = `${icon} ${text}`;
      if (id === 'student' && state.live) label = busy ? '↻ Waiting for reply' : state.student.cardValid === false ? '⚠ University card not verified' : '✓ Online';
      if (id === 'hub' && state.hubFeed && busy) label = `↻ Relaying (${relaying(state.active)})`;
      if (SPECIALIST_IDS.includes(id) && busy && s === 'ready') label = `↻ Working (${state.active[id]})`;
      n.statusText.textContent = label;
      n.statusG.dataset.tone = busy && (s === 'ready' || id === 'student') ? 'busy' : id === 'student' && state.student.cardValid === false ? 'warn' : tone;
      n.g.dataset.status = s;
      n.g.dataset.busy = String(busy);
      const spec = state.specialists[id];
      if (id === 'hub') n.extra.textContent = state.snapshot?.hub?.router ? `router: ${state.snapshot.hub.router.mode}` : '';
      else if (spec) n.extra.textContent = spec.lastHeartbeatAt ? `♥ ${ago(spec.lastHeartbeatAt)}` : 'no heartbeat yet';
      else if (id === 'student') n.extra.textContent = 'student-alex';
      n.sep.textContent = n.extra.textContent ? ' · ' : '';
      n.g.setAttribute('aria-label', `${NODES[id].name}: ${label.slice(2)}. Open details.`);
    }
    svg.classList.toggle('offline', !state.live);
    paintFocus(); // a status change can make a part a problem (always written out, never faint) or clear it
    if (state.selected?.kind === 'node') renderDetail();
  }
  setInterval(() => {
    for (const id of SPECIALIST_IDS) {
      const spec = state.specialists[id];
      if (spec?.lastHeartbeatAt) nodeEls[id].extra.textContent = `♥ ${ago(spec.lastHeartbeatAt)}`;
    }
    clockEl.textContent = state.live ? `live · ${new Date().toLocaleTimeString([], { hour12: false })}` : 'not live';
  }, 1000);

  const warned = new Set();
  function warnOnce(id) { if (!warned.has(id)) { warned.add(id); console.warn(`Topology: no node drawn for "${id}"`); } }
  function caption(node, text) {
    const box = nodeEls[node];
    if (!box) return warnOnce(node); // a node this page doesn't draw yet (CHRS before its Topology tile): nothing to caption
    const says = NODES[node].owner ? nodeEls[NODES[node].owner] : box; // a model box carries no words: its agent says it
    says.caption.textContent = text;
    box.g.classList.add('flash');
    clearTimeout(box.captionTimer);
    box.captionTimer = setTimeout(() => {
      if (says.caption.textContent === text) says.caption.textContent = '';
      box.g.classList.remove('flash');
    }, 1400);
  }

  // ---- pulses -----------------------------------------------------------------------------
  // A system looks busy from the moment an MCP tool call is drawn leaving its agent until its answer is drawn
  // (at least BUSY_MIN_MS, so a fast mock call is still visible; at most BUSY_MAX_MS without an answer).
  function sysCall(id, t) {
    const p = state.sys[id];
    if (t.phase === 'attempted') {
      if (p.inFlight === 0) p.since = performance.now();
      p.inFlight += 1;
      clearTimeout(p.maxTimer);
      p.maxTimer = setTimeout(() => { p.inFlight = 0; renderNodes(); }, BUSY_MAX_MS);
      return renderNodes();
    }
    if (!['completed', 'failed', 'unknown'].includes(t.phase)) return;
    setTimeout(() => {
      if (p.inFlight === 0) return; // already cleared by the 30 s limit
      p.inFlight -= 1;
      if (p.inFlight === 0) clearTimeout(p.maxTimer);
      if (t.phase === 'completed' && SYSTEMS[id].saved.test(t.label)) {
        p.savedUntil = Date.now() + SAVED_MS;
        clearTimeout(p.savedTimer);
        p.savedTimer = setTimeout(renderNodes, SAVED_MS + 20);
      }
      renderNodes();
    }, Math.max(0, p.since + BUSY_MIN_MS - performance.now()));
  }
  controls.reduce.addEventListener('change', () => renderNodes());
  reducedQuery.addEventListener?.('change', () => renderNodes());

  function pulse(ev) {
    const t = ev.topo;
    onActivity();
    if (SYSTEM_OF_EDGE[t.edge] && t.category === 'tool') sysCall(SYSTEM_OF_EDGE[t.edge], t);
    if (t.category !== 'heartbeat') touch(t.edge ? [t.from, t.to] : [t.node], t.edge, t.category === 'registration' || t.category === 'card'); // heartbeats are background, not a request
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

  // Live events play in agent-timestamp order after a short buffer, staggered so order is visible. The stagger
  // carries over between batches: a long burst's last pulses must not be overtaken by the next batch's first
  // (PeopleSoft's busy look pairs each MCP call with its answer in play order).
  let nextSlot = 0;
  const MAX_PULSE_DELAY_MS = 2000;
  setInterval(() => {
    if (controls.pause.checked || !state.queue.length) return;
    const now = performance.now();
    const cutoff = now - BUFFER_MS;
    const ready = state.queue.filter((q) => q.arrived <= cutoff);
    if (!ready.length) return;
    state.queue = state.queue.filter((q) => q.arrived > cutoff);
    ready.sort((a, b) => (a.ev.at < b.ev.at ? -1 : a.ev.at > b.ev.at ? 1 : a.ev.seq - b.ev.seq));
    for (const q of ready) {
      const at = Math.min(Math.max(now, nextSlot), now + MAX_PULSE_DELAY_MS); // order kept; a flood can't queue minutes
      nextSlot = at + STAGGER_MS;
      setTimeout(() => pulse(q.ev), at - now);
    }
  }, 100);
  controls.pause.addEventListener('change', () => { if (!controls.pause.checked) state.queue = state.queue.slice(-12); });

  // ---- traces, edges and the event list -----------------------------------------------------
  function trace(runId) {
    let tr = state.traces.get(runId);
    if (!tr) {
      // HR (staff only): the Hub names a staff request's run `staff-<operationId>` (started from the Faculty view).
      tr = { n: state.traces.size + 1, kind: runId.startsWith('staff-') ? 'staff' : 'chat', at: null, destination: null, outcome: null, edges: new Set(), nodes: new Set(), events: [] };
      state.traces.set(runId, tr);
    }
    return tr;
  }
  const TRACE_DEST = { tutor: 'Tutor Agent', library: 'Library Agent', professor: 'Faculty', hr: 'HR Agent', chrs: 'Campus Agent' };
  const traceName = (runId) => {
    const tr = state.traces.get(runId);
    if (!tr) return runId.slice(0, 8);
    // A staff run that went to CHRS (a roster request, or the class's time and room before a cancellation) is named for it.
    const toRoster = tr.destination === 'chrs' || (tr.edges.has('hub-chrs') && !tr.edges.has('hub-hr'));
    const toHr = tr.destination === 'hr' || tr.edges.has('hub-hr');
    const staffTo = toRoster ? 'Campus Agent' : toHr ? 'HR' : 'Hub'; // until the Hub has routed it, the request is only known to have reached the Hub
    // Review round 2: name the whole path a roster read takes (Faculty → Campus Agent → Campus Solutions), and never
    // a raw agent id (the reviewer saw “#26 → chrs”).
    const staffWhat = toRoster ? 'Roster request (Faculty → Campus Agent → Campus Solutions)' : `Staff request (Faculty → ${staffTo})`;
    const what = tr.kind === 'form_action' ? `Form action${tr.action ? ` “${tr.action}”` : ''}` : tr.kind === 'staff' ? staffWhat : 'Chat';
    const dest = tr.kind === 'staff' ? '' : tr.destination ? ` → ${TRACE_DEST[tr.destination] ?? 'a service'}` : '';
    return `${what} #${tr.n}${dest}${tr.outcome ? ` · ${tr.outcome}` : ''}`;
  };
  function renderTraceOptions() {
    const current = traceSelect.value;
    const options = [...state.traces.entries()].slice(-25).reverse().map(([runId]) => html('option', { value: runId, textContent: `${traceName(runId)} · ${runId.slice(0, 8)}` }));
    traceSelect.replaceChildren(html('option', { value: '', textContent: 'All traffic' }), ...options);
    traceSelect.value = state.traces.has(current) ? current : '';
  }
  traceSelect.addEventListener('change', () => (traceSelect.value ? select({ kind: 'trace', id: traceSelect.value }) : select(null)));

  const nodeName = (id) => { if (!NODES[id]) warnOnce(id); return NODES[id]?.name ?? id; }; // an agent this page doesn't draw yet (e.g. CHRS) is named by its id, never thrown on
  const route = (t) => (t.edge ? `${nodeName(t.from)} → ${nodeName(t.to)}` : `inside ${nodeName(t.node)}`);
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
  // Review #8: repeated events (one per student) are one row with a count. The key is the run, the event type, the
  // connection and the group the server named; a row that was trimmed or cleared is simply not found and starts over.
  const groupRows = new Map();
  function addToList(ev) {
    const t = ev.topo;
    if (t.category === 'heartbeat' && !controls.heartbeats.checked) return;
    if (state.traceFilter && ev.runId !== state.traceFilter) return;
    if (t.group) {
      const key = [ev.runId ?? '', ev.source, ev.type, t.edge ?? t.node, t.group].join('|');
      const hit = groupRows.get(key);
      if (hit?.li.isConnected) {
        hit.n += 1;
        hit.li.querySelector('.ev-label').textContent = t.groupLabel.replace('{n}', hit.n);
        hit.li.dataset.count = String(hit.n);
        return;
      }
      const li = listItem(ev);
      li.dataset.at = ev.at;
      li.dataset.count = '1';
      const after = [...list.children].find((x) => x.dataset.at <= ev.at);
      list.insertBefore(li, after ?? null);
      while (list.children.length > MAX_LIST) list.lastChild.remove();
      groupRows.set(key, { li, n: 1 });
      state.listed += 1;
      count.textContent = `(${list.children.length} shown)`;
      return;
    }
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
    groupRows.clear();
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
    if (tr) leaveFunctionUnless(known(tr.nodes));
    paintFocus();
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
      if (SYSTEMS[id]) {
        const p = state.sys[id];
        const sys = SYSTEMS[id];
        detail.replaceChildren(html('h3', { textContent: sys.title, style: `color: ${color(id)}` }),
          html('p', { className: 'hint', textContent: `Reached only by ${sys.reachedBy}, over MCP. Fictional data.` }),
          dl([['status', sysState(id).text.replace(/^\S+ /, '')], ['last call', p.last ? `${p.last.label} (${clock(p.last.at)})` : 'none yet']]),
          html('h4', { textContent: 'Tools' }), html('ul', { className: 'dest-list' }, ...sys.tools.map((tool) => html('li', { textContent: tool }))));
        return;
      }
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
        const dests = html('ul', { className: 'dest-list' }, ...(hub?.destinations ?? []).map((d) => html('li', {}, html('strong', { textContent: d.destination }), ` → ${d.workerName}${d.audience === 'staff' ? ' — staff only' : ''} `, html('span', { className: 'hint', textContent: `(${STATUS[state.specialists[d.worker]?.status]?.[1] ?? 'unknown'})` }))));
        detail.replaceChildren(head, dl([['status', text], ['public name', hub?.name], ['router', hub?.router ? `${hub.router.mode}${hub.router.model ? ` (${hub.router.model})` : ''}` : null], ['relaying now', relaying(state.active)], ['telemetry', state.hubFeed ? 'connected' : 'lost']]),
          html('h4', { textContent: 'Destinations (server-owned)' }), dests,
          html('p', { className: 'hint', textContent: state.snapshot?.trust ?? '' }));
      } else {
        const s = state.specialists[id] ?? {};
        detail.replaceChildren(head, dl([['status', text], ['serves', s.audience === 'staff' ? 'university staff only (the Hub’s signed staff path; students never reach it)' : s.audience ? 'students, through the Hub' : null], ['registered', s.registered === undefined ? null : s.registered ? 'yes' : 'no'], ['enabled', s.enabled === null || s.enabled === undefined ? null : s.enabled ? 'yes' : 'no'], ['reachable', s.reachable === null || s.reachable === undefined ? 'not checked yet' : s.reachable ? 'yes' : 'no'],
          ['last heartbeat', s.lastHeartbeatAt ? `${clock(s.lastHeartbeatAt)} (${ago(s.lastHeartbeatAt)})` : 'none'], ['card revision', s.revision], ['instance', s.instance], ['in flight', state.active[id]], ['last error', s.lastError]]),
          html('h4', { textContent: 'Skills the Hub routes on' }), html('ul', { className: 'dest-list' }, ...(s.skills ?? []).map((k) => html('li', { textContent: k.name }))));
      }
    } else if (sel.kind === 'edge') {
      const [a, b] = EDGES[sel.id];
      const events = state.edgeEvents[sel.id];
      detail.replaceChildren(html('h3', { textContent: `${NODES[a].name} ↔ ${NODES[b].name}` }), html('p', { className: 'hint', textContent: EDGE_KIND(sel.id) === 'model' ? 'HTTPS calls from the agent to its model provider (not A2A). Latest events on this connection:' : EDGE_KIND(sel.id) === 'mcp' ? `MCP tool calls from ${SYSTEMS[SYSTEM_OF_EDGE[sel.id]].reachedBy} to ${NODES[b].name} (demo stand-in), not A2A. Latest events on this connection:` : 'A2A JSON-RPC over localhost. Latest events on this connection:' }),
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
    // The latest MCP session state per system, from the hello (event type → status). Session events are published only
    // on a change, so on a long-running server they may no longer be in the replayed history.
    sessions(map) {
      for (const [id, sys] of Object.entries(SYSTEMS)) {
        const st = map?.[sys.sessionEvent];
        if (st) state.sys[id].session = st === 'connected' || st === 'not_configured' ? st : 'unreachable';
      }
      renderNodes();
    },
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
      // New conversation: no call is shown as running or just saved (an answer still on its way is ignored).
      for (const p of Object.values(state.sys)) {
        p.last = null;
        p.inFlight = 0;
        p.savedUntil = 0;
        clearTimeout(p.maxTimer);
        clearTimeout(p.savedTimer);
      }
      restFocus();
      renderNodes();
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
      // A label for a connection this page doesn't draw (a newer server) is ignored, not allowed to break the
      // stream: before Part 15's drawing, an hr-peoplesoft label threw here and stalled the page's live view.
      if (ev.topo?.edge && !EDGES[ev.topo.edge]) ev.topo = null;
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
      // A system (PeopleSoft, Canvas LMS): the MCP session its agent reported, and the last tool call (labels only).
      if (t?.edge && SYSTEM_OF_EDGE[t.edge]) {
        const sysState = state.sys[SYSTEM_OF_EDGE[t.edge]];
        if (ev.type === SYSTEMS[SYSTEM_OF_EDGE[t.edge]].sessionEvent) sysState.session = t.phase === 'completed' ? 'connected' : ev.data?.status === 'not_configured' ? 'not_configured' : 'unreachable';
        if (t.category === 'tool') {
          sysState.last = { label: t.label, at: ev.at };
          if (t.phase === 'completed') sysState.session = 'connected'; // the system answered over the session
        }
      }
      if (ev.source === 'hub' && ev.type === 'route_decided' && ev.runId) {
        const tr = trace(ev.runId);
        tr.destination = ev.data.decision === 'route' ? ev.data.destination : `not routed (${ev.data.decision})`;
        renderTraceOptions();
        // rows already listed for this run were named before the Hub had routed it: rename them
        for (const b of list.querySelectorAll(`li[data-run="${CSS.escape(ev.runId)}"] .ev-trace`)) b.textContent = traceName(ev.runId);
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
          leaveFunctionUnless(known(tr.nodes)); // the selected trace reached a part outside the chosen function
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
