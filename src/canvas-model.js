// Canvas's own AI (a DEMO STAND-IN, not real Canvas): it plans which steps to run from a fixed menu when a quiz is
// saved. Model proposes, code decides: unknown picks are dropped, required steps are always added, store_quiz is
// always last. Checks, dates, points and pass/fail never come from here. The model sees counts and settings only —
// never the question text, answers or title.
//
// CANVAS_MODE (read at import, like PEOPLESOFT_MODE):
//   mock  (default)  a labelled heuristic, no network
//   live             one Claude call (maxRetries 0, no fallback model, no canned answers except the failure plan below)
import { TIMEOUTS } from './timeouts.js';
import { modelName, callModel, keyConfigured, loadDotenvOnce, toLlmError } from './llm.js';

export const CANVAS_MODE = process.env.CANVAS_MODE ?? 'mock';
if (!['mock', 'live'].includes(CANVAS_MODE)) throw new Error(`Unknown CANVAS_MODE "${CANVAS_MODE}" (use mock or live).`);
if (CANVAS_MODE === 'live') loadDotenvOnce();

export const STEP_MENU = ['check_questions', 'check_settings', 'check_due_date', 'check_course', 'set_unpublished', 'store_quiz'];
export const REQUIRED_STEPS = ['check_questions', 'check_settings', 'check_due_date', 'store_quiz'];

const MOCK_LABEL = 'mock heuristic';
// < the caller's MCP call timeout, which waits on this inside create_quiz (src/timeouts.js).
const LIMITS = { maxOutputTokens: 400, timeoutMs: Number(process.env.CANVAS_MODEL_TIMEOUT_MS ?? TIMEOUTS.canvasPlannerMs) };
const PURPOSE = 'plan Canvas steps';
const SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string', enum: STEP_MENU } } },
  required: ['steps'],
  additionalProperties: false,
};
const SYSTEM = [
  'You are the scheduling brain of a demo course-site system (a stand-in for Canvas LMS).',
  'You get the shape of one new quiz (question count, points, minutes, attempts). Pick which OPTIONAL steps to run, using only the menu.',
  'Optional steps: check_course (confirm the course exists), set_unpublished (save the quiz as a draft students cannot see).',
  'The required steps (check_questions, check_settings, check_due_date, store_quiz) are always run by code; you may list them or not.',
  'Return only the steps array.',
].join('\n');

export const canvasStatus = () => ({ mode: CANVAS_MODE, model: CANVAS_MODE === 'live' ? modelName() : MOCK_LABEL, keyConfigured: CANVAS_MODE === 'live' ? keyConfigured() : null });

// Every required or picked menu item, once, in menu order (store_quiz is last in the menu). Unknown picks are dropped.
const finish = (picked) => {
  const wanted = new Set([...REQUIRED_STEPS, ...(Array.isArray(picked) ? picked : [])]);
  return STEP_MENU.filter((s) => wanted.has(s));
};

export async function planSteps({ quiz, emit = () => {} }) {
  if (CANVAS_MODE === 'mock') return { steps: finish(['check_course', 'set_unpublished']), by: 'mock', model: MOCK_LABEL };

  const failed = (model = modelName()) => ({ steps: finish(['set_unpublished']), by: 'model_failed', model });
  if (!keyConfigured()) return failed();
  emit('model_call_started', { model: modelName(), mode: 'live', purpose: PURPOSE, earlierMessages: 0 });
  const started = Date.now();
  let result;
  try {
    const shape = { questionCount: Array.isArray(quiz?.questions) ? quiz.questions.length : null, pointsEach: quiz?.pointsEach, minutes: quiz?.minutes, attempts: quiz?.attempts };
    result = await callModel({
      system: SYSTEM,
      messages: [{ role: 'user', content: `<quiz>\n${JSON.stringify(shape)}\n</quiz>` }],
      maxTokens: LIMITS.maxOutputTokens, timeoutMs: LIMITS.timeoutMs, schema: SCHEMA,
    });
  } catch (err) {
    const mapped = toLlmError(err);
    emit('model_call_failed', { purpose: PURPOSE, mode: 'live', model: modelName(), code: mapped.code, message: mapped.message, latencyMs: Date.now() - started, requestId: mapped.requestId });
    return failed();
  }
  emit('model_response_received', { purpose: PURPOSE, mode: 'live', model: result.model, latencyMs: Date.now() - started, usage: result.usage, stopReason: result.stopReason, requestId: result.requestId });
  return { steps: finish(result.parsed?.steps), by: 'model', model: result.model };
}
