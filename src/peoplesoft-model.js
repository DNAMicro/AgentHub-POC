// PeopleSoft's own AI (a DEMO STAND-IN, not the real PeopleSoft): it plans which steps to run from a fixed menu.
// Model proposes, code decides: unknown picks are dropped, required steps are always added, and the order is the
// menu's. Dates, hours, balances and pass/fail never come from here.
//
// PEOPLESOFT_MODE (read at import, like HR_MODE):
//   mock  (default)  a labelled heuristic, no network
//   live             one Claude call (maxRetries 0, no fallback model, no canned answers except the failure plan below)
import { TIMEOUTS } from './timeouts.js';
import { modelName, callModel, keyConfigured, loadDotenvOnce, toLlmError } from './llm.js';

export const PEOPLESOFT_MODE = process.env.PEOPLESOFT_MODE ?? 'mock';
if (!['mock', 'live'].includes(PEOPLESOFT_MODE)) throw new Error(`Unknown PEOPLESOFT_MODE "${PEOPLESOFT_MODE}" (use mock or live).`);
if (PEOPLESOFT_MODE === 'live') loadDotenvOnce();

export const STEP_MENU = ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'apply_leave_policy', 'route_to_manager', 'notify_timekeeper', 'store_record'];
export const REQUIRED_STEPS = ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'store_record'];

const MOCK_LABEL = 'mock heuristic';
// < HR's MCP call timeout, which waits on this inside create_absence_request (src/timeouts.js).
const LIMITS = { maxOutputTokens: 400, timeoutMs: Number(process.env.PEOPLESOFT_MODEL_TIMEOUT_MS ?? TIMEOUTS.peoplesoftPlannerMs) };
const PURPOSE = 'plan PeopleSoft steps';
const SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string', enum: STEP_MENU } } },
  required: ['steps'],
  additionalProperties: false,
};
const SYSTEM = [
  'You are the scheduling brain of a demo HR records system (a stand-in for PeopleSoft).',
  'You get one time-off request (absence type, dates, hours). Pick which OPTIONAL steps to run, using only the menu.',
  'Optional steps: apply_leave_policy (check the leave policy for this absence type), route_to_manager (send for manager approval), notify_timekeeper (tell the timekeeper).',
  'The required steps (check_balance, check_dates_and_holidays, check_overlap, store_record) are always run by code; you may list them or not.',
  'Return only the steps array.',
].join('\n');

export const peoplesoftStatus = () => ({ mode: PEOPLESOFT_MODE, model: PEOPLESOFT_MODE === 'live' ? modelName() : MOCK_LABEL, keyConfigured: PEOPLESOFT_MODE === 'live' ? keyConfigured() : null });

// Every required or picked menu item, once, in menu order. Unknown picks are dropped.
const finish = (picked) => {
  const wanted = new Set([...REQUIRED_STEPS, ...(Array.isArray(picked) ? picked : [])]);
  return STEP_MENU.filter((s) => wanted.has(s));
};

export async function planSteps({ request, emit = () => {} }) {
  if (PEOPLESOFT_MODE === 'mock') return { steps: finish(['apply_leave_policy', 'route_to_manager']), by: 'mock', model: MOCK_LABEL };

  const failed = (model = modelName()) => ({ steps: finish(['route_to_manager']), by: 'model_failed', model });
  if (!keyConfigured()) return failed();
  emit('model_call_started', { model: modelName(), mode: 'live', purpose: PURPOSE, earlierMessages: 0 });
  const started = Date.now();
  let result;
  try {
    const { absenceType, beginDate, endDate, hours } = request ?? {};
    result = await callModel({
      system: SYSTEM,
      messages: [{ role: 'user', content: `<request>\n${JSON.stringify({ absenceType, beginDate, endDate, hours })}\n</request>` }],
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
