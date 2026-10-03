# Private browser controller: test and deployment preparation

This repository contains deployment source, not a deployed browser service.
The bundled fixture uses invented identities and no real account credentials.
Keep real Relay access disabled until the private host, authentication, approved
origins and per-worker scopes have been reviewed together.

## Reproduce the real browser test on a supported host

Use a dedicated Ubuntu 22.04/24.04 host with Node 24.19.0, a non-root service
user and working Chromium sandbox/user namespaces. The host must support those
protections already. Do not alter this workspace's kernel, AppArmor, network
policy, or sandbox settings to make the test pass.

Run as the non-root service user, from the controller source directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install playwright install --with-deps chromium
RELAY_REQUIRE_CHROMIUM=1 RELAY_TEST_ARTIFACTS=1 npm test
```

The installer may need the host administrator to provision system dependencies
in advance. Chromium itself and all test execution remain non-root. Installation,
missing binary, launch or sandbox failures are failures; no weaker fallback is
provided. `RELAY_REQUIRE_CHROMIUM=1` converts the local optional missing-binary
skip into a required test failure.

The new `browser-controller.yml` workflow performs those checks on a fresh
Ubuntu 22.04 runner using the lockfile. It accepts no repository secrets, keeps
the repository token read-only, and does not publish or deploy anything. Confirm
the run belongs to the exact reviewed commit. A successful run uploads only:

- `fixture-masked.png`: the fixed fixture with text inputs/secret regions masked.
- `fixture-timings.json`: bounded numeric fixture action timings; no account IDs,
  cookies, tokens, profile paths, screenshots from real sites or comparison claim.

Artifacts expire after three days. Do not broaden the upload to profiles,
browser traces, videos, logs, environment files, or arbitrary test output. These
timings are a smoke measurement, not proof of superiority over another browser.

The [foundation run](https://github.com/doublekingwasabi1819-a11y/doublekingwasabi1819-a11y.github.io/actions/runs/37099102990)
passed 161 tests with no skips at
`9d08d94fdc461d4282d35d3f57ad5249321f61d3`, including both real Chromium tests.
Later source changes require their own passing exact-head run. This verifies
controlled fixture behavior, not a deployed Relay browser or ChatGPT connection.

## Container fixture tests

The Dockerfile uses the official Playwright 1.62.1 Noble image, matching the npm
package exactly. It runs as `pwuser`, makes bundled browser binaries read-only,
and starts only `node --version` by default. Building it cannot activate a service.
The image is for controlled tests/development; Playwright does not recommend its
stock image for arbitrary untrusted websites.

On a separately provisioned supported Docker host:

```sh
docker build -t relay-controller-fixture:0.1.0 ./controller
```

For repeatable hosting, record and pin the verified base-image digest in the
host's deployment manifest. A version tag is not an immutable digest. The image
has not been built or run in the ChatGPT workspace.

Chromium sandboxing in Docker requires a host-reviewed seccomp profile allowing
its user namespace operations. Use the official Playwright profile from the
verified 1.62.1 release commit, review it on that host, and store it at the host's
private configuration path. Do not substitute `seccomp=unconfined`, privileged
mode, extra `SYS_ADMIN` capability, shared host IPC, or `--no-sandbox`.

After the host administrator approves that profile, run only our fixture tests:

```sh
docker run --rm --init --network none --user pwuser \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=/etc/relay/chromium-seccomp.json \
  --shm-size 1g --pids-limit 256 --memory 2g --cpus 2 \
  relay-controller-fixture:0.1.0 npm run test:chromium
```

This command publishes no ports and provides no network interface to external
sites. If this host cannot run the sandbox with those restrictions, stop and
choose a supported host; do not weaken the command. Persistent profile storage
must be a dedicated canonical 0700 directory owned by the service user. Never
mount a human browser profile or the Docker socket.

## Private fixture service

The explicit `serve.mjs --fixture` entry point is for local authenticated fixture
checks only. It binds to `127.0.0.1` and has no fixture CLI host override. Use a
fresh fixture bearer credential distinct from all Relay credentials and a fresh
private profile directory:

```sh
umask 077
relay_fixture_profiles="$(mktemp -d /tmp/relay-fixture-profiles.XXXXXXXX)"
relay_fixture_token="$(node --input-type=module -e 'import {randomBytes} from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')"
RELAY_FIXTURE_MCP_TOKEN="$relay_fixture_token" \
RELAY_BROWSER_PROFILES="$relay_fixture_profiles" \
RELAY_BROWSER_PORT=8788 node serve.mjs --fixture
```

The CLI rejects a missing/short `RELAY_FIXTURE_MCP_TOKEN`; it requires at least
32 characters. `RELAY_BROWSER_PROFILES` must name an existing private canonical
0700 directory owned by the same service user. `RELAY_BROWSER_PORT` defaults to
8788. Keep these values in a private process environment, not a credential-bearing
URL, source file or console output. No Docker port mapping or unauthenticated
remote browser endpoint is included here. Unset the temporary shell variables
and delete the fixture-only directory when the test is finished.

To test the MCP server over a private local connection, use the pinned MCP client
or an approved local development client. A successful HTTP/MCP test does not
prove ChatGPT has discovered and invoked the installed plugin.

## Before real Relay hosting

GitHub Pages cannot run persistent Chromium. This source needs a separately
provisioned persistent Linux service with a non-root Chromium sandbox, private
profile storage, process supervision and approved outbound access. The workflow
runner is temporary test infrastructure, not that service.

`relay-host.mjs` prepares the combined Relay/browser tools behind host-issued
opaque grants. `oauth-resource.mjs` prepares protected-resource metadata and
verified-token authentication but is not automatically connected to that host.
Use an external OAuth 2.1 provider with S256 PKCE, authorization-server discovery,
client registration/metadata and the exact MCP resource audience. A reviewed
host bridge must map verified identities/scopes to stable grants and share live
worker authorization and expiry/revocation cleanup across browser and direct
tools. Never pass OAuth bearer credentials to Relay. See README for the pinned
SDK's top-level tool-metadata limitation and required ChatGPT linking proof.

A secure MCP development tunnel is another endpoint option after a persistent
host exists. It requires an approved Platform/workspace association and private
tunnel credentials; it does not provision Chromium or OAuth. No tunnel is
created or connected by this repository.

The host must supply and review its trusted authorization hooks, consent/action
policy, approved Relay origin policy, worker profile isolation, revocation and
retention behavior, connection limits, timeout/teardown handling, and an
authenticated viewer. Keep credential-bearing pages and browser profiles out of
diagnostic artifacts. Use OS/container egress rules in addition to Playwright
request interception. Route handlers alone do not constrain Chromium background
traffic or grant safe access to arbitrary websites.

Choose the hostname, TLS termination, authenticated user/agent audience, allowed
site origins, profile retention, host/provider and any cost before enabling
remote access. That concrete deployment/access decision needs the owner's
approval. It is not implied by passing these source tests. Only after the
endpoint and authentication are ready should ChatGPT's plugin be connected and
an actual tool invocation verified. No public service, paid host, real worker
credential delegation, or ChatGPT plugin connection has been activated here.

## Verified official references

- [Playwright Docker guidance](https://playwright.dev/docs/docker)
- [Playwright 1.62.1 release](https://github.com/microsoft/playwright/releases/tag/v1.62.1)
- [Official seccomp profile at the 1.62.1 release commit](https://github.com/microsoft/playwright/blob/26a9e470a7b3c7822084b09fb7f13902c5f37b51/utils/docker/seccomp_profile.json)
- [Node 24.19.0 LTS release](https://github.com/nodejs/node/releases/tag/v24.19.0)
- [Checkout v7.0.1 commit](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)
- [Setup Node v7.0.0 commit](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020)
- [Upload Artifact v7.0.1 commit](https://github.com/actions/upload-artifact/commit/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a)
