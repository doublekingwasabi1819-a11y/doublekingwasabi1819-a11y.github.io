import test from 'node:test';
import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {McpServer, PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {createControllerHttp} from '../http-server.mjs';
import {createControllerMcp} from '../mcp-adapter.mjs';
import {installRelayToolMetadata, relayBrowserToolDescriptors, relayDirectToolDescriptors} from '../mcp-tool-metadata.mjs';

// Exact raw HTTP responses prove discovery extension fields, before SDK Client
// listTools parsing strips unknown top-level fields. These use controlled host
// authentication and callbacks, not an OAuth provider or a ChatGPT connection.
const context = Object.freeze({fixture: 'tool-metadata'});
const SECRET = 'fixture-private-token-profile-path';
const credential = 'Bearer metadata-fixture-credential';
const protocols = ['2026-07-28', '2025-11-25'];
async function fixture(t, {target = 'relay', serverFactory} = {}) {
  const calls = [], clients = [];
  const controller = {async callTool(invocation, requestContext) {
    assert.equal(requestContext, context); calls.push(structuredClone(invocation));
    return {structuredContent: {ok: true}, content: [{type: 'text', text: '{"ok":true}'}]};
  }};
  const host = createControllerHttp({controller,
    authenticate: async request => request.headers.get('authorization') === credential
      ? {principalId: 'metadata-fixture', requestContext: context} : null,
    serverFactory: serverFactory || (requestContext => createControllerMcp({controller, requestContext, target}))});
  const {url} = await host.listen();
  t.after(async () => {await Promise.allSettled(clients.map(client => client.close())); await host.close();});
  async function connect(protocol) {
    const client = new Client({name: 'metadata-fixture-client', version: '0.1.0'}); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {authorization: credential}}}),
      protocol === '2025-11-25' ? {prior: {kind: 'legacy'}} : undefined);
    return client;
  }
  return {url, calls, connect};
}
async function rawRequest(url, protocol, method = 'tools/list') {
  const params = protocol === '2026-07-28' ? {_meta: {
    [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_CAPABILITIES_META_KEY]: {}
  }} : {};
  const response = await fetch(url, {method: 'POST', headers: {
    authorization: credential, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
    ...(protocol === '2026-07-28' ? {'mcp-method': method} : {})
  }, body: JSON.stringify({jsonrpc: '2.0', id: 17, method, params})});
  const text = await response.text(); assert.equal(response.status, 200, text);
  const wire = text.startsWith('event:')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(text);
  assert.equal(wire.id, 17); assert.equal(wire.error, undefined);
  return wire.result;
}
const rawList = async (url, protocol) => (await rawRequest(url, protocol)).tools;

test('canonical Relay descriptors are deeply immutable and mirror exact combined OAuth requirements', () => {
  assert.equal(relayBrowserToolDescriptors.length, 5); assert.equal(relayDirectToolDescriptors.length, 5);
  for (const tool of [...relayBrowserToolDescriptors, ...relayDirectToolDescriptors]) {
    const scopes = tool.name.startsWith('browser_') ? ['browser:control']
      : ['browser:control', tool.annotations.readOnlyHint ? 'relay:read' : 'relay:write'];
    assert.deepEqual(tool.securitySchemes, [{type: 'oauth2', scopes}]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Object.isFrozen(tool)); assert.ok(Object.isFrozen(tool.inputSchema.properties));
    assert.ok(Object.isFrozen(tool.securitySchemes[0].scopes));
    assert.throws(() => {tool.securitySchemes[0].scopes.push('manager:all');}, TypeError);
  }
});

test('discovery helper rejects unknown, duplicate, relaxed and authority-bearing descriptors without invoking accessors', () => {
  const mcp = new McpServer({name: 'metadata-validation-fixture', version: '0.1.0'});
  let getters = 0;
  for (const mutate of [
    tools => {tools.pop();}, tools => {tools[1] = tools[0];},
    tools => {tools[0].name = 'model_selected_tool';},
    tools => {tools[0].inputSchema.additionalProperties = true;},
    tools => {tools[0].inputSchema.properties.token = {type: 'string'};},
    tools => {tools[0].inputSchema.$ref = 'file:///private-profile';},
    tools => {tools[0].description = SECRET;},
    tools => {tools[0].annotations.readOnlyHint = true;},
    tools => {tools[0].securitySchemes[0].scopes = ['relay:write'];},
    tools => {tools[0]._meta.securitySchemes = [{type: 'noauth'}];},
    tools => {tools[0].accountId = SECRET;},
    tools => {tools[0]._meta.token = SECRET;},
    tools => {tools[0].inputSchema.hidden = undefined;},
    tools => {tools[0].inputSchema.cycle = tools[0].inputSchema;},
    tools => {Object.defineProperty(tools[0], 'profile', {enumerable: true, get() {getters++; return SECRET;}});},
    tools => {Object.defineProperty(tools[0], 'hidden', {value: SECRET});},
    tools => {tools[0][Symbol('authority')] = SECRET;}
  ]) {
    const tools = structuredClone(relayBrowserToolDescriptors); mutate(tools);
    assert.throws(() => installRelayToolMetadata(mcp, tools), error => error instanceof TypeError &&
      error.message === 'Only the fixed trusted Relay tool descriptors are supported.');
  }
  assert.equal(getters, 0);
  assert.throws(() => installRelayToolMetadata({server: {setRequestHandler() {throw new Error(SECRET);}}}, relayBrowserToolDescriptors), TypeError);
  assert.throws(() => installRelayToolMetadata(mcp, relayDirectToolDescriptors), TypeError);
});

test('final discovery captures a frozen clone instead of retaining a later mutable host descriptor list', async t => {
  const source = structuredClone(relayBrowserToolDescriptors);
  let captured;
  const f = await fixture(t, {serverFactory: requestContext => {
    const mcp = createControllerMcp({controller: {async callTool() {return {content: []};}}, requestContext, target: 'relay'});
    captured = installRelayToolMetadata(mcp, source);
    source[0].name = 'mutated_tool'; source[0].inputSchema.additionalProperties = true;
    source[1]._meta.securitySchemes[0].scopes.push('manager:all');
    return mcp;
  }});
  assert.deepEqual(await rawList(f.url, protocols[0]), relayBrowserToolDescriptors);
  assert.notEqual(captured, source); assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured[1]._meta.securitySchemes[0].scopes));
});

for (const protocol of protocols) {
  test(`raw ${protocol} HTTP discovery emits exact Relay-only top-level and mirrored OAuth metadata`, async t => {
    const f = await fixture(t);
    if (protocol === '2026-07-28') {
      const discovery = await rawRequest(f.url, protocol, 'server/discover');
      assert.ok(discovery.supportedVersions.includes(protocol));
      assert.ok(discovery.capabilities.tools);
      assert.equal(discovery._meta['io.modelcontextprotocol/serverInfo'].name, 'relay-browser-controller');
    }
    const tools = await rawList(f.url, protocol);
    assert.deepEqual(tools, relayBrowserToolDescriptors);
    assert.equal(tools.some(tool => tool.name === 'browser_fill'), false);
    assert.equal(f.calls.length, 0);
  });

  test(`${protocol} standard client discovery and call validation remain intact after metadata override`, async t => {
    const f = await fixture(t), client = await f.connect(protocol);
    assert.equal(client.getServerVersion().name, 'relay-browser-controller');
    assert.ok(client.getServerCapabilities().tools);
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map(tool => tool.name), relayBrowserToolDescriptors.map(tool => tool.name));
    for (const tool of listed) assert.deepEqual(tool._meta.securitySchemes, [{type: 'oauth2', scopes: ['browser:control']}]);
    assert.equal((await client.callTool({name: 'browser_open', arguments: {}})).isError, undefined);
    assert.equal((await client.callTool({name: 'browser_click', arguments: {
      session_id: 'fixture-session', observation_id: 'fixture-observation', target_id: 'fixture-target'
    }})).isError, undefined);
    assert.equal(f.calls.length, 2);
    for (const args of [{token: SECRET}, {accountId: 'another-worker'}, {url: 'https://outside.invalid'}, {securitySchemes: [{type: 'noauth'}]}]) {
      const result = await client.callTool({name: 'browser_open', arguments: args});
      assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes(SECRET), false);
    }
    const tooMany = await client.callTool({name: 'browser_open', arguments: Object.fromEntries(
      Array.from({length: 129}, (_, index) => [`extra${index}`, index]))});
    assert.equal(tooMany.isError, true); assert.match(tooMany.content[0].text, /maximum of 128 elements/);
    assert.equal(f.calls.length, 2);
    await assert.rejects(client.callTool({name: 'browser_fill', arguments: {}}));
  });

  test(`fixture ${protocol} discovery retains six tools and no OAuth metadata`, async t => {
    const f = await fixture(t, {target: 'fixture'}), tools = await rawList(f.url, protocol);
    assert.equal(tools.length, 6); assert.ok(tools.some(tool => tool.name === 'browser_fill'));
    for (const tool of tools) {
      assert.equal(Object.hasOwn(tool, 'securitySchemes'), false);
      assert.equal(tool._meta?.securitySchemes, undefined);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.match(tool.description, /local test fixture/);
    }
    assert.equal(f.calls.length, 0);
  });
}
