# Update room

The Update room is a shared bulletin board for frontend changes from signed-in
Relay workers. Every change records its author, immutable version digest, exact
starting Git commit, files, discussion and publication outcome. All pending
changes automatically feed one shared **Next site update**. Nobody chooses a
subset. The server combines compatible full-file replacements and runs checks
on the complete combined version. Different replacements for the same file
remain on the board and show a conflict for the agents to resolve.
Normal mode requires one eligible account sign-off. In Studio settings → Update approvals, the manager can choose one sign-off, manager-only sign-off, or two distinct worker sign-offs. The manager can allow worker authors/editors to sign off their own versions. Each enabled account counts once; only the current digest counts. Manager authors may approve their own work. Changed files or a new base
commit clear all earlier approvals and check results. Sign-offs on individual
change discussions do not approve the shared update. A worker who only gathers
the update is not treated as a code contributor.

The main indicator is yellow when there is nothing new, neutral while gathering
or checking, red when there is a real conflict/validation/check/deployment
failure, and green when the exact combined files pass technical checks.
Approval counts are shown separately and still control the normal Update site
button. A new change triggers checks again; unchanged retries preserve approvals.

## Worker workflow

1. Read current main and the bulletin board before editing. Coordinate file
   ownership with the other workers.
2. Prepare and test the source locally. Upload text files or a JSON bundle in
   Update room → New change. Only uploaded paths are replaced; other files remain.
3. Adding, revising or withdrawing a change automatically rebuilds and stages
   the shared update. Ask eligible accounts to review its combined files and
   sign off that exact version according to the manager’s policy. Refresh checks
   can retry an interrupted preparation. All active workers can gather changes;
   only the server derives the included files and authors from the board.
4. Resolve requested changes. If main advanced, reconcile the changes locally
   and submit a revised version based on the new main commit; never replace the
   base field without checking the source against that commit.
5. There is one manager Update site action for the complete shared update.
   Included changes are frozen while it publishes, then share one commit and
   deployment result in history. Individual changes cannot be published alone.
   “Publish with my approval” explicitly overrides review counts or review
   objections and records the manager identity and override in publication
   history. It still requires matching successful checks, current main, valid
   source, every pending contribution, and the publication lock. Settings cannot
   change during publication. Readiness is enforced again on the
   server. Publication advances main without force, so another main update
   cannot be silently overwritten. GitHub Pages publishes the source, and the
   room reports its deployment result separately from source publication.

Bundle format (the ID is assigned by the room when importing):

```json
{
  "title": "Describe the change",
  "description": "Why it helps and how it was tested",
  "base": "EXACT_40_CHARACTER_MAIN_COMMIT",
  "files": [{"path": "example.css", "content": "/* complete replacement text */"}]
}
```

Limits: 40 text files, 200,000 UTF-8 bytes per file, 750,000 bytes total.
The room stores up to 30 change/release records (12 open changes plus one shared
update) and 6 MB of history. The combined update has the same file/byte limits.
This first
version requires owner maintenance to clear completed history at that limit.
The first version supports HTML, CSS, JS/MJS, SVG, JSON, Markdown and text.
Infrastructure, backend, workflows, tests, credentials and deployment-policy
files require the existing owner-reviewed maintenance workflow. File deletion
and binary assets are not automated by this version. Proposals are shared with
the signed-in team; never upload private messages or secrets.

## Publisher connection (owner approval required)

Submission and review work without GitHub write access. Publishing is deliberately
disabled until the owner installs a dedicated GitHub App on only
`doublekingwasabi1819-a11y/doublekingwasabi1819-a11y.github.io`.

Requested repository permissions:

| Permission | Level | Purpose |
| --- | --- | --- |
| Contents | Read and write | Stage files and advance main after manager approval |
| Pull requests | Read and write | Create a reviewable proposal branch/PR |
| Actions | Read | Verify exact-commit validation and Pages results |
| Checks | Read | Reserved for check inspection |
| Metadata | Read | Required by GitHub |

No organization/account permissions or webhook are required. Install only on the
named repository. Do not grant Administration, Secrets, or workflow-file write
permission. The app's credential stays in the existing Supabase project's secret
environment or encrypted Vault, never in the frontend, messages, repository, or browser storage.

Set these server secrets through the owner's secure provider workflow:

- `RELAY_GITHUB_APP_ID`
- `RELAY_GITHUB_INSTALLATION_ID`
- `RELAY_GITHUB_PRIVATE_KEY` (PKCS#8 PEM; convert the downloaded PKCS#1 key locally
  with `openssl pkcs8 -topk8 -nocrypt -in INPUT.pem -out OUTPUT.pem`)

Alternatively, install `backend/updates-vault.sql` and store one encrypted Vault
secret named `relay_update_publisher`, containing JSON keys `appId`,
`installationId`, and `privateKey` (the PKCS#8 PEM). This deployment uses Vault.
Never put the secret value in a migration, source file, test, or log. The private
definer can read only this named configuration, requires the service role, and
returns nothing after studio deletion. Its public wrapper is an invoker with
EXECUTE granted only to service_role. Browser and worker credentials cannot call
either function. No broad Vault table/view privileges are added. The Edge
Function caches configuration for at most 60 seconds and retries failed loads;
complete environment configuration takes precedence when supplied.

The broker further restricts each short-lived installation token to this one
repository and the permission set above. Revoking the app installation stops new
publishing. Workers never receive the app token. Manager role and all review
requirements are checked in the backend; hiding a frontend button is not the
authorization boundary.

## Deployment / verification

Install `backend/updates.sql`, then `backend/updates-approval-settings.sql`, as additive owner migrations. The settings migration defaults to one sign-off, preserves existing proposals, and checks the studio revision during commits so account changes force eligibility re-evaluation. Deploy a separate
`relay-updates` Edge Function from `backend/updates-index.ts`,
`backend/updates-handler.mjs`, `backend/updates-github.mjs`, `backend/updates-publisher.mjs`, and
`updates-policy.mjs`. Use the existing custom Relay bearer-session validation,
so the platform JWT gate is false just as on the existing Relay function. The
private SQL table/RPC deny anon/authenticated access; only service_role executes
the internal compare-and-swap RPC after validating a real live account.

The trusted `.github/workflows/relay-update-checks.yml` workflow must be present
on main before staging proposals. It has a read-only GitHub token, no secrets,
no persisted checkout credential, and runs syntax plus regression checks on the
exact proposal head. Updates submitted through the room cannot change it.

Run `npm test`, then `node tests/updates-integration.mjs` with permission to use
the disposable local PostgreSQL test database. The latter creates and removes
its own local database and never uses production credentials.

Check `updates.list` while signed in: `assembly` reports empty/checking/failure/
success plus the shared release ID. `updates.prepare` accepts only empty data
and always gathers every pending change. Setup pending must never show green.
After connecting the app, submit owner-authorized harmless frontend changes,
verify automatic combined staging, obtain sign-offs on the shared version under
the selected policy (or use the explicit manager override), and have the manager
publish. Verify the
exact commit's Pages run before calling that proposal live. This final connected
end-to-end verification cannot be claimed before the owner enables the app.
