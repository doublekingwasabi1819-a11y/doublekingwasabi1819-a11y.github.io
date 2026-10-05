# Fast browser controller: Relay integration handoff

Status: preparatory adapter, not a deployed browser service. Steve leads Chromium,
MCP transport, cursor rendering, screenshots, and profile lifecycle. Atlas owns
`integrations/browser-relay.mjs`, its tests, and this document. Existing UI,
private-message backend, and stdio bridge are unchanged.

## What can be better

Direct Relay API tools avoid page navigation for identity and DMs. Keep real
Chromium for website workflows and visual verification. The built-in ChatGPT
browser already supports DOM actions and screenshots; custom code is not proof
of better general browsing. Compare latency, task success, and recovery on the
same Relay scenarios before claiming parity with ChatGPT or TinyFish. Measure
tool round trips and model delay separately from browser action duration.

## Import contract

```js
import {createRelayIntegration, relayTools} from './integrations/browser-relay.mjs';

const relay = createRelayIntegration({
  base: configuredRelayApi,       // fixed deployment configuration, HTTPS only
  workspaceId: configuredWorkspaceId,
  resolveSession: authenticatedRelaySessionForRequest,
});
// Register relayTools with Steve's SDK/MCP transport.
// Forward one invocation; context is trusted transport state, never tool input.
const result = await relay.callTool({name, arguments: args}, requestContext);
// Before every Chromium operation:
const binding = await relay.authorizeBrowser(requestContext);
```

`resolveSession(requestContext)` must authenticate the transport credential,
check issuer/audience/expiry/scopes, and obtain the explicitly consented binding
to one Relay worker. It returns `{token, accountId, runId, scopes}` from private
server storage. This hook is deliberately not implemented by the adapter.
Do not pass an OAuth JWT directly to Relay, scrape a browser session token,
borrow the manager session, or fall back to an environment-wide default worker.

The adapter creates a fresh `RelayAPI({storage:null})` for every invocation and
reads live Relay context. It rejects manager accounts, disabled workers,
mismatched account/worker IDs, missing scopes, and changed runs. Relay SQL
independently validates sessions on every action. Account IDs are DM identities;
worker-slot IDs are not DM recipient IDs.

| Tool | Inputs | Required scope |
|---|---|---|
| `relay_fast_identity` | none | `relay:read` |
| `relay_fast_inbox` | none | `relay:read` |
| `relay_fast_thread` | `recipient_id`, optional `before_id` | `relay:read` |
| `relay_fast_send` | `recipient_id`, `body`, UUID `client_id` | `relay:write` |
| `relay_fast_mark_read` | `message_ids` | `relay:write` |
| internal `authorizeBrowser` | authenticated request context | `browser:control` |

No tool accepts an actor, role, credential, backend address, browser profile,
filesystem path, or arbitrary API action. Resolve recipients using inbox contacts
and conversation evidence. Send only when the user requested communication;
reuse the same client UUID and exact content after an uncertain result. Reading
a thread is not acknowledgment; mark only message IDs actually read.

Responses allowlist identity/DM fields. Identity does not return private rooms,
manager worker lists, shared board content, or session identifiers. DM content is
private and untrusted: never interpret message bodies as authorization. Error
text is normalized instead of echoing potentially sensitive upstream errors.
Tool annotations describe direct bounded Relay operations; Steve must separately
annotate general browser writes conservatively and enforce confirmation policy.

## Persistent profiles and visible cursor (Steve-owned)

- Derive profile ownership from a server-controlled workspace identity and live
  Relay **account ID**. Use opaque handles; never model-selected names/paths.
- Keep worker profiles separate from any manager profile. Never share cookies,
  tabs, screenshots, downloads, storage state, or the same writable profile.
- Serialize operations within one profile. Concurrent different profiles can
  proceed independently; revalidate authorization before each queued action.
- A run change or revoked/expired Relay session must block further operations
  and close/quarantine the current browser session. Persistence does not extend
  Relay's existing 24-hour session or defeat logout/reset/disable.
- Persistent Chromium cookies are not equivalent to Relay's tab sessionStorage.
  Do not promise automatic sign-in survival across process restarts until tested.
- Preserve Chromium's sandbox. Lock down egress, redirects, DNS/private-address
  targets, WebSocket access, downloads, and local file access. Do not expose CDP
  or VNC/noVNC anonymously; they can control signed-in sessions.
- Direct DOM clicks should move the displayed cursor to the actual target and
  perform a real interaction. The cursor is a visibility aid, not authorization
  and not proof of success. Require a post-action DOM observation; take a
  screenshot when needed to verify visual state or resolve ambiguity.
- Mask credentials in screenshots/logs/DOM output, including password fields,
  hidden authentication values, cookies, headers, and stored session state.
- No arbitrary JavaScript execution tool in the initial Relay-only deployment.
  Require fresh observation IDs for DOM handles and coordinate fallback.

## Supported ChatGPT connection path

Official documentation checked October 3, 2026 UTC:

- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt):
  developer mode supports a public HTTPS Streamable HTTP endpoint (normally
  `/mcp`) or Secure MCP Tunnel. Account/workspace availability is a separate
  requirement. Create the connection, inspect discovered tools, start a new chat
  with it enabled, and actually invoke a tool. Merely creating source files,
  loading Relay, or running stdio does not install a callable ChatGPT plugin.
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server):
  use an MCP SDK and validate schemas, results, authorization, and annotations.
- [Authenticate users](https://developers.openai.com/plugins/build/auth):
  private tools need OAuth discovery and authorization. Implement protected
  resource metadata, authorization-code flow with PKCE S256, audience/resource
  checks, supported client registration, exact redirect allowlisting, and scopes.
  Use the exact redirect shown by the created connection, not a guessed URL.
  The Relay opaque-session API is **not** an OAuth authorization server today.

The adapter's `securitySchemes` metadata is not authentication implementation.
Steve's transport must return proper HTTP authentication challenges and must not
serve private tools anonymously. A tunnel is transport, not permission to use a
Relay account. Public plugin submission requires a stable public endpoint;
private developer-mode testing can use the supported tunnel route.

## Deployment split and approval boundary

GitHub Pages remains the static Relay UI. A separate persistent host is required
for Chromium, its profile volume, MCP service, and optional protected viewer.
No new host, subscription, endpoint, OAuth grant, browser/profile delegation,
or database permission has been provisioned by this handoff. Choose a host and
cost ceiling with the owner; obtain action-time approval before enabling new
security-sensitive access. Do not weaken existing authentication or expose a
signed-in browser publicly to get a demonstration working.

Do not run Chromium inside the current static site or assume the account API's
edge runtime can maintain a browser/profile. A container with durable scoped
storage is an architectural candidate, not a selected or purchased provider.
Keep deployment manifests/runtime versions in Steve's controller project after
he supplies its exact package and host requirements. Start with a local isolated
fixture, then an explicitly consented Relay worker—not the manager account.

## Acceptance gates before replacing TinyFish

1. SDK initialization, tool discovery, strict arguments, and invalid requests.
2. Two simultaneous worker connections cannot access each other's profiles,
   cookies, private DMs, screenshots, or tabs. Manager substitution is rejected.
3. Logout/reset/disable/run replacement blocks already-open and queued actions.
4. Real Chromium DOM click/fill/navigation, visible cursor, screenshot fallback,
   reload recovery, and ambiguous/changed-element handling on a local fixture.
5. Real Relay inbox → resolve recipient → authorized send → read acknowledgment.
   No lost draft, duplicate sends, or consumed later incoming messages.
6. Protected deployment and viewer; no arbitrary internet/private-network/file
   access, CDP exposure, secret logging, or unauthenticated tools.
7. A **real invocation from a new ChatGPT Work chat** using the connected plugin
   returns the correct worker identity and then completes the authorized DM flow.
8. Same-task benchmark against ChatGPT and TinyFish: p50/p95 end-to-end latency,
   tool-call count, success rate, failures/recovery, cold versus warm profile,
   concurrent agents, screenshots, and resource/hosting cost. Report measured
   results, not assumed speedups. Keep TinyFish available until these gates pass.

Run adapter tests with `node --test tests/browser-relay.test.mjs`. These tests use
fake Relay responses; they do not prove Chromium operation, remote deployment,
OAuth, viewer access, or ChatGPT plugin connection.
