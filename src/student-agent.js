// Agent A — "Student Agent". An A2A client: discovers the Tutor via its Agent
// Card, sends one message with the SDK client, and prints the actual reply.
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';

export const STUDENT_MESSAGE = 'Hello Tutor Agent. Can you help me with calculus?';

const log = (...args) => console.log('[Student Agent]', ...args);
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

export async function askTutor(baseUrl, text = STUDENT_MESSAGE) {
  // 1. Discovery: GET <baseUrl>/.well-known/agent-card.json
  const card = await new DefaultAgentCardResolver().resolve(baseUrl);
  log('discovered Agent Card', {
    name: card.name,
    interfaces: card.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion} ${i.url}`),
  });

  // 2. The factory picks a transport from the card's supportedInterfaces.
  const client = await new ClientFactory().createFromAgentCard(card);

  const message = {
    messageId: randomUUID(),
    contextId: '', // empty: let the server start a new context
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  log('sending message', { messageId: message.messageId, text });

  // 3. SendMessage over the A2A JSON-RPC binding.
  const result = await client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined });

  // A SendMessage result is either a Message or a Task; the Tutor always replies with a Message.
  if (!('messageId' in result) || result.role !== Role.ROLE_AGENT) {
    throw new Error(`Expected an agent Message, got: ${JSON.stringify(result)}`);
  }
  const reply = { messageId: result.messageId, contextId: result.contextId, taskId: result.taskId, text: textOf(result) };
  log('received reply', reply);
  return reply;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.TUTOR_URL ?? 'http://127.0.0.1:41241';
  try {
    const reply = await askTutor(baseUrl);
    console.log(`\nTutor Agent replied: ${reply.text}`);
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message;
    console.error(`[Student Agent] FAILED to reach Tutor Agent at ${baseUrl}: ${err.message}${cause ? ` (${cause})` : ''}`);
    process.exitCode = 1;
  }
}
