// Part 6: the issuing side of a workflow form, shared by Tutor and Library.
//
// An agent decides (from the student's request) to offer one of its own workflows; the host sends
// the registered A2UI template inside an A2A Task in INPUT_REQUIRED, then accepts only that
// workflow's allowlisted actions for that form. Server code validates and calls the agent's
// allowlisted handler; the handler's result is the authoritative answer sent back over A2A.
//
// In memory only: restarting the agent clears forms, results and deduplication records.
import { randomUUID } from 'node:crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import { A2UI_MIME_TYPE, A2UI_VERSION, BASIC_CATALOG_ID, WORKFLOWS, buildDelete, checkAction } from './forms.js';

const FORM_VERSION = 1;
const MAX_RECORDS = 1000;

const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const jsonPart = (value) => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
// A2A v1.0 Parts have a native mediaType; the A2UI extension spec names metadata.mimeType. Set both.
const a2uiPart = (messages) => ({ content: { $case: 'data', value: messages }, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '', mediaType: A2UI_MIME_TYPE });
const status = (state, message) => ({ state, message, timestamp: new Date().toISOString() });

// workflows: { [workflowId]: { build(surfaceId, { prefill, now }), offerText, actions: { [name]: async (form, context, tools) => result } } }
// result: { status: 'accepted' | 'updated' | 'rejected' | 'conflict' | 'cancelled', message, errors?, receipt?, a2ui?, values? }
export function createFormHost({ agentId, workflows, isEnabled, emitViz, log, logValues = () => '[values not logged]' }) {
  const forms = new Map(); // formId (= A2UI surfaceId) → { workflowId, version, taskId, contextId, state, stage, data }
  const operations = new Map(); // operationId → { formId, name, raw, result }
  const byRequest = new Map(); // `${contextId}|${messageId}` of the chat request → formId it produced
  const trim = (map) => { if (map.size > MAX_RECORDS) map.delete(map.keys().next().value); };

  const agentMessage = (ctx, parts, { taskId = '', metadata } = {}) =>
    ({ messageId: randomUUID(), contextId: ctx.contextId, taskId, role: Role.ROLE_AGENT, parts, metadata, extensions: [], referenceTaskIds: [] });

  // The student's client must have declared A2UI v0.9 basic-catalog support on this request.
  const clientSupportsForms = (incoming) => Boolean(incoming.metadata?.a2uiClientCapabilities?.[A2UI_VERSION]?.supportedCatalogIds?.includes(BASIC_CATALOG_ID));

  const openForm = (contextId, workflowId) => [...forms.entries()].find(([, f]) => f.contextId === contextId && f.workflowId === workflowId && f.state === 'awaiting_input')?.[0] ?? null;

  // Send a new form. `supersedes`: an open form of the same workflow the student explicitly asked to replace.
  // The same chat request seen again (retry/reconcile) gets the same open form back, never a second one.
  function issue(ctx, bus, { workflowId, prefill = {}, runId, intro, supersedes = null }) {
    const requestKey = `${ctx.contextId}|${ctx.userMessage.messageId}`;
    const earlier = forms.get(byRequest.get(requestKey));
    if (earlier?.state === 'awaiting_input') {
      bus.publish(AgentEvent.task({ id: earlier.taskId, contextId: earlier.contextId, status: status(TaskState.TASK_STATE_INPUT_REQUIRED, earlier.message), artifacts: [], history: [], metadata: earlier.message.metadata }));
      bus.finished();
      log('repeat request — re-sent the same form', { formId: earlier.message.metadata.formId });
      emitViz('form_sent', runId, { formId: earlier.message.metadata.formId, workflowId, repeat: true, taskId: earlier.taskId, contextId: earlier.contextId, messageId: earlier.message.messageId, a2uiMessages: earlier.a2uiCount });
      return earlier.message.metadata.formId;
    }
    const wf = workflows[workflowId];
    const formId = `${workflowId}-${randomUUID().slice(0, 8)}`;
    const a2ui = wf.build(formId, { prefill, now: new Date() });
    const prior = supersedes ? forms.get(supersedes) : null;
    if (prior) prior.state = 'superseded';
    const metadata = { runId, agentId, formId, workflowId, formVersion: FORM_VERSION, issuer: agentId, supersedes: prior ? supersedes : null, prefilled: Object.keys(prefill) };
    // The removal of a replaced form travels with the new one, as the standard A2UI deleteSurface.
    const parts = [textPart(intro), a2uiPart(a2ui), ...(prior ? [jsonPart({ supersedes, a2uiDelete: buildDelete(supersedes) })] : [])];
    const message = agentMessage(ctx, parts, { taskId: ctx.taskId, metadata });
    forms.set(formId, { workflowId, version: FORM_VERSION, taskId: ctx.taskId, contextId: ctx.contextId, state: 'awaiting_input', stage: 'edit', data: {}, message, a2uiCount: a2ui.length });
    byRequest.set(requestKey, formId);
    trim(forms);
    trim(byRequest);
    // INPUT_REQUIRED keeps the task open so actions can resume it with the same taskId.
    bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: status(TaskState.TASK_STATE_INPUT_REQUIRED, message), artifacts: [], history: [], metadata }));
    bus.finished();
    const sent = { formId, workflowId, taskId: ctx.taskId, contextId: ctx.contextId, messageId: message.messageId, a2uiMessages: a2ui.length, prefilled: Object.keys(prefill), supersedes: metadata.supersedes };
    log('sent form', sent);
    emitViz('form_sent', runId, sent);
    return formId;
  }

  async function handleAction(ctx, bus, runId, part) {
    const incoming = ctx.userMessage;
    const resuming = Boolean(ctx.task);
    const operationId = incoming.metadata?.operationId;
    const messages = part.content.value;
    const actionMsg = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
    const formId = actionMsg?.action?.surfaceId;
    const name = actionMsg?.action?.name ?? null;
    const form = forms.get(formId);
    const ids = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, formId, operationId, actionName: name, resumedTask: resuming };
    const final = form && WORKFLOWS[form.workflowId]?.actions[name]?.final;
    const lookup = name === 'checkAvailability';
    log('received form action', { ...ids, values: final ? logValues(actionMsg?.action?.context) : '[not logged]' });
    emitViz('form_action_received', runId, { ...ids, workflowId: form?.workflowId ?? null, final: Boolean(final), lookup, receivedValues: lookup ? null : actionMsg?.action?.context ?? null, criteria: lookup ? actionMsg?.action?.context ?? null : null });

    // Reply on the form's task while it's open; COMPLETED once the form is closed.
    const respond = (body, { a2ui = [], text, closed = false } = {}) => {
      const state = closed ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_INPUT_REQUIRED;
      const parts = [textPart(text ?? body.message ?? ''), jsonPart(body), ...(a2ui.length ? [a2uiPart(a2ui)] : [])];
      const metadata = { runId, agentId, formId, operationId, duplicate: Boolean(body.duplicate) };
      if (resuming) {
        bus.publish(AgentEvent.task(ctx.task));
        bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, metadata: undefined, status: status(state, agentMessage(ctx, parts, { taskId: ctx.taskId, metadata })) }));
      } else {
        bus.publish(AgentEvent.message(agentMessage(ctx, parts, { metadata })));
      }
      bus.finished();
      // What actually went back to the Student over A2A (shown as "Sent" in the agent's panel).
      emitViz('form_reply_sent', runId, { formId, operationId, actionName: name, status: body.status, text: parts[0].content.value, receipt: body.receipt ?? null, duplicate: Boolean(body.duplicate), taskState: closed ? 'completed' : 'input-required', contextId: ctx.contextId });
    };
    const reject = (errors, extra = {}) => {
      const body = { status: 'rejected', formId, operationId, errors, ...extra };
      log('rejected form action', { ...ids, errors });
      emitViz('form_action_result', runId, { ...ids, status: 'rejected', errors });
      respond({ ...body, message: 'Not accepted. Please check the form.' }, { closed: !form || form.state !== 'awaiting_input' });
    };

    if (typeof operationId !== 'string' || !/^[\w-]{8,100}$/.test(operationId)) return reject({ _form: 'Missing or malformed operation ID.' });
    if (!form) return reject({ _form: 'Unknown form (forms are kept in memory; a restart clears them).' });
    if (incoming.metadata?.formVersion !== undefined && incoming.metadata.formVersion !== form.version) return reject({ _form: 'This form version is out of date.' });
    // Correlation: the action must belong to this form's task and conversation.
    const correlated = resuming ? ctx.task.id === form.taskId : incoming.referenceTaskIds.includes(form.taskId) && ctx.contextId === form.contextId;
    if (!correlated) return reject({ _form: 'This action isn’t correlated with that form’s task and conversation.' });

    const previous = operations.get(operationId);
    if (previous) {
      if (previous.formId !== formId || previous.name !== name || previous.raw !== JSON.stringify(actionMsg.action.context ?? {})) {
        return reject({ _form: 'This operation ID was already used with different values.' });
      }
      // Identical retry: the stored result, nothing re-executed.
      log('duplicate operation — returning the stored result', ids);
      emitViz('form_action_result', runId, { ...ids, status: previous.result.body.status, duplicate: true, receipt: previous.result.body.receipt ?? null });
      respond({ ...previous.result.body, duplicate: true }, { a2ui: previous.result.a2ui, closed: previous.result.closed });
      return;
    }

    if (form.state !== 'awaiting_input') return reject({ _form: `This form is ${form.state === 'accepted' ? 'already submitted' : form.state}.` });
    // Checked against the CURRENT skills, not those in force when the form was issued.
    if (!isEnabled(form.workflowId)) return reject({ _form: 'This workflow is no longer offered (its skill is disabled).' });
    const checked = checkAction(actionMsg, { workflowId: form.workflowId, surfaceId: formId });
    if (!checked.ok) return reject({ _form: checked.error });

    const handler = workflows[form.workflowId].actions[checked.name];
    const result = await handler(form, checked.context, { formId, runId, reviewAcknowledged: incoming.metadata?.reviewAcknowledged === true, emit: (type, data) => emitViz(type, runId, { formId, ...data }) });
    if (checked.spec.final && result.status === 'accepted') form.state = 'accepted';
    if (checked.spec.cancel) form.state = 'cancelled';
    const closed = form.state !== 'awaiting_input';
    const body = { status: result.status, formId, operationId, workflowId: form.workflowId, message: result.message, ...(result.errors ? { errors: result.errors } : {}), ...(result.flags ? { flags: result.flags } : {}), ...(result.receipt ? { receipt: result.receipt } : {}) };
    const a2ui = [...(result.a2ui ?? []), ...(closed ? buildDelete(formId) : [])];
    operations.set(operationId, { formId, name: checked.name, raw: JSON.stringify(checked.context), result: { body, a2ui, closed } });
    trim(operations);
    log('form action result', { ...ids, status: result.status, receiptId: result.receipt?.requestId ?? result.receipt?.bookingId ?? null });
    // The handler's outcome first, then the reply that carries it back over A2A.
    emitViz('form_action_result', runId, { ...ids, workflowId: form.workflowId, status: result.status, errors: result.errors ?? null, flags: result.flags ?? null, receipt: result.receipt ?? null, values: result.values ?? null });
    respond(body, { a2ui, closed });
  }

  // The form an earlier attempt of this same chat request produced (null if none).
  const formForRequest = (ctx) => byRequest.get(`${ctx.contextId}|${ctx.userMessage.messageId}`) ?? null;

  return { issue, handleAction, openForm, formForRequest, clientSupportsForms, form: (id) => forms.get(id) };
}
