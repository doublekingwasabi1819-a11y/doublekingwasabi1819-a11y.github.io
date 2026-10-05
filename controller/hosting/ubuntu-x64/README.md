# Ubuntu 22.04 x64 preparation

This package prepares and verifies the browser controller on an **already
provisioned Ubuntu 22.04 x86_64 host**. It is suitable for the proposed host
architecture; it does not purchase/create a VPS, connect to a provider account,
configure live Relay access, start a persistent service or publish an endpoint.
The earlier Oracle ARM preparation files remain separate and unchanged.

The runtime checksum manifest pins the reviewed controller source present at
PR #16 head `b80b0629e19e4b6ea017f7661d31a96cbe933401`. Obtain the whole package
through the owner's reviewed repository connection and verify that exact source
before executing scripts. Checksums detect accidental changes; a manifest from
an untrusted download is not an independent authenticity check.

## Host prerequisites

- Confirm the actual VM exists, runs Ubuntu **22.04 x86_64**, and is reachable
  through an approved operator connection. Provider account signup alone is
  not a running VM. Verify a remote host's identity before using the connection.
- Use a dedicated non-root `relay-browser` test/service user with a private 0700
  home/profile area. Keep an isolated writable test copy without real Relay,
  OAuth, tunnel or other account credentials and without human browser profiles.
- An administrator installs the official **Node 24.19.0 Linux x64** distribution
  and verifies its archive against the release's published SHA256 sums/signature.
  Keep that installation administrator-owned and outside service-writable paths.
  Do not use an unpinned third-party installation script or Ubuntu's different
  default Node package. Use the verified Node/npm installation in the test PATH.
- Chromium sandbox/user namespaces must already work for the non-root user.
  A failed sandbox test is a blocker. Do not disable the sandbox, relax
  AppArmor/kernel settings or change firewall/network protections to pass.

The administrator separately installs pinned Playwright Chromium system
dependencies from an administrator-owned, read-only copy of the verified source
and locked packages. Use that copy's absolute verified Node executable and
`node_modules/playwright/cli.js install-deps chromium`. This apt step requires
administrator rights. Do not run root code from the service-user-writable test
tree. Browser download and all tests remain non-root.

## Prepare the controlled fixture runtime

Copy the complete reviewed controller directory, including this preparation
package, into the non-root test area. From that controller directory:

```sh
bash hosting/ubuntu-x64/prepare.sh --plan
bash hosting/ubuntu-x64/prepare.sh --prepare
```

`--plan` prints prerequisites and intended work only. It performs no installation
or host checks and is safe to inspect before a VM is available. `--prepare`:

1. Rejects root, wrong OS/architecture/Node and known credential, interpreter,
   package-manager or Playwright download override environments.
2. Verifies every pinned runtime/test file with the checksum manifest and rejects
   additional or missing test files.
3. Runs locked `npm ci` with lifecycle scripts disabled, then the pinned official
   Playwright CLI's Chromium installer.
4. Runs all reviewed tests with `RELAY_REQUIRE_CHROMIUM=1` and
   `RELAY_TEST_ARTIFACTS=1`; an absent browser cannot be treated as a skipped pass.
5. Requires the complete TAP summary: **244 tests/pass, zero failures,
   cancellations, skips or todos**. The private temporary TAP file is removed
   when the script exits.

Download, system dependency, browser launch, sandbox and test failures stop the
script. Do not change the required test count or manifest to accept a failed
run. A reviewed runtime update needs a newly reviewed manifest and gate. Tests
may create temporary loopback-only fixture listeners and disposable test
profiles; they do not create a persistent/public service or contact real Relay
accounts.

Record the reviewed commit, actual VM OS/architecture and complete zero-skip
result. Inspect the fixed masked fixture PNG. Keep only that image and bounded
fixture timings as shareable evidence; never upload profiles, cookies, tokens,
real-site screenshots, arbitrary logs, traces or environment files.

## After preparation passes

Passing preparation proves this host can execute the controlled browser tests.
The only supplied executable server CLI is still
`node serve.mjs --fixture`: invented identities, loopback-only fixture tools.
Do not reverse proxy that CLI as a real Relay browser endpoint.

Real Relay startup requires an explicit host module calling
`createRelayBrowserHost` with reviewed live binding, delegated worker-session
resolver and action policy. Inject the reviewed PR #15 adapter separately if
direct Relay DM tools are enabled. Start with `controllerOptions.maxSessions: 2`
and `httpOptions.maxRequests: 8`, then measure actual CPU/RAM and session use.
Use an owned canonical 0700 profile root, disk/retention monitoring, non-root
process supervision and OS egress restrictions.

Authenticated ChatGPT use also requires a reviewed OAuth provider/verifier and
stable scope-limited worker mapping, plus an approved HTTPS front end or secure
development tunnel. The OAuth bridge is source composition, not an identity
provider or automatic server listener. Private viewer authentication remains
separate. Configure scope intersection, expiry/revocation and bounded cleanup;
never forward incoming OAuth credentials to Relay.

Choose and review the hostname, TLS, permitted audience/origins, remote access
and any provider cost before activation. Account creation, VM ordering and
operator access are not provided by this package. Follow the existing
[deployment contract](../../DEPLOYMENT.md), then verify actual ChatGPT linking
and a tool invocation before calling the browser live.

## Official installation references

- [Node 24.19.0 release files and checksums](https://nodejs.org/dist/v24.19.0/)
- [Playwright browser and system dependency installation](https://playwright.dev/docs/browsers)
- [Playwright supported operating systems](https://playwright.dev/docs/intro)
