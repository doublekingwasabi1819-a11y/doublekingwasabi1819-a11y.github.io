# Task controls: backend rollout and rollback

## Current status and scope

Prepared and tested locally on 2026-10-05. No production database, Edge Function,
or website was changed. Publishing source to GitHub alone does not update this
backend.

The source baseline is repository main commit
`56c47abe01d807a52cde82ebc46d7038ae36cdcb`. Live function definitions and provider
configuration have **not** been assumed to match that commit. Verify the actual
target before applying anything.

The backend consists of:

- `engine.mjs`: task permissions, multiple assignments, task versions,
  soft-deletion/restoration, and legacy single-owner compatibility.
- `backend/handler.mjs`: authenticated public task-operation dispatch, request
  boundaries, and retry of board compare-and-swap conflicts.
- `backend/index.ts` and `backend/deno.json`: the existing Edge entrypoint and
  runtime configuration.
- `backend/task-controls-rollout.sql`: a focused, guarded update to the existing
  account RPC and its new private task-lifecycle helper.
- `backend/task-controls-rollback.sql`: a guarded rollback for the period before
  new-format tasks have been written.

Do **not** reinstall all of `schema.sql` to update a populated studio. It is the
reference fresh-install schema and local test fixture. The focused rollout does
not modify tables, rows, passwords, accounts, sessions, setup state, RLS, or
existing RPC grants. It changes only the two account-lifecycle task statements,
their explanatory comment, the authenticated context fields described below,
and the new private helper.

## 1. Before an authorized deployment

1. Verify the intended Supabase project and existing `relay` function. The
   checked-in API URL is configuration evidence, not proof of deployment state.
   Preserve the current function files, deployed version metadata, environment
   configuration names, and exact SQL function definitions for rollback. Use
   the provider's protected backup mechanism for database data; never commit
   database dumps, session tokens, or credentials to the public repository.
2. Confirm a recoverable database backup and a tested restore procedure. Do not
   export secrets into screenshots, chat messages, shell history, or this file.
3. Arrange a short maintenance window in which clients and workers stop writing.
   A single-function deploy is versioned, but database, Edge, and frontend
   publication are separate steps. Do not let clients write between incompatible
   releases. Existing open browser tabs need to reload the new frontend.
4. Run the local unit/handler tests and the SQL suite below. In a disposable
   native PostgreSQL environment, also run the existing SQL integration suite;
   it covers independent setup transactions that PGlite cannot establish.
5. Inspect the existing database as its owner with these **read-only** queries:

```sql
select n.nspname, p.proname, md5(p.prosrc) as body_hash,
       p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.oid=to_regprocedure('public.relay_rpc(text,text,jsonb)')
   or p.oid=to_regprocedure('relay_private.update_task_worker(jsonb,text,text,timestamptz)');

select n.nspname, c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='relay_private' and c.relkind='r';
```

Expected baseline RPC body hash: `6f6381892da4da201900f74e7fd6b8fb`.
The new RPC body hash is `a1828d6823d03c92c15e96e5460f6ee0`.
The earlier prepared task-controls hash `48f80463867e20075a3f13fc5b641eb7`
is also accepted as an exact upgrade/rollback source.
These hashes identify source compatibility; they are not cryptographic integrity
or authorization proofs. The RPC must be `SECURITY INVOKER`, use
`search_path=pg_catalog`, deny `anon`/`authenticated`, and allow `service_role`.
All private tables must retain RLS. Keep `relay_private` outside exposed API
schemas. Run the provider's security advisors and resolve unexpected findings.

If the baseline differs, stop. Inspect and reconcile the real function in a
separate local proposal. Do not remove the guards or overwrite unrelated deployed
function changes with the full reference schema.

## 2. Apply the compatible SQL update

With approval for the confirmed target database, run the entire
`backend/task-controls-rollout.sql` file as the database owner in one execution.
It contains its own `BEGIN`/`COMMIT` and takes the studio row lock. It validates
the function body, invoker/search-path settings, and access rights before
changing anything. An error aborts the transaction; explicitly `ROLLBACK` an
open failed transaction before doing anything else in the same SQL session.

The authenticated SQL context now returns `manager: {name: string}` and
`capabilities: {taskLifecycleV1: true}` for both manager and worker sessions.
The manager object exposes only the display name: no account ID, login, recovery
information, password hash, or session token. Workers still receive an empty
`workers` list; existing account, private-room, and authorization rules remain
unchanged. SQL does not advertise `taskControlsV1`: the matching Edge handler
adds that capability only when it sees `taskLifecycleV1: true`. The frontend
requires `taskControlsV1: true`, so updating only SQL or only Edge cannot enable
controls prematurely. Baseline SQL has neither capability. The Edge handler
also rejects every `task.*` operation with HTTP 503 / `BACKEND_NOT_READY` when
SQL lacks verified lifecycle support, before any board write, and checks again
on compare-and-swap retries. This cannot be enabled by request payload fields.

Reapplying the unchanged rollout is supported. It preserves existing RPC grants
and makes the helper executable only by `service_role`. No new public RPC or
end-user schema access is introduced.

Repeat the read-only verification query. Expect the new RPC hash above and
helper body hash `0a35847000b1587329990102943670df`, with both functions invoker
and restricted as described. Confirm no unexpected account/board changes before
reopening writes.

## 3. Deploy the matching Edge bundle

With deployment approval, deploy these exact paths together to the existing
`relay` function, retaining their relative import structure:

```text
engine.mjs
backend/index.ts
backend/handler.mjs
backend/deno.json
```

For the Supabase deployment tool, use entrypoint `backend/index.ts` and include
all four files. Preserve existing `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` server-side configuration. There are no new secrets
or OAuth permissions for this feature. Never include the service-role key in
frontend configuration or the upload's source text.

Preserve Relay's established custom authentication: the gateway JWT verification
setting is `false` for this function because Relay uses opaque application
sessions. The handler plus SQL independently validate every protected request.
Do not disable authentication checks inside either layer. Verify the current
function configuration before deployment rather than changing unrelated settings.

Keep the approved production origins unchanged. If using the CLI instead of the
deployment tool, inspect the installed CLI's `--help` and project configuration
first; the CLI is not installed in this test environment, so no local CLI deploy
has been claimed. Follow the provider's current
[deployment](https://supabase.com/docs/guides/functions/deploy),
[function configuration](https://supabase.com/docs/guides/functions/function-configuration),
and [environment variable](https://supabase.com/docs/guides/functions/secrets)
documentation.

Only after the SQL and Edge versions are compatible should the matching frontend
be published and clients reloaded. The updated backend still accepts omitted
task versions on legacy single-assignee worker operations. Multi-assignee
mutations require current versions, so older clients must refresh.

## 4. Verify before reporting it live

First use a disposable staging studio with separate test accounts. Through the
deployed handler, verify:

1. Manager creates one task assigned to two workers, edits it, and both workers
   see the same persisted task after refresh.
2. The secondary worker reports progress. An unrelated worker cannot modify it;
   neither assignee can independently approve their own work. Worker attempts
   to assign, edit, delete, or restore are rejected.
3. Two edits from the same version yield one accepted edit and one conflict.
   A concurrent unrelated board write is retried without duplicate task changes.
4. Delete hides the task; restore preserves assignment, progress, evidence, and
   linked messages. Retrying the same operation ID does not duplicate writes.
5. Resetting a worker rotates every matching unfinished assignment, including
   secondary/soft-deleted ones, and invalidates old login sessions. Deleting a
   worker removes only their unfinished assignments and promotes the first
   survivor. Completed assignment snapshots remain unchanged.
6. Both manager and worker contexts show the authenticated manager display name
   without account secrets; full task controls appear only when both SQL and Edge
   capability checks pass.
7. Anonymous protected requests fail, unauthenticated database RPC access fails,
   private rooms stay isolated, and normal login/context/message reads still
   work. Review function logs for errors without exposing credentials.

Then perform only approved, non-destructive production checks and inspect the
exact deployed function version, SQL hashes, frontend deployment, and origins.
Do not create test accounts, reset passwords, or delete real workers/tasks in
production merely to finish a smoke test. Keep the maintenance window until
the approved acceptance checks pass or a safe rollback decision is made.

## Rollback decision

- **Before new-format data is written:** while writes remain stopped, restore
  the previously saved frontend and Edge versions, then run the complete
  `backend/task-controls-rollback.sql` as database owner. It validates known
  function definitions, restores the exact baseline RPC, drops only the new
  helper, and preserves data and existing RPC grants. Repeat the permission,
  source-hash, and basic login/context checks before reopening clients.
- **After any task contains `assignees`, `version`, `deletedAt`, or `deletedBy`:**
  the rollback deliberately refuses. Retain the compatible Edge/SQL release
  and prepare a forward fix. Reverting to the old engine could expose deleted
  work or mishandle secondary assignees and stale edits. Do not strip fields,
  delete records, reset the studio, or bypass this guard. A backup restore or
  explicit data conversion requires a separate reviewed plan and approval,
  including the risk of losing newer work.
- **Unexpected baseline, failed SQL, or failed Edge deployment:** leave writes
  paused. Verify which stage committed before choosing recovery. SQL failure
  within its transaction leaves the old functions intact. SQL-only success
  needs the matching Edge bundle before writes resume, because account actions
  can introduce new task version/assignment fields.

## Local verification evidence

```sh
npm test
RELAY_PGLITE_ROOT=/tmp/<install>/node_modules/@electric-sql/pglite \
  node tests/task-lifecycle-pglite.mjs
```

PGlite must be `@electric-sql/pglite@0.5.8`, installed outside this checkout.
The SQL suite runs the actual PostgreSQL schema, pgcrypto, production handler,
and production database transport; only HTTP to the database is replaced with
local parameterized SQL calls. It verifies 22 scenarios, including focused
rollout/rollback, unknown-definition refusal, authorization, full task operation
round trips, deterministic SQL CAS collisions, and account lifecycle changes.

These results do not prove network transport, the deployed runtime, provider
configuration, or independent-session PostgreSQL concurrency. The existing
`tests/sql-integration.mjs` suite requires native PostgreSQL and the local
postgres account, which are unavailable here. See
`TASK-LIFECYCLE-TEST-NOTES.md` for the account-lifecycle contract.
