import test from 'node:test';
import assert from 'node:assert/strict';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {createControllerMcp} from '../mcp-adapter.mjs';
import {createBrowserController} from '../core.mjs';

const names = [
  'browser_open', 'browser_observe', 'browser_click',
  'browser_fill', 'browser_screenshot', 'browser_close'
];
const requestContext = Object.freeze({fixturePrincipal: 'atlas-test'});

async function wire(t, implementation, configuredController, options = {}) {
  const calls = [];
  const controller = configuredController || {async callTool(invocation, context) {
    calls.push({invocation, context});
    return implementation ? implementation(invocation, context) : {
      structuredContent: {ok: true},
      content: [{type: 'text', text: '{"ok":true}'}]
    };
  }};
  const server = createControllerMcp({controller, requestContext, ...options});
  const client = new Client({name: 'relay-fixture-wire-test', version: '0.1.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close(); await server.close(); await controller.shutdown?.();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {client, calls};
}

test('MCP factory requires an explicit controller and trusted request context', () => {
  for (const options of [undefined, {}, {controller: {}},
    {controller: {callTool() {}}}, {controller: {callTool() {}}, requestContext: null},
    {controller: {callTool() {}}, requestContext: []},
    {controller: {callTool() {}}, requestContext: 'worker'}]) {
    assert.throws(() => createControllerMcp(options), /controller and trusted request context/);
  }
});

test('trusted Relay target advertises only permitted navigation and masked-view tools', async t => {
  const {client, calls} = await wire(t, undefined, undefined, {target: 'relay'});
  assert.equal(client.getServerVersion().name, 'relay-browser-controller');
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), names.filter(name => name !== 'browser_fill'));
  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, true);
    assert.doesNotMatch(tool.description, /test fixture/i);
    assert.match(tool.description, /Relay/);
    assert.equal(Object.hasOwn(tool.inputSchema.properties || {}, 'target'), false);
  }
  assert.match(tools.find(tool => tool.name === 'browser_click').description, /navigation or Refresh/);
  assert.match(tools.find(tool => tool.name === 'browser_screenshot').description, /masked/);
  await assert.rejects(client.callTool({name: 'browser_fill', arguments: {
    session_id: 'fixture', observation_id: 'fixture', target_id: 'fixture', text: 'blocked'
  }}), error => error.code === -32602);
  const injected = await client.callTool({name: 'browser_open', arguments: {target: 'fixture'}});
  assert.equal(injected.isError, true); assert.equal(calls.length, 0);
});

test('MCP target is a strict trusted factory option and lifecycle methods are not model-callable', async t => {
  const controller = {callTool() {}};
  for (const target of [null, 'arbitrary', {}, ['relay']]) {
    assert.throws(() => createControllerMcp({controller, requestContext, target}), /trusted request context/);
  }
  const {client, calls} = await wire(t);
  for (const name of ['revokeContext', 'snapshot', 'shutdown']) {
    await assert.rejects(client.callTool({name, arguments: {}}), error => error.code === -32602);
  }
  assert.equal(calls.length, 0);
});

test('real MCP initialize and tools/list advertise six strict fixture-only tools', async t => {
  const {client, calls} = await wire(t);
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), names);
  assert.equal(client.getServerVersion().name, 'relay-browser-fixture');
  assert.equal(client.getServerCapabilities().tools !== undefined, true);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, false);
    for (const forbidden of ['account_id', 'workspace_id', 'run_id', 'token',
      'requestContext', 'profile', 'profile_path', 'url', 'selector', 'javascript', 'cdp']) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties || {}, forbidden), false);
    }
  }
  for (const name of ['browser_click', 'browser_fill']) {
    const annotations = tools.find(tool => tool.name === name).annotations;
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.idempotentHint, false);
  }
  assert.equal(calls.length, 0);
});

test('valid tool call forwards only tool arguments and the host-bound context', async t => {
  const {client, calls} = await wire(t);
  const result = await client.callTool({name: 'browser_open', arguments: {}});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {ok: true});
  assert.deepEqual(calls[0].invocation, {name: 'browser_open', arguments: {}});
  assert.equal(calls[0].context, requestContext);
});

test('SDK validation rejects extra privilege, location and code arguments before controller', async t => {
  const {client, calls} = await wire(t);
  for (const arguments_ of [
    {account_id: 'someone-else'}, {token: 'not-a-credential'},
    {profile_path: '/other/account'}, {url: 'https://example.invalid/'},
    {selector: 'body'}, {javascript: 'process.exit(1)'},
    {requestContext: {fixturePrincipal: 'another-worker'}}
  ]) {
    const result = await client.callTool({name: 'browser_open', arguments: arguments_});
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test('SDK validation rejects missing required action identifiers before controller', async t => {
  const {client, calls} = await wire(t);
  for (const name of names.filter(name => name !== 'browser_open')) {
    const result = await client.callTool({name, arguments: {}});
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test('unknown MCP tools do not reach the controller', async t => {
  const {client, calls} = await wire(t);
  await assert.rejects(
    client.callTool({name: 'browser_evaluate', arguments: {code: '1+1'}}),
    error => error.code === -32602
  );
  assert.equal(calls.length, 0);
});

test('controller-normalized errors pass through without successful action claims', async t => {
  const expected = {
    isError: true,
    structuredContent: {error: {code: 'STALE_OBSERVATION', message: 'Observe again before acting.'}},
    content: [{type: 'text', text: 'Observe again before acting.'}]
  };
  const {client, calls} = await wire(t, () => expected);
  const result = await client.callTool({name: 'browser_open', arguments: {}});
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
});

test('schema element limit rejects oversized argument objects before controller', async t => {
  const {client, calls} = await wire(t);
  const arguments_ = Object.fromEntries(Array.from({length: 64}, (_, index) => [`extra${index}`, index]));
  const result = await client.callTool({name: 'browser_open', arguments: arguments_});
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('unexpected controller exceptions cannot leak private details through SDK errors', async t => {
  const {client, calls} = await wire(t, () => {
    throw new Error('private-profile-path=/secret/worker token=private-token');
  });
  const result = await client.callTool({name: 'browser_open', arguments: {}});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'INTERNAL');
  assert.doesNotMatch(JSON.stringify(result), /secret|private-token|profile-path/);
  assert.equal(calls.length, 1);
});

test('all six tools execute through the real MCP wire and authorized fixture controller', async t => {
  const binding = Object.freeze({
    workspaceId: 'fixture-tests',
    accountId: 'ec05a82f-0afb-456b-9c8c-5ac2ec9e7a4f',
    agentId: 'd7258bba-b513-419b-ae31-30e9f661ee45',
    runId: 'test-run'
  });
  const image = {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  };
  let status = 'Ready', closed = false;
  const driverCalls = [];
  const controller = createBrowserController({
    authorize: async context => {
      assert.equal(context, requestContext);
      return binding;
    },
    authorizeAction: async () => true,
    createDriver: async ({binding: actual}) => {
      assert.deepEqual(actual, binding);
      return {
        async observe() {
          return {title: 'Local fixture', status, targets: [
            {id: 'fixture-button', role: 'button', name: 'Submit'},
            {id: 'fixture-textbox', role: 'textbox', name: 'Draft'}
          ]};
        },
        async click(target) {driverCalls.push(['click', target]); status = 'Clicked';},
        async fill(target, text) {driverCalls.push(['fill', target, text]); status = 'Filled';},
        async screenshot() {return image;},
        async close() {closed = true;}
      };
    }
  });
  const {client} = await wire(t, null, controller);
  const opened = await client.callTool({name: 'browser_open', arguments: {}});
  assert.equal(opened.isError, undefined);
  const session_id = opened.structuredContent.sessionId;
  assert.equal(typeof session_id, 'string');

  const observed = await client.callTool({name: 'browser_observe', arguments: {session_id}});
  const initialId = observed.structuredContent.observation.id;
  assert.equal(observed.structuredContent.observation.status, 'Ready');
  const filled = await client.callTool({name: 'browser_fill', arguments: {
    session_id, observation_id: initialId, target_id: 'fixture-textbox', text: 'Non-secret test note'
  }});
  assert.equal(filled.structuredContent.observation.status, 'Filled');
  assert.doesNotMatch(JSON.stringify(filled), /Non-secret test note/);

  const stale = await client.callTool({name: 'browser_click', arguments: {
    session_id, observation_id: initialId, target_id: 'fixture-button'
  }});
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'STALE_OBSERVATION');
  assert.equal(driverCalls.length, 1);

  const clicked = await client.callTool({name: 'browser_click', arguments: {
    session_id, observation_id: filled.structuredContent.observation.id, target_id: 'fixture-button'
  }});
  assert.equal(clicked.structuredContent.observation.status, 'Clicked');
  const screenshot = await client.callTool({name: 'browser_screenshot', arguments: {
    session_id, observation_id: clicked.structuredContent.observation.id
  }});
  assert.deepEqual(screenshot.content, [{type: 'image', ...image}]);
  assert.equal(screenshot.structuredContent.sessionId, session_id);
  assert.deepEqual(driverCalls, [
    ['fill', 'fixture-textbox', 'Non-secret test note'], ['click', 'fixture-button']
  ]);
  const result = await client.callTool({name: 'browser_close', arguments: {session_id}});
  assert.deepEqual(result.structuredContent, {closed: true});
  assert.equal(closed, true);
  const unavailable = await client.callTool({name: 'browser_observe', arguments: {session_id}});
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error.code, 'NOT_FOUND');
});
