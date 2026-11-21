// Part 21: what the Topology brings forward. Pure helpers (no DOM, no imports) so node:test can check them:
// which parts one kind of request uses (a "function"), and the tightest frame around a set of parts.
// The frame is a viewBox [x, y, width, height]; the page animates the SVG's viewBox to it.

// A function = the parts one kind of request uses. Each agent's own model box comes with its agent.
export const FUNCTIONS = {
  tutoring: { label: 'Tutoring', parts: ['student', 'hub', 'tutor'] },
  library: { label: 'Library', parts: ['student', 'hub', 'library'] },
  course: { label: 'Course and quizzes', parts: ['student', 'hub', 'professor', 'canvas'] },
  timeoff: { label: 'Time off', parts: ['professor', 'hub', 'hr', 'peoplesoft'] },
  roster: { label: 'Class roster', parts: ['professor', 'hub', 'chrs', 'studentdb'] },
};

export function inFunction(fn, id, nodes) {
  const F = FUNCTIONS[fn];
  const n = nodes[id];
  if (!F || !n) return false;
  return F.parts.includes(n.owner ?? id);
}

// How far a part's drawing reaches from its centre, including what appears when it is in use: the status pill,
// the line under it, and the caption that flashes above it (public/topology.js draws them at these offsets).
export function extent(n) {
  if (n.kind === 'system') return { l: n.w / 2 + 8, r: n.w / 2 + 8, t: n.h / 2 + 26, b: 80 }; // caption above, pill below
  if (n.w) return { l: n.w / 2 + 8, r: n.w / 2 + 8, t: n.h / 2 + 8, b: n.h / 2 + 8 }; // a model box carries no words
  const side = Math.max(n.r + 10, 100); // the line under the pill (role and heartbeat) is about 200 wide
  return { l: side, r: side, t: n.r + 34, b: n.r + 62 }; // caption above; pill and one line below
}

// The tightest frame that shows every listed part, kept inside the full drawing. A lone part gets a
// little room around it (minW × minH) so one shape never fills the whole picture.
export function frameOf(ids, nodes, full, { pad = 10, minW = 420, minH = 320 } = {}) {
  const parts = [...ids].map((id) => nodes[id]).filter(Boolean);
  if (!parts.length) return full.slice();
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const n of parts) {
    const e = extent(n);
    x1 = Math.min(x1, n.x - e.l); x2 = Math.max(x2, n.x + e.r);
    y1 = Math.min(y1, n.y - e.t); y2 = Math.max(y2, n.y + e.b);
  }
  x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
  const [fx, fy, fw, fh] = full;
  const w = Math.min(fw, Math.max(x2 - x1, minW));
  const h = Math.min(fh, Math.max(y2 - y1, minH));
  // Grow around the middle, then slide back inside the drawing.
  const x = Math.min(Math.max((x1 + x2) / 2 - w / 2, fx), fx + fw - w);
  const y = Math.min(Math.max((y1 + y2) / 2 - h / 2, fy), fy + fh - h);
  return [x, y, w, h].map(Math.round);
}

// “Follow the conversation”, before one function fits: which parts the frame should hold for the parts a turn has
// touched so far. One specialist in play → that specialist with everything it connects to (the Hub, its own model,
// its record system), so the frame is already where the turn can go next and does not chase each hop. No specialist
// yet (the request is still being routed) or more than one → null: show the whole campus.
export function turnParts(trail, nodes, edges, specialists) {
  const ends = Object.values(edges);
  const agentOf = (id) => {
    const n = nodes[id];
    if (!n) return null;
    if (n.owner) return n.owner;
    if (n.kind === 'system') { const e = ends.find((pair) => pair.includes(id)); return e ? e.find((x) => x !== id) : id; }
    return id;
  };
  const agents = new Set([...trail].map(agentOf).filter((id) => specialists.includes(id)));
  if (agents.size !== 1) return null;
  const [agent] = agents;
  const around = ends.filter((pair) => pair.includes(agent)).map((pair) => pair.find((x) => x !== agent));
  return [...new Set([agent, ...around, ...trail])];
}
