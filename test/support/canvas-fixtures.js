// Part 16: shared fixtures for the Faculty -> Canvas link tests.
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../../src/quiz-rules.js';
import { startCanvas } from './harness.js';

export const NOW = '2026-11-04T18:00:00Z';
export const canvasEnv = (token, extra = {}) => ({ CANVAS_TOKEN: token, CANVAS_TEST_HOOKS: '1', CANVAS_NOW: NOW, CANVAS_MODE: 'mock', ...extra });
export const newToken = () => randomUUID().replace(/-/g, '');
export function validQuiz(topic = 8) {
  const questions = [1, 2, 3, 4, 5].map((n) => ({
    text: `Sample question number ${n} about the marketing topic?`,
    answers: [`First option ${n}`, `Second option ${n}`, `Third option ${n}`, `Fourth option ${n}`],
    correct: n % 4,
  }));
  return { topic, ...defaultSettings(topic, new Date(NOW)), questions };
}
export async function canvasRecords(canvas) {
  return (await (await fetch(`${canvas.url}/test/quizzes`)).json()).quizzes;
}
export async function startTestCanvas(token, extra = {}) {
  return startCanvas(canvasEnv(token, extra));
}
export function recorder() {
  const events = [];
  return { events, emit: (type, runId, data) => events.push({ type, runId, data }), ofType: (t) => events.filter((e) => e.type === t) };
}
