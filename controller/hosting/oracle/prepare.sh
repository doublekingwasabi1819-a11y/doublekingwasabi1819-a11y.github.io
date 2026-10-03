#!/usr/bin/env bash
# Native ARM fixture preparation. No listener, cloud API or account delegation.
set -euo pipefail
umask 077

relay_plan() {
  cat <<'PLAN'
Oracle candidate: VM.Standard.A1.Flex, 2 OCPUs, 12 GB RAM, 100 GB boot disk.
Require Always Free eligibility and home-region unused allowances before creation.
OS: Ubuntu 24.04 ARM64. Node: official 24.19.0 ARM64 distribution.
Run as a dedicated non-root user in an isolated copy of the reviewed controller.
Verify source hashes; install locked npm dependencies and official Chromium.
Require all controller tests, including Chromium sandbox tests; accept zero skips.
No OCI provisioning, public listener, firewall change, service or credential setup.
PLAN
}

if [[ ${1:-} == --plan && $# == 1 ]]; then relay_plan; exit 0; fi
if [[ ${1:-} != --prepare || $# != 1 ]]; then
  printf 'Usage: bash prepare.sh --plan | --prepare\n' >&2
  exit 2
fi

relay_fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $(id -u) != 0 ]] || relay_fail 'Run preparation as the dedicated non-root test user.'
[[ $(uname -m) == aarch64 ]] || relay_fail 'This preparation requires an ARM64 host.'
[[ -r /etc/os-release ]] || relay_fail 'OS identity is unavailable.'
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || relay_fail 'Use Ubuntu 24.04 ARM64.'
command -v node >/dev/null || relay_fail 'Install official Node 24.19.0 ARM64 first.'
[[ $(node --version) == v24.19.0 ]] || relay_fail 'Use the reviewed Node 24.19.0 version.'
node -e 'if(process.arch !== "arm64" || process.platform !== "linux") process.exit(1)'

relay_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
relay_controller_dir=$(cd -- "$relay_script_dir/../.." && pwd -P)
cd -- "$relay_controller_dir"
[[ -f package-lock.json && -f tests/chromium.test.mjs ]] || relay_fail 'Reviewed controller source is missing.'
sha256sum --check --strict "$relay_script_dir/controller-sha256.txt"

# The dedicated host administrator installs system dependencies beforehand.
# npm lifecycle scripts stay disabled. Chromium is installed by the pinned CLI.
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install playwright install chromium
relay_test_log=$(mktemp)
trap 'rm -f -- "$relay_test_log"' EXIT
RELAY_REQUIRE_CHROMIUM=1 RELAY_TEST_ARTIFACTS=1 node --test --test-reporter=tap tests/*.test.mjs | tee "$relay_test_log"
# Require a complete final summary, not only a successful command exit.
awk -v expected=244 '
  /^# (tests|pass|fail|cancelled|skipped|todo) [0-9]+$/ {
    if (++seen[$2] != 1) bad=1
    count[$2]=$3
  }
  END {
    split("tests pass fail cancelled skipped todo", names, " ")
    for (i in names) if (seen[names[i]] != 1) bad=1
    if (count["tests"] != expected || count["pass"] != expected ||
        count["fail"] != 0 || count["cancelled"] != 0 ||
        count["skipped"] != 0 || count["todo"] != 0) bad=1
    if (bad) { print "Required complete 244-pass/zero-skip TAP summary is missing." > "/dev/stderr"; exit 1 }
  }
' "$relay_test_log"
printf '%s\n' 'ARM controlled-fixture verification passed: 244 tests, zero failures or skips.'
printf '%s\n' 'This did not start Relay, OAuth, an MCP listener or a browser service.'
