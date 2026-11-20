// Part 21: the Topology's focus helpers — which parts belong to a side of campus, and the frame around a set of parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LENSES, inLens, extent, frameOf } from '../public/topology-focus.js';

// The real layout, read from the page's own code so the test follows it.
const src = readFileSync(new URL('../public/topology.js', import.meta.url), 'utf8');
const NODES = new Function(`return ${src.slice(src.indexOf('const NODES = {') + 'const NODES = '.length, src.indexOf('};\nconst EDGES') + 1)}`)();
const FULL = [0, 0, 1100, 1285];
const ids = (lens) => Object.keys(NODES).filter((id) => inLens(lens, id, NODES));
const inside = (frame, id) => {
  const n = NODES[id];
  const e = extent(n);
  return n.x - e.l >= frame[0] && n.x + e.r <= frame[0] + frame[2] && n.y - e.t >= frame[1] && n.y + e.b <= frame[1] + frame[3];
};

test('focus: the layout was read (17 parts)', () => assert.equal(Object.keys(NODES).length, 17));

test('focus: the student side is five agents and their model boxes, no record system', () => {
  assert.deepEqual(ids('student').sort(), ['hub', 'library', 'llm-hub', 'llm-library', 'llm-professor', 'llm-student', 'llm-tutor', 'professor', 'student', 'tutor']);
});

test('focus: the staff side is four agents, their model boxes and the three record systems', () => {
  assert.deepEqual(ids('staff').sort(), ['canvas', 'chrs', 'hr', 'hub', 'llm-chrs', 'llm-hr', 'llm-hub', 'llm-professor', 'peoplesoft', 'professor', 'studentdb']);
  assert.equal(inLens('staff', 'student', NODES), false);
  assert.equal(inLens('nope', 'hub', NODES), false);
  assert.equal(inLens('staff', 'llm-nobody', NODES), false);
  assert.deepEqual(Object.keys(LENSES), ['student', 'staff']);
});

test('focus: a frame holds every listed part whole, stays inside the drawing, and is smaller than it', () => {
  for (const set of [['student', 'hub'], ['hub', 'professor', 'llm-professor', 'canvas'], ['hub', 'hr', 'llm-hr', 'peoplesoft'], ids('staff'), ids('student'), Object.keys(NODES)]) {
    const f = frameOf(set, NODES, FULL);
    for (const id of set) assert.ok(inside(f, id), `${id} is inside ${f} for ${set}`);
    assert.ok(f[0] >= 0 && f[1] >= 0 && f[0] + f[2] <= 1100 && f[1] + f[3] <= 1285, `${f} is inside the drawing`);
  }
  const quiz = frameOf(['hub', 'professor', 'llm-professor', 'canvas'], NODES, FULL);
  assert.ok(quiz[2] < 800 && quiz[3] < 420, `a quiz save zooms in well: ${quiz}`);
});

test('focus: nothing to show, or parts the page does not draw, give the whole drawing; one part gets some room', () => {
  assert.deepEqual(frameOf([], NODES, FULL), FULL);
  assert.deepEqual(frameOf(['model', undefined], NODES, FULL), FULL);
  const one = frameOf(['tutor'], NODES, FULL);
  assert.deepEqual(one.slice(2), [420, 320]);
  assert.ok(inside(one, 'tutor') && one[1] >= 0);
});
