import test from 'node:test';
import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {McpServer, fromJsonSchema} from '@modelcontextprotocol/server';
import {createControllerHttp, HttpAuthenticationError} from '../http-server.mjs';
import {createBrowserController} from '../core.mjs';
import {request as nodeRequest, createServer} from 'node:http';

const contexts = [Object.freeze({fixtureWorker: 'first'}), Object.freeze({fixtureWorker: 'second'})];
const bindings = [
  {workspaceId: 'http-fixture', accountId: '45b9d8ad-9609-458e-8c41-c6ec715ff50b', agentId: 'e9d7b623-9dab-4f45-885a-24c38f5a5a49', runId: 'first-run'},
  {workspaceId: 'http-fixture', accountId: '8c9d0f4e-cf5b-4f0b-b760-1cb256fd1b34', agentId: 'bf907836-128a-4e94-ae6a-1b360a9b65bf', runId: 'second-run'}
];
const credentials = ['Bearer fixture-first', 'Bearer fixture-second'];

async function fixture(t, options = {}) {
  let revoked = false, authenticateCalls = 0, driverCloses = 0;
  const driverActions = [], controllerCalls = [];
  const core = createBrowserController({
    authorize: async context => {
      const index = contexts.indexOf(context);
      if (index < 0 || (revoked && index === 0)) throw new Error('private-authorizer-error');
      return bindings[index];
    },
    authorizeAction: async () => true,
    createDriver: async ({binding}) => {
      let clicks = 0;
      return {
        async observe() {return {title: 'Local HTTP fixture', status: `Clicks ${clicks}`, targets: [
          {id: 'test-button', role: 'button', name: 'Fixture button'},
          {id: 'test-note', role: 'textbox', name: 'Fixture note'}
        ]};},
        async click(target) {driverActions.push({owner: binding.accountId, target}); clicks++;},
        async fill(target, text) {driverActions.push({owner: binding.accountId, target, text});},
        async screenshot() {return {mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='};},
        async close() {driverCloses++;}
      };
    }
  });
  const controller = {async callTool(invocation, context) {
    controllerCalls.push({invocation, context}); return core.callTool(invocation, context);
  }};
  const host = createControllerHttp({controller, authenticate: async request => {
    authenticateCalls++;
    const credential = request.headers.get('authorization');
    if (credential === 'Bearer fixture-denied') throw new HttpAuthenticationError('FORBIDDEN');
    if (credential === 'Bearer fixture-fault') throw new Error('private-token-secret/profile/path');
    const index = credentials.indexOf(credential);
    if (index < 0) return null;
    return {principalId: `fixture-${index}`, requestContext: contexts[index]};
  }, ...options});
  const {url} = await host.listen();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close())); await host.close(); await core.shutdown();
  });
  async function connect(index = 0, connectOptions) {
    const client = new Client({name: 'http-fixture-client', version: '0.1.0'});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {headers: {authorization: credentials[index]}}
    }), connectOptions);
    return client;
  }
  return {url, host, connect, controllerCalls, driverActions,
    revoke() {revoked = true;},
    get authenticateCalls() {return authenticateCalls;}, get driverCloses() {return driverCloses;}};
}
const request = (url, body = {jsonrpc: '2.0', id: 1, method: 'ping'}, headers = {}) =>
  fetch(url, {method: 'POST', headers: {'content-type': 'application/json',
    accept: 'application/json, text/event-stream', authorization: credentials[0], ...headers},
  body: typeof body === 'string' ? body : JSON.stringify(body)});
const rawHostRequest = url => new Promise((resolve, reject) => {
  const req = nodeRequest(url, {method: 'POST', headers: {host: 'evil.example',
    'content-type': 'application/json', authorization: credentials[0]}}, res => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject); req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
});

test('HTTP host requires explicit trusted hooks and only listens when asked', async () => {
  assert.throws(() => createControllerHttp(), /explicit authenticator/);
  assert.throws(() => createControllerHttp({authenticate() {}, controller: {callTool() {}}, maxContexts: 0}), /valid HTTP limits/);
  const host = createControllerHttp({authenticate() {}, controller: {callTool() {}}});
  await assert.rejects(host.listen({host: '0.0.0.0'}), /loopback/);
  await host.close();
});

const lifecycleHost = () => createControllerHttp({
  authenticate: async () => ({principalId: 'startup-fixture', requestContext: contexts[0]}),
  controller: {async callTool() {return {content: []};}},
  publicRoutes: {'/health': {body: '<!doctype html><title>Startup fixture</title>', contentType: 'text/html'}}
});
const bindFixture = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const closeFixture = server => new Promise(resolve => server.close(resolve));

test('failed occupied-port startup permits an explicit same-host retry after the port is freed', async t => {
  const occupied = createServer(), port = await bindFixture(occupied), host = lifecycleHost();
  t.after(async () => {await closeFixture(occupied); await host.close();});
  await assert.rejects(host.listen({port}), error => error.code === 'EADDRINUSE');
  await assert.rejects(host.listen({port}), error => error.code === 'EADDRINUSE');
  await closeFixture(occupied);
  const {url} = await host.listen({port});
  assert.equal(new URL(url).port, String(port));
  assert.equal((await fetch(url.replace('/mcp', '/health'))).status, 200);
  await assert.rejects(host.listen(), /loopback/);
});

test('a concurrent listen cannot replace the candidate server or its startup slot', async t => {
  const host = lifecycleHost();t.after(() => host.close());
  const startup = host.listen();await assert.rejects(host.listen(), /loopback/);
  const {url} = await startup;assert.equal((await fetch(url.replace('/mcp', '/health'))).status, 200);
});

test('close during immediate startup settles both operations and never returns a live endpoint', {timeout: 2000}, async () => {
  for(const hostname of ['127.0.0.1', 'localhost']){
    const host = lifecycleHost(), occupied = createServer(), port = await bindFixture(occupied);
    await closeFixture(occupied);
    const startup = host.listen({host: hostname, port}), shutdown = host.close();
    const [started, stopped] = await Promise.allSettled([startup, shutdown]);
    assert.equal(started.status, 'rejected');assert.match(started.reason.message, /closed during startup/);
    assert.equal(stopped.status, 'fulfilled');await assert.rejects(host.listen({port}), /loopback/);
    // A later event-loop turn must not resurrect the cancelled listener.
    await new Promise(resolve => setImmediate(resolve));
    const probe = createServer();await new Promise((resolve, reject) => {
      probe.once('error', reject);probe.listen(port, hostname, resolve);
    });await closeFixture(probe);
  }
});

test('closing after failed startup keeps the host retired and close remains idempotent', async t => {
  const occupied = createServer(), port = await bindFixture(occupied), host = lifecycleHost();
  t.after(() => closeFixture(occupied));
  await assert.rejects(host.listen({port}), error => error.code === 'EADDRINUSE');
  await host.close();await host.close();await assert.rejects(host.listen(), /loopback/);
  assert.equal((await host.fetch(new Request('http://127.0.0.1/health'))).status, 503);
});

test('real HTTP MCP client discovers, lists and runs all six browser tools with stable host contexts', async t => {
  const f = await fixture(t), client = await f.connect();
  const list = await client.listTools();
  assert.equal(list.tools.length, 6);
  const opened = await client.callTool({name: 'browser_open', arguments: {}});
  assert.equal(opened.isError, undefined);
  const {sessionId, observation} = opened.structuredContent;
  const clicked = await client.callTool({name: 'browser_click', arguments: {
    session_id: sessionId, observation_id: observation.id, target_id: 'test-button'
  }});
  assert.equal(clicked.structuredContent.observation.status, 'Clicks 1');
  const observed = await client.callTool({name: 'browser_observe', arguments: {session_id: sessionId}});
  assert.equal(observed.structuredContent.observation.status, 'Clicks 1');
  const filled = await client.callTool({name: 'browser_fill', arguments: {
    session_id: sessionId, observation_id: observed.structuredContent.observation.id,
    target_id: 'test-note', text: 'Non-secret HTTP fixture note'
  }});
  assert.equal(filled.isError, undefined);
  assert.doesNotMatch(JSON.stringify(filled), /Non-secret HTTP fixture note/);
  const screenshot = await client.callTool({name: 'browser_screenshot', arguments: {
    session_id: sessionId, observation_id: filled.structuredContent.observation.id
  }});
  assert.equal(screenshot.content[0].type, 'image'); assert.equal(screenshot.content[0].mimeType, 'image/png');
  assert.equal(Object.hasOwn(screenshot.structuredContent, 'data'), false);
  const closed = await client.callTool({name: 'browser_close', arguments: {session_id: sessionId}});
  assert.deepEqual(closed.structuredContent, {closed: true});
  assert.equal(f.driverCloses, 1);
  assert.equal(f.driverActions.length, 2);
  assert.equal(f.controllerCalls.every(call => call.context === contexts[0]), true);
  assert.ok(f.authenticateCalls >= 8);
});

test('legacy MCP initialize and stateless HTTP tool calls remain interoperable', async t => {
  const f = await fixture(t), client = await f.connect(0, {prior: {kind: 'legacy'}});
  assert.equal(client.getServerVersion().name, 'relay-browser-fixture');
  assert.equal((await client.listTools()).tools.length, 6);
  const opened = await client.callTool({name: 'browser_open', arguments: {}});
  assert.equal(opened.isError, undefined); assert.equal(typeof opened.structuredContent.sessionId, 'string');
  assert.equal(f.controllerCalls[0].context, contexts[0]);
});

test('HTTP requests cannot choose another principal or re-use its browser handles', async t => {
  const f = await fixture(t), first = await f.connect(0), second = await f.connect(1);
  const a = (await first.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  const b = (await second.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  assert.notEqual(a.sessionId, b.sessionId);
  const forbidden = await second.callTool({name: 'browser_observe', arguments: {session_id: a.sessionId}});
  assert.equal(forbidden.structuredContent.error.code, 'FORBIDDEN');
  const injected = await second.callTool({name: 'browser_open', arguments: {principalId: 'fixture-0'}});
  assert.equal(injected.isError, true);
  assert.equal(f.driverCloses, 0);
});

test('controller resolves authority again after HTTP authentication and safely tears down only revoked owner', async t => {
  const f = await fixture(t), first = await f.connect(0), second = await f.connect(1);
  const a = (await first.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  const b = (await second.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  f.revoke();
  const revoked = await first.callTool({name: 'browser_observe', arguments: {session_id: a.sessionId}});
  assert.equal(revoked.structuredContent.error.code, 'AUTH_REQUIRED');
  assert.equal(f.driverCloses, 1);
  const live = await second.callTool({name: 'browser_observe', arguments: {session_id: b.sessionId}});
  assert.equal(live.isError, undefined);
  assert.equal(f.driverCloses, 1);
});

test('unauthenticated, denied-scope and authentication faults never reach MCP', async t => {
  const f = await fixture(t);
  for (const [authorization, status] of [['', 401], ['Bearer fixture-denied', 403], ['Bearer fixture-fault', 401]]) {
    const response = await request(f.url, undefined, {authorization});
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private|profile|token-secret/);
  }
  assert.equal(f.controllerCalls.length, 0);
});

test('host, origin, HTTP method, path and JSON media type are checked before authentication', async t => {
  const f = await fixture(t);
  assert.equal(await rawHostRequest(f.url), 403);
  for (const origin of ['https://evil.example', 'null', 'http://localhost:9999']) {
    assert.equal((await request(f.url, undefined, {origin})).status, 403);
  }
  for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const response = await fetch(f.url, {method}); assert.equal(response.status, 405);
  }
  assert.equal((await request(`${f.url}?principal=other`)).status, 404);
  assert.equal((await request(f.url, '{}', {'content-type': 'text/plain'})).status, 415);
  assert.equal(f.authenticateCalls, 0);
});

test('bounded body rejects malformed JSON, oversized bodies, batches and unsupported streams', async t => {
  const f = await fixture(t, {maxBodyBytes: 256});
  for (const [body, status] of [['{', 400], [' '.repeat(257), 413],
    [[], 400], [{method: 'subscriptions/listen', jsonrpc: '2.0', id: 1}, 400],
    [{method: 'browser/evaluate', jsonrpc: '2.0', id: 1}, 400]]) {
    assert.equal((await request(f.url, body)).status, status);
  }
  assert.equal(f.controllerCalls.length, 0);
});

test('trusted generic serverFactory can add direct tools without browser or credential arguments', async t => {
  let factoryContext;
  const f = await fixture(t, {serverFactory: context => {
    factoryContext = context;
    const server = new McpServer({name: 'combined-fixture', version: '0.1.0'});
    server.registerTool('relay_fixture_identity', {inputSchema: fromJsonSchema({type: 'object', additionalProperties: false})},
      async () => ({content: [{type: 'text', text: 'fixture worker'}]}));
    return server;
  }});
  const client = await f.connect();
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['relay_fixture_identity']);
  assert.equal((await client.callTool({name: 'relay_fixture_identity', arguments: {}})).content[0].text, 'fixture worker');
  assert.equal(factoryContext, contexts[0]);
});

test('principal cache is bounded and can expire idle transport contexts without closing browsers', async t => {
  let time = 1000;
  const f = await fixture(t, {maxContexts: 1, contextTTL: 1000, now: () => time});
  const first = await f.connect(0);
  await first.callTool({name: 'browser_open', arguments: {}});
  await assert.rejects(f.connect(1), /429|limit/);
  time += 1001;
  const second = await f.connect(1);
  assert.equal((await second.listTools()).tools.length, 6);
  assert.equal(f.driverCloses, 0);
});

test('changing trusted context for the same principal is rejected rather than inheriting browser access', async t => {
  let context = contexts[0];
  const f = await fixture(t, {authenticate: async () => ({principalId: 'constant-principal', requestContext: context})});
  const first = await f.connect();
  await first.callTool({name: 'browser_open', arguments: {}});
  context = contexts[1];
  assert.equal((await request(f.url)).status, 403);
  assert.equal(f.driverCloses, 0);
});

test('factory exceptions are normalized and never disclose host secrets', async t => {
  const f = await fixture(t, {serverFactory() {throw new Error('private-token-secret/profile/path');}});
  const response = await request(f.url, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'fixture', version: '1'}
  }});
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private|profile|token-secret/);
});

test('private exact routes share authentication, context, method and body limits', async t => {
  const seen = [];
  const f = await fixture(t, {routes: {
    '/viewer': {methods: ['GET'], handler: async (req, context) => {
      seen.push(context); return new Response('<!doctype html><title>Private fixture viewer</title>',
        {headers: {'content-type': 'text/html', 'content-security-policy': "default-src 'none'; style-src 'self'"}});
    }},
    '/viewer/open': {methods: ['POST'], handler: async (req, context) => {
      seen.push(context); assert.deepEqual(await req.json(), {});
      return new Response('{"ok":true}', {headers: {'content-type': 'application/json'}});
    }},
    '/viewer/fault': {methods: ['GET'], handler() {throw new Error('private-token/profile-path');}}
  }, maxBodyBytes: 256});
  const viewerUrl = f.url.replace('/mcp', '/viewer');
  assert.equal((await fetch(viewerUrl)).status, 401);
  const shell = await fetch(viewerUrl, {headers: {authorization: credentials[0]}});
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Private fixture viewer/);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(shell.headers.get('content-security-policy'), "default-src 'none'; style-src 'self'");
  const opened = await request(`${viewerUrl}/open`, {});
  assert.equal(opened.status, 200); assert.deepEqual(await opened.json(), {ok: true});
  assert.match(opened.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await request(`${viewerUrl}/open`, ' '.repeat(257))).status, 413);
  assert.equal((await request(`${viewerUrl}/open`, {}, {origin: new URL(viewerUrl).origin})).status, 200);
  assert.equal((await fetch(`${viewerUrl}/open`, {headers: {authorization: credentials[0]}})).status, 405);
  assert.equal((await fetch(`${viewerUrl}/unconfigured`, {headers: {authorization: credentials[0]}})).status, 404);
  const fault = await fetch(`${viewerUrl}/fault`, {headers: {authorization: credentials[0]}});
  assert.equal(fault.status, 500); assert.doesNotMatch(await fault.text(), /private|profile-path/);
  assert.deepEqual(seen, [contexts[0], contexts[0], contexts[0]]);
});

test('streaming POST bodies cannot bypass the size limit with no Content-Length header', async t => {
  const f = await fixture(t, {maxBodyBytes: 256});
  const response = await new Promise((resolve, reject) => {
    const req = nodeRequest(f.url, {method: 'POST', headers: {
      'content-type': 'application/json', authorization: credentials[0], 'transfer-encoding': 'chunked'
    }}, res => {res.resume(); res.on('end', () => resolve(res.statusCode));});
    req.on('error', reject); req.write(' '.repeat(100)); req.write(' '.repeat(157)); req.end();
  });
  assert.equal(response, 413);
  assert.equal(f.controllerCalls.length, 0);
});

test('concurrent request cap counts pending authentication before accepting further work', async t => {
  let release, entered;
  const gate = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {entered = resolve;});
  let calls = 0;
  const f = await fixture(t, {maxRequests: 1, authenticate: async () => {
    calls++; entered(); await gate;
    return {principalId: 'fixture-gated', requestContext: contexts[0]};
  }});
  const pending = request(f.url);
  await started;
  try {assert.equal((await request(f.url)).status, 429); assert.equal(calls, 1);}
  finally {release();}
  assert.equal((await pending).status, 200);
});

test('closing HTTP host does not shut down shared controller or other worker resources', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.callTool({name: 'browser_open', arguments: {}});
  await f.host.close();
  assert.equal(f.driverCloses, 0);
  const unavailable = await f.host.fetch(new Request(f.url, {method: 'POST',
    headers: {host: new URL(f.url).host, 'content-type': 'application/json'}, body: '{}'}));
  assert.equal(unavailable.status, 503);
});

test('explicit public shell exposes only static HTML and never inherits private route authority', async t => {
  let privateCalls = 0;
  const f = await fixture(t, {publicRoutes: {'/viewer': {
    body: '<!doctype html><title>Fixture viewer</title><input type="password" aria-label="Connection token">',
    contentType: 'text/html'
  }}, routes: {'/viewer/snapshot': {methods: ['GET'], handler() {
    privateCalls++; return new Response('private fixture data');
  }}}});
  const viewerUrl = f.url.replace('/mcp', '/viewer');
  const shell = await fetch(viewerUrl);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /Fixture viewer/); assert.doesNotMatch(html, /fixture-first|fixture-second|private fixture data/);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.authenticateCalls, 0);
  assert.equal((await fetch(viewerUrl, {headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await request(viewerUrl, {})).status, 405);
  assert.equal((await fetch(`${viewerUrl}/snapshot`)).status, 401);
  assert.equal(privateCalls, 0);
  const snapshot = await fetch(`${viewerUrl}/snapshot`, {headers: {authorization: credentials[0]}});
  assert.equal(snapshot.status, 200); assert.equal(await snapshot.text(), 'private fixture data');
  assert.equal(privateCalls, 1);
});

test('public route configuration cannot contain callbacks or collide with authenticated routes', () => {
  const options = {authenticate() {}, controller: {callTool() {}}};
  for (const publicRoutes of [
    {'/viewer': {body: 'shell', contentType: 'text/html', handler() {}}},
    {'/mcp': {body: 'shell', contentType: 'text/html'}},
    {'/viewer': {body: 'shell', contentType: 'application/json'}},
    {'/viewer': {body: 'shell', contentType: 'text/html', headers: {'set-cookie': 'private'}}}
  ]) assert.throws(() => createControllerHttp({...options, publicRoutes}), /valid HTTP limits/);
  assert.throws(() => createControllerHttp({...options,
    routes: {'/viewer': {methods: ['GET'], handler() {}}},
    publicRoutes: {'/viewer': {body: 'shell', contentType: 'text/html'}}}), /valid HTTP limits/);
});
