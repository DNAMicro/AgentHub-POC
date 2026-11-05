// Student records' own AI (a DEMO STAND-IN for PeopleSoft student records): it plans which steps to run from a fixed menu.
// Model proposes, code decides: unknown picks are dropped, required steps are always added, and the order is the
// menu's. Who may see the roster and the roster itself never come from here.
//
// STUDENT_RECORDS_MODE (read at import, like CHRS_MODE):
//   mock  (default)  a labelled heuristic, no network
//   live             one Claude call (maxRetries 0, no fallback model, no canned answers except the failure plan below)
import { TIMEOUTS } from './timeouts.js';
import { modelName, callModel, keyConfigured, loadDotenvOnce, toLlmError } from './llm.js';

export const STUDENT_RECORDS_MODE = process.env.STUDENT_RECORDS_MODE ?? 'mock';
if (!['mock', 'live'].includes(STUDENT_RECORDS_MODE)) throw new Error(`Unknown STUDENT_RECORDS_MODE "${STUDENT_RECORDS_MODE}" (use mock or live).`);
if (STUDENT_RECORDS_MODE === 'live') loadDotenvOnce();

export const STEP_MENU = ['check_instructor', 'check_term', 'read_enrollment', 'mask_private_fields'];
export const REQUIRED_STEPS = ['check_instructor', 'read_enrollment', 'mask_private_fields'];

const MOCK_LABEL = 'mock heuristic';
// < CHRS's MCP call timeout, which waits on this inside get_class_roster (src/timeouts.js).
const LIMITS = { maxOutputTokens: 400, timeoutMs: Number(process.env.STUDENT_RECORDS_MODEL_TIMEOUT_MS ?? TIMEOUTS.studentRecordsPlannerMs) };
const PURPOSE = 'plan student records steps';
const SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string', enum: STEP_MENU } } },
  required: ['steps'],
  additionalProperties: false,
};
const SYSTEM = [
  'You are the scheduling brain of a demo student-records system (a stand-in for PeopleSoft student records).',
  'You get one class-roster request (a course id). Pick which OPTIONAL steps to run, using only the menu.',
  'Optional step: check_term (confirm the term is the current one).',
  'The required steps (check_instructor, read_enrollment, mask_private_fields) are always run by code; you may list them or not.',
  'Return only the steps array.',
].join('\n');

export const studentRecordsStatus = () => ({ mode: STUDENT_RECORDS_MODE, model: STUDENT_RECORDS_MODE === 'live' ? modelName() : MOCK_LABEL, keyConfigured: STUDENT_RECORDS_MODE === 'live' ? keyConfigured() : null });

// Every required or picked menu item, once, in menu order. Unknown picks are dropped.
const finish = (picked) => {
  const wanted = new Set([...REQUIRED_STEPS, ...(Array.isArray(picked) ? picked : [])]);
  return STEP_MENU.filter((s) => wanted.has(s));
};

export async function planSteps({ request, emit = () => {} }) {
  if (STUDENT_RECORDS_MODE === 'mock') return { steps: finish(['check_term']), by: 'mock', model: MOCK_LABEL };

  const failed = (model = modelName()) => ({ steps: finish([]), by: 'model_failed', model });
  if (!keyConfigured()) return failed();
  emit('model_call_started', { model: modelName(), mode: 'live', purpose: PURPOSE, earlierMessages: 0 });
  const started = Date.now();
  let result;
  try {
    const { courseId } = request ?? {};
    result = await callModel({
      system: SYSTEM,
      messages: [{ role: 'user', content: `<request>\n${JSON.stringify({ courseId })}\n</request>` }],
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
