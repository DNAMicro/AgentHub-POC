// Validates A2UI messages against the official v0.9 JSON Schemas shipped in @a2ui/web_core
// (read from the package directory; they aren't listed in its "exports").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const dir = fileURLToPath(new URL('../../node_modules/@a2ui/web_core/src/v0_9/schemas/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));

// Formats are validated: DateTimeInput min/max is "oneOf" date | time | date-time, which only
// works if the formats are checked. These mirror ajv-formats' defaults (time needs seconds;
// the timezone is optional). Other formats (e.g. "uri") aren't used by these forms and are ignored.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false });
const realDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const TIME = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(z|[+-]\d\d(:?\d\d)?)?$/i;
ajv.addFormat('date', realDate);
ajv.addFormat('time', TIME);
ajv.addFormat('date-time', (s) => { const [d, t] = String(s).split(/t|\s/i); return realDate(d) && TIME.test(t ?? ''); });
ajv.addFormat('uri', true);
const basicCatalog = load('catalogs/basic/catalog.json');
ajv.addSchema(load('common_types.json'));
ajv.addSchema(basicCatalog);
// The protocol schemas reference a generic "catalog.json" — the slot for whichever catalog
// the surface uses. Bind it to the basic catalog, the only one this spike accepts.
ajv.addSchema({ ...basicCatalog, $id: 'https://a2ui.org/specification/v0_9/catalog.json' });
ajv.addSchema(load('server_to_client.json'));
// client_to_server.json ships without an $id; register it where client_to_server_list.json looks for it.
ajv.addSchema(load('client_to_server.json'), 'https://a2ui.org/specification/v0_9/client_to_server.json');
const serverList = ajv.compile(load('server_to_client_list.json'));
const clientList = ajv.compile(load('client_to_server_list.json'));

const run = (validate, data) => (validate(data) ? null : validate.errors);
export const validateServerToClientList = (messages) => run(serverList, messages);
export const validateClientToServerList = (messages) => run(clientList, messages);
