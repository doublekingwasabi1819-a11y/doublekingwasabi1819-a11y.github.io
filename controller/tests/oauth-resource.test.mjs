import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {McpServer, fromJsonSchema} from '@modelcontextprotocol/server';
import {createOAuthResource} from '../oauth-resource.mjs';
import {createControllerHttp} from '../http-server.mjs';
import {createBrowserController} from '../core.mjs';

// These registered fixture tokens and trusted verifier outputs test resource
// policy only. They are NOT JWT signature verification, a real provider, OAuth
// code/PKCE exchange, real TLS, account linking, or actual Relay delegation.
const RESOURCE = 'https://mcp.fixture.invalid/mcp', ISSUER = 'https://issuer.fixture.invalid';
const contextA = Object.freeze({grantId: 'oauth-fixture-a'}), contextB = Object.freeze({grantId: 'oauth-fixture-b'});
const PRIVATE = 'private-provider-value-profile-path-token';
const claims = (resource = RESOURCE, subject = 'fixture-subject-a') => ({
  iss: ISSUER, sub: subject, aud: resource, exp: 2000, nbf: 900,
  scope: 'browser:control', jti: `fixture-${subject}`
});
const identity = (resource = RESOURCE, context = contextA, subject = 'fixture-subject-a') => ({
  claims: claims(resource, subject), principalId: context.grantId, requestContext: context
});
const req = (path = '/mcp', options = {}) => new Request(`https://mcp.fixture.invalid${path}`, {
  headers: {host: 'mcp.fixture.invalid', ...options.headers}, ...options,
  ...(options.headers ? {headers: {host: 'mcp.fixture.invalid', ...options.headers}} : {})
});

function policy(options = {}) {
  const credentials = new Map([['registered-fixture-a', identity()],
    ['registered-fixture-b', identity(RESOURCE, contextB, 'fixture-subject-b')]]);
  const verified = [], retired = [];
  const resource = createOAuthResource({resource: RESOURCE, issuers: [ISSUER], now: () => 1000000,
    verifyAccessToken: async (token, config) => {
      verified.push({token, config}); if (!credentials.has(token)) throw new Error(PRIVATE);
      return credentials.get(token);
    }, onRevoke: async context => {retired.push(context);}, ...options});
  return {resource, credentials, verified, retired};
}

async function rejectsAuth(resource, request, code = 'AUTH_REQUIRED') {
  await assert.rejects(resource.authenticate(request), error => {
    assert.equal(error.code, code); assert.doesNotMatch(error.message, /private|profile|token-/); return true;
  });
}

test('OAuth resource requires canonical HTTPS identifiers, issuers, verifier and bounded scopes', () => {
  const valid = {resource: RESOURCE, issuers: [ISSUER], verifyAccessToken: async () => identity()};
  for (const change of [
    {resource: 'http://mcp.fixture.invalid/mcp'}, {resource: `${RESOURCE}#fragment`},
    {resource: 'https://username:password@mcp.fixture.invalid/mcp'}, {resource: `${RESOURCE}?token=secret`},
    {issuers: ['http://issuer.fixture.invalid']}, {issuers: []}, {issuers: [ISSUER, ISSUER]},
    {verifyAccessToken: undefined}, {scopesSupported: ['bad scope']}, {requiredScopes: ['unknown:scope']},
    {maxVerifiedTokens: 0}, {verificationTimeout: 0}, {allowedOrigins: ['*']}
  ]) assert.throws(() => createOAuthResource({...valid, ...change}), TypeError);
});

test('public strict GET resource metadata advertises only its configured real-provider dependency', async () => {
  const f = policy(), fetch = f.resource.wrapFetch(async () => new Response('private downstream'));
  assert.equal(f.resource.metadataUrl, 'https://mcp.fixture.invalid/.well-known/oauth-protected-resource/mcp');
  const response = await fetch(req('/.well-known/oauth-protected-resource/mcp'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {resource: RESOURCE, authorization_servers: [ISSUER],
    scopes_supported: ['browser:control'], bearer_methods_supported: ['header']});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(f.verified.length, 0);
  assert.equal((await fetch(req('/.well-known/oauth-protected-resource/mcp', {method: 'POST', body: '{}'}))).status, 405);
  assert.equal((await fetch(req('/.well-known/oauth-protected-resource/mcp?token=x'))).status, 400);
  // This module publishes no authorization-server capabilities or endpoints.
  assert.equal(await (await fetch(req('/.well-known/oauth-authorization-server'))).text(), 'private downstream');
});

test('HTTPS, exact Host and Origin protections also cover public metadata and ignore forwarded claims', async () => {
  const f = policy(), fetch = f.resource.wrapFetch(async () => new Response('downstream'));
  for (const request of [
    req('/.well-known/oauth-protected-resource/mcp', {headers: {host: 'evil.example'}}),
    req('/.well-known/oauth-protected-resource/mcp', {headers: {origin: 'https://evil.example'}}),
    req('/.well-known/oauth-protected-resource/mcp', {headers: {origin: 'null'}}),
    new Request('http://mcp.fixture.invalid/.well-known/oauth-protected-resource/mcp', {
      headers: {host: 'mcp.fixture.invalid', 'x-forwarded-proto': 'https'}})
  ]) assert.equal((await fetch(request)).status, 403);
  assert.equal(f.verified.length, 0);
  assert.equal((await fetch(req('/.well-known/oauth-protected-resource/mcp', {
    headers: {origin: 'https://mcp.fixture.invalid'}}))).status, 200);
});

test('401/403 HTTP challenges and tool errors advertise fixed metadata, scopes and OAuth error hints', async () => {
  const f = policy();
  for (const [status, expected] of [[401, 'invalid_token'], [403, 'insufficient_scope']]) {
    const response = await f.resource.wrapFetch(async () => new Response('denied', {status}))(req());
    assert.equal(response.status, status);
    const challenge = response.headers.get('www-authenticate');
    assert.match(challenge, new RegExp(`error="${expected}"`));
    assert.match(challenge, /resource_metadata="https:\/\/mcp.fixture.invalid\/.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(challenge, /scope="browser:control"/);
    const tool = f.resource.toolAuthError(status === 403 ? 'FORBIDDEN' : 'AUTH_REQUIRED');
    assert.equal(tool.isError, true);
    assert.match(tool._meta['mcp/www_authenticate'][0], /error_description=/);
    assert.match(tool._meta['mcp/www_authenticate'][0], new RegExp(expected));
  }
  assert.deepEqual(f.resource.toolSecuritySchemes, [{type: 'oauth2', scopes: ['browser:control']}]);
});

test('missing, malformed, duplicate, oversized and forged bearer tokens never authenticate', async () => {
  const f = policy();
  for (const authorization of ['', 'Basic fixture', 'Bearer', 'Bearer fixture extra',
    'Bearer registered-fixture-a, Bearer registered-fixture-b', `Bearer ${'x'.repeat(8193)}`,
    'Bearer not-a-registered-token']) await rejectsAuth(f.resource, req('/mcp', {headers: {authorization}}));
  assert.deepEqual(f.retired, []);
  assert.equal(f.verified.length, 1); // Only a well-formed forged fixture reaches the trusted verifier.
});

test('provider runs on every request and passes no token or signed claims into the model context', async () => {
  const f = policy();
  const a = await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  const again = await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  const b = await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-b'}}));
  assert.equal(a.requestContext, contextA); assert.equal(again.requestContext, contextA);
  assert.equal(a.principalId, again.principalId); assert.notEqual(a.principalId, b.principalId);
  assert.equal(f.verified.length, 3);
  assert.deepEqual(Object.keys(a).sort(), ['principalId', 'requestContext']);
  assert.doesNotMatch(JSON.stringify(a), /registered-fixture|fixture-subject|\biss\b|\baud\b|\bexp\b/);
  assert.equal(f.verified[0].config.resource, RESOURCE); assert.equal(f.verified[0].config.signal.aborted, false);
});

test('trusted grant accessor returns frozen canonical scopes and expiry only after verified policy', async () => {
  const f=policy();
  f.credentials.set('registered-fixture-a',{...identity(),claims:{...claims(),scope:'relay:read browser:control'}});
  const value=await f.resource.authenticateGrant(req('/mcp',{headers:{authorization:'Bearer registered-fixture-a'}}));
  assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.scopes),true);
  assert.deepEqual(value.scopes,['browser:control','relay:read']);assert.equal(value.expiresAt,2000000);
  assert.equal(value.requestContext,contextA);assert.deepEqual(Object.keys(value.requestContext),['grantId']);
  assert.deepEqual(Object.keys(await f.resource.authenticate(req('/mcp',{headers:{authorization:'Bearer registered-fixture-a'}}))).sort(),['principalId','requestContext']);
  f.credentials.set('registered-fixture-b',{...identity(RESOURCE,contextB),claims:{...claims(),aud:'https://wrong.fixture.invalid'}});
  await assert.rejects(f.resource.authenticateGrant(req('/mcp',{headers:{authorization:'Bearer registered-fixture-b'}})),error=>error.code==='AUTH_REQUIRED');
});

test('wrong issuer, Relay/downstream audience, expiry, not-before and missing scope fail closed', async () => {
  for (const [patch, code] of [
    [{iss: `${ISSUER}/`}, 'AUTH_REQUIRED'], [{iss: 'https://wrong.fixture.invalid'}, 'AUTH_REQUIRED'],
    [{aud: 'https://relay-downstream.fixture.invalid'}, 'AUTH_REQUIRED'], [{aud: undefined}, 'AUTH_REQUIRED'],
    [{aud: `${RESOURCE}/`}, 'AUTH_REQUIRED'], [{aud: [RESOURCE, RESOURCE]}, 'AUTH_REQUIRED'],
    [{exp: 1000}, 'AUTH_REQUIRED'], [{exp: undefined}, 'AUTH_REQUIRED'], [{exp: Number.MAX_SAFE_INTEGER}, 'AUTH_REQUIRED'],
    [{active: false}, 'AUTH_REQUIRED'], [{nbf: 1001}, 'AUTH_REQUIRED'],
    [{nbf: 2500}, 'AUTH_REQUIRED'], [{scope: 'relay:read'}, 'FORBIDDEN'],
    [{scope: ['browser:control']}, 'AUTH_REQUIRED']
  ]) {
    const f = policy(); f.credentials.set('registered-fixture-a', {...identity(), claims: {...claims(), ...patch}});
    await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}), code);
    assert.deepEqual(f.retired, []);
  }
  const f = policy();
  f.credentials.set('registered-fixture-a', {...identity(), claims: {...claims(), aud: ['https://other.fixture.invalid', RESOURCE]}});
  assert.equal((await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}))).requestContext, contextA);
});

test('claims and trusted context are bounded and cannot carry authority snapshots', async () => {
  for (const patch of [
    {principalId: 'not a bounded opaque identifier'}, {requestContext: {grantId: 'mutable'}},
    {requestContext: Object.freeze({grantId: 'grant', token: PRIVATE})},
    {claims: {...claims(), sub: 'x'.repeat(257)}}, {claims: {...claims(), jti: 'x'.repeat(257)}},
    {claims: {...claims(), scope: 'browser:control '.repeat(40)}},
    {claims: {...claims(), payload: 'x'.repeat(8192)}}, {claims: null}
  ]) {
    const f = policy(); f.credentials.set('registered-fixture-a', {...identity(), ...patch});
    await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  }
});

test('failed known-token verification retires only its last verified context, ignoring failed verifier data', async () => {
  const f = policy();
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-b'}}));
  // Failed output attempts to point at B; cleanup must use cached verified A.
  f.credentials.set('registered-fixture-a', {...identity(RESOURCE, contextB, 'fixture-subject-b'),
    claims: {...claims(), aud: 'https://relay-downstream.fixture.invalid'}});
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(f.retired, [contextA]);
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer forged'}}));
  assert.deepEqual(f.retired, [contextA]);
});

test('stable context cannot alias a different grant or silently change signed grant claims', async () => {
  const f = policy();
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  f.credentials.set('new-fixture-token', {...identity(), claims: {...claims(), jti: 'different-grant', exp: 2100}});
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer new-fixture-token'}}));
  assert.deepEqual(f.retired, []);
  f.credentials.set('registered-fixture-a', identity(RESOURCE, Object.freeze({grantId: 'fresh-context'})));
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(f.retired, [contextA]);
});

test('concurrent first-use tokens cannot alias a context while unrelated expiry cleanup yields', {timeout: 5000}, async () => {
  let time = 1000000, entered, release;
  const cleanupStarted = new Promise(resolve => {entered = resolve;});
  const cleanupGate = new Promise(resolve => {release = resolve;});
  const shared = Object.freeze({grantId: 'concurrent-new-grant'});
  const f = policy({now: () => time, onRevoke: async context => {
    assert.equal(context, contextA);
    entered(); await cleanupGate;
  }});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  time = 2000000;
  for (const subject of ['first', 'second']) f.credentials.set(subject, {
    ...identity(RESOURCE, shared, subject), claims: {...claims(RESOURCE, subject), exp: 3000}
  });
  const request = token => req('/mcp', {headers: {authorization: `Bearer ${token}`}});
  const first = f.resource.authenticate(request('first'));
  await cleanupStarted;
  const second = f.resource.authenticate(request('second'));
  // Drain verification microtasks so both requests reach the shared cleanup gate.
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winningIndex = results.findIndex(result => result.status === 'fulfilled');
  const winner = winningIndex === 0 ? 'first' : 'second';
  const loser = winningIndex === 0 ? 'second' : 'first';
  assert.equal(results[1 - winningIndex].reason.code, 'AUTH_REQUIRED');
  const again = await f.resource.authenticate(request(winner));
  assert.equal(again.requestContext, shared);
  assert.equal(again.principalId, results[winningIndex].value.principalId);
  await rejectsAuth(f.resource, request(loser));
});

test('verified-token cache is bounded; expired known tokens safely trigger lifecycle retirement', async () => {
  let time = 1000000;
  const f = policy({maxVerifiedTokens: 1, now: () => time});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-b'}}));
  assert.deepEqual(f.retired, []);
  time = 2000000;
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(f.retired, [contextA]);
  f.credentials.set('registered-fixture-b', {...identity(RESOURCE, contextB, 'fixture-subject-b'), claims: {...claims(RESOURCE, 'fixture-subject-b'), exp: 2500}});
  assert.equal((await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-b'}}))).requestContext, contextB);
});

test('provider deadline aborts verification and private hook errors remain secret-safe', async () => {
  let signal;
  const f = policy({verificationTimeout: 20, verifyAccessToken: async (_token, options) => {
    signal = options.signal; return new Promise(() => {});
  }});
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.equal(signal.aborted, true);
  const fault = policy({verifyAccessToken() {throw new Error(PRIVATE);}});
  await rejectsAuth(fault.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  const response = await fault.resource.wrapFetch(async () => {throw new Error(PRIVATE);})(req());
  assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /private|profile|token-/);
});

test('failed known lifecycle cleanup retains only verified context knowledge for safe retry', async () => {
  const retired = []; let failClose = true;
  const f = policy({onRevoke: async context => {
    retired.push(context); return failClose ? {isError: true} : {structuredContent: {closed: true}};
  }});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  f.credentials.delete('registered-fixture-a');
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(retired, [contextA]);
  failClose = false;
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(retired, [contextA, contextA]);
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.deepEqual(retired, [contextA, contextA]);
});

test('invalid host clock fails closed rather than disabling expiration checks', async () => {
  const f = policy({now: () => NaN});
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
});

test('known-token retirement is single-flight and failed cleanup quarantines reauthentication', async () => {
  let enter, release, attempts = 0;
  const entered = new Promise(resolve => {enter = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = policy({onRevoke: async context => {
    assert.equal(context, contextA); attempts++; enter(); await gate; throw new Error(PRIVATE);
  }});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  f.credentials.delete('registered-fixture-a');
  const first = rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await entered;
  const second = rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await Promise.resolve(); assert.equal(attempts, 1); release();
  await Promise.all([first, second]); assert.equal(attempts, 1);
  // A provider becoming reachable again cannot reopen a quarantined host grant.
  f.credentials.set('registered-fixture-a', identity());
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.equal(attempts, 2);
});

test('verification already in flight cannot reaccept a token while its known grant is retiring', async () => {
  let verifierEnter, verifierRelease, cleanupEnter, cleanupRelease, delayed = false, invalid = false;
  const entered = new Promise(resolve => {verifierEnter = resolve;});
  const verificationGate = new Promise(resolve => {verifierRelease = resolve;});
  const cleanupStarted = new Promise(resolve => {cleanupEnter = resolve;});
  const cleanupGate = new Promise(resolve => {cleanupRelease = resolve;});
  const f = policy({verifyAccessToken: async () => {
    if (delayed) {delayed = false; verifierEnter(); await verificationGate; return identity();}
    if (invalid) throw new Error(PRIVATE);
    return identity();
  }, onRevoke: async () => {cleanupEnter(); await cleanupGate; return {isError: true};}});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  delayed = true;
  const pending = rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await entered; invalid = true;
  const revoked = rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await cleanupStarted; verifierRelease(); await Promise.resolve(); cleanupRelease();
  await Promise.all([pending, revoked]);
});

test('successful cleanup and intervening valid refresh cannot resurrect a retired grant from a late verifier', async () => {
  let enter, release, delayNext = false, invalid = false, retireCalls = 0;
  const entered = new Promise(resolve => {enter = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = policy({verifyAccessToken: async () => {
    if (delayNext) {delayNext = false; enter(); await gate; return identity();}
    if (invalid) throw new Error(PRIVATE);
    return identity();
  }, onRevoke: async context => {assert.equal(context, contextA); retireCalls++;}});
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  delayNext = true;
  const pending = rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  await entered;
  // This valid request used to replace the captured cache entry before revoke.
  await f.resource.authenticate(req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  invalid = true;
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.equal(retireCalls, 1); release(); await pending;
  invalid = false;
  // Retired host grant objects stay invalid after successful cache removal.
  await rejectsAuth(f.resource, req('/mcp', {headers: {authorization: 'Bearer registered-fixture-a'}}));
  assert.equal(retireCalls, 1);
});

async function httpFixture(t) {
  let route, resource, verifiedCalls = 0, browserCloses = 0;
  const credentials = new Map(), clients = [];
  const nodeServer = createServer(async (incoming, outgoing) => {
    try {
      // Fixed, trusted fixture TLS-termination mapping. No forwarded header is
      // used to manufacture origin. Production needs an actual trusted HTTPS
      // runtime/proxy; this local plain HTTP test proves policy/wire only.
      const request = new Request(`${resource.replace('/mcp', '')}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
        ...(incoming.method === 'POST' ? {body: incoming, duplex: 'half'} : {})
      });
      const response = await route(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {outgoing.writeHead(500); outgoing.end('fixture transport failure');}
  });
  await new Promise(resolve => nodeServer.listen(0, '127.0.0.1', resolve));
  const port = nodeServer.address().port;
  resource = `https://127.0.0.1:${port}/mcp`;
  const url = `http://127.0.0.1:${port}/mcp`;
  const bindings = new Map([
    [contextA, {workspaceId: 'oauth-fixture', accountId: '11111111-1111-4111-8111-111111111111', agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'oauth-run-a'}],
    [contextB, {workspaceId: 'oauth-fixture', accountId: '22222222-2222-4222-8222-222222222222', agentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId: 'oauth-run-b'}]
  ]);
  const controller = createBrowserController({authorize: async context => bindings.get(context),
    authorizeAction: async () => true, createDriver: async () => ({
      async observe() {return {title: 'OAuth HTTP fixture', status: 'Ready', targets: [{id: 'button', role: 'button', name: 'Fixture'}]};},
      async click() {}, async fill() {}, async screenshot() {return {mimeType: 'image/png', data: 'iVBORw0KGgo='};},
      async close() {browserCloses++;}
    })});
  const oauth = createOAuthResource({resource, issuers: [ISSUER], now: () => 1000000,
    verifyAccessToken: async token => {verifiedCalls++; if (!credentials.has(token)) throw new Error(PRIVATE); return credentials.get(token);},
    onRevoke: context => controller.revokeContext(context)});
  const host = createControllerHttp({controller, authenticate: oauth.authenticate, serverFactory: context => {
    const server = new McpServer({name: 'oauth-resource-fixture', version: '0.1.0'});
    for (const name of ['browser_open', 'browser_observe']) {
      const properties = name === 'browser_open' ? {} : {session_id: {type: 'string'}};
      server.registerTool(name, {inputSchema: fromJsonSchema({type: 'object', properties,
        required: Object.keys(properties), additionalProperties: false}),
        _meta: {securitySchemes: oauth.toolSecuritySchemes}},
      args => controller.callTool({name, arguments: args}, context));
    }
    return server;
  }});
  route = oauth.wrapFetch(host.fetch);
  credentials.set('registered-fixture-a', identity(resource));
  credentials.set('registered-fixture-b', identity(resource, contextB, 'fixture-subject-b'));
  t.after(async () => {
    await Promise.all(clients.map(client => client.close())); await host.close(); await controller.shutdown();
    await new Promise(resolve => nodeServer.close(resolve));
  });
  async function connect(token, options) {
    const client = new Client({name: 'oauth-policy-wire-fixture', version: '0.1.0'}); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {headers: {authorization: `Bearer ${token}`}}
    }), options);
    return client;
  }
  return {resource, url, credentials, connect, get verifiedCalls() {return verifiedCalls;}, get browserCloses() {return browserCloses;}};
}

test('actual HTTP MCP fixture supports discovery, challenges and isolated authenticated tool calls', async t => {
  const f = await httpFixture(t);
  const metadata = await fetch(f.url.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'));
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).resource, f.resource);
  const missing = await fetch(f.url, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(missing.status, 401); assert.match(missing.headers.get('www-authenticate'), /resource_metadata=/);
  const a = await f.connect('registered-fixture-a'), b = await f.connect('registered-fixture-b');
  const tools = (await a.listTools()).tools;
  assert.deepEqual(tools[0]._meta.securitySchemes, [{type: 'oauth2', scopes: ['browser:control']}]);
  // SDK2.3 carries the supported _meta mirror; top-level securitySchemes is not
  // an advertised SDK registerTool field. This test does NOT prove ChatGPT UI.
  assert.equal(Object.hasOwn(tools[0], 'securitySchemes'), false);
  const first = (await a.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  const second = (await b.callTool({name: 'browser_open', arguments: {}})).structuredContent;
  assert.notEqual(first.sessionId, second.sessionId);
  const cross = await b.callTool({name: 'browser_observe', arguments: {session_id: first.sessionId}});
  assert.equal(cross.structuredContent.error.code, 'FORBIDDEN');
  assert.equal(f.browserCloses, 0); assert.ok(f.verifiedCalls >= 6);
  f.credentials.delete('registered-fixture-a');
  await assert.rejects(a.callTool({name: 'browser_observe', arguments: {session_id: first.sessionId}}), /Authentication is required/);
  assert.equal(f.browserCloses, 1);
  assert.equal((await b.callTool({name: 'browser_observe', arguments: {session_id: second.sessionId}})).isError, undefined);
});

test('actual legacy HTTP MCP tools/list preserves supported metadata mirror without claiming linking UI', async t => {
  const f = await httpFixture(t), client = await f.connect('registered-fixture-a', {prior: {kind: 'legacy'}});
  assert.deepEqual((await client.listTools()).tools[0]._meta.securitySchemes,
    [{type: 'oauth2', scopes: ['browser:control']}]);
  assert.equal((await client.callTool({name: 'browser_open', arguments: {}})).isError, undefined);
});

test('actual HTTP scope denial advertises insufficient_scope and never opens a browser', async t => {
  const f = await httpFixture(t);
  f.credentials.set('registered-fixture-a', {...identity(f.resource), claims: {...claims(f.resource), scope: 'relay:read'}});
  const response = await fetch(f.url, {method: 'POST', headers: {'content-type': 'application/json',
    authorization: 'Bearer registered-fixture-a'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'})});
  assert.equal(response.status, 403); assert.match(response.headers.get('www-authenticate'), /insufficient_scope/);
  assert.equal(f.browserCloses, 0); assert.equal(f.verifiedCalls, 1);
});
