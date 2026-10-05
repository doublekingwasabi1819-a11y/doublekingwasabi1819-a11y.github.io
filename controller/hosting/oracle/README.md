# Oracle Always Free hosting candidate

Status: preparation only. No Oracle account, instance, server, public endpoint or
ChatGPT connection has been activated. The Oracle console was inaccessible from
the current cloud browser on 2026-10-03; no signed-in tenancy was inspected.

This package prepares a native Ubuntu ARM fixture test without depending on an
unverified Docker ARM image manifest. The existing controller runtime stays at
reviewed commit `7d646385028ee44d2482d1c712fcd3836a5d0982` (244 passing tests on
the x86 Ubuntu CI runner). ARM execution still needs its own evidence.

## Instance settings

| Setting | Candidate |
| --- | --- |
| Provider | Oracle Cloud Infrastructure |
| Account plan | Always Free; do not upgrade to paid automatically |
| Region | Account's home region |
| Shape | `VM.Standard.A1.Flex`, marked Always Free eligible |
| CPU / memory | 2 OCPUs / 12 GB RAM |
| Image | Always Free eligible Ubuntu 24.04 ARM64 |
| Boot storage | 100 GB; verify total boot + block storage remains within 200 GB |
| Other free usage | Check existing instances consume none of the required CPU/RAM allowance |
| Initial inbound access | SSH restricted to the approved operator; no MCP/viewer port |
| Initial browser concurrency | At most 2 active sessions when the real host is composed |

Oracle currently lists 1,500 OCPU-hours and 9,000 GB-hours monthly for A1,
equivalent to 2 OCPUs and 12 GB RAM, plus 200 GB combined boot/block storage.
Confirm the current tenancy's eligibility and remaining allowances in the
console before creating anything. Trial credits must not substitute for an
Always Free label. If the shape has no capacity, stop or try another availability
domain in the same home region; do not silently select a paid shape or region.
Free idle instances can be reclaimed. Do not generate fake load to avoid this.

## Prepare and verify on the actual VM

Use a dedicated non-root `relay-browser` test/service user, with a private home
and profile directory (0700). Test in a writable, isolated copy of the controller,
without any real Relay environment variables, credentials or human profiles.
Keep runtime source root-owned and read-only for any later live service.

1. Provision the above instance and obtain a trusted operator connection.
2. Install the official Node **24.19.0 Linux ARM64** distribution. Verify its
   archive against the release's published SHA256 sums/signature. Do not use an
   unpinned third-party installation script or Ubuntu's different default Node.
3. Copy the reviewed controller plus this preparation directory to the test copy.
4. As the non-root test user, run `npm ci --ignore-scripts --no-audit --no-fund`
   from that controller directory.
5. The host administrator installs the pinned Playwright Chromium system
   dependencies from a separate administrator-owned, read-only copy of the
   verified source and locked npm dependencies. Use the absolute reviewed Node
   executable with that copy's `node_modules/playwright/cli.js install-deps
   chromium`; this apt step needs administrator rights. Do not execute root code
   from the service-user-writable test tree. Browser installation and tests
   remain non-root.
6. Run the preparation script as the non-root test user:

   ```sh
   bash hosting/oracle/prepare.sh --plan
   bash hosting/oracle/prepare.sh --prepare
   ```

The script checks Ubuntu/ARM/Node/root identity and all original controller
source hashes before locked package and browser installation. It uses the pinned
official Playwright binary and requires the real Chromium tests to run.
An OS, download, missing dependency, sandbox or test failure stops preparation.
It requires a complete TAP summary with exactly 244 passes and zero failures,
cancellations, skips or todos. Its private temporary TAP file is removed on exit.
Do not weaken sandbox, AppArmor, user namespace or network protections to pass.
Inspect the TAP result and require **zero skipped tests**, with the exact source
hashes and VM image recorded. Keep only the fixed masked fixture PNG and bounded
timings as evidence, never profiles, cookies, tokens, arbitrary logs or traces.

## Turn the tested VM into a real Relay host

Passing tests supplies the browser runtime. It does not create a production
service. The fixture CLI binds to loopback and exposes fixture tools only; do
not reverse proxy it as the real Relay endpoint.

Use `createRelayBrowserHost` with reviewed live worker binding, action policy,
delegated session resolver and Relay adapter. Set `controllerOptions.maxSessions`
to 2 initially and `httpOptions.maxRequests` to 8 (also configure the OAuth
bridge's separate `maxRequests` as 8 if used); measure real usage
before increasing those limits. Use a canonical, service-user-owned 0700 profile
root with retention and disk monitoring. Server-issued grants remain memory-only
and must be freshly issued after process restart.

The real service still needs trusted OAuth verification, stable principal/worker
mapping, delegated account authorization, revocation, approved origins, OS-level
egress controls, a hostname/TLS front end, private viewer access and supervised
non-root process limits. Review these concrete settings before enabling public
access. Oracle credentials and SSH private keys must stay out of repository code
and the frontend. GitHub Pages continues to host the Relay site separately.
Actual ChatGPT account linking and an MCP tool invocation must be verified after
the endpoint is live. See [the existing deployment contract](../../DEPLOYMENT.md).

## Official references

- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle instance creation](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm)
- [Node 24.19.0 release](https://nodejs.org/dist/v24.19.0/)
- [Playwright supported operating systems](https://playwright.dev/docs/intro)
- [Playwright browser and dependency installation](https://playwright.dev/docs/browsers)
