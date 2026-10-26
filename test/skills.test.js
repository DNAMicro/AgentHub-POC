// Part 5 deterministic unit tests: skill configuration, single source of truth, capability
// limits, router-decision validation, and trusted card validation. No processes, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillConfig, buildCardSkills, buildScopeExtension, policyFromConfig, SCOPE_EXTENSION_URI } from '../src/skills.js';
import { TUTOR_DEFAULT_SKILLS } from '../src/tutor-agent.js';
import { LIBRARY_DEFAULT_SKILLS } from '../src/library-agent.js';
import { validateDecision } from '../src/router.js';
import { validateCard, trustedPeers } from '../src/student-registry.js';

const TUTOR_HANDLERS = { 'llm-tutoring': { multiple: true }, 'a2ui-student-form': {} };
const LIBRARY_HANDLERS = Object.fromEntries(LIBRARY_DEFAULT_SKILLS.skills.map((s) => [s.handler, {}]));
const clone = (v) => structuredClone(v);

test('invalid skill configurations are rejected with field-level errors', () => {
  const cases = [
    [(c) => { c.skills[1].id = c.skills[0].id; }, /Duplicate skill ID/],
    [(c) => { c.skills[0].id = 'Bad ID!'; }, /Skill ID must be/],
    [(c) => { c.skills[0].name = ''; }, /Name is required/],
    [(c) => { c.skills[0].description = 'x'.repeat(501); }, /Description is required/],
    [(c) => { c.skills[0].scope.allowed = []; }, /needs at least one allowed-scope item/],
    [(c) => { c.skills[0].enabled = 'yes'; }, /enabled must be true or false/],
    [(c) => { c.skills[0].endpointUrl = 'http://evil.example'; }, /Unexpected field/],
    [(c) => { c.securitySchemes = {}; }, /Only skills can be edited/],
    [(c) => { c.skills[1].handler = 'a2ui-student-form'; c.skills.push({ ...c.skills[1], id: 'second-form' }); }, /Only one skill can use/],
  ];
  for (const [mutate, message] of cases) {
    const cfg = clone(TUTOR_DEFAULT_SKILLS);
    mutate(cfg);
    const result = validateSkillConfig(cfg, TUTOR_HANDLERS);
    assert.equal(result.ok, false, String(message));
    assert.match(result.errors.map((e) => e.message).join(' | '), message);
  }
  assert.equal(validateSkillConfig(TUTOR_DEFAULT_SKILLS, TUTOR_HANDLERS).ok, true);
});

test('card skills, scope extension, and runtime policy all derive from the same saved configuration', () => {
  const cfg = clone(TUTOR_DEFAULT_SKILLS);
  cfg.skills[0].description = 'Edited description';
  cfg.skills[1].enabled = false;
  const { config } = validateSkillConfig(cfg, TUTOR_HANDLERS);
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
  assert.equal(policy.handlers.has('a2ui-student-form'), false);
  assert.equal(ext.uri, SCOPE_EXTENSION_URI);
  assert.equal(ext.required, false);
  // Standard AgentSkill fields only; scope lives in the documented extension.
  assert.deepEqual(Object.keys(card[0]).sort(), ['description', 'examples', 'id', 'inputModes', 'name', 'outputModes', 'securityRequirements', 'tags']);
});

test('the Library cannot advertise a capability its fixture does not implement', () => {
  const cfg = clone(LIBRARY_DEFAULT_SKILLS);
  cfg.skills.push({ id: 'interlibrary-loan', handler: 'interlibrary-loan', enabled: true, name: 'Interlibrary loans', description: 'Requests books from other libraries.', tags: [], examples: [], scope: { allowed: ['interlibrary loan requests'], excluded: [] } });
  const result = validateSkillConfig(cfg, LIBRARY_HANDLERS);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /not implemented by this agent/);
  // Re-describing an implemented handler is fine (configured scope ≠ new capability).
  const edited = clone(LIBRARY_DEFAULT_SKILLS);
  edited.skills[2].description = 'Renewal guidance, now with more detail.';
  assert.equal(validateSkillConfig(edited, LIBRARY_HANDLERS).ok, true);
});

test('router decisions are validated against the live registry view; anything else sends nothing', () => {
  const services = [{ agentId: 'tutor', name: 'Calculus Tutor', skills: [{ id: 'calculus-tutoring' }] }, { agentId: 'library', name: 'Library', skills: [{ id: 'renewals' }] }];
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
