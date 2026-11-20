// Part 21: what the Topology shows large. Pure helpers (no DOM, no imports) so node:test can check them:
// which parts belong to a side of campus (a "lens"), and the tightest frame around a set of parts.
// The frame is a viewBox [x, y, width, height]; the page animates the SVG's viewBox to it.

// A side of campus = some agents, each with its own model box. The record systems (not agents) are
// reached only by staff-side agents, so they belong to the staff side.
export const LENSES = {
  student: { label: 'Student services', agents: ['student', 'hub', 'tutor', 'library', 'professor'], systems: false },
  staff: { label: 'Staff services', agents: ['hub', 'professor', 'hr', 'chrs'], systems: true },
};

export function inLens(lens, id, nodes) {
  const L = LENSES[lens];
  const n = nodes[id];
  if (!L || !n) return false;
  if (n.kind === 'system') return L.systems;
  return L.agents.includes(n.owner ?? id);
}

// How far a part's drawing reaches from its centre, including its status pill and the caption that
// flashes next to it (public/topology.js draws them at these offsets).
export function extent(n) {
  if (n.kind === 'system') return { l: n.w / 2 + 8, r: n.w / 2 + 8, t: n.h / 2 + 8, b: 78 }; // pill below the tile
  if (n.w) return { l: n.w / 2 + 8, r: n.w / 2 + 8, t: n.h / 2 + 24, b: n.h / 2 + 8 }; // model box, caption above
  const side = Math.max(n.r + 10, 64); // the status pill is 124 wide
  return { l: side, r: side, t: n.r + 32, b: n.r + 40 }; // caption above, pill below
}

// The tightest frame that shows every listed part, kept inside the full drawing. A lone part gets a
// little room around it (minW × minH) so one shape never fills the whole picture.
export function frameOf(ids, nodes, full, { pad = 12, minW = 420, minH = 320 } = {}) {
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
