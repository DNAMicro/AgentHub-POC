// Validates A2UI messages against the official v0.9 JSON Schemas shipped in @a2ui/web_core
// (read from the package directory; they aren't listed in its "exports").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const dir = fileURLToPath(new URL('../../node_modules/@a2ui/web_core/src/v0_9/schemas/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));

// validateFormats off: the schemas use "uri"/"date" formats that need ajv-formats; nothing in this form uses them.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, logger: false });
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
