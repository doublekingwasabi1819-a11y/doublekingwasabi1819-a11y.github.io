# Multi-assignee task account lifecycle

This is a local source change to `schema.sql`. It has not been applied to a
hosted database. Use the focused `task-controls-rollout.sql` and follow
`TASK-CONTROLS-DEPLOYMENT.md` for an existing studio; do not blindly reinstall
the full schema. The compatible SQL must accompany the multi-assignee engine.

`relay_private.update_task_worker` is a private, `SECURITY INVOKER` helper with
`search_path=pg_catalog`. Existing schema grants keep it unavailable to `anon`
and `authenticated`; only the backend service role may execute it. Account RPCs
still hold the studio row lock and bump the board revision once per operation.

## Task data behavior

- An `assignees` array is authoritative, including an explicitly empty array.
  Legacy tasks without an array read `owner` and `session` as one assignment.
- Worker password reset renews that worker's session in every matching
  unfinished assignment, including secondary and soft-deleted assignments.
- Worker deletion removes only that worker's unfinished assignments. Remaining
  assignment order is retained; `owner` and `session` mirror the first remaining worker.
  Unfinished tasks with no remaining workers become `ready`.
- Completed (`done`) tasks retain their assignment/session snapshots and remain
  entirely unchanged by worker reset or deletion. The existing deleted-worker
  tombstone preserves their historical worker identity.
- Modified tasks get one `version` increment, treating a missing version as
  zero, and an updated timestamp. Unrelated tasks remain unchanged.
- `deletedAt`, `deletedBy`, history, evidence, and all other task fields remain
  intact. Neither account action restores a soft-deleted task.

## Local regression command

The optional SQL test uses the pinned `@electric-sql/pglite@0.5.8` package and its
real PostgreSQL `pgcrypto` extension, installed outside the checkout. It accepts
only a local `/tmp/` package path, constructs an in-memory database, and makes no
remote database requests:

```sh
RELAY_PGLITE_ROOT=/tmp/<install>/node_modules/@electric-sql/pglite \
  node tests/task-lifecycle-pglite.mjs
```

On 2026-10-05, all 22 checks passed. Coverage includes schema compilation,
restricted invoker permissions, real manager/worker account RPCs, failed
authentication and confirmation, primary/secondary/legacy assignments,
completed and soft-deleted tasks, version changes, session revocation, stale
board CAS rejection, survivor promotion, repeated worker deletion, and schema
reinstallation without data loss. The production Edge handler and database
transport also execute task create/assign/edit/progress/delete/restore against
real local SQL, including unauthorized worker controls, stale task versions,
actual board CAS collisions, retries, and lost commit acknowledgements. Focused
rollout/rollback artifacts are tested for exact source preservation, repeated
execution, unknown-definition rejection, and unsafe-data-rollback refusal.
The earlier task-controls SQL release also upgrades and rolls back exactly.
Authenticated manager and worker context responses expose only the manager
display name; malformed/unknown sessions expose neither manager nor capability.
Baseline rollback removes SQL lifecycle capability without modifying user data;
rollout restores it, and the matching Edge layer advertises full task controls.
A real baseline-SQL task mutation returns 503 / `BACKEND_NOT_READY` with no board
changes. Unit tests additionally cover every task operation, forged/truthy
capability values, and compatibility loss during a compare-and-swap retry.

This fixture is additional coverage. The existing `tests/sql-integration.mjs`
suite needs native PostgreSQL and a local postgres OS account, unavailable in
this execution environment. PGlite does not establish independent-session
concurrency behavior or validate the deployed Supabase configuration. Run the
existing native integration suite and database security advisors as part of an
authorized deployment; no deployment is implied by these local results.
