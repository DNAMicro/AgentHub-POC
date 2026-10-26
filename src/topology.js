// Part 7: topology labels for telemetry events. The browser's live graph draws a pulse only for an
// event this function labels — it never infers a hop from timing or guesses a direction.
//
// Each label names the edge (Student↔Hub, Hub↔Tutor, Hub↔Library — there is no Student↔specialist
// edge — plus each agent's own HTTPS calls to its model: Student, Hub router, Tutor, Library),
// the direction the data travelled, a category, and a phase:
//   attempted (send started) · accepted (receiver confirmed) · processing (work inside a node)
//   completed (result returned) · failed · unknown (outcome not known, e.g. a timeout)
// Labels carry only IDs and short fixed text; message content, emails, notes and form values are
// never copied into them.

const SPECIALISTS = new Set(['tutor', 'library', 'professor']);
const edgeFor = (agentId) => (SPECIALISTS.has(agentId) ? `hub-${agentId}` : null);
const NODE_NAMES = { student: 'Student', hub: 'University Hub', tutor: 'Tutor', library: 'Library', professor: 'Marketing 101 Professor', model: 'Model provider' };

function hop(from, to, category, phase, label) {
  const edge = from === 'model' || to === 'model' ? `${from === 'model' ? to : from}-model`
    : from === 'student' || to === 'student' ? 'student-hub' : edgeFor(from === 'hub' ? to : from);
  return { edge, from, to, category, phase, label };
}
const inside = (node, category, phase, label) => ({ edge: null, node, from: node, to: node, category, phase, label });

// A provider call is a hop only when it really went over the network (live). Mock "models" run in
// process, and a missing key fails before any call — both stay inside the agent's node.
const isLive = (d) => d.mode === 'live' || /^claude/.test(String(d.model ?? ''));
const purposeOf = (d) => d.purpose ?? (d.stage ? 'scope check' : 'answer');
const MODEL_CALLS = {
  model_call_started: (a, d) => (isLive(d) ? hop(a, 'model', 'model', 'attempted', `Model call: ${purposeOf(d)}`) : inside(a, 'model', 'processing', 'Mock model (no network call)')),
  model_response_received: (a, d) => (isLive(d) ? hop('model', a, 'model', 'completed', `Model replied (${purposeOf(d)})`) : inside(a, 'model', 'processing', 'Mock model replied')),
  model_call_failed: (a, d) => (d.code === 'missing_credentials' ? inside(a, 'model', 'failed', 'No API key — no call made')
    : hop('model', a, 'model', d.code === 'timeout' ? 'unknown' : 'failed', d.code === 'timeout' ? 'Model call timed out' : `Model call failed (${d.code})`)),
  scope_check_started: (a, d) => (d.mode === 'live' ? hop(a, 'model', 'model', 'attempted', 'Model call: scope check') : inside(a, 'routing', 'processing', 'Scope check')),
  scope_checked: (a, d) => (d.usage ? hop('model', a, 'model', 'completed', `Scope verdict: ${d.verdict}`) : inside(a, 'routing', 'processing', 'Scope check')),
};

const STUDENT = {
  model_call_started: (d) => MODEL_CALLS.model_call_started('student', d),
  model_response_received: (d) => MODEL_CALLS.model_response_received('student', d),
  model_call_failed: (d) => MODEL_CALLS.model_call_failed('student', d),
  request_planned: (d) => inside('student', 'routing', 'processing', d.action === 'clarify' ? 'Student decided to ask you first' : d.action === 'decline' ? 'Not a university service — Student answers itself'
    : d.capability ? `Student chose ${d.capabilityName ?? d.capability}${d.by === 'model' ? ' (its model)' : ''}` : d.by === 'rule' ? 'Obvious — the Hub routes it' : 'Student left routing to the Hub'),
  clarification_asked: () => inside('student', 'request', 'completed', 'Student asked you a clarifying question'),
  // Part 9: the Student's inbound side (lessons the Hub delivered) and its session with the Hub.
  student_session: (d) => hop('student', 'hub', 'registration', d.status === 'registered' ? 'completed' : 'failed', d.status === 'registered' ? 'Student session confirmed' : `Student session not registered (${d.reason ?? d.status})`),
  lesson_received: () => inside('student', 'lesson', 'completed', 'Lesson saved in the Student’s inbox'),
  lesson_opened: () => inside('student', 'lesson', 'completed', 'Student opened the lesson'),
  course_available: () => inside('student', 'lesson', 'completed', 'Course available notice received'),
  request_declined: () => inside('student', 'request', 'completed', 'Student answered you itself (not offered by the university)'),
  // Only a real discovery (it carries a reason); the per-request reuse of the known card is not a hop.
  card_discovered: (d) => (d.reason ? hop('hub', 'student', 'card', 'completed', 'Student read the university’s public card') : null),
  request_sent: () => hop('student', 'hub', 'request', 'attempted', 'Question sent to the Hub'),
  reply_received: (d) => hop('hub', 'student', 'request', 'completed', d.hub?.decision && d.hub.decision !== 'route' ? `Hub answered itself (${d.hub.decision})` : 'Answer received from the Hub'),
  tutor_error: () => hop('hub', 'student', 'request', 'failed', 'Hub returned a service error'),
  form_received: () => hop('hub', 'student', 'form', 'completed', 'Form received from the Hub'),
  request_failed: (d) => hop('student', 'hub', 'request', d.outcome === 'uncertain' ? 'unknown' : 'failed', d.outcome === 'uncertain' ? 'No reply in time — outcome unknown' : 'Not delivered to the Hub'),
  form_action_sent: (d) => hop('student', 'hub', 'form', 'attempted', `Form action “${d.actionName}” sent`),
  form_action_result: (d) => hop('hub', 'student', 'form', ['rejected', 'conflict'].includes(d.status ?? d.body?.status) ? 'failed' : 'completed', `Form result: ${d.status ?? d.body?.status ?? 'unknown'}${d.duplicate ? ' (stored result)' : ''}`),
  form_action_failed: (d) => hop('student', 'hub', 'form', d.outcome === 'uncertain' ? 'unknown' : 'failed', d.outcome === 'uncertain' ? 'Form action: outcome unknown' : 'Form action not delivered'),
};

const HUB = {
  model_call_started: (d) => MODEL_CALLS.model_call_started('hub', d),
  model_response_received: (d) => MODEL_CALLS.model_response_received('hub', d),
  model_call_failed: (d) => MODEL_CALLS.model_call_failed('hub', d),
  message_received: () => hop('student', 'hub', 'request', 'accepted', 'Hub received the question'),
  request_repeat: () => inside('hub', 'request', 'processing', 'Repeat request — earlier result reused'),
  route_decided: (d) => inside('hub', 'routing', d.decision === 'route' ? 'processing' : 'completed', d.decision === 'route' ? `Routed to ${d.destination}${{ student: ' (Student’s choice)', lesson: ' (lesson record)' }[d.decidedBy] ?? ''}` : `Not routed: ${d.decision}`),
  capability_rejected: () => inside('hub', 'routing', 'failed', 'Unknown capability ignored — Hub routed itself'),
  // Part 9: the reverse route, Professor → Hub → Student, and the student's receipts.
  lesson_publish_received: (d) => hop(d.agentId, 'hub', 'lesson', 'accepted', 'Lesson received from the Professor (verified)'),
  lesson_rejected: (d) => (SPECIALISTS.has(d.agentId) ? hop(d.agentId, 'hub', 'lesson', 'failed', `Lesson refused (${d.reason})`) : inside('hub', 'lesson', 'failed', `Lesson refused (${d.reason})`)),
  lesson_delivery_attempted: (d) => hop('hub', 'student', 'lesson', 'attempted', d.attempt > 1 ? `Lesson sent to the Student (attempt ${d.attempt})` : 'Lesson sent to the Student'),
  lesson_delivered: (d) => hop('student', 'hub', 'lesson', 'completed', d.duplicate ? 'Already in the Student’s inbox (no duplicate)' : 'Saved in the Student’s inbox'),
  lesson_queued: () => inside('hub', 'lesson', 'processing', 'Lesson queued — Student agent offline'),
  lesson_uncertain: () => hop('hub', 'student', 'lesson', 'unknown', 'Delivery outcome unknown — will reconcile'),
  lesson_reconciled: (d) => inside('hub', 'lesson', 'processing', d.found ? 'Reconciled: already delivered' : 'Reconciled: not delivered — sending again'),
  lesson_failed: (d) => hop('hub', 'student', 'lesson', 'failed', `Delivery refused (${d.reason})`),
  lesson_opened: () => hop('student', 'hub', 'lesson', 'completed', 'Student opened the lesson'),
  course_available_sent: () => hop('hub', 'student', 'lesson', 'completed', 'Course available notice delivered'),
  student_session: (d) => hop('student', 'hub', 'registration', d.status === 'registered' ? 'accepted' : 'failed', d.status === 'registered' ? 'Student session confirmed (challenge answered)' : `Student session refused (${d.reason})`),
  lesson_route_rejected: () => inside('hub', 'routing', 'failed', 'Lesson question refused — not this student’s lesson'),
  route_failed: () => inside('hub', 'routing', 'failed', 'Routing failed'),
  forward_attempted: (d) => hop('hub', d.agentId, 'request', 'attempted', `Forwarded to ${NODE_NAMES[d.agentId] ?? d.agentId}`),
  forward_completed: (d) => hop(d.agentId, 'hub', d.kind === 'form_offer' ? 'form' : 'request', 'completed', d.kind === 'form_offer' ? 'Specialist returned a form' : 'Specialist answered'),
  forward_failed: (d) => hop('hub', d.agentId, 'request', d.outcome === 'unknown' ? 'unknown' : 'failed', d.outcome === 'answered_with_error' ? 'Specialist reported an error' : d.outcome === 'unknown' ? 'Specialist did not answer in time' : 'Specialist unreachable'),
  relay_sent: (d) => hop('hub', 'student', d.kind === 'form_offer' ? 'form' : 'request', 'attempted', d.repeat ? 'Earlier result relayed again' : 'Hub relayed the reply'),
  form_ref_created: () => inside('hub', 'form', 'processing', 'Hub created a form reference'),
  form_action_received: () => hop('student', 'hub', 'form', 'accepted', 'Hub received a form action'),
  form_action_rejected: () => inside('hub', 'form', 'failed', 'Hub refused the form action'),
  form_action_duplicate: () => hop('hub', 'student', 'form', 'completed', 'Same operation ID — stored result returned'),
  form_forwarded: (d) => hop('hub', d.agentId, 'form', 'attempted', 'Form action forwarded to its issuer'),
  form_result_relayed: (d) => hop(d.agentId, 'hub', 'form', ['rejected', 'conflict'].includes(d.status) ? 'failed' : 'completed', `Issuer replied: ${d.status}`),
  form_forward_failed: (d) => hop('hub', d.agentId, 'form', d.outcome === 'unknown' ? 'unknown' : 'failed', d.outcome === 'unknown' ? 'Issuer did not confirm in time' : 'Issuer unreachable'),
  registration_accepted: (d) => hop(d.agentId, 'hub', 'registration', 'accepted', 'Registration accepted'),
  registration_rejected: (d) => (SPECIALISTS.has(d.claimedAgentId) ? hop(d.claimedAgentId, 'hub', 'registration', 'failed', 'Registration refused') : inside('hub', 'registration', 'failed', 'Registration from an unknown identity refused')),
  deregistered: (d) => hop(d.agentId, 'hub', 'registration', 'completed', 'Signed out'),
  heartbeat: (d) => hop(d.agentId, 'hub', 'heartbeat', 'completed', 'Heartbeat'),
  card_notification_received: (d) => hop(d.agentId, 'hub', 'card', 'accepted', d.duplicate ? 'Card-change notice (duplicate)' : 'Card-change notice received'),
  card_notification_rejected: (d) => (SPECIALISTS.has(d.agentId) ? hop(d.agentId, 'hub', 'card', 'failed', 'Card-change notice refused') : inside('hub', 'card', 'failed', 'Card-change notice refused')),
  card_refreshed: (d) => hop(d.agentId, 'hub', 'card', 'completed', d.changed ? `Hub fetched the new card (rev ${d.revision})` : 'Card unchanged (304)'),
  card_refresh_failed: (d) => hop('hub', d.agentId, 'card', 'failed', 'Card fetch failed'),
};

const SPECIALIST = {
  ...MODEL_CALLS,
  message_received: (a) => hop('hub', a, 'request', 'accepted', 'Specialist received the request'),
  intent_decided: (a) => inside(a, 'routing', 'processing', 'Intent decided'),
  model_call_reused: (a) => inside(a, 'model', 'processing', 'Repeat request — no new model call'),
  answer_checked: (a) => inside(a, 'routing', 'processing', 'Answer checked'),
  reply_published: (a) => hop(a, 'hub', 'request', 'attempted', 'Specialist sent its reply'),
  form_sent: (a) => hop(a, 'hub', 'form', 'attempted', 'Specialist sent a form'),
  form_action_received: (a) => hop('hub', a, 'form', 'accepted', 'Specialist received the form action'),
  form_review: (a) => inside(a, 'model', 'processing', 'Submission reviewed'),
  form_action_result: (a, d) => inside(a, 'form', ['rejected', 'conflict'].includes(d.status) ? 'failed' : 'processing', `Handler result: ${d.status}`),
  form_reply_sent: (a) => hop(a, 'hub', 'form', 'attempted', 'Specialist sent the form result'),
  ui_generated: (a, d) => inside(a, 'form', d.fallback ? 'failed' : 'processing', d.kind === 'ui' ? 'Generated an interface (validated)' : d.fallback ? 'Generated UI failed checks — answered in text' : d.kind === 'clarify' ? 'Asked a clarifying question' : 'Answered from loan records'),
  loan_operation: (a, d) => inside(a, 'form', d.ok ? 'completed' : 'failed', d.ok ? `Loan service renewed ${d.loanId}${d.duplicate ? ' (stored result)' : ''}` : `Loan service refused (${d.code})`),
  hub_registration: (a, d) => hop(a, 'hub', 'registration', d.status === 'registered' ? 'completed' : 'failed', d.status === 'registered' ? 'Registered with the Hub' : d.status === 'not_delivered' ? 'Hub not reachable for registration' : 'Registration refused'),
  skills_saved: (a) => inside(a, 'card', 'processing', 'Skills saved'),
  lesson_posted: (a) => inside(a, 'lesson', 'processing', 'Professor posted a lesson'),
  lesson_publish_result: (a, d) => hop('hub', a, 'lesson', d.status === 'rejected' ? 'failed' : ['not_delivered', 'uncertain'].includes(d.status) ? 'unknown' : 'completed', `Hub: lesson ${d.status}${d.duplicate ? ' (stored result)' : ''}`),
  card_notification: (a, d) => hop(a, 'hub', 'card', d.outcome === 'delivered' ? 'completed' : d.outcome === 'pending' ? 'unknown' : 'failed', `Card-change notice ${d.outcome}`),
};

export function topologyLabel(event) {
  const { source, type, data = {} } = event;
  let t = null;
  if (source === 'student') t = STUDENT[type]?.(data);
  else if (source === 'hub') t = HUB[type]?.(data);
  else if (SPECIALISTS.has(source)) t = SPECIALIST[type]?.(source, data);
  if (!t) return null;
  if (t.edge === undefined) return null;
  return { ...t, operationId: typeof data.operationId === 'string' ? data.operationId : null };
}
