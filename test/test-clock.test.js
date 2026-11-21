// The test clock: <NAME>_NOW pins "now" only together with <NAME>_TEST_HOOKS=1, so a real run can never be pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nowFn, pinnedNow, professorNow } from '../src/test-clock.js';

const NOW = '2026-11-04T20:00:00Z';

test('HR_NOW pins the HR clock only with HR_TEST_HOOKS=1', () => {
  assert.equal(pinnedNow('HR', { HR_NOW: NOW }), null, 'ignored without the test hook');
  assert.equal(pinnedNow('HR', { HR_TEST_HOOKS: '1' }), null, 'nothing to pin');
  assert.equal(pinnedNow('HR', { HR_TEST_HOOKS: '1', HR_NOW: NOW }), Date.parse(NOW));
  assert.equal(nowFn({ HR_TEST_HOOKS: '1', HR_NOW: NOW }, 'HR')().toISOString(), '2026-11-04T20:00:00.000Z');
  assert.ok(Math.abs(nowFn({ HR_NOW: NOW }, 'HR')().getTime() - Date.now()) < 5000, 'the real clock without the hook');
});

test('one process’s pin never moves another’s clock', () => {
  assert.equal(pinnedNow('HR', { PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: NOW }), null);
  assert.equal(professorNow({ PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: NOW }), Date.parse(NOW));
  assert.equal(professorNow({ HR_TEST_HOOKS: '1', HR_NOW: NOW }), null);
});

test('a value that is not a strict ISO date-time stops startup', () => {
  for (const bad of ['tomorrow', '2026-11-04', '2026-13-40T99:00:00Z']) {
    assert.throws(() => pinnedNow('HR', { HR_TEST_HOOKS: '1', HR_NOW: bad }), /HR_NOW must be an ISO date-time/, bad);
  }
});
