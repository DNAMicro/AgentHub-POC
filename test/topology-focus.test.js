// Part 21: the Topology's focus helpers — which parts one kind of request uses, and the frame around a set of parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FUNCTIONS, inFunction, extent, frameOf } from '../public/topology-focus.js';

// The real layout, read from the page's own code so the test follows it.
const src = readFileSync(new URL('../public/topology.js', import.meta.url), 'utf8');
const NODES = new Function(`return ${src.slice(src.indexOf('const NODES = {') + 'const NODES = '.length, src.indexOf('};\nconst EDGES') + 1)}`)();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const FULL = /id="topo" class="topo" viewBox="([\d ]+)"/.exec(html)[1].split(' ').map(Number);
const ids = (fn) => Object.keys(NODES).filter((id) => inFunction(fn, id, NODES));
const inside = (frame, id) => {
  const n = NODES[id];
  const e = extent(n);
  return n.x - e.l >= frame[0] && n.x + e.r <= frame[0] + frame[2] && n.y - e.t >= frame[1] && n.y + e.b <= frame[1] + frame[3];
};

test('focus: the layout was read (17 parts in a 845 × 959 drawing)', () => {
  assert.equal(Object.keys(NODES).length, 17);
  assert.deepEqual(FULL, [0, 0, 845, 959]);
});

test('focus: every part, with its pill and caption, is inside the drawing', () => {
  for (const id of Object.keys(NODES)) assert.ok(inside(FULL, id), `${id} is inside the drawing`);
});

test('focus: a function is its agents, each with its own model box, and the record system it uses', () => {
  assert.deepEqual(Object.keys(FUNCTIONS), ['tutoring', 'library', 'course', 'timeoff', 'roster']);
  assert.deepEqual(ids('tutoring').sort(), ['hub', 'llm-hub', 'llm-student', 'llm-tutor', 'student', 'tutor']);
  assert.deepEqual(ids('library').sort(), ['hub', 'library', 'llm-hub', 'llm-library', 'llm-student', 'student']);
  assert.deepEqual(ids('course').sort(), ['canvas', 'hub', 'llm-hub', 'llm-professor', 'llm-student', 'professor', 'student']);
  assert.deepEqual(ids('timeoff').sort(), ['hr', 'hub', 'llm-hr', 'llm-hub', 'llm-professor', 'peoplesoft', 'professor']);
  assert.deepEqual(ids('roster').sort(), ['chrs', 'hub', 'llm-chrs', 'llm-hub', 'llm-professor', 'professor', 'studentdb']);
  assert.equal(inFunction('timeoff', 'student', NODES), false);
  assert.equal(inFunction('nope', 'hub', NODES), false);
  assert.equal(inFunction('roster', 'llm-nobody', NODES), false);
  for (const f of Object.values(FUNCTIONS)) for (const part of f.parts) assert.ok(NODES[part], `${part} is drawn`);
});

test('focus: every function has a button on the page, and the first button shows everything', () => {
  const buttons = [...html.matchAll(/data-function="([a-z]*)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['', ...Object.keys(FUNCTIONS)]);
  for (const f of Object.values(FUNCTIONS)) assert.ok(html.includes(`>${f.label}</button>`), f.label);
});

test('focus: a frame holds every listed part whole and stays inside the drawing', () => {
  for (const set of [...Object.keys(FUNCTIONS).map(ids), ['student', 'hub'], Object.keys(NODES)]) {
    const f = frameOf(set, NODES, FULL);
    for (const id of set) assert.ok(inside(f, id), `${id} is inside ${f} for ${set}`);
    assert.ok(f[0] >= 0 && f[1] >= 0 && f[0] + f[2] <= FULL[2] && f[1] + f[3] <= FULL[3], `${f} is inside the drawing`);
  }
});

test('focus: the staff functions zoom in well; a function that spans the map does not pretend to', () => {
  for (const fn of ['timeoff', 'roster']) {
    const f = frameOf(ids(fn), NODES, FULL);
    assert.ok(f[2] <= 660 && f[3] <= 720, `${fn} closes in: ${f}`);
  }
  assert.ok(frameOf(ids('course'), NODES, FULL)[2] > 800, 'Course and quizzes runs from the Student to Canvas: full width');
});

test('focus: nothing to show, or parts the page does not draw, give the whole drawing; one part gets some room', () => {
  assert.deepEqual(frameOf([], NODES, FULL), FULL);
  assert.deepEqual(frameOf(['model', undefined], NODES, FULL), FULL);
  const one = frameOf(['tutor'], NODES, FULL);
  assert.deepEqual(one.slice(2), [420, 320]);
  assert.ok(inside(one, 'tutor') && one[1] >= 0);
});
