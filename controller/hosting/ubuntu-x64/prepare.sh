#!/usr/bin/env bash
# Native x64 fixture preparation. No cloud provisioning or live account setup.
set -euo pipefail
umask 077

relay_plan() {
  cat <<'PLAN'
Preparation target: Ubuntu 22.04 x86_64, dedicated non-root test/service user.
Require trusted operator access to an already provisioned VM; no provider API is used.
Prerequisite: verified official Node 24.19.0 Linux x64, administrator-owned installation.
Prerequisite: administrator-installed pinned Playwright Chromium system dependencies.
Use an isolated writable controller test copy with no real credentials or human profiles.
Verify pinned source hashes, install locked npm packages, then official pinned Chromium.
Require a complete 244-pass TAP summary with zero failures, cancellations, skips or todos.
Tests may create temporary loopback-only fixture listeners and disposable profiles.
No persistent service, public listener, firewall/security change, OAuth setup or Relay delegation.
PLAN
}

if [[ ${1:-} == --plan && $# == 1 ]]; then relay_plan; exit 0; fi
if [[ ${1:-} != --prepare || $# != 1 ]]; then
  printf 'Usage: bash prepare.sh --plan | --prepare\n' >&2
  exit 2
fi

relay_fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $(id -u) != 0 ]] || relay_fail 'Run preparation as the dedicated non-root test user.'
[[ $(uname -m) == x86_64 ]] || relay_fail 'This preparation requires an x86_64 host.'
[[ -r /etc/os-release ]] || relay_fail 'OS identity is unavailable.'
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 22.04 ]] || relay_fail 'Use Ubuntu 22.04 x86_64.'

# Real credentials are not needed for fixture preparation. Reject known host
# credential environments and interpreter overrides rather than inheriting them.
while IFS= read -r relay_env_name; do
  case "$relay_env_name" in
    RELAY_REQUIRE_CHROMIUM|RELAY_TEST_ARTIFACTS) ;;
    RELAY_*|OPENAI_*|SUPABASE_*|CONTROL_PLANE_API_KEY|NODE_OPTIONS|NODE_PATH|PLAYWRIGHT_*|NPM_CONFIG_*|npm_config_*)
      relay_fail 'Use a clean fixture-test environment without account credentials or interpreter overrides.' ;;
  esac
done < <(compgen -e)

command -v node >/dev/null || relay_fail 'Install verified official Node 24.19.0 Linux x64 first.'
[[ $(node --version) == v24.19.0 ]] || relay_fail 'Use the reviewed Node 24.19.0 version.'
node -e 'if(process.arch !== "x64" || process.platform !== "linux") process.exit(1)'

relay_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
relay_controller_dir=$(cd -- "$relay_script_dir/../.." && pwd -P)
cd -- "$relay_controller_dir"
[[ -f package-lock.json && -f tests/chromium.test.mjs ]] || relay_fail 'Reviewed controller source is missing.'
sha256sum --check --strict "$relay_script_dir/controller-sha256.txt"

# Require exactly the reviewed tests. Do not execute an extra unreviewed test
# merely because it appeared in a writable tree before preparation.
mapfile -t relay_reviewed_tests < <(awk '$2 ~ /^tests\/[^/]+\.test\.mjs$/ {print $2}' "$relay_script_dir/controller-sha256.txt")
relay_present_tests=(tests/*.test.mjs)
[[ ${#relay_reviewed_tests[@]} == 14 && ${#relay_present_tests[@]} == 14 ]] || relay_fail 'The reviewed test inventory changed.'
for relay_test_file in "${relay_present_tests[@]}"; do
  relay_known_test=false
  for relay_reviewed_file in "${relay_reviewed_tests[@]}"; do
    if [[ $relay_test_file == "$relay_reviewed_file" ]]; then relay_known_test=true; break; fi
  done
  [[ $relay_known_test == true ]] || relay_fail 'The reviewed test inventory changed.'
done

# System dependencies must already be installed by the host administrator from
# a separate administrator-owned reviewed tree. Never sudo service-writable code.
# npm lifecycle scripts remain disabled; this pinned CLI installs only Chromium.
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/playwright/cli.js install chromium
relay_test_log=$(mktemp)
trap 'rm -f -- "$relay_test_log"' EXIT
RELAY_REQUIRE_CHROMIUM=1 RELAY_TEST_ARTIFACTS=1 node --test --test-reporter=tap "${relay_reviewed_tests[@]}" | tee "$relay_test_log"
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
printf '%s\n' 'Ubuntu x64 controlled-fixture verification passed: 244 tests, zero failures or skips.'
printf '%s\n' 'No persistent browser service, real Relay delegation, OAuth provider or public endpoint was configured.'
