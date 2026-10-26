// Part 6 workflow forms: the registered A2UI v0.9 templates (built by the issuing agent), the
// validation rules (enforced independently by browser, UI server, and the issuing agent), and the
// allowlist the Student applies to every A2UI payload it receives.
//
// Dependency-free ESM so the browser can load it too (served at /shared/forms.js).
// All availability, rooms and hours are FICTIONAL demo data.

export const A2UI_VERSION = 'v0.9';
export const A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9';
export const A2UI_MIME_TYPE = 'application/a2ui+json';
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
export const MAX_A2UI_PAYLOAD_BYTES = 64 * 1024;

// Demo configuration (fictional campus).
export const TIMEZONE = 'America/Los_Angeles';
export const TIMEZONE_LABEL = 'Pacific Time (America/Los_Angeles)';
export const TUTORING_HOURS = { open: '09:00', noon: '12:00', close: '17:00', days: 'Monday–Friday', maxDaysAhead: 60 };
export const ROOMS = [
  { id: 'room-a', name: 'Room A — Floor 2', capacity: 4 },
  { id: 'room-b', name: 'Room B — Floor 2', capacity: 6 },
  { id: 'room-c', name: 'Room C — Floor 3', capacity: 10 },
];
export const BOOKING = { open: '09:00', close: '21:00', durations: [60, 120], maxDaysAhead: 14, maxGroup: 10 };

// ---- workflows: ids, owning agent/skill, and each action's button and fields -------------------

const TUTORING_FIELDS = ['firstName', 'lastName', 'email', 'preferredDate', 'period', 'specificTime', 'notes'];
const BOOKING_CRITERIA = ['date', 'room', 'duration', 'groupSize'];
const BOOKING_FIELDS = ['firstName', 'lastName', 'email', ...BOOKING_CRITERIA, 'slot'];

export const WORKFLOWS = {
  'tutoring-request': {
    id: 'tutoring-request', agentId: 'tutor', skillId: 'in-person-tutoring-request',
    title: 'Request an in-person calculus tutoring session',
    finalAction: 'submitTutoringRequest', pendingText: 'Sending request…',
    actions: {
      submitTutoringRequest: { button: 'submit_button', fields: TUTORING_FIELDS, final: true },
      cancelForm: { button: 'cancel_button', fields: [], cancel: true },
    },
  },
  'study-room-booking': {
    id: 'study-room-booking', agentId: 'library', skillId: 'study-room-booking',
    title: 'Book a group study room',
    finalAction: 'confirmStudyRoomBooking', pendingText: 'Confirming booking…',
    actions: {
      checkAvailability: { button: 'check_button', fields: BOOKING_CRITERIA }, // scheduling fields only
      reviewBooking: { button: 'review_button', fields: BOOKING_FIELDS },
      editBooking: { button: 'edit_button', fields: [] },
      confirmStudyRoomBooking: { button: 'confirm_button', fields: BOOKING_FIELDS, final: true },
      cancelForm: { button: 'cancel_button', fields: [], cancel: true },
    },
  },
};
export const workflowOfSkill = (skillId) => Object.values(WORKFLOWS).find((w) => w.skillId === skillId) ?? null;

// ---- dates and times in the configured timezone -------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function todayIn(now = new Date(), timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isRealDate = (s) => DATE_RE.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
export const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
export function prettyDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// DateTimeInput values are ISO 8601; take the date or time part.
const datePart = (v) => (typeof v === 'string' ? v.trim().slice(0, 10) : v);
const timePart = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  const m = /(?:T|^)(\d{2}:\d{2})/.exec(t);
  return m ? m[1] : t;
};
// ChoicePicker values are string lists; one selection expected.
const single = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : v.length ? null : '') : v);

// ---- validation (browser, UI server and issuing agent all run these) ------------------------

// Server/browser format check only: it says nothing about whether the address exists.
const EMAIL_PATTERN = /^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)+$/;
const LIMITS = { name: 100, email: 254, notes: 1000 };

function checkKeys(input, fields) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'Submission must be an object.';
  const unexpected = Object.keys(input).filter((k) => !fields.includes(k));
  return unexpected.length ? `Unexpected field(s): ${unexpected.join(', ')}.` : null;
}
const text = (v) => (typeof v === 'string' ? v.trim() : null);

function contact(input, errors, values) {
  for (const [field, label] of [['firstName', 'First name'], ['lastName', 'Last name']]) {
    const v = text(input[field] ?? '');
    if (v === null) errors[field] = 'Must be text.';
    else if (!v) errors[field] = `${label} is required.`;
    else if (v.length > LIMITS.name) errors[field] = `Must be at most ${LIMITS.name} characters.`;
    else values[field] = v;
  }
  const email = text(input.email ?? '');
  if (email === null) errors.email = 'Must be text.';
  else if (!email) errors.email = 'Email is required.';
  else if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email format, like alex@example.com.';
  else values.email = email;
}

// Returns { ok: true, values } or { ok: false, errors } keyed by field (`_form` for structure).
export function validateTutoringRequest(input, { now = new Date() } = {}) {
  const structural = checkKeys(input, TUTORING_FIELDS);
  if (structural) return { ok: false, errors: { _form: structural } };
  const errors = {};
  const values = {};
  contact(input, errors, values);

  const today = todayIn(now);
  const date = datePart(input.preferredDate ?? '');
  if (!date) errors.preferredDate = 'Preferred date is required.';
  else if (!isRealDate(date)) errors.preferredDate = 'Enter a valid date.';
  else if (date < today || date > addDays(today, TUTORING_HOURS.maxDaysAhead)) errors.preferredDate = `Choose a date between today and ${TUTORING_HOURS.maxDaysAhead} days from now.`;
  else if ([0, 6].includes(weekday(date))) errors.preferredDate = `In-person tutoring runs ${TUTORING_HOURS.days} only.`;
  else values.preferredDate = date;

  const period = single(input.period ?? '');
  if (period === null) errors.period = 'Choose one: morning or afternoon.';
  else if (!period) errors.period = 'Preferred time of day is required.';
  else if (!['morning', 'afternoon'].includes(period)) errors.period = 'Choose morning or afternoon.';
  else values.period = period;

  const time = timePart(input.specificTime ?? '');
  if (time === '' || time == null) values.specificTime = null;
  else if (typeof time !== 'string' || !TIME_RE.test(time)) errors.specificTime = 'Enter a time like 14:30.';
  else if (minutes(time) < minutes(TUTORING_HOURS.open) || minutes(time) >= minutes(TUTORING_HOURS.close)) errors.specificTime = `Tutoring hours are ${TUTORING_HOURS.open}–${TUTORING_HOURS.close}.`;
  else if (values.period === 'morning' && minutes(time) >= minutes(TUTORING_HOURS.noon)) errors.specificTime = `Morning means before ${TUTORING_HOURS.noon}; pick an earlier time or choose afternoon.`;
  else if (values.period === 'afternoon' && minutes(time) < minutes(TUTORING_HOURS.noon)) errors.specificTime = `Afternoon starts at ${TUTORING_HOURS.noon}; pick a later time or choose morning.`;
  else values.specificTime = time;

  const notes = text(input.notes ?? '');
  if (notes === null) errors.notes = 'Must be text.';
  else if (!notes) errors.notes = 'Describe what you’d like help with.';
  else if (notes.length > LIMITS.notes) errors.notes = `Must be at most ${LIMITS.notes} characters.`;
  else values.notes = notes;

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

// Scheduling criteria only (what an availability lookup may send).
export function validateBookingCriteria(input, { now = new Date() } = {}) {
  const structural = checkKeys(input, BOOKING_CRITERIA);
  if (structural) return { ok: false, errors: { _form: structural } };
  return criteria(input, now);
}
function criteria(input, now) {
  const errors = {};
  const values = {};
  const today = todayIn(now);
  const date = datePart(input.date ?? '');
  if (!date) errors.date = 'Date is required.';
  else if (!isRealDate(date)) errors.date = 'Enter a valid date.';
  else if (date < today || date > addDays(today, BOOKING.maxDaysAhead)) errors.date = `Choose a date from today up to ${BOOKING.maxDaysAhead} days ahead.`;
  else values.date = date;

  const roomId = single(input.room ?? '');
  const room = ROOMS.find((r) => r.id === roomId);
  if (!roomId) errors.room = 'Choose a room.';
  else if (!room) errors.room = 'Unknown room.';
  else values.room = room.id;

  const duration = Number(single(input.duration ?? ''));
  if (!single(input.duration ?? '')) errors.duration = 'Choose a duration.';
  else if (!BOOKING.durations.includes(duration)) errors.duration = 'Choose 1 or 2 hours.';
  else values.duration = duration;

  const rawSize = typeof input.groupSize === 'number' ? String(input.groupSize) : text(input.groupSize ?? '');
  const size = Number(rawSize);
  if (!rawSize) errors.groupSize = 'Group size is required.';
  else if (!/^\d{1,2}$/.test(rawSize) || size < 1) errors.groupSize = 'Enter a whole number of people.';
  else if (size > BOOKING.maxGroup) errors.groupSize = `The largest room holds ${BOOKING.maxGroup}.`;
  else if (room && size > room.capacity) errors.groupSize = `${room.name} holds up to ${room.capacity}; choose a bigger room or a smaller group.`;
  else values.groupSize = size;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

// Full booking (review or final confirmation). `slot` is the opaque ID the Library offered.
export function validateBooking(input, { now = new Date() } = {}) {
  const structural = checkKeys(input, BOOKING_FIELDS);
  if (structural) return { ok: false, errors: { _form: structural } };
  const errors = {};
  const values = {};
  contact(input, errors, values);
  const c = criteria(input, now);
  if (c.ok) Object.assign(values, c.values);
  else Object.assign(errors, c.errors);
  const slot = single(input.slot ?? '');
  if (slot === null || !slot) errors.slot = 'Choose an available start time.';
  else if (typeof slot !== 'string' || !/^slot-[\w-]{4,40}$/.test(slot)) errors.slot = 'Unknown time slot.';
  else values.slot = slot;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

export function validateFinal(workflowId, context, opts) {
  if (workflowId === 'tutoring-request') return validateTutoringRequest(context, opts);
  if (workflowId === 'study-room-booking') return validateBooking(context, opts);
  return { ok: false, errors: { _form: 'Unknown workflow.' } };
}

// Validate an A2UI client-to-server `action` against the form's workflow. Field values are
// validated per action by the caller (final actions with validateFinal, lookups with criteria).
export function checkAction(message, { workflowId, surfaceId }) {
  const action = message?.action;
  const workflow = WORKFLOWS[workflowId];
  if (message?.version !== A2UI_VERSION || !action || typeof action !== 'object') return { ok: false, error: 'Not an A2UI v0.9 action message.' };
  if (!workflow) return { ok: false, error: 'Unknown workflow.' };
  const spec = workflow.actions[action.name];
  if (!spec) return { ok: false, error: `Unknown action "${action.name}" for this form.` };
  if (action.surfaceId !== surfaceId) return { ok: false, error: 'Action is for a different form.' };
  if (action.sourceComponentId !== spec.button) return { ok: false, error: 'Action did not come from that form’s own button.' };
  const context = action.context ?? {};
  const keyError = checkKeys(context, spec.fields);
  if (keyError) return { ok: false, error: keyError };
  return { ok: true, name: action.name, spec, context };
}

// ---- A2UI templates (built by the issuing agent) --------------------------------------------

const v = (body) => ({ version: A2UI_VERSION, ...body });
const afterSubmit = (rule, message) => ({
  condition: { call: 'or', args: { values: [{ call: 'not', args: { value: { path: '/ui/submitAttempted' } } }, rule] } },
  message,
});
const required = (path, label) => afterSubmit({ call: 'required', args: { value: { path } } }, `${label} is required.`);
const nonBlank = (path, label) => afterSubmit({ call: 'regex', args: { value: { path }, pattern: '\\S' } }, `${label} is required.`);
const maxLen = (path, max, label) => afterSubmit({ call: 'length', args: { value: { path }, max } }, `${label} must be at most ${max} characters.`);
const textField = (id, label, field, checks = [], variant = 'shortText') => ({ id, component: 'TextField', label, variant, value: { path: `/form/${field}` }, checks });
const textC = (id, value, variant) => ({ id, component: 'Text', text: value, ...(variant ? { variant } : {}) });
const button = (id, label, actionName, contextFields, variant = 'default', lockable = true) => [
  textC(`${id}_label`, label),
  {
    id, component: 'Button', child: `${id}_label`, variant,
    // The client sets /ui/submitLocked while anything is pending; the renderer then disables the button.
    ...(lockable ? { checks: [{ condition: { call: 'not', args: { value: { path: '/ui/submitLocked' } } }, message: 'Please wait.' }] } : {}),
    action: { event: { name: actionName, context: Object.fromEntries(contextFields.map((f) => [f, { path: `/form/${f}` }])) } },
  },
];
const contactFields = () => [
  textField('first_name', 'First name', 'firstName', [nonBlank('/form/firstName', 'First name'), maxLen('/form/firstName', LIMITS.name, 'First name')]),
  textField('last_name', 'Last name', 'lastName', [nonBlank('/form/lastName', 'Last name'), maxLen('/form/lastName', LIMITS.name, 'Last name')]),
  textField('email', 'Email', 'email', [
    required('/form/email', 'Email'),
    // The catalog's own `email` function (custom regexes can be refused by the renderer's ReDoS guard).
    afterSubmit({ call: 'email', args: { value: { path: '/form/email' } } }, 'Enter a valid email format, like alex@example.com.'),
  ]),
];

// prefill: only values the student explicitly stated (never names or emails).
export function buildTutoringForm(surfaceId, { prefill = {}, now = new Date() } = {}) {
  const today = todayIn(now);
  const wf = WORKFLOWS['tutoring-request'];
  return [
    v({ createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID, sendDataModel: false } }),
    v({
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['title', 'description', 'hours', 'first_name', 'last_name', 'email', 'preferred_date', 'period', 'specific_time', 'notes', 'demo_note', 'actions'] },
          textC('title', wf.title, 'h3'),
          textC('description', 'Tell us your preferences. This submits a request; it does not book a time.'),
          textC('hours', `Times are ${TIMEZONE_LABEL}. Tutoring runs ${TUTORING_HOURS.days}, ${TUTORING_HOURS.open}–${TUTORING_HOURS.close}. Morning = ${TUTORING_HOURS.open}–${TUTORING_HOURS.noon}, afternoon = ${TUTORING_HOURS.noon}–${TUTORING_HOURS.close}.`, 'caption'),
          ...contactFields(),
          { id: 'preferred_date', component: 'DateTimeInput', label: 'Preferred date', enableDate: true, enableTime: false, min: today, max: addDays(today, TUTORING_HOURS.maxDaysAhead), value: { path: '/form/preferredDate' }, checks: [required('/form/preferredDate', 'Preferred date')] },
          { id: 'period', component: 'ChoicePicker', label: 'Preferred time of day', variant: 'mutuallyExclusive', displayStyle: 'chips', options: [{ label: 'Morning', value: 'morning' }, { label: 'Afternoon', value: 'afternoon' }], value: { path: '/form/period' }, checks: [required('/form/period', 'Preferred time of day')] },
          { id: 'specific_time', component: 'DateTimeInput', label: 'Preferred specific time (optional)', enableDate: false, enableTime: true, min: `${TUTORING_HOURS.open}:00`, max: `${TUTORING_HOURS.close}:00`, value: { path: '/form/specificTime' } }, // min/max: ISO 8601 times (schema format "time")
          textField('notes', 'Describe what you’d like help with.', 'notes', [nonBlank('/form/notes', 'A description'), maxLen('/form/notes', LIMITS.notes, 'Notes')], 'longText'),
          textC('demo_note', 'Demo request: these are preferences, not a confirmed appointment. This spike sends no email or scheduling message.', 'caption'),
          { id: 'actions', component: 'Row', children: ['submit_button', 'cancel_button'] },
          ...button('submit_button', 'Send tutoring request', 'submitTutoringRequest', TUTORING_FIELDS, 'primary'),
          ...button('cancel_button', 'Cancel', 'cancelForm', [], 'borderless'),
        ],
      },
    }),
    v({
      updateDataModel: {
        surfaceId, path: '/',
        value: {
          form: { firstName: '', lastName: '', email: '', preferredDate: prefill.preferredDate ?? '', period: prefill.period ? [prefill.period] : [], specificTime: prefill.specificTime ?? '', notes: '' },
          ui: { submitAttempted: false, submitLocked: false },
        },
      },
    }),
  ];
}

const slotPicker = (slots, note) => [
  { id: 'slot', component: 'ChoicePicker', label: 'Available start time (Demo availability)', variant: 'mutuallyExclusive', displayStyle: 'chips', options: slots.map((s) => ({ label: s.label, value: s.slotId })), value: { path: '/form/slot' }, checks: [required('/form/slot', 'A start time')] },
  textC('slot_note', note, 'caption'),
];

const BOOKING_EDIT_CHILDREN = ['title', 'details', 'first_name', 'last_name', 'email', 'group_size', 'date', 'room', 'duration', 'check_button', 'slot', 'slot_note', 'demo_note', 'actions'];

export function buildStudyRoomForm(surfaceId, { prefill = {}, now = new Date() } = {}) {
  const today = todayIn(now);
  const wf = WORKFLOWS['study-room-booking'];
  return [
    v({ createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID, sendDataModel: false } }),
    v({
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: BOOKING_EDIT_CHILDREN },
          textC('title', wf.title, 'h3'),
          textC('details', `Times are ${TIMEZONE_LABEL}. Rooms are bookable ${BOOKING.open}–${BOOKING.close}, for 1 or 2 hours, up to ${BOOKING.maxDaysAhead} days ahead. ${ROOMS.map((r) => `${r.name}: up to ${r.capacity} people`).join('; ')}.`, 'caption'),
          ...contactFields(),
          textField('group_size', `Group size (1–${BOOKING.maxGroup})`, 'groupSize', [required('/form/groupSize', 'Group size')], 'number'),
          { id: 'date', component: 'DateTimeInput', label: 'Date', enableDate: true, enableTime: false, min: today, max: addDays(today, BOOKING.maxDaysAhead), value: { path: '/form/date' }, checks: [required('/form/date', 'Date')] },
          { id: 'room', component: 'ChoicePicker', label: 'Room', variant: 'mutuallyExclusive', displayStyle: 'chips', options: ROOMS.map((r) => ({ label: `${r.name} (up to ${r.capacity})`, value: r.id })), value: { path: '/form/room' }, checks: [required('/form/room', 'Room')] },
          { id: 'duration', component: 'ChoicePicker', label: 'Duration', variant: 'mutuallyExclusive', displayStyle: 'chips', options: BOOKING.durations.map((d) => ({ label: `${d / 60} hour${d > 60 ? 's' : ''}`, value: String(d) })), value: { path: '/form/duration' }, checks: [required('/form/duration', 'Duration')] },
          ...button('check_button', 'Show available times', 'checkAvailability', BOOKING_CRITERIA),
          ...slotPicker([], 'Choose group size, date, room and duration to see demo availability.'),
          textC('demo_note', 'Demo availability and demo bookings only — not a real university reservation. Selecting a time does not reserve it.', 'caption'),
          { id: 'actions', component: 'Row', children: ['review_button', 'cancel_button'] },
          ...button('review_button', 'Review booking', 'reviewBooking', BOOKING_FIELDS, 'primary'),
          ...button('cancel_button', 'Cancel', 'cancelForm', [], 'borderless'),
        ],
      },
    }),
    v({
      updateDataModel: {
        surfaceId, path: '/',
        value: {
          form: { firstName: '', lastName: '', email: '', groupSize: prefill.groupSize ? String(prefill.groupSize) : '', date: prefill.date ?? '', room: [], duration: prefill.duration ? [String(prefill.duration)] : [], slot: [] },
          ui: { submitAttempted: false, submitLocked: false },
        },
      },
    }),
  ];
}

// Library → form: new slot options for the current criteria. The selection is cleared unless the
// previously selected slot is still offered (a stale selection never survives a criteria change).
export function buildSlotUpdate(surfaceId, slots, note, keepSlot = null) {
  return [
    v({ updateComponents: { surfaceId, components: slotPicker(slots, note) } }),
    v({ updateDataModel: { surfaceId, path: '/form/slot', value: keepSlot && slots.some((s) => s.slotId === keepSlot) ? [keepSlot] : [] } }),
  ];
}

// Library → form: switch to the read-only review summary with the final confirmation button.
export function buildReviewUpdate(surfaceId, lines) {
  return [
    v({
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['review_title', ...lines.map((_, i) => `review_line_${i}`), 'review_note', 'review_actions'] },
          textC('review_title', 'Review your demo booking', 'h4'),
          ...lines.map((line, i) => textC(`review_line_${i}`, line)),
          textC('review_note', 'Nothing is reserved until you confirm. The time is re-checked when you confirm.', 'caption'),
          { id: 'review_actions', component: 'Row', children: ['confirm_button', 'edit_button'] },
          ...button('confirm_button', 'Confirm demo booking', 'confirmStudyRoomBooking', BOOKING_FIELDS, 'primary'),
          ...button('edit_button', 'Back to edit', 'editBooking', [], 'borderless'),
        ],
      },
    }),
  ];
}
export function buildEditUpdate(surfaceId) {
  return [v({ updateComponents: { surfaceId, components: [{ id: 'root', component: 'Column', children: BOOKING_EDIT_CHILDREN }] } })];
}
export const buildDelete = (surfaceId) => [v({ deleteSurface: { surfaceId } })];

// ---- Student side: allowlist for received A2UI payloads -------------------------------------

const ALLOWED_COMPONENTS = new Set(['Column', 'Row', 'Text', 'TextField', 'Button', 'ChoicePicker', 'DateTimeInput', 'Divider']);
// Pure, side-effect-free catalog functions a form needs. Anything else (openUrl, formatters, …) is refused.
const ALLOWED_FUNCTIONS = new Set(['required', 'regex', 'length', 'email', 'and', 'or', 'not']);

function findForbidden(value, path) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findForbidden(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  if ('functionCall' in value) return `Local function call at ${path} is not allowed.`;
  if ('call' in value && !ALLOWED_FUNCTIONS.has(value.call)) return `Function "${value.call}" at ${path} is not allowed.`;
  if ('action' in value) {
    const keys = value.action && typeof value.action === 'object' ? Object.keys(value.action) : [];
    if (keys.length !== 1 || keys[0] !== 'event') return `Action at ${path} must be a server event only.`;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findForbidden(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function checkMessages(messages, surfaceId, allowedKeys) {
  for (const m of messages) {
    if (m?.version !== A2UI_VERSION) return `Unsupported A2UI version "${m?.version}".`;
    const keys = Object.keys(m).filter((k) => k !== 'version');
    if (keys.length !== 1 || !allowedKeys.has(keys[0])) return `Unsupported A2UI message: ${keys.join(', ')}.`;
    if (m[keys[0]].surfaceId !== surfaceId) return 'All messages must target the same surface.';
    if (m.createSurface && m.createSurface.catalogId !== BASIC_CATALOG_ID) return 'Only the basic catalog is accepted.';
    for (const c of m.updateComponents?.components ?? []) {
      if (!ALLOWED_COMPONENTS.has(c.component)) return `Component "${c.component}" is not allowed.`;
    }
  }
  return null;
}

// A new form: exactly one createSurface first, plain form components only, server-event actions
// only, no non-allowlisted function anywhere, one surface, bounded size. Returns an error or null.
export function checkFormPayloadPolicy(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'A2UI payload must be a non-empty array of messages.';
  if (JSON.stringify(messages).length > MAX_A2UI_PAYLOAD_BYTES) return 'A2UI payload is too large.';
  const creates = messages.filter((m) => m?.createSurface);
  if (creates.length !== 1 || messages[0] !== creates[0]) return 'Payload must start with exactly one createSurface.';
  const surfaceId = creates[0].createSurface.surfaceId;
  if (typeof surfaceId !== 'string' || !/^[\w-]{1,100}$/.test(surfaceId)) return 'Malformed surfaceId.';
  return checkMessages(messages, surfaceId, new Set(['createSurface', 'updateComponents', 'updateDataModel'])) ?? findForbidden(messages, 'payload');
}

// An update to an existing form (slot options, review screen, removal): same rules, no createSurface.
export function checkFormUpdatePolicy(messages, surfaceId) {
  if (!Array.isArray(messages) || messages.length === 0) return 'A2UI update must be a non-empty array of messages.';
  if (JSON.stringify(messages).length > MAX_A2UI_PAYLOAD_BYTES) return 'A2UI update is too large.';
  return checkMessages(messages, surfaceId, new Set(['updateComponents', 'updateDataModel', 'deleteSurface'])) ?? findForbidden(messages, 'update');
}

export const isA2uiPart = (part) => part?.content?.$case === 'data' && (part.mediaType === A2UI_MIME_TYPE || part.metadata?.mimeType === A2UI_MIME_TYPE);
