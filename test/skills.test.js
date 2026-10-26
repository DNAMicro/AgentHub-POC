// Part 5 deterministic unit tests: skill configuration, single source of truth, answer-content
// rules, router-decision validation, and trusted card validation. No processes, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillConfig, buildCardSkills, buildScopeExtension, policyFromConfig, SCOPE_EXTENSION_URI } from '../src/skills.js';
import { TUTOR_DEFAULT_SKILLS } from '../src/tutor-agent.js';
import { LIBRARY_DEFAULT_SKILLS } from '../src/library-fixture.js';
import { validateDecision } from '../src/router.js';
import { validateCard, trustedPeers } from '../src/student-registry.js';

const TUTOR_RULES = { answer: { knowledge: 'optional' }, form: { id: 'in-person-tutoring-request' } };
const LIBRARY_RULES = { answer: { knowledge: 'required' }, form: { id: 'study-room-booking' } };
const clone = (v) => structuredClone(v);
const newSkill = (extra = {}) => ({ id: 'opening-events', kind: 'answer', enabled: true, name: 'Events', description: 'Library events.', tags: [], examples: [], scope: { allowed: ['library events'], excluded: [] }, knowledge: 'Book club: first Monday, 18:00.', ...extra });

test('invalid skill configurations are rejected with field-level errors', () => {
  const cases = [
    [(c) => { c.skills[1].id = c.skills[0].id; }, /already uses the ID/],
    [(c) => { c.skills[0].id = 'Bad ID!'; }, /Skill ID must be/],
    [(c) => { c.skills[0].name = ''; }, /Name is required/],
    [(c) => { c.skills[0].description = 'x'.repeat(501); }, /Description is required/],
    [(c) => { c.skills[0].scope.allowed = []; }, /at least one line describing what this skill covers/],
    [(c) => { c.skills[0].enabled = 'yes'; }, /enabled must be true or false/],
    [(c) => { c.skills[0].endpointUrl = 'http://evil.example'; }, /Unexpected field/],
    [(c) => { c.skills[0].handler = 'llm-tutoring'; }, /Unexpected field\(s\): handler/],
    [(c) => { c.securitySchemes = {}; }, /Only skills can be edited/],
    [(c) => { c.skills.push({ ...c.skills[1], id: 'second-form' }); }, /Only the built-in "in-person-tutoring-request" skill can be a form/],
    [(c) => { c.skills[0].id = 'in-person-tutoring-request'; c.skills[1].id = 'x-form'; c.skills[1].kind = 'answer'; }, /reserved for the built-in form/],
    [(c) => { c.skills[0].kind = 'robot'; }, /Unknown skill kind/],
    [(c) => { c.skills[0].knowledge = 'x'.repeat(6001); }, /limited to 6000 characters/],
  ];
  for (const [mutate, message] of cases) {
    const cfg = clone(TUTOR_DEFAULT_SKILLS);
    mutate(cfg);
    const result = validateSkillConfig(cfg, TUTOR_RULES);
    assert.equal(result.ok, false, String(message));
    assert.match(result.errors.map((e) => e.message).join(' | '), message);
  }
  assert.equal(validateSkillConfig(TUTOR_DEFAULT_SKILLS, TUTOR_RULES).ok, true);
  assert.equal(validateSkillConfig(LIBRARY_DEFAULT_SKILLS, LIBRARY_RULES).ok, true);
});

test('card skills, scope extension, and runtime policy all derive from the same saved configuration', () => {
  const cfg = clone(TUTOR_DEFAULT_SKILLS);
  cfg.skills[0].description = 'Edited description';
  cfg.skills[0].knowledge = 'Private reference note: use the limit definition first.';
  cfg.skills[1].enabled = false;
  const { config } = validateSkillConfig(cfg, TUTOR_RULES);
  const card = buildCardSkills(config);
  const ext = buildScopeExtension(config, 7);
  const policy = policyFromConfig(config, 7);

  const enabledIds = ['calculus-tutoring'];
  assert.deepEqual(card.map((s) => s.id), enabledIds, 'disabled skill not advertised');
  assert.deepEqual(policy.skills.map((s) => s.id), enabledIds, 'disabled skill not permitted');
  assert.deepEqual(Object.keys(ext.params.skills), enabledIds);
  assert.equal(card[0].description, 'Edited description');
  assert.equal(policy.skills[0].description, 'Edited description');
  assert.deepEqual(ext.params.skills['calculus-tutoring'].excluded, policy.skills[0].excluded);
  assert.equal(policy.kinds.has('form'), false);
  assert.equal(ext.uri, SCOPE_EXTENSION_URI);
  assert.equal(ext.required, false);
  // Answer content reaches the runtime policy but never the advertised card or extension.
  assert.match(policy.skills[0].knowledge, /Private reference note/);
  assert.doesNotMatch(JSON.stringify({ card, ext }), /Private reference note/);
  assert.deepEqual(Object.keys(card[0]).sort(), ['description', 'examples', 'id', 'inputModes', 'name', 'outputModes', 'securityRequirements', 'tags']);
});

test('Library skills must carry the answer content they answer from; any number of them is allowed', () => {
  const cfg = clone(LIBRARY_DEFAULT_SKILLS);
  cfg.skills.push(newSkill({ knowledge: '' }));
  const empty = validateSkillConfig(cfg, LIBRARY_RULES);
  assert.equal(empty.ok, false);
  assert.match(empty.errors[0].message, /Add the answer content/);
  assert.equal(empty.errors[0].path, `skills[${cfg.skills.length - 1}].knowledge`, 'error points at the field');

  // With content it's accepted — two skills about borrowing are fine (no handler limit any more).
  const two = clone(LIBRARY_DEFAULT_SKILLS);
  two.skills.push(newSkill({ id: 'borrowing-book', name: 'Borrowing a book', knowledge: 'Loans last 21 days.' }));
  assert.equal(validateSkillConfig(two, LIBRARY_RULES).ok, true);
  // A disabled skill may be saved without content (a draft).
  const draft = clone(LIBRARY_DEFAULT_SKILLS);
  draft.skills.push(newSkill({ enabled: false, knowledge: '' }));
  assert.equal(validateSkillConfig(draft, LIBRARY_RULES).ok, true);
  // Only the Library's own built-in workflow can be a form.
  const form = clone(LIBRARY_DEFAULT_SKILLS);
  form.skills[0].kind = 'form';
  assert.match(validateSkillConfig(form, LIBRARY_RULES).errors[0].message, /Only the built-in "study-room-booking" skill can be a form/);
});

test('router decisions are validated against the live registry view; anything else sends nothing', () => {
  const services = [{ agentId: 'tutor', name: 'Tutor Agent', skills: [{ id: 'calculus-tutoring' }] }, { agentId: 'library', name: 'Library', skills: [{ id: 'renewals' }] }];
  assert.equal(validateDecision({ decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring', reason: 'ok' }, services).decision, 'route');
  for (const raw of [
    { decision: 'route', agent_id: 'evil', skill_id: 'calculus-tutoring' },
    { decision: 'route', agent_id: 'http://127.0.0.1:9/a2a/jsonrpc', skill_id: 'x' },
    { decision: 'route', agent_id: 'library', skill_id: 'calculus-tutoring' }, // skill not on that agent
    { decision: 'route', agent_id: 'tutor', skill_id: 'physics-tutoring' }, // removed/unknown skill
    { decision: 'broadcast', agent_id: 'tutor' },
    null,
  ]) {
    const d = validateDecision(raw, services);
    assert.equal(d.decision, 'unsupported', JSON.stringify(raw));
    assert.equal(d.agentId, null);
    assert.equal(d.invalid, true);
  }
  // Extra fields (e.g. a URL) are never carried into the validated decision.
  const d = validateDecision({ decision: 'route', agent_id: 'tutor', skill_id: 'calculus-tutoring', reason: 'r', url: 'http://evil' }, services);
  assert.ok(!('url' in d));
});

test('Student rejects fetched cards that change identity, endpoint, protocol, or security', () => {
  const peer = trustedPeers().tutor;
  const good = { name: 'Tutor Agent', supportedInterfaces: [{ url: peer.rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], securitySchemes: {}, securityRequirements: [], skills: [], capabilities: { extensions: [] } };
  assert.equal(validateCard(good, peer).ok, true);
  const bad = [
    { ...good, name: 'Totally Legit Tutor' },
    { ...good, supportedInterfaces: [{ ...good.supportedInterfaces[0], url: 'http://127.0.0.1:9999/a2a/jsonrpc' }] },
    { ...good, supportedInterfaces: [...good.supportedInterfaces, { url: 'http://evil', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] },
    { ...good, supportedInterfaces: [{ ...good.supportedInterfaces[0], protocolBinding: 'GRPC' }] },
    { ...good, securitySchemes: { key: {} } },
    { ...good, skills: [{ id: 'BAD ID', name: 'x', description: 'y' }] },
  ];
  for (const card of bad) assert.equal(validateCard(card, peer).ok, false, JSON.stringify(card).slice(0, 80));
});
