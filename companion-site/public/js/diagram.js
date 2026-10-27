// One architecture diagram for all nine steps. Every component and connection has a FIXED place, name
// and color here; a step only says which of them exist and whether each one was added, modified,
// removed or left unchanged (shown with a tag and a border style as well as color). Pure SVG, no library.
const SVG = 'http://www.w3.org/2000/svg';

// viewBox 1200 × 640. Top band: the external model service. Middle: your machine (127.0.0.1).
// Bottom band: files on disk. Labels sit in the gaps between components, never on them.
export const VIEW = { w: 1200, h: 640, short: 556 };
export const NODES = {
  anthropic: { x: 228, y: 14, w: 952, h: 58, type: 'external', title: 'Anthropic Messages API', sub: 'Claude Haiku 5.5 · external service over HTTPS' },
  browser: { x: 22, y: 250, w: 152, h: 96, type: 'frontend', title: 'Browser', sub: 'the student’s view' },
  student: { x: 228, y: 250, w: 170, h: 96, type: 'agent', title: 'Student Agent', sub: 'A2A client' },
  hub: { x: 488, y: 250, w: 180, h: 96, type: 'agent', title: 'University Hub', sub: 'front door + router' },
  tutor: { x: 790, y: 124, w: 186, h: 88, type: 'agent', title: 'Tutor Agent', sub: 'A2A server' },
  library: { x: 790, y: 252, w: 186, h: 88, type: 'agent', title: 'Library Agent', sub: 'A2A server' },
  professor: { x: 790, y: 380, w: 186, h: 88, type: 'agent', title: 'Marketing 101 Professor', sub: 'A2A server' },
  storage: { x: 228, y: 566, w: 952, h: 58, type: 'storage', title: 'data/*.json', sub: 'git-ignored files on disk' },
};

// kind: a2a (agent-to-agent protocol, solid) · http (browser ↔ UI server) · sse (telemetry stream, dotted,
// watch-only) · https (model call, dashed) · file (disk, dash-dot). pts: the polyline; lx/ly: label spot.
export const EDGES = {
  browser_student: { from: 'browser', to: 'student', kind: 'http', pts: [[174, 282], [228, 282]], lx: 201, ly: 222, label: 'HTTP' },
  student_browser_sse: { from: 'student', to: 'browser', kind: 'sse', pts: [[228, 318], [174, 318]], lx: 201, ly: 372, label: 'SSE' },
  student_tutor: { from: 'student', to: 'tutor', kind: 'a2a', pts: [[398, 270], [430, 270], [430, 168], [790, 168]], lx: 729, ly: 152, label: 'A2A' },
  student_library: { from: 'student', to: 'library', kind: 'a2a', pts: [[398, 300], [790, 300]], lx: 729, ly: 316, label: 'A2A' },
  tutor_student_sse: { from: 'tutor', to: 'student', kind: 'sse', pts: [[790, 196], [414, 196], [414, 250]], lx: 729, ly: 210, label: 'SSE telemetry' },
  library_student_sse: { from: 'library', to: 'student', kind: 'sse', pts: [[790, 328], [398, 328]], lx: 729, ly: 344, label: 'SSE telemetry' },
  student_hub: { from: 'student', to: 'hub', kind: 'a2a', pts: [[398, 286], [488, 286]], lx: 443, ly: 222, label: 'A2A' },
  hub_student_sse: { from: 'hub', to: 'student', kind: 'sse', pts: [[488, 322], [398, 322]], lx: 443, ly: 372, label: 'SSE' },
  hub_tutor: { from: 'hub', to: 'tutor', kind: 'a2a', pts: [[668, 270], [714, 270], [714, 168], [790, 168]], lx: 740, ly: 136, label: 'A2A' },
  hub_library: { from: 'hub', to: 'library', kind: 'a2a', pts: [[668, 290], [790, 290]], lx: 729, ly: 276, label: 'A2A' },
  hub_professor: { from: 'hub', to: 'professor', kind: 'a2a', pts: [[668, 314], [714, 314], [714, 424], [790, 424]], lx: 740, ly: 486, label: 'A2A' },
  student_model: { from: 'student', to: 'anthropic', kind: 'https', pts: [[313, 250], [313, 72]], lx: 313, ly: 168, label: 'HTTPS' },
  hub_model: { from: 'hub', to: 'anthropic', kind: 'https', pts: [[578, 250], [578, 72]], lx: 578, ly: 168, label: 'HTTPS' },
  tutor_model: { from: 'tutor', to: 'anthropic', kind: 'https', pts: [[883, 124], [883, 72]], lx: 883, ly: 98, label: 'HTTPS' },
  library_model: { from: 'library', to: 'anthropic', kind: 'https', pts: [[976, 280], [1040, 280], [1040, 72]], lx: 1040, ly: 236, label: 'HTTPS' },
  professor_model: { from: 'professor', to: 'anthropic', kind: 'https', pts: [[976, 410], [1112, 410], [1112, 72]], lx: 1112, ly: 330, label: 'HTTPS' },
  student_storage: { from: 'student', to: 'storage', kind: 'file', pts: [[313, 346], [313, 566]], lx: 313, ly: 504, label: 'inbox' },
  hub_storage: { from: 'hub', to: 'storage', kind: 'file', pts: [[578, 346], [578, 566]], lx: 578, ly: 504, label: 'lessons' },
  library_storage: { from: 'library', to: 'storage', kind: 'file', pts: [[976, 322], [1010, 322], [1010, 566]], lx: 1010, ly: 532, label: 'loans' },
  professor_storage: { from: 'professor', to: 'storage', kind: 'file', pts: [[883, 468], [883, 566]], lx: 883, ly: 532, label: 'outbox' },
};

const TAG = { added: '+ NEW', modified: '~ CHANGED', removed: '✕ REMOVED' };
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};
const pathOf = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');

// Wraps a short label into at most two lines that fit `width` (rough per-character estimate).
function lines(text, width, size) {
  const max = Math.max(6, Math.floor(width / (size * 0.56)));
  const words = String(text).split(' ');
  const out = [''];
  for (const w of words) {
    const cur = out.at(-1);
    if (!cur) out[out.length - 1] = w;
    else if ((cur + ' ' + w).length <= max) out[out.length - 1] = `${cur} ${w}`;
    else if (out.length < 2) out.push(w);
    else { out[1] = `${out[1]} ${w}`; }
  }
  return out.map((l) => (l.length > max + 2 ? `${l.slice(0, max)}…` : l));
}

// state: { nodes: { id: { status, title?, sub? } }, edges: { id: { status, label? } } }
// status: unchanged | added | modified | removed | neutral. Removed items are drawn as ghosts.
// opts: { animate: bool (added draw in, removed fade, modified pulse), boundary: bool }
export function renderDiagram(svg, state, opts = {}) {
  svg.replaceChildren();
  // Without the storage band (Steps 1–7) the bottom strip would be empty: leave it out.
  const height = opts.height ?? (state.nodes?.storage ? VIEW.h : VIEW.short);
  svg.setAttribute('viewBox', `0 0 ${VIEW.w} ${height}`);
  const defs = el('defs');
  for (const kind of ['a2a', 'http', 'sse', 'https', 'file']) {
    const m = el('marker', { id: `arrow-${kind}-${svg.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,1 L9,5 L0,9 z', class: `arrowhead k-${kind}` }));
    defs.append(m);
  }
  svg.append(defs);
  // Trust boundary: everything local binds to 127.0.0.1; the model service is outside it.
  const b = el('g', { class: 'boundary' });
  b.append(el('rect', { x: 10, y: 92, width: 1180, height: 452, rx: 18 }));
  b.append(el('text', { x: 26, y: 118, class: 'boundary-label' }, 'Your machine · 127.0.0.1'));
  svg.append(b);

  const edgesG = el('g', { class: 'edges' });
  const labelsG = el('g', { class: 'edge-labels' });
  for (const [id, e] of Object.entries(EDGES)) {
    const s = state.edges?.[id];
    if (!s) continue;
    const status = s.status ?? 'unchanged';
    const g = el('g', { class: `edge k-${e.kind} st-${status}${opts.animate ? ' anim' : ''}`, 'data-id': id });
    const d = pathOf(e.pts);
    g.append(el('path', { d, class: 'edge-line', 'marker-end': status === 'removed' ? null : `url(#arrow-${e.kind}-${svg.id})`, pathLength: 100 }));
    edgesG.append(g);
    const text = `${TAG[status] ? `${TAG[status].split(' ')[0]} ` : ''}${s.label ?? e.label}`;
    const lg = el('g', { class: `edge-label k-${e.kind} st-${status}${opts.animate ? ' anim' : ''}`, 'data-id': id });
    const w = Math.min(240, 14 + text.length * 8.3);
    lg.append(el('rect', { x: e.lx - w / 2, y: e.ly - 13, width: w, height: 25, rx: 8 }));
    lg.append(el('text', { x: e.lx, y: e.ly + 5, 'text-anchor': 'middle' }, text));
    labelsG.append(lg);
  }
  svg.append(edgesG);

  const nodesG = el('g', { class: 'nodes' });
  for (const [id, n] of Object.entries(NODES)) {
    const s = state.nodes?.[id];
    if (!s) continue;
    const status = s.status ?? 'unchanged';
    const g = el('g', { class: `node t-${n.type} n-${id} st-${status}${opts.animate ? ' anim' : ''}`, 'data-id': id, transform: `translate(${n.x},${n.y})` });
    if (status === 'modified') g.append(el('rect', { x: -5, y: -5, width: n.w + 10, height: n.h + 10, rx: 16, class: 'node-outer' }));
    g.append(el('rect', { width: n.w, height: n.h, rx: n.type === 'storage' ? 26 : 12, class: 'node-box' }));
    const title = s.title ?? n.title;
    const band = n.type === 'external' || n.type === 'storage';
    const tl = lines(title, n.w - 20, 19);
    const first = band ? 26 : 32;
    tl.forEach((l, i) => g.append(el('text', { x: n.w / 2, y: first + i * 22, 'text-anchor': 'middle', class: 'node-title' }, l)));
    const sub = s.sub ?? n.sub;
    if (sub) {
      const top = first + (tl.length - 1) * 22 + 20;
      const room = band ? 1 : Math.max(1, Math.floor((n.h - top - 2) / 17) + 1);
      lines(sub, n.w - 14, 14).slice(0, room).forEach((l, i) => g.append(el('text', { x: n.w / 2, y: top + i * 17, 'text-anchor': 'middle', class: 'node-sub' }, l)));
    }
    if (TAG[status]) {
      const tw = TAG[status].length * 9 + 16;
      const tg = el('g', { class: 'node-tag', transform: `translate(8,-12)` });
      tg.append(el('rect', { width: tw, height: 24, rx: 12 }));
      tg.append(el('text', { x: tw / 2, y: 17, 'text-anchor': 'middle' }, TAG[status]));
      g.append(tg);
    }
    if (status === 'removed') g.append(el('line', { x1: 8, y1: n.h - 8, x2: n.w - 8, y2: 8, class: 'strike' }));
    nodesG.append(g);
  }
  svg.append(nodesG, labelsG);
  svg.append(el('g', { class: 'pulses' }));
}

// A point at fraction t (0..1) along an edge's polyline, in the given direction.
export function pointAlong(id, t, reverse = false) {
  const pts = reverse ? [...EDGES[id].pts].reverse() : EDGES[id].pts;
  const segs = pts.slice(1).map((p, i) => ({ a: pts[i], b: p, len: Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]) }));
  const total = segs.reduce((s, x) => s + x.len, 0);
  let d = Math.max(0, Math.min(1, t)) * total;
  for (const s of segs) {
    if (d <= s.len) return [s.a[0] + ((s.b[0] - s.a[0]) * d) / s.len, s.a[1] + ((s.b[1] - s.a[1]) * d) / s.len];
    d -= s.len;
  }
  return pts.at(-1);
}

// Neutral copy of a state (for walkthroughs): same pieces, no added/modified/removed styling.
export function neutral(state) {
  const pick = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v.status !== 'removed').map(([k, v]) => [k, { ...v, status: 'neutral' }]));
  return { nodes: pick(state.nodes), edges: pick(state.edges) };
}
