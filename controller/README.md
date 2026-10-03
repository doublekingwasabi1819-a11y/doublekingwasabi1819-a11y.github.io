# Relay browser controller

This package contains the browser controller, MCP/HTTP transport, constrained
Relay driver source and private host integration. It is not a live replacement
for TinyFish. No real worker credentials, public endpoint or ChatGPT plugin
connection are enabled by adding these files. The direct Relay API adapter
remains separate in draft PR #15; this package has no static dependency on it.

## Implemented source

- Six strict browser tools: open, observe, click, fill, screenshot and close.
  Fixture tool inputs contain no URLs, JavaScript, credentials, account selectors
  or filesystem/profile paths.
- Live host authorization before queued operations, after action approval, and
  before returning private results. Actions are serialized per worker; stale
  observations and uncertain mutations cannot be silently retried.
- Server-derived persistent profile paths, bounded observations/images, masked
  screenshots, normalized errors and teardown quarantine when process closure
  cannot be confirmed.
- Fixed local fixture driver using real Playwright DOM element handles, a visible
  cursor, isolated profiles and `chromiumSandbox: true`.
- MCP SDK v2 registration and optional host-invoked stdio transport. The
  Streamable HTTP host uses live authentication, stable per-principal contexts,
  exact host/origin checks, bounded requests and stateless JSON exchanges.
- Expiring/revocable host-issued MCP grants with a credential audience separate
  from Relay worker tokens, plus a masked browser viewer with authenticated
  image/action routes. The static viewer shell contains no account data.
- Read/navigation-only Relay driver source with exact static assets and backend
  read payloads allowlisted. It requires explicit browser delegation and live
  worker identity; no real credential is bundled.
- A combined Relay host that can register the five browser tools and five
  reviewed direct Relay tools through a host-injected adapter. Every result is
  checked against the grant's anchored worker/run before it reaches the client.
- An OAuth protected-resource adapter with discovery metadata, verified token
  policy and authentication challenges. It requires an external OAuth provider
  and explicit host integration; it is not an authorization server.
- A controller-only Docker recipe and CI workflow requiring the actual pinned
  Chromium fixture test on a supported non-root host. Neither deploys a service.

## Run checks

Use Node 20+ and the exact dependencies in `package-lock.json`. CI pins Node
24.19.0 and Playwright 1.62.1:

```sh
cd controller
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Unit/protocol checks use controlled fake drivers. The HTTP suite includes 18
tests, including a real local HTTP MCP client exchange; that does not launch
Chromium. The Relay driver's 27 source contract tests verify request policy,
identity binding, stale handles, screenshot masks and profile lifecycle without
logging in to Relay.

On a supported non-root Chromium host, require real browser execution:

```sh
npx --no-install playwright install --with-deps chromium
RELAY_REQUIRE_CHROMIUM=1 RELAY_TEST_ARTIFACTS=1 npm test
```

The normal local suite may skip the two real fixture tests when the pinned binary is
missing. With `RELAY_REQUIRE_CHROMIUM=1`, missing binaries fail. An installed
browser that cannot launch with its sandbox also fails. Do not disable the
sandbox or change this workspace's kernel/AppArmor/network policy as a fallback.

The foundation's [sandboxed Chromium CI run](https://github.com/doublekingwasabi1819-a11y/doublekingwasabi1819-a11y.github.io/actions/runs/37099102990)
passed all 161 tests with zero skips at commit
`9d08d94fdc461d4282d35d3f57ad5249321f61d3`. It exercised actual DOM actions,
the cursor, screenshot masking, persistent fixture profiles, HTTP/MCP, the
rendered viewer and revocation cleanup. The masked PNG was visually inspected.
This workspace itself lacks a usable pinned binary and required namespace
isolation. Changes after that foundation require their own exact-commit CI run.
Fixture artifacts are limited to a masked PNG and bounded
numeric timings; no cookies, tokens, profiles, real-site contents or comparative
performance claims are included. See [DEPLOYMENT.md](./DEPLOYMENT.md) for commands
and the host/access decision required before remote activation.

## Controller and authorization hooks

`createBrowserController({authorize, authorizeAction, createDriver})` accepts
trusted host hooks. Model tool arguments cannot supply or replace them.

- `authorize(requestContext)` resolves a fresh canonical
  `{workspaceId, accountId, agentId, runId}` worker binding. Never derive identity
  from model input, a saved credential snapshot, a default worker or a manager
  token. Each live scope/run check remains the host's responsibility.
- Keep the context object stable per authenticated principal/run. The controller
  uses previously verified contexts only to tear down their own revoked sessions;
  an unverified context cannot close another worker's session.
- `authorizeAction({name, arguments, binding}, requestContext)` must return `true`
  for a permitted mutation, including open/close. Missing hooks deny mutations.
  A fixture allowance is not consent to perform actions with a real account.
- `createDriver({binding})` supplies the host-owned driver. Observe, screenshot
  and viewer reads still require fresh authorization. The trusted
  `controller.snapshot(requestContext)` returns a masked image without exposing
  action target IDs or invalidating an agent's observation.
- Call `controller.shutdown()` during host teardown. Failed browser closure
  quarantines its profile; inspect/terminate the isolated process before allowing
  reuse. Do not clear a lock to bypass unconfirmed teardown.

Trusted authentication, approval, driver and route hooks need their own bounded
timeouts and cancellation. HTTP limits bound concurrent requests, not the time
an indefinitely hung callback can hold a slot or delay shutdown. Chromium
process supervision and an OS/container egress boundary remain host obligations.

## MCP and HTTP hosting

`createControllerMcp({controller, requestContext, target})` registers six fixture
tools by default. Trusted `target: 'relay'` uses Relay-specific descriptions,
open-world metadata and five tools; it omits fill. These schemas and annotations
are descriptions, not authentication. Each connection needs a host-resolved
context. `connectControllerStdio(options)` starts stdio only when the host
explicitly calls it.

`createControllerHttp({controller, authenticate, serverFactory, ...limits})`
creates an opt-in Streamable HTTP host. Nothing listens at import time.
`authenticate(Request)` verifies every request and returns
`{principalId, requestContext}`; a changed context for a cached principal is
rejected. `listen({host, port})` accepts loopback hosts only. Hostnames, browser
origins, endpoint, body size, request count, context count and idle transport TTL
are explicit server settings. No anonymous tool call or cross-origin fallback is
provided.

An optional trusted `serverFactory(requestContext)` can combine a reviewed direct
Relay adapter with correctly described browser tools. This package does not
import PR #15's files or obtain their credentials. Target metadata remains a
trusted host setting. Closing an HTTP transport does not close another
principal's browser; the runtime separately owns controller shutdown and
revocation.

## Private host, grants and viewer

`createPrivateBrowserHost({resolveBinding, authorizeAction, createDriver, target,
serverFactory, httpOptions, controllerOptions})` composes the controller, live
grant registry, HTTP transport and viewer. Importing it creates no listener,
account or grant. Supply `target: 'relay'` only with a reviewed Relay driver and
live browser-delegation resolver. Options cannot override the composed
authentication, controller authority or private viewer routes.

The host calls `issueGrant({requestContext, ttlMs, token})` only after its trusted
access decision. It returns `{grantId, token, expiresAt}`. The credential is
randomly generated unless the host supplies a distinct 32–128 character opaque
credential. The registry stores its digest and associates an immutable public
context with the host's private resolver context. It rechecks the live worker
binding on authentication and every controller operation. A changed run/binding,
expiry or `revokeGrant(grantId)` removes access and triggers browser teardown.
Default lifetime is one hour; the permitted range is one second to 24 hours.
Grants are in-memory and do not survive a host restart. They are not Relay tokens
or an OAuth/discovery provider.
The first accepted workspace/account/agent/run binding is fixed for that grant.
Revoked explicit credentials cannot be reissued in the same host; bounded digest
history permits 1,024 grant issuances by default. Failed teardown retains an
inactive grant and resource capacity until a revoke/close retry succeeds.

`/viewer` is a bounded static shell with no embedded credential, account identity
or screenshot. The user supplies their separate MCP connection token there;
it stays in page memory and is cleared on disconnect/page exit, not placed in a
URL or browser storage. `/viewer/snapshot` and `/viewer/open` require the same
fresh host authentication and worker binding as MCP. The former returns only a
masked PNG and preserves the agent's current observation; the latter invokes
the controller's ordinary approved open action. The viewer supplies no arbitrary
URL, target ID or cross-worker selector.

`createFixtureHost({profileRoot, token})` creates invented fixture identities and
a one-hour fixture grant. `node serve.mjs --fixture` starts only this explicit
fixture mode at `127.0.0.1`, using `RELAY_FIXTURE_MCP_TOKEN`,
`RELAY_BROWSER_PROFILES` and optional `RELAY_BROWSER_PORT` (default 8788). It
prints endpoint URLs without credentials. It does not start the Relay adapter.
The production host must invoke the API with its own reviewed hooks; no CLI
option grants real account access. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the
fixture commands and private host requirements.

## Combined Relay tools

`createRelayBrowserHost({profileRoot, resolveBinding, resolveWorkerSession,
authorizeAction, relayAdapter, ...limits})` composes the private host with the
fixed Relay browser driver. The optional injected adapter is
`{tools: relayTools, callTool: relayIntegration.callTool}` from reviewed PR #15.
Omitting it exposes only the five navigation/browser tools. Imports create no
listener, credentials or account delegation.

The direct tools cover identity, inbox, thread, send and mark-read. Their strict
schemas, owner-bound output validation and read/write scopes remain separate
from browser navigation. They receive the original host-owned grant reference,
never the incoming MCP bearer credential. The reference and its resolver must
remain bound to the same worker and run for their lifetime. Reauthorization
before and after calls discards results after revocation; ambiguous sends are
not retried automatically. The composition's HTTP/MCP tests use controlled
adapters, not real Relay accounts.

## OAuth protected-resource seam

`createOAuthResource({resource, issuers, verifyAccessToken, onRevoke, ...limits})`
provides an authenticator, `wrapFetch(next)`, RFC 9728 metadata, scope challenges
and tool authentication-error metadata. `resource` and issuer IDs must be exact
HTTPS URLs. The trusted verifier must cryptographically verify or securely
introspect tokens on every request; decoding JWT claims is insufficient. The
module bounds verification, checks issuer/audience/time/scopes and fixes each
principal to a frozen host-owned grant reference. It retains inactive records
when cleanup fails and requires a safe retry.

This adapter is not automatically wired into `createPrivateBrowserHost` or
`createRelayBrowserHost`, whose opaque-grant authentication is deliberately
fixed. Production composition still needs an explicit trusted mapping from
verified provider identity and scopes to host grants, the same live worker/run
authorization, and expiry/revocation cleanup. Never forward an incoming OAuth
token to Relay. Multiple grants for the same worker/run share its browser;
revocation can conservatively close that run. These tests do not prove separate
per-OAuth-grant browser isolation.

An external OAuth 2.1 provider must supply authorization, token exchange,
S256 PKCE, authorization-server discovery, client registration/metadata and
resource audience enforcement. The source supplies none of those flows. An
HTTPS front end must construct trusted request URLs without trusting arbitrary
forwarded headers. Provider and cleanup hooks need their own cancellation and
deadlines. A development tunnel still needs a persistent local host and an
approved connection; it does not supply an identity provider.

The pinned SDK's public tool configuration does not expose top-level
`securitySchemes`; `_meta.securitySchemes` is exercised on its modern and legacy
wire formats. Actual ChatGPT account linking and tool discovery must be verified
with a supported metadata path before claiming plugin compatibility. No private
SDK internals are patched. The resource tests use a controlled verifier and
trusted HTTPS URL mapping, not real token signatures, TLS or account linking.

## Fixture and Relay drivers

`createFixtureDriverFactory({profileRoot, headless})` is fixed to the bundled
fixture. It blocks external routes, sockets, downloads, service workers and
popups. `chromium` injection is reserved for trusted test harnesses.

`createRelayDriverFactory({profileRoot, resolveWorkerSession, headless})` is an
opt-in source adapter for the pinned Relay origin. The trusted
`resolveWorkerSession(binding)` must resolve fresh authorization and return:

```js
{
  binding: {workspaceId, accountId, agentId, runId},
  role: 'worker',
  enabled: true,
  token,
  expiresAt,
  scopes: ['browser:control']
}
```

The same live authority must back the controller's `authorize` hook. The driver
does not extract browser credentials or sign in by itself. Token rotation/run
changes require a new browser session. It clears old account authority before
seeding only the host-approved worker session at the exact Relay origin.

Only known navigation/refresh targets are advertised. DM text, identities and
private data are excluded from observations and masked in screenshots. Fill,
send, mark-read, updates and backend mutations are denied. Future message
actions need a recipient-resolved, payload-bound approval contract before use.
Exact request interception and CSP are defense in depth; they do not constrain
Chromium background traffic or make arbitrary browsing safe.

For either driver, prepare a fresh canonical absolute 0700 profile root owned by
the service user, with no untrusted writers or symlink ancestors. The driver does
not adopt or chmod an arbitrary existing directory. Use separate private storage
for real profiles; never import a human browser profile, cookies or session dump.
Review retention, revocation, resource limits and recovery across host restarts.

## Remaining proof and activation steps

1. Keep the required sandboxed Chromium checks passing on the exact reviewed
   commit; inspect the masked screenshot/cursor and restart isolation evidence.
2. Exercise the Relay source adapter against controlled Relay fixtures, then
   review live delegation/origin/action policy before any real account is used.
3. Provision private host/storage, process supervision, OS egress restrictions,
   authenticated viewer and host-hook deadlines. Choose the hostname, audience,
   TLS/authentication and any provider cost before activating remote access.
4. Configure an external OAuth provider and reviewed resource/host composition.
   Connect the approved HTTPS MCP endpoint or secure development tunnel in
   ChatGPT, inspect its tools and verify account linking and an actual invocation.
   Local SDK/HTTP tests do not prove a plugin is connected.
5. Benchmark the same tasks for correctness, latency, stale-state recovery and
   failure handling before comparing this controller with ChatGPT or TinyFish.

Official references: [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[Playwright Docker guidance](https://playwright.dev/docs/docker),
[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), and
[ChatGPT connection requirements](https://developers.openai.com/plugins/deploy/connect-chatgpt).
