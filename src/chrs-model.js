// CHRS's AI (a staff-only service): it chooses which student-records MCP tool fits this moment. Same shape as HR's
// chooseTool (src/hr-model.js): the model returns a tool NAME only; code accepts it only if it is in the records
// server's tools/list and is the moment's own tool, and builds every argument itself. A failed call picks nothing
// (no fallback, no guessed tool): the caller then makes no records call.
//
// CHRS_MODE (read at import):
//   mock (default) — the labelled heuristic picks the moment's tool. No network. It proves plumbing, not judgment.
//   live           — one structured Claude call (maxRetries 0, no fallback model).
import { TIMEOUTS } from './timeouts.js';
import { callModel, keyConfigured, loadDotenvOnce, modelName, toLlmError } from './llm.js';

export const CHRS_MODE = process.env.CHRS_MODE ?? 'mock';
if (!['mock', 'live'].includes(CHRS_MODE)) throw new Error(`Unknown CHRS_MODE "${CHRS_MODE}" (use mock or live).`);
if (CHRS_MODE === 'live') loadDotenvOnce();

const LIMITS = { maxOutputTokens: 400, toolTimeoutMs: Number(process.env.CHRS_TOOL_CHOICE_TIMEOUT_MS ?? TIMEOUTS.chrsToolChoiceMs) };
const MOCK_LABEL = 'mock heuristic';
export const chrsStatus = () => ({ mode: CHRS_MODE, model: CHRS_MODE === 'live' ? modelName() : MOCK_LABEL, keyConfigured: CHRS_MODE === 'live' ? keyConfigured() : null });

// Which tool each moment may use. Today one moment: the instructor's class roster.
export const CHRS_MOMENT_TOOL = { roster: 'get_class_roster' };
const MOMENT_WORDS = { roster: 'look up the class roster (the class and the students enrolled) for the course\'s own instructor.' };
const PURPOSE = 'choose student records tool';
const toolSystem = (moment) => `You are CHRS, a university staff service. You reach PeopleSoft Campus Solutions (a demo stand-in) through MCP tools. Pick the ONE tool that does what CHRS needs right now, from the tools listed. Return only its name; code builds the arguments.
CHRS needs to: ${MOMENT_WORDS[moment]}`;

export async function chooseRecordsTool({ moment, tools = [], emit = () => {} }) {
  if (!MOMENT_WORDS[moment]) return { tool: null, by: 'model_failed', model: CHRS_MODE === 'live' ? modelName() : MOCK_LABEL };
  if (CHRS_MODE === 'mock') return { tool: tools.includes(CHRS_MOMENT_TOOL[moment]) ? CHRS_MOMENT_TOOL[moment] : null, by: 'mock', model: MOCK_LABEL };
  const failed = (model = modelName()) => ({ tool: null, by: 'model_failed', model });
  if (!keyConfigured() || !tools.length) return failed();
  emit('model_call_started', { model: modelName(), mode: 'live', purpose: PURPOSE, earlierMessages: 0 });
  const started = Date.now();
  let result;
  try {
    result = await callModel({
      system: toolSystem(moment),
      messages: [{ role: 'user', content: `Student records tools (from tools/list): ${tools.join(', ')}` }],
      maxTokens: LIMITS.maxOutputTokens, timeoutMs: LIMITS.toolTimeoutMs,
      schema: { type: 'object', properties: { tool: { type: 'string', enum: tools } }, required: ['tool'], additionalProperties: false },
    });
  } catch (err) {
    const mapped = toLlmError(err);
    emit('model_call_failed', { purpose: PURPOSE, mode: 'live', model: modelName(), code: mapped.code, message: mapped.message, latencyMs: Date.now() - started, requestId: mapped.requestId });
    return failed();
  }
  emit('model_response_received', { purpose: PURPOSE, mode: 'live', model: result.model, latencyMs: Date.now() - started, usage: result.usage, stopReason: result.stopReason, requestId: result.requestId });
  const tool = result.parsed?.tool;
  return { tool: typeof tool === 'string' && tools.includes(tool) ? tool : null, by: 'model', model: result.model };
}
