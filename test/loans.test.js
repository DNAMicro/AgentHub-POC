// Part 8: the Library's loans and model-generated UI.
//
// What is real here: the loan service, the catalog/validator, the Hub path, the Student/UI checks, the
// form lifecycle and renewals. What is MOCKED: the model's output — integration tests run the Library in
// live mode against the local fake Messages API with SCRIPTED responses. They prove plumbing, validation,
// repair and safety, not the model's judgment; that is checked live, in a browser, separately.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { startStack, waitFor, openStream, find, findAll, formVia, chatVia, formAction, waitLifecycle, lastLifecycle, freshLoanStore, post } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { createLoanStore, LOAN_POLICY } from '../src/loan-store.js';
import { CATALOG_INFO, allowedDatesFrom, catalogForModel, validateGeneratedUi, validateServerToClientList, wrapSurface } from '../src/a2ui-catalog.js';
import { GENERATED_COMPONENTS, checkAction, checkFormPayloadPolicy, surfaceButtons, addDays } from '../src/forms.js';
import { askTutor } from '../src/student-agent.js';

// ---- the loan service (unit) ---------------------------------------------------------------------

test('loan service: authoritative eligibility, a backend-computed range, idempotent renewals that persist', () => {
  const file = freshLoanStore();
  const store = createLoanStore({ file });
  const mine = store.listLoans('student-alex');
  assert.ok(mine.length >= 5 && mine.every((l) => l.synthetic));
  assert.ok(!mine.some((l) => l.loanId === 'L-2001'), 'another borrower’s loan is never listed');
  const byId = Object.fromEntries(mine.map((l) => [l.loanId, l]));
  assert.equal(byId['L-1001'].eligible, true);
  assert.deepEqual(byId['L-1001'].permittedReturnDates, { earliest: addDays(byId['L-1001'].dueDate, 1), latest: addDays(byId['L-1001'].dueDate, LOAN_POLICY.renewalDays) });
  assert.deepEqual(['L-1003', 'L-1004', 'L-1006'].map((id) => byId[id].eligibilityCode), ['on_hold', 'renewal_limit', 'course_reserve']);
  assert.equal(byId['L-1003'].permittedReturnDates, null);

  const range = byId['L-1001'].permittedReturnDates;
  const op = randomUUID();
  assert.equal(store.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1001', returnDate: addDays(range.latest, 1), expectedVersion: 1, operationId: randomUUID() }).code, 'out_of_range');
  assert.equal(store.renewLoan({ borrowerId: 'student-sam', loanId: 'L-1001', returnDate: range.latest, expectedVersion: 1, operationId: randomUUID() }).code, 'not_found', 'ownership is enforced');
  assert.equal(store.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1003', returnDate: range.latest, expectedVersion: 1, operationId: randomUUID() }).code, 'on_hold');
  const ok = store.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1001', returnDate: range.latest, expectedVersion: 1, operationId: op });
  assert.equal(ok.ok, true);
  assert.equal(ok.receipt.newDueDate, range.latest);
  // The same operation again — even after a "restart" (a new store on the same file) — renews nothing.
  const restarted = createLoanStore({ file });
  const again = restarted.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1001', returnDate: range.latest, expectedVersion: 1, operationId: op });
  assert.equal(again.duplicate, true);
  assert.equal(restarted.getLoan('student-alex', 'L-1001').renewalsUsed, 1, 'renewed exactly once');
  assert.equal(restarted.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1001', returnDate: range.earliest, expectedVersion: 1, operationId: op }).code, 'operation_reused');
  assert.equal(restarted.renewLoan({ borrowerId: 'student-alex', loanId: 'L-1001', returnDate: addDays(range.latest, 2), expectedVersion: 1, operationId: randomUUID() }).code, 'stale', 'an old record version is refused');
  // Seeded today; read 40 days later, the same record is overdue.
  const seededFile = freshLoanStore();
  createLoanStore({ file: seededFile });
  const later = createLoanStore({ file: seededFile, now: () => new Date(Date.now() + 40 * 864e5) });
  assert.equal(later.getLoan('student-alex', 'L-1002').eligibilityCode, 'overdue');
});

// ---- the catalog and the validator (unit) ----------------------------------------------------------

test('the model-visible catalog is the installed renderer’s catalog (minus URL-loading media)', () => {
  const catalog = JSON.parse(readFileSync(new URL('../node_modules/@a2ui/web_core/src/v0_9/schemas/catalogs/basic/catalog.json', import.meta.url), 'utf8'));
  const registered = readFileSync(new URL('../node_modules/@a2ui/lit/src/v0_9/catalogs/basic/index.js', import.meta.url), 'utf8');
  for (const c of GENERATED_COMPONENTS) {
    assert.ok(catalog.components[c], `${c} is in the official catalog`);
    assert.match(registered, new RegExp(`\\bA2ui${c}\\b`), `${c} is registered by the installed Lit renderer`);
  }
  for (const media of ['Image', 'Video', 'AudioPlayer']) assert.ok(!GENERATED_COMPONENTS.includes(media));
  const forModel = catalogForModel();
  assert.equal(forModel.catalog.id, CATALOG_INFO.catalogId);
  const dti = forModel.components.find((c) => c.component === 'DateTimeInput');
  assert.deepEqual(dti.properties.map((p) => p.name).sort(), Object.keys(catalog.components.DateTimeInput.allOf.at(-1).properties).filter((k) => k !== 'component').sort());
  assert.ok(forModel.components.find((c) => c.component === 'ChoicePicker').properties.some((p) => p.name === 'filterable'), 'the searchable selector is offered because the renderer implements it');
});

const LOANS = createLoanStore({ file: freshLoanStore() }).listLoans('student-alex');
const L = Object.fromEntries(LOANS.map((l) => [l.loanId, l]));
const ALLOWED = allowedDatesFrom({ loans: LOANS, today: LOANS[0].checkedOut, studentText: [] });
// A composition like the model would write (scripted here) — a renewal for one loan.
function renewalSurface(loan, overrides = {}) {
  const r = loan.permittedReturnDates ?? { earliest: '2026-01-01', latest: '2026-01-02' };
  return [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['title', 'facts', 'date', 'actions'] },
    { id: 'title', component: 'Text', text: `Renew ${loan.title}`, variant: 'h3' },
    { id: 'facts', component: 'Text', text: `${loan.loanId} is due ${loan.dueDate}.` },
    { id: 'date', component: 'DateTimeInput', label: 'New return date', enableDate: true, value: { path: '/form/returnDate' }, min: r.earliest, max: r.latest, ...overrides.date },
    { id: 'actions', component: 'Row', children: ['renew_button', 'cancel_button'] },
    { id: 'renew_label', component: 'Text', text: 'Renew' },
    { id: 'renew_button', component: 'Button', child: 'renew_label', variant: 'primary', action: { event: { name: overrides.op ?? 'renewLoan', context: { loanId: loan.loanId, returnDate: { path: '/form/returnDate' } } } } },
    { id: 'cancel_label', component: 'Text', text: 'Not now' },
    { id: 'cancel_button', component: 'Button', child: 'cancel_label', action: { event: { name: 'cancelForm', context: {} } } },
  ];
}
const validate = (components, dataModel = { form: { returnDate: '' } }) => validateGeneratedUi({ components, dataModel, loans: LOANS, allowedDates: ALLOWED });

test('validator: a valid composition passes the official schema and the app rules', () => {
  const comps = renewalSurface(L['L-1001']);
  assert.equal(validateServerToClientList(wrapSurface('s1', comps, { form: { returnDate: '' } })), null);
  const v = validate(comps);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.renewable, { 'L-1001': 1 });
  // Read-only overview with a List template and a filterable picker is fine too (no actions at all).
  assert.deepEqual(validate([
    { id: 'root', component: 'Column', children: ['h', 'pick', 'list'] },
    { id: 'h', component: 'Text', text: 'Your loans', variant: 'h3' },
    { id: 'pick', component: 'ChoicePicker', label: 'Show', filterable: true, options: LOANS.map((l) => ({ label: l.title, value: l.loanId })), value: { path: '/view/pick' } },
    { id: 'list', component: 'List', children: { componentId: 'row', path: '/view/rows' } },
    { id: 'row', component: 'Text', text: { path: 'label' } },
  ], { view: { pick: [], rows: [{ label: `${L['L-1002'].title}, due ${L['L-1002'].dueDate}` }] } }).errors, []);
});

test('validator rejects unsupported components, unregistered actions, misleading or unsafe compositions', () => {
  const c = () => renewalSurface(L['L-1001']);
  const cases = [
    ['an Image (loads a URL)', [...c(), { id: 'pic', component: 'Image', url: 'https://example.com/x.png' }], /Image" is not allowed/],
    ['an unregistered operation', renewalSurface(L['L-1001'], { op: 'deleteLoan' }), /not a registered operation/],
    ['a renew action for an ineligible loan', renewalSurface(L['L-1003']), /not eligible for renewal/],
    ['a date range the backend didn’t give', renewalSurface(L['L-1001'], { date: { max: addDays(L['L-1001'].permittedReturnDates.latest, 7) } }), /exactly the backend's permitted dates/],
    ['a slider for the return date', c().map((x) => (x.id === 'date' ? { id: 'date', component: 'Slider', value: { path: '/form/returnDate' }, min: 0, max: 21 } : x)), /DateTimeInput/],
    ['an editable due date', [...c(), { id: 'due_edit', component: 'TextField', label: 'Due date', value: { path: '/form/due' } }].map((x) => (x.id === 'body' ? { ...x, children: [...x.children, 'due_edit'] } : x)), /due date the backend owns/, { form: { returnDate: '', due: L['L-1001'].dueDate } }],
    ['an invented date', c().map((x) => (x.id === 'facts' ? { ...x, text: 'Due December 25.' } : x)), /dates don't come from the loan data/],
    ['a local function action', c().map((x) => (x.id === 'cancel_button' ? { ...x, action: { functionCall: { call: 'openUrl', args: { url: 'https://example.com' } } } } : x)), /server event|not allowed/],
    ['a missing reference', c().map((x) => (x.id === 'body' ? { ...x, children: [...x.children, 'ghost'] } : x)), /missing component "ghost"/],
    ['no root', c().map((x) => (x.id === 'root' ? { ...x, id: 'top' } : x)), /id "root"/],
    ['Markdown in text', c().map((x) => (x.id === 'title' ? { ...x, text: '**Renew**' } : x)), /Markdown/],
    ['nesting that is too deep', [{ id: 'root', component: 'Column', children: ['n1'] }, ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i + 1}`, component: 'Column', children: i < 11 ? [`n${i + 2}`] : [] }))], /too deep/],
  ];
  for (const [what, comps, pattern, dataModel] of cases) {
    const v = validate(comps, dataModel);
    assert.equal(v.ok, false, `${what} must be rejected`);
    assert.ok(v.errors.some((e) => pattern.test(e)), `${what}: ${v.errors.join(' | ')}`);
  }
});

test('Student-side checks: generated surfaces get the wider catalog set; only the surface’s own buttons can act', () => {
  const msgs = wrapSurface('loan-renewal-x1', renewalSurface(L['L-1001']), { form: { returnDate: '' } });
  assert.equal(checkFormPayloadPolicy(msgs, { workflowId: 'loan-renewal' }), null);
  assert.match(checkFormPayloadPolicy(msgs, { workflowId: 'tutoring-request' }), /Component "Card" is not allowed/, 'fixed forms keep the small set');
  const buttons = surfaceButtons(msgs);
  const act = (sourceComponentId, name = 'renewLoan') => checkAction({ version: 'v0.9', action: { name, surfaceId: 'loan-renewal-x1', sourceComponentId, context: { loanId: 'L-1001', returnDate: '2026-01-01' } } }, { workflowId: 'loan-renewal', surfaceId: 'loan-renewal-x1', buttons });
  assert.equal(act('renew_button').ok, true);
  assert.match(act('made_up_button').error, /button in that form/);
  assert.match(act('cancel_button').error, /button in that form/, 'a button can only send its own operation');
});

// ---- through the Hub, with a scripted model (MOCKED model output) --------------------------------
// The Hub runs its MOCK router here, so requests use wording that heuristic places clearly with the
// Library; the natural phrasings ("the calculus book") are exercised live against the real router.

let stub, stack, storeFile, stream;
const classify = { verdict: 'my_loans', skill_id: '', answer: '', evidence: [], clarification_question: '' };
const reply = (r) => messageReply(JSON.stringify({ loan_ids: [], components_json: '[]', data_model_json: '{}', ...r }));
// Each Library call: the first model call classifies the request, the next ones compose the reply.
function script(...loanReplies) {
  let n = 0;
  stub.respondWith((body) => (body.output_config?.format?.schema?.properties?.verdict ? messageReply(JSON.stringify(classify)) : reply(loanReplies[Math.min(n++, loanReplies.length - 1)])));
}
const loanCalls = () => stub.requests.filter((r) => r.body.output_config?.format?.schema?.properties?.kind);
const loansNow = () => Object.fromEntries(JSON.parse(readFileSync(storeFile, 'utf8')).loans.map((l) => [l.loanId, l]));
const ui = (loan, extra = {}) => ({ kind: 'ui', text: `You can keep ${loan.title} longer. Pick a date.`, loan_ids: [loan.loanId], components_json: JSON.stringify(renewalSurface(loan)), data_model_json: JSON.stringify({ form: { returnDate: '' } }), ...extra });

before(async () => {
  stub = await startFakeAnthropic();
  storeFile = freshLoanStore();
  stack = await startStack({
    hubEnv: { ROUTER_MODE: 'mock' },
    libraryEnv: { LIBRARY_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0', LOAN_STORE_FILE: storeFile, LIBRARY_TEST_HOOKS: '1' },
  });
  await waitFor(() => existsSync(storeFile), { what: 'loan store' });
  stream = await openStream(stack.ui.url);
});
after(async () => {
  stream?.close();
  stack?.kill();
  await stub?.close();
});

test('a due-date question gets a direct answer from the records — no form', async () => {
  const loan = loansNow()['L-1001'];
  script({ kind: 'answer', text: `${loan.title} is due on ${loan.dueDate}.`, loan_ids: ['L-1001'] });
  const r = await chatVia(stack.ui, stream, 'When is my calculus book due?');
  assert.equal(r.reply.servedBy, 'library');
  assert.match(r.reply.text, new RegExp(loan.dueDate));
  assert.ok(!find(r.events, 'student', 'form_received'), 'no unnecessary form');
  const gen = await waitFor(() => find(r.events, 'library', 'ui_generated') ?? find(stream.events.filter((e) => e.runId === r.runId), 'library', 'ui_generated'), { what: 'inspector event' });
  assert.equal(gen.data.inspector.decision, 'answer');
  assert.ok(gen.data.inspector.authoritative.some((l) => l.loanId === 'L-1001' && l.dueDate === loan.dueDate), 'the inspector shows where the date came from');
  // The model saw the borrower's loans only — from the Hub's verified student, not from the model.
  const body = loanCalls().at(-1).body.messages[0].content;
  assert.match(body, /L-1001/);
  assert.doesNotMatch(body, /L-2001/);
});

test('an invented date is caught and repaired from the validation errors', async () => {
  const loan = loansNow()['L-1002'];
  stub.reset();
  script({ kind: 'answer', text: `${loan.title} is due on December 25.` }, { kind: 'answer', text: `${loan.title} is due on ${loan.dueDate}.` });
  const r = await chatVia(stack.ui, stream, 'When is the marketing book I borrowed due?');
  assert.match(r.reply.text, new RegExp(loan.dueDate));
  assert.equal(loanCalls().length, 2, 'one repair');
  assert.match(JSON.stringify(loanCalls()[1].body.messages.at(-1)), /dates that don't come from the loan data/);
});

test('a clarifying question is passed on as a question, not a form', async () => {
  script({ kind: 'clarify', text: 'Which book do you mean — Principles of Marketing or Marketing Research Methods?' });
  const r = await chatVia(stack.ui, stream, 'Extend the marketing book');
  assert.match(r.reply.text, /Which book/);
  assert.ok(!find(r.events, 'student', 'form_received'));
});

test('eligible renewal: generated surface through the Hub → verified receipt; retries and double submits renew once', async () => {
  const loan = { ...loansNow()['L-1001'], ...LOANS.find((l) => l.loanId === 'L-1001') };
  const current = createLoanStore({ file: storeFile }).getLoan('student-alex', 'L-1001');
  script(ui(current));
  const { form, events } = await formVia(stack.ui, stream, 'Can I renew my borrowed library book until after my exam?');
  assert.ok(form, `a generated surface arrived (got: ${JSON.stringify(events.filter((e) => ['reply_received', 'request_failed', 'ui_generated'].includes(e.type)).map((e) => [e.type, e.data.text ?? e.data.error, e.data.inspector?.validation]))})`);
  assert.equal(form.workflowId, 'loan-renewal');
  assert.equal(form.issuer, 'library');
  assert.match(form.formRef, /^hf-/, 'relayed by the Hub with its own reference');
  const comps = form.a2uiMessages.flatMap((m) => m.updateComponents?.components ?? []);
  assert.ok(comps.some((c) => c.component === 'DateTimeInput' && c.min === current.permittedReturnDates.earliest), 'the model’s composition arrived unchanged');
  assert.ok(find(events, 'hub', 'forward_attempted'));

  const op = randomUUID();
  const ctx = { loanId: 'L-1001', returnDate: current.permittedReturnDates.latest };
  assert.equal((await formAction(stack.ui, form.formId, 'renewLoan', 'renew_button', ctx, op)).status, 202);
  await waitLifecycle(stream, form.formId, ['accepted']);
  const receipt = lastLifecycle(stream.events, form.formId).receipt;
  assert.match(receipt.renewalId, /^RN-/);
  assert.equal(receipt.newDueDate, current.permittedReturnDates.latest);
  assert.equal(loansNow()['L-1001'].renewals, loan.renewalsUsed + 1, 'renewed in the backend');
  // Accepted: the form is closed — a second submit is refused; nothing renews twice.
  assert.equal((await formAction(stack.ui, form.formId, 'renewLoan', 'renew_button', ctx, randomUUID())).status, 409);
  assert.equal(loansNow()['L-1001'].renewals, loan.renewalsUsed + 1);
});

test('an action from a button that isn’t in the generated surface is refused before anything is sent', async () => {
  const current = createLoanStore({ file: storeFile }).getLoan('student-alex', 'L-1005');
  script(ui(current));
  const { form } = await formVia(stack.ui, stream, 'I want to keep my borrowed library book longer');
  const res = await formAction(stack.ui, form.formId, 'renewLoan', 'invented_button', { loanId: 'L-1005', returnDate: current.permittedReturnDates.earliest });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /button in that form/);
  // Changed eligibility behind the form's back (another borrower places a hold) → refused at submission.
  await post(`${stack.library.url}/test/loans/L-1005/hold`, { hold: true });
  await formAction(stack.ui, form.formId, 'renewLoan', 'renew_button', { loanId: 'L-1005', returnDate: current.permittedReturnDates.earliest });
  await waitLifecycle(stream, form.formId, ['rejected']);
  assert.match(JSON.stringify(lastLifecycle(stream.events, form.formId).errors), /changed since the form was made/);
  assert.equal(loansNow()['L-1005'].renewals, 0, 'nothing renewed');
});

test('ineligible: a renew button for it is rejected and repaired into an explanation', async () => {
  const blocked = createLoanStore({ file: storeFile }).getLoan('student-alex', 'L-1003');
  stub.reset();
  script(ui({ ...blocked, permittedReturnDates: { earliest: '2026-01-01', latest: '2026-01-02' } }), { kind: 'answer', text: `${blocked.title} can’t be renewed: ${blocked.eligibilityReason}`, loan_ids: ['L-1003'] });
  const r = await chatVia(stack.ui, stream, 'Why can’t I renew the chemistry lab manual?');
  assert.match(r.reply.text, /hold/);
  assert.ok(!find(r.events, 'student', 'form_received'), 'no executable submission');
  const gen = await waitFor(() => find(stream.events.filter((e) => e.runId === r.runId), 'library', 'ui_generated'), { what: 'inspector' });
  assert.deepEqual(gen.data.inspector.validation.map((a) => a.ok), [false, true]);
  assert.ok(gen.data.inspector.validation[0].errors.some((e) => /not eligible/.test(e)));
});

test('invalid UI that can’t be repaired degrades truthfully — no canned form', async () => {
  stub.reset();
  script({ kind: 'ui', text: 'Here you go.', components_json: JSON.stringify([{ id: 'root', component: 'Image', url: 'https://example.com' }]), data_model_json: '{}' });
  const r = await chatVia(stack.ui, stream, 'Show me everything I borrowed');
  assert.match(r.reply.text, /didn't pass the library's checks/);
  assert.ok(!find(r.events, 'student', 'form_received'));
  assert.equal(loanCalls().length, 3, 'bounded: the first attempt plus two repairs');
});

test('the Library never takes the borrower from the caller: no Hub-signed student, no loans (spoofed or forged identities refused)', async () => {
  stub.reset();
  script({ kind: 'answer', text: 'unused' });
  const direct = await askTutor(stack.library.url, 'When is my calculus book due?', {});
  assert.match(direct.text, /only look up loans for a student who asks through the university/);
  // Another local process claiming to be student-alex — without the Hub's signature, or with a forged one.
  for (const metadata of [{ studentId: 'student-alex' }, { studentId: 'student-alex', hubOperationId: randomUUID(), hubSignature: 'forged-signature-forged-signature-forged-xx' }]) {
    const spoofed = await askTutor(stack.library.url, 'Show me everything I borrowed', { metadata });
    assert.match(spoofed.text, /only look up loans for a student who asks through the university/, `refused: ${JSON.stringify(Object.keys(metadata))}`);
  }
  assert.equal(loanCalls().length, 0, 'no loan data was given to the model');
});

test('mock mode answers in labelled text and never generates UI', async () => {
  const mock = await startStack({ hubEnv: { ROUTER_MODE: 'mock' }, library: true });
  try {
    const s = await openStream(mock.ui.url);
    const r = await chatVia(mock.ui, s, 'Show me everything I borrowed');
    assert.match(r.reply.text, /mock mode — no model, so no generated interface/);
    assert.ok(!find(r.events, 'student', 'form_received'));
    s.close();
  } finally {
    mock.kill();
  }
});
