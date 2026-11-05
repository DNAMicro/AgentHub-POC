// HR (staff only): the Hub's STAFF path — this application's convention carried as typed A2A data parts,
// like the Part 9 lesson publishes. A staff member's own agent (the Professor) signs each part with the
// per-process key it gave the Hub at registration (hubLink.sendSigned); the Hub verifies it, maps the
// agent to a staff record from its own configuration, and forwards to a staff-only destination (HR).
// Students never use these parts, and the student path never reaches a staff destination.
//
// Request: { type: 'staff_request', operationId, conversationId, text, formValues? }
//   formValues (optional, only while a card is open): that card's current values in the browser, checked
//   with checkTimeOffValues; HR merges them first, then the words.
//   signed fields ['staff-request', operationId, conversationId]
// Action:  { type: 'staff_action', operationId, formRef, action, conversationId }  (action = the A2UI action)
//   signed fields ['staff-action', operationId, formRef, conversationId] — the Hub requires conversationId
//   and checks it against the conversation the formRef was issued in.
//
// The Hub answers with ONE data part:
//   { status: 'ok' | 'refused' | 'not_delivered' | 'outcome_unknown',
//     reply?: { text, servedBy: 'hr', formRef?, a2ui?, hrCard?, receipt?, closed?, errors? }, reason?, code? }
// 'refused': the Hub (or HR) refused it — reason says why in plain words. 'not_delivered': nothing reached
// HR. 'outcome_unknown': HR may have processed it; retry with the SAME operationId (both sides dedupe).
import { checkTimeOffValues } from './forms.js';

export const STAFF_REQUEST_MEDIA_TYPE = 'application/vnd.a2a-spike.staff-request+json';
export const STAFF_ACTION_MEDIA_TYPE = 'application/vnd.a2a-spike.staff-action+json';
// Part 17 (CHRS): the Hub -> CHRS typed parts (sent with sendData; the Hub signs them toward CHRS).
//   roster request: { type: 'roster_request', kind: 'roster', courseId? } + metadata { hubOperationId, via, staffId,
//     callerKind: 'staff', hubSignature } (the same staff signature HR verifies). Reply data part { roster } or { text }.
//   roster lookup:  { type: 'roster_lookup', courseId, instructorStaffId } + metadata { hubOperationId, hubSignature }
//     (signRosterLookup, the Hub's own). Reply data part { studentIds, names, count } or { error, text }; never emails or IDs.
export const ROSTER_REQUEST_MEDIA_TYPE = 'application/vnd.a2a-spike.roster-request+json';
export const ROSTER_LOOKUP_MEDIA_TYPE = 'application/vnd.a2a-spike.roster-lookup+json';
export const ROSTER_FAILED_TEXT = "I couldn't get your class roster just now. Try again in a moment.";
export const CHRS_REFUSED_TEXT = 'CHRS serves university staff only.';
export const HUB_STAFF_MEDIA_TYPES = new Set([STAFF_REQUEST_MEDIA_TYPE, STAFF_ACTION_MEDIA_TYPE]);
export const STAFF_STATUSES = ['ok', 'refused', 'not_delivered', 'outcome_unknown'];

// The fields each part's signature covers (the sender's agentId and instanceId are prepended by sendSigned).
export const staffRequestFields = (v) => ['staff-request', v?.operationId, v?.conversationId];
export const staffActionFields = (v) => ['staff-action', v?.operationId, v?.formRef, v?.conversationId];

// code (typed, for the sender's code — never parse `reason`): 'card_closed' = this formRef can't be acted on
// any more (unknown, expired, replaced, completed, or another staff member's / conversation's card).
export const CARD_CLOSED = 'card_closed';
export const staffReply = (status, { reply, reason, code } = {}) => ({ status, ...(reply ? { reply } : {}), ...(reason ? { reason } : {}), ...(code ? { code } : {}) });

// HR (staff only): the open time-off card's values sent with a professor message ({ formRef, formValues }).
// Malformed → an error (the run is refused); a field that fails the form's own rules is dropped, never sent.
export function cardValues(input) {
  if (input?.formValues === undefined && input?.formRef === undefined) return { fields: {} };
  if (typeof input.formRef !== 'string' || !/^[\w-]{1,120}$/.test(input.formRef)) return { error: 'Missing card reference.' };
  const c = checkTimeOffValues(input.formValues);
  if (!c.ok) return { error: `Card values: ${Object.values(c.errors)[0]}` };
  return { fields: { formRef: input.formRef, formValues: c.values } };
}
