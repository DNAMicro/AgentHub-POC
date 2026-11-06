// HR (staff only): the Hub's STAFF path — this application's convention carried as typed A2A data parts,
// like the Part 9 lesson publishes. A staff member's own agent (the Professor) signs each part with the
// per-process key it gave the Hub at registration (hubLink.sendSigned); the Hub verifies it, maps the
// agent to a staff record from its own configuration, and forwards to a staff-only destination (HR).
// Students never use these parts, and the student path never reaches a staff destination.
//
// Request: { type: 'staff_request', operationId, conversationId, text, formValues? }
//   formValues (optional, only while a card is open): that card's current values in the browser, checked
//   with checkTimeOffValues; HR merges them first, then the words.
//   signed fields ['staff-request', operationId, conversationId] (+ service when given: 'hr' (default) | 'chrs')
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
//   roster request: { type: 'roster_request', kind: 'roster', courseId?, purpose } + metadata { hubOperationId, via, staffId,
//     callerKind: 'staff', hubSignature } (the same staff signature HR verifies). Reply data part { roster } or { text }.
//   roster lookup:  { type: 'roster_lookup', courseId, instructorStaffId } + metadata { hubOperationId, hubSignature }
//     (signRosterLookup, the Hub's own). Reply data part { studentIds, names, count } or { error, text }: roster student IDs and names go to the Hub
//     (it addresses deliveries from them), never emails or CWIDs.
export const ROSTER_REQUEST_MEDIA_TYPE = 'application/vnd.a2a-spike.roster-request+json';
export const ROSTER_LOOKUP_MEDIA_TYPE = 'application/vnd.a2a-spike.roster-lookup+json';
// Review C16: the Hub asks CHRS to EMAIL the students a post couldn't reach in the app (no session, or unreachable).
//   email notice: { type: 'email_notice', courseId, instructorStaffId, studentIds: [id, …], title, text, professorName }
//     + metadata { hubOperationId, hubSignature } (signEmailNotice, the Hub's own key toward CHRS, like a roster lookup).
//     Reply data part { results: { studentId: 'emailed' | 'failed' }, emailed, failed } or { error, text }. CHRS reads the
//     addresses from Campus Solutions itself; they never come back to the Hub.
export const EMAIL_NOTICE_MEDIA_TYPE = 'application/vnd.a2a-spike.email-notice+json';
export const ROSTER_UNAVAILABLE_CODE = 'roster_unavailable'; // the Hub refuses a post it can't address from CHRS's roster
export const ROSTER_POST_FAILED_TEXT = "I couldn't get your class list just now, so nothing was sent. Try again in a moment.";
export const ROSTER_FAILED_TEXT = "I couldn't get your class roster just now. Try again in a moment.";
export const CHRS_REFUSED_TEXT = 'Campus Agent serves university staff only.';
export const HUB_STAFF_MEDIA_TYPES = new Set([STAFF_REQUEST_MEDIA_TYPE, STAFF_ACTION_MEDIA_TYPE]);
export const STAFF_STATUSES = ['ok', 'refused', 'not_delivered', 'outcome_unknown'];

// The fields each part's signature covers (the sender's agentId and instanceId are prepended by sendSigned).
// Part 17: `service` ('hr' | 'chrs', a configured staff destination) is signed when present, so it can't be added,
// removed or changed in transit; a request without one is HR's and signs exactly the three fields it always did.
// Review #7: a roster request (service 'chrs') may carry `purpose` (why the roster is read; ROSTER_PURPOSES below). It is
// signed when present, after service, like service itself; a request without one signs exactly what it always did.
export const staffRequestFields = (v) => ['staff-request', v?.operationId, v?.conversationId, ...(v?.service === undefined ? [] : [v.service]), ...(v?.purpose === undefined ? [] : [`purpose:${v.purpose}`])];
// Review #7: why the class roster / class record is read. A fixed set chosen by CODE at the caller, signed with the request
// and written into the Campus Agent's audit log with every read. Never a free text, never from the model or the browser.
//   view (show the roster card), fact (a count / membership / one student), question (a roster question or filter),
//   tag (resolving @-tags, the composer's suggestions), class_info (a cancellation's class time and room),
//   membership (comparing Canvas with the roster), recipients (the Hub addressing a post), email (the email fallback),
//   message (review E: the faculty member's message preview card — who a message would reach, read when the card opens
//   and again at Send; the Hub still addresses the post itself with its own 'recipients' read).
export const ROSTER_PURPOSES = ['view', 'fact', 'question', 'tag', 'class_info', 'membership', 'recipients', 'email', 'message'];
export const STAFF_ROSTER_PURPOSES = ['view', 'fact', 'question', 'tag', 'class_info', 'membership', 'message']; // the faculty member's own reads
export const LOOKUP_ROSTER_PURPOSES = ['recipients', 'tag']; // the Hub's own lookups (signRosterLookup)
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
