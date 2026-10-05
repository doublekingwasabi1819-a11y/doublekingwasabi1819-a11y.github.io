import {McpServer} from '@modelcontextprotocol/server';
import {browserTools} from './core.mjs';

const descriptions = {
  browser_open: 'Open this host-approved Relay worker workspace. It permits only navigation, refresh and masked screenshots; websites, identity and profiles are configured by the trusted host.',
  browser_observe: 'Observe this worker’s allowed Relay navigation and Refresh controls. Returns bounded opaque targets, excluding private messages and credential fields.',
  browser_click: 'Click one advertised Relay navigation or Refresh control using the current observation. Returns a fresh observation. Never retry an uncertain click automatically.',
  browser_screenshot: 'Capture this worker’s masked Relay workspace using a current observation. Private content and credential fields are hidden.',
  browser_close: 'Close this worker’s host-approved Relay browser session.'
};
const uuid = {type: 'string', pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'};
const object = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const directDefinitions = [
  ['relay_fast_identity', 'Read the authorized Relay worker identity and unread count.', object(), true],
  ['relay_fast_inbox', 'Read this worker’s private inbox contacts and conversation previews.', object(), true],
  ['relay_fast_thread', 'Read this worker’s conversation with a resolved recipient. Does not mark messages read.', object({recipient_id: uuid, before_id: uuid}, ['recipient_id']), true],
  ['relay_fast_send', 'Send an authorized private message to a resolved recipient. Preserve client_id and body after an uncertain send.', object({recipient_id: uuid, body: {type: 'string', minLength: 1, maxLength: 12000}, client_id: uuid}, ['recipient_id', 'body', 'client_id']), false],
  ['relay_fast_mark_read', 'Acknowledge only incoming message IDs actually read by this worker.', object({message_ids: {type: 'array', items: uuid, maxItems: 100, uniqueItems: true}}, ['message_ids']), false]
];
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const oauth = scopes => ({securitySchemes: [{type: 'oauth2', scopes: [...scopes]}],
  _meta: {securitySchemes: [{type: 'oauth2', scopes: [...scopes]}]}});

// Only source-owned definitions enter discovery. There is no model-supplied
// registry, credential, identity, profile path, URL or authorization callback.
export const relayBrowserToolDescriptors = freeze(browserTools.filter(tool => tool.name !== 'browser_fill').map(tool => ({
  name: tool.name,
  description: descriptions[tool.name],
  inputSchema: structuredClone(tool.inputSchema),
  annotations: {...structuredClone(tool.annotations), openWorldHint: true,
    ...(tool.name === 'browser_click' ? {readOnlyHint: false, destructiveHint: true, idempotentHint: false} : {})},
  ...oauth(['browser:control'])
})));
export const relayDirectToolDescriptors = freeze(directDefinitions.map(([name, description, inputSchema, readOnlyHint]) => ({
  name, description, inputSchema: structuredClone(inputSchema),
  annotations: {readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  ...oauth(['browser:control', readOnlyHint ? 'relay:read' : 'relay:write'])
})));
const expected = new Map([...relayBrowserToolDescriptors, ...relayDirectToolDescriptors].map(tool => [tool.name, tool]));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function json(value, depth = 0, state = {nodes: 0, path: new Set()}) {
  if (depth > 12 || ++state.nodes > 2048) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 16000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!(Array.isArray(value) || plain(value)) || state.path.has(value)) return false;
  const keys = Reflect.ownKeys(value).filter(key => !(Array.isArray(value) && key === 'length'));
  if (keys.length > 200 || keys.some(key => typeof key !== 'string')) return false;
  state.path.add(value);
  const valid = keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && json(descriptor.value, depth + 1, state);
  });
  state.path.delete(value);
  return valid;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/**
 * Finalize discovery AFTER all fixed high-level registerTool calls. The public
 * McpServer.server API carries top-level OAuth extension metadata on both MCP
 * wire eras while the original SDK tools/call handler still validates schemas.
 * This static registry supports no enable/disable/update/remove operations.
 * Security declarations describe requirements; live host/provider checks enforce
 * authorization. Installing metadata neither issues tokens nor links ChatGPT.
 */
export function installRelayToolMetadata(mcp, descriptors) {
  let captured;
  try {
    if (!(mcp instanceof McpServer) || !Array.isArray(descriptors) || ![5, 10].includes(descriptors.length) || !json(descriptors)) throw new Error();
    const seen = new Set();
    for (const descriptor of descriptors) {
      if (!plain(descriptor) || !expected.has(descriptor.name) || seen.has(descriptor.name) ||
          JSON.stringify(canonical(descriptor)) !== JSON.stringify(canonical(expected.get(descriptor.name)))) throw new Error();
      seen.add(descriptor.name);
    }
    if (!relayBrowserToolDescriptors.every(tool => seen.has(tool.name)) ||
        (descriptors.length === 10 && !relayDirectToolDescriptors.every(tool => seen.has(tool.name)))) throw new Error();
    captured = freeze(structuredClone(descriptors));
  } catch {
    throw new TypeError('Only the fixed trusted Relay tool descriptors are supported.');
  }
  mcp.server.setRequestHandler('tools/list', () => ({tools: captured}));
  return captured;
}
