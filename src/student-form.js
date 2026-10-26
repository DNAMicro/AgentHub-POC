// The student-details form: its A2UI v0.9 description (built by the Tutor),
// the validation rules (enforced independently by browser, UI server, and Tutor),
// and the allowlist the Student applies to any A2UI payload it receives.
//
// Dependency-free ESM so the browser can load it too (served at /shared/student-form.js).

export const A2UI_VERSION = 'v0.9';
export const A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9';
export const A2UI_MIME_TYPE = 'application/a2ui+json';
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
export const FORM_REQUEST = 'student-details-form'; // A2A Message.metadata.request value
export const SUBMIT_ACTION = 'submitStudentDetails';
export const SUBMIT_BUTTON_ID = 'submit_button';

export const FIELDS = ['firstName', 'lastName', 'email', 'notes'];
export const LIMITS = { firstName: 100, lastName: 100, email: 254, notes: 1000 };
export const MAX_A2UI_PAYLOAD_BYTES = 64 * 1024;

// Server/browser format check only: it says nothing about whether the address exists.
// Not ambiguous (labels exclude dots), so it can't backtrack badly; input is also length-capped.
const EMAIL_PATTERN = /^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)+$/;
const NON_BLANK_PATTERN = '\\S';

// ---- Tutor side: build the A2UI messages ----------------------------------

// A check that only fails after the student pressed Submit once, so an untouched
// form doesn't open full of errors. `/ui/submitAttempted` is client-local state.
const afterSubmit = (rule, message) => ({
  condition: { call: 'or', args: { values: [{ call: 'not', args: { value: { path: '/ui/submitAttempted' } } }, rule] } },
  message,
});
const regex = (path, pattern) => ({ call: 'regex', args: { value: { path }, pattern } });
const maxLength = (path, max) => ({ call: 'length', args: { value: { path }, max } });

export function buildStudentDetailsForm(surfaceId) {
  const textField = (id, label, field, extraChecks = [], variant = 'shortText') => ({
    id,
    component: 'TextField',
    label,
    variant,
    value: { path: `/form/${field}` },
    checks: [...extraChecks, afterSubmit(maxLength(`/form/${field}`, LIMITS[field]), `${label.replace(' (optional)', '')} must be at most ${LIMITS[field]} characters.`)],
  });

  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID, sendDataModel: false } },
    {
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['title', 'first_name', 'last_name', 'email', 'notes', SUBMIT_BUTTON_ID] },
          { id: 'title', component: 'Text', text: 'Student details', variant: 'h3' },
          textField('first_name', 'First name', 'firstName', [afterSubmit(regex('/form/firstName', NON_BLANK_PATTERN), 'First name is required.')]),
          textField('last_name', 'Last name', 'lastName', [afterSubmit(regex('/form/lastName', NON_BLANK_PATTERN), 'Last name is required.')]),
          textField('email', 'Email', 'email', [
            afterSubmit({ call: 'required', args: { value: { path: '/form/email' } } }, 'Email is required.'),
            // The catalog's own `email` function. (A custom regex here is refused by the
            // renderer's ReDoS guard, which then reports the check as failed.)
            afterSubmit({ call: 'email', args: { value: { path: '/form/email' } } }, 'Enter a valid email format, like alex@example.com.'),
          ]),
          textField('notes', 'Notes (optional)', 'notes', [], 'longText'),
          { id: 'submit_label', component: 'Text', text: 'Submit' },
          {
            id: SUBMIT_BUTTON_ID,
            component: 'Button',
            child: 'submit_label',
            variant: 'primary',
            // The renderer disables a Button whose checks fail; the client sets this
            // local flag while a submission is pending and after it's accepted.
            checks: [{ condition: { call: 'not', args: { value: { path: '/ui/submitLocked' } } }, message: 'Submission pending or complete.' }],
            action: {
              event: {
                name: SUBMIT_ACTION,
                context: Object.fromEntries(FIELDS.map((f) => [f, { path: `/form/${f}` }])),
              },
            },
          },
        ],
      },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId, path: '/', value: { form: { firstName: '', lastName: '', email: '', notes: '' }, ui: { submitAttempted: false, submitLocked: false } } },
    },
  ];
}

// ---- Everyone: validate a submission ---------------------------------------

// Returns { ok: true, values } with trimmed values, or { ok: false, errors } keyed by field
// (or `_form` for structural problems such as unexpected fields).
export function validateSubmission(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _form: 'Submission must be an object.' } };
  }
  const unexpected = Object.keys(input).filter((k) => !FIELDS.includes(k));
  if (unexpected.length) return { ok: false, errors: { _form: `Unexpected field(s): ${unexpected.join(', ')}.` } };

  const errors = {};
  const values = {};
  for (const field of FIELDS) {
    const raw = input[field] ?? '';
    if (typeof raw !== 'string') {
      errors[field] = 'Must be text.';
      continue;
    }
    values[field] = raw.trim();
    if (values[field].length > LIMITS[field]) errors[field] = `Must be at most ${LIMITS[field]} characters.`;
  }
  if (!errors.firstName && !values.firstName) errors.firstName = 'First name is required.';
  if (!errors.lastName && !values.lastName) errors.lastName = 'Last name is required.';
  if (!errors.email && !values.email) errors.email = 'Email is required.';
  else if (!errors.email && !EMAIL_PATTERN.test(values.email)) errors.email = 'Enter a valid email format.';

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

// Validates an A2UI client-to-server `action` message for this form.
export function validateAction(message, expectedSurfaceId) {
  const action = message?.action;
  if (message?.version !== A2UI_VERSION || !action) return { ok: false, errors: { _form: 'Not an A2UI v0.9 action message.' } };
  if (action.name !== SUBMIT_ACTION) return { ok: false, errors: { _form: `Unknown action "${action.name}".` } };
  if (action.surfaceId !== expectedSurfaceId) return { ok: false, errors: { _form: 'Action is for a different form.' } };
  if (action.sourceComponentId !== SUBMIT_BUTTON_ID) return { ok: false, errors: { _form: 'Action did not come from the submit button.' } };
  return validateSubmission(action.context);
}

// ---- Student side: allowlist for received A2UI payloads -------------------

const ALLOWED_COMPONENTS = new Set(['Column', 'Text', 'TextField', 'Button']);
const ALLOWED_MESSAGE_KEYS = new Set(['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']);

// Rejects anything beyond what a plain form needs: other components (Image, Video, …),
// local function-call actions (e.g. openUrl), other catalogs, or oversized payloads.
export function checkFormPayloadPolicy(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'A2UI payload must be a non-empty array of messages.';
  if (JSON.stringify(messages).length > MAX_A2UI_PAYLOAD_BYTES) return 'A2UI payload is too large.';
  for (const m of messages) {
    if (m?.version !== A2UI_VERSION) return `Unsupported A2UI version "${m?.version}".`;
    const keys = Object.keys(m).filter((k) => k !== 'version');
    if (keys.length !== 1 || !ALLOWED_MESSAGE_KEYS.has(keys[0])) return `Unsupported A2UI message: ${keys.join(', ')}.`;
    if (m.createSurface && m.createSurface.catalogId !== BASIC_CATALOG_ID) return 'Only the basic catalog is accepted.';
    for (const c of m.updateComponents?.components ?? []) {
      if (!ALLOWED_COMPONENTS.has(c.component)) return `Component "${c.component}" is not allowed.`;
      if (c.action && !c.action.event) return 'Only server event actions are allowed (no local function calls).';
    }
  }
  return null;
}

export const isA2uiPart = (part) => part?.content?.$case === 'data' && (part.mediaType === A2UI_MIME_TYPE || part.metadata?.mimeType === A2UI_MIME_TYPE);
