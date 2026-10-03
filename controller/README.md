# Relay browser controller — isolated prototype

This is **not a live replacement for TinyFish**. It adds a fixture-only Chromium
driver, a worker-isolated controller, and an MCP SDK adapter. Nothing starts
automatically, no real accounts are imported, and the Relay website is unchanged.
The direct Relay API adapter remains separate in draft PR #15.

## What exists

- Six strict tools: open, observe, click, fill, screenshot and close.
- Host-authenticated workspace/account/agent/run binding; live authorization
  before queued operations and after approval hooks. No model-selected identity.
- Serialized actions per worker, stale observation rejection, bounded output,
  secret-free normalized errors and no automatic retry of uncertain mutations.
- Persistent profiles derived from trusted workspace/account identity, not tool
  input. The prototype persists **fixture data only**, never a Relay login.
- Playwright persistent Chromium context with sandbox enabled. DOM actions use
  actual element handles; the fixture draws a visible cursor at mouse movement.
- Screenshot image blocks, with input and secret fixture regions masked.
- MCP v2 server factory, strict schemas and linked-client protocol tests.
  Optional stdio transport is explicitly host-invoked. No public HTTP server,
  OAuth service, ChatGPT plugin connection or viewer is deployed.

## Run checks

Requires Node 20+ and the exact dependencies in `package-lock.json`:

```sh
cd controller
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:chromium
```

The real-browser test reports **SKIP** when the pinned Chromium binary is absent.
An installed binary that cannot launch with its sandbox makes that test fail;
do not “fix” this by disabling sandbox protections. Use a dedicated non-root,
network-isolated host with Chromium sandbox support. Package tests with fake
drivers verify contracts, not actual browser performance or screenshot pixels.

In this workspace, the official Chromium installer returned truncated archives.
The real-browser test has therefore not run successfully. Do not claim this
controller is faster, more reliable, or equivalent to ChatGPT/TinyFish yet.

## Trusted host integration

`createBrowserController({authorize, authorizeAction, createDriver})` accepts
server-owned hooks. A tool call cannot supply these hooks, a URL, JavaScript,
credentials, an account identifier, a profile path or a filesystem selector.

- `authorize(requestContext)` must resolve a fresh live worker binding. When
  integrating Relay, connect the reviewed Relay adapter's `authorizeBrowser`
  hook and preserve the requested account/run scopes. Never use a default worker
  or manager credential.
- Keep the host context object stable per authenticated principal/connection.
  This permits teardown on later revocation without trusting a model's session
  ID. A revoked unknown context cannot close another worker's browser.
- `authorizeAction({name, arguments, binding}, requestContext)` must explicitly
  return `true` for a permitted mutation, including opening/closing a session.
  It denies by default. The fixture tests use an explicit fixture-only allowance;
  that is not production approval. Reads still require live authorization.
- `createFixtureDriverFactory({profileRoot, headless})` is fixed to the bundled
  fixture. Prepare a **fresh** canonical, host-owned 0700 absolute directory with
  no untrusted writers or symlink ancestors; the driver never changes an existing
  directory's permissions. Do not point it at a human browser
  profile. `chromium` injection is for trusted test harnesses only.
- `createControllerMcp({controller, requestContext})` registers six tools. Each
  authenticated connection needs its own host-resolved context. The MCP adapter
  catches unexpected exceptions; tool annotations are not authorization.
- Call `controller.shutdown()` during host shutdown/revocation lifecycle.
  If Chromium teardown fails, that factory quarantines the profile instead of
  allowing reuse. The host must inspect/terminate its isolated browser process
  before rebuilding a factory; never erase the lock to skip failed teardown.

Route interception denies everything except the fixed fixture document;
WebSockets, downloads, popups, dialogs and service workers are constrained.
This is defense in depth, **not an OS egress policy**. Chromium background traffic,
filesystem schemes and persistent state require a dedicated container/network
boundary before production. This driver must not be enabled for arbitrary sites.

## Remaining production gates

1. Run the real Chromium fixture suite on a supported sandboxed host, inspect
   screenshot masking/cursor visually, and test isolation across restart.
2. Review a real Relay browser driver with narrow origin/action policy, redirect
   and subresource enforcement, sensitive-action approval, and credential-safe
   observation. The current fixture driver cannot navigate to Relay.
3. Provision private persistent storage, retention/revocation, OS isolation,
   resource limits, logs that exclude secrets, and an authenticated viewer.
4. Implement/review OAuth or equivalent per-connection authentication plus
   HTTPS Streamable HTTP MCP (or an approved secure development tunnel).
   Deploying that endpoint or granting account/session delegation needs an
   explicit access decision; it is not done by adding these source files.
5. Connect the plugin in ChatGPT, inspect its tool list, and verify an actual
   ChatGPT tool invocation. Passing an in-memory SDK test is not that proof.
6. Benchmark the same fixture/Relay tasks for correctness, latency and recovery
   before deciding whether this improves on the current browser options.

Official references: [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), and
[ChatGPT connection requirements](https://developers.openai.com/plugins/deploy/connect-chatgpt).
