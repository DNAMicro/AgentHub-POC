// Skill settings for a service agent (Tutor or Library): the single skill configuration,
// its atomic save, the settings HTTP API (local developer controls), and the A2A
// "agent_card_changed" notification to Student Agent.
//
// The settings API edits skills only. Identity, endpoint URLs, security and protocol
// capabilities are not part of the configuration and cannot be changed here.
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { sameOriginGuard } from './local-guard.js';
import {
  CARD_CHANGED_MEDIA_TYPE, SCOPE_EXTENSION_URI, buildCardSkills, buildScopeExtension, configHash,
  policyFromConfig, validateSkillConfig,
} from './skills.js';

const NOTIFY_TIMEOUT_MS = 3000;

export function createSkillService({ agentId, agentName, defaults, handlers, card, emit, log, studentUrl }) {
  const initial = validateSkillConfig(defaults, handlers);
  if (!initial.ok) throw new Error(`Invalid default skills for ${agentId}: ${JSON.stringify(initial.errors)}`);
  const testedHash = configHash(initial.config); // the defaults are what the automated tests cover

  let config = initial.config;
  let revision = 1;
  let policy = policyFromConfig(config, revision);
  let etag = null;
  let lastNotification = null;
  let selfCardUrl = null;
  let port = null;

  // Write the configuration into the live card object the SDK serves (synchronous: atomic in JS).
  function applyToCard(target, cfg, rev) {
    target.skills = buildCardSkills(cfg);
    const others = (target.capabilities.extensions ?? []).filter((e) => e.uri !== SCOPE_EXTENSION_URI);
    target.capabilities.extensions = [...others, buildScopeExtension(cfg, rev)];
  }
  applyToCard(card, config, revision);

  async function refreshOwnEtag() {
    // The SDK serves the card with a content-hash ETag; read it back so the UI can show it.
    try {
      const res = await fetch(selfCardUrl, { signal: AbortSignal.timeout(2000) });
      etag = res.headers.get('etag');
    } catch {
      etag = null;
    }
    return etag;
  }

  // One attempt, no retry loop. Student refreshes all cards on its own startup/reconnect, so a
  // notification that can't be delivered now is reported as pending, not resent forever.
  async function notifyStudent(reason) {
    const notificationId = randomUUID();
    const notice = { type: 'agent_card_changed', notificationId, agentId, revision, reason, changedAt: new Date().toISOString() };
    let outcome;
    let detail;
    try {
      const client = await new ClientFactory().createFromUrl(studentUrl);
      const result = await client.sendMessage({
        tenant: '', configuration: undefined, metadata: undefined,
        message: {
          messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER,
          parts: [{ content: { $case: 'data', value: notice }, metadata: undefined, filename: '', mediaType: CARD_CHANGED_MEDIA_TYPE }],
          metadata: { notification: 'agent_card_changed' }, extensions: [], referenceTaskIds: [],
        },
      }, { signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
      // Student's A2A reply is the delivery receipt; its own status says what it did with it.
      const ack = result.parts?.find((p) => p.content?.$case === 'data')?.content.value ?? {};
      outcome = ack.status === 'received' || ack.status === 'duplicate' ? 'delivered' : 'rejected';
      detail = ack.status === 'received' ? 'Student acknowledged; it will re-fetch the card' : ack.reason ?? ack.status ?? 'unrecognized reply';
    } catch (err) {
      outcome = 'pending';
      detail = err.cause?.code === 'ECONNREFUSED' ? 'Student Agent is offline — it will refresh cards when it starts' : `Not delivered (${err.name === 'TimeoutError' ? 'timeout' : err.message}) — Student refreshes on startup/reconnect or via Refresh skills`;
    }
    lastNotification = { notificationId, revision, reason, outcome, detail, at: new Date().toISOString() };
    log('card change notification', { notificationId, revision, reason, outcome });
    emit('card_notification', lastNotification);
    return lastNotification;
  }

  const describe = () => ({
    agentId, agentName, revision, etag, config,
    handlers: Object.entries(handlers).map(([id, h]) => ({ id, label: h.label, multiple: Boolean(h.multiple) })),
    matchesTestedDefault: configHash(config) === testedHash,
    lastNotification,
    note: 'Local developer controls. Edits skills only — not identity, endpoints, security, or protocol settings.',
  });

  function previewCard(cfg, rev) {
    const copy = structuredClone(card);
    applyToCard(copy, cfg, rev);
    return copy;
  }

  function router() {
    const r = express.Router();
    r.use(express.json({ limit: '32kb' }));
    r.use((req, res, next) => (req.method === 'GET' ? next() : sameOriginGuard(port)(req, res, next)));
    r.get('/settings/skills', (req, res) => res.json(describe()));
    r.post('/settings/skills/preview', (req, res) => {
      const result = validateSkillConfig(req.body?.config, handlers);
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      res.json({ card: previewCard(result.config, revision + 1), matchesTestedDefault: configHash(result.config) === testedHash });
    });
    r.put('/settings/skills', async (req, res) => {
      if (req.body?.baseRevision !== revision) {
        return res.status(409).json({ error: `The skills changed since you opened them (now revision ${revision}). Reload and try again.`, revision });
      }
      const result = validateSkillConfig(req.body?.config, handlers);
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      // Atomic swap: configuration, runtime policy, and served card change together.
      revision += 1;
      config = result.config;
      policy = policyFromConfig(config, revision);
      applyToCard(card, config, revision);
      await refreshOwnEtag();
      const saved = { revision, etag, enabledSkills: policy.skills.map((s) => s.id), matchesTestedDefault: configHash(config) === testedHash };
      log('skills saved', saved);
      emit('skills_saved', saved);
      res.json({ ...saved, card });
      notifyStudent('skills_saved'); // reported separately via card_notification
    });
    return r;
  }

  return {
    policy: () => policy,
    revision: () => revision,
    describe,
    router,
    notifyStudent,
    async started(actualPort, cardUrl) {
      port = actualPort;
      selfCardUrl = cardUrl;
      await refreshOwnEtag();
      // Tell Student this agent (re)started with its current card; harmless if Student is offline.
      notifyStudent('startup');
    },
  };
}
