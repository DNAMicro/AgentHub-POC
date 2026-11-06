// Owner, 2026-11-05: "there should not be any models exposed". What a person reads (the Faculty view, the
// student's Conversation, the quiz card, the header pills, the faculty member's chat replies) never names a model or
// "the AI". Topology and Agent activity (the audience's technical panels) still show which model ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PERSON_FILES = ['public/classroom.js', 'public/quiz-ui.js', 'public/roster-ui.js', 'public/cancel-ui.js', 'public/message-ui.js', 'src/cancel-text.js', 'src/professor-message.js', 'src/professor-quiz.js', 'src/professor-roster.js', 'src/professor-staff.js', 'src/professor-canvas.js', 'src/quiz-model.js'];
const EXPOSED = /\bAI\b|claude-|\bHaiku\b/;

// String literals only (comments are code notes, not screen text).
function literals(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  return [...noComments.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
}

test('no model name or "AI" in any string a person can read', () => {
  for (const file of PERSON_FILES) {
    const hits = literals(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).filter((s) => EXPOSED.test(s));
    assert.deepEqual(hits, [], `${file} shows a model or "AI": ${hits.join(' | ')}`);
  }
});

test('the chat labels and header pills never append the model', () => {
  const classroom = readFileSync(new URL('../public/classroom.js', import.meta.url), 'utf8');
  assert.doesNotMatch(classroom, /Course assistant[^\n]*\$\{m\.model\}/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /`Tutor: live \(\$\{/);
  assert.doesNotMatch(app, /`Router: live \(\$\{/);
  assert.doesNotMatch(app, /model: fmtUsage\(data\.tutor\), outcome/); // the student's own chat bubble
});
