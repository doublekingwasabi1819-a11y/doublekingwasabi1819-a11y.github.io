# Task deletion, restoration and multiple agents

Local source changes based on GitHub `main` commit
`56c47abe01d807a52cde82ebc46d7038ae36cdcb` (verified October 5, 2026).
No repository push, deployment, production SQL, or existing-task mutation has
been performed. This is an implementation/review package, not an activated
website feature.

## User-facing behavior

- Managers can choose several agents while creating a task or use **Manage
  agents** on an existing unfinished task. Each must be enabled and have a
  current session. Clearing every agent returns the task to Ready without
  erasing its checkpoint or evidence.
- Every assigned agent sees the task in their room, agent filter and handoff,
  and can record progress. Current assignees cannot approve their own shared
  work; an independent agent or the manager reviews it.
- Managers can edit task scope/title/acceptance/priority while retaining history.
- **Delete task** opens a confirmation. Cancel/Close changes nothing. Confirming
  hides it from active boards, assignment lists, new prerequisites and handoffs.
- **Deleted tasks** retains the task's prior status, assignments, checkpoint,
  evidence, review and conversation. A second confirmation restores it.
  Deletion is recoverable and is not a privacy erasure or permanent purge.
- Deleting a prerequisite of an unfinished active task is blocked. Finish or
  delete its dependent tasks first; restore deleted prerequisites before their
  dependents. No dependency is silently detached.

## State and compatibility

The existing board is a JSON document; there is no new table, public data API,
credential or storage bucket. Existing `schema: 1` boards remain supported.

A task may have `assignees: [{agentId, session}, ...]`, `version`, `deletedAt`
and `deletedBy`. If `assignees` is absent, `owner`/`session` are interpreted as
the legacy single assignment. They are retained as mirrors of the first
assignee after any assignment edit. Empty arrays explicitly mean unassigned.
Existing fields, IDs, dependencies and message references are not rewritten.
A legacy task version starts at zero. JSON import/export preserves all fields.

All new task management operations require `expectedVersion`. Updated UI sends
it for progress/review/claim/release too. Version increments on each task
mutation, including worker session lifecycle changes. A stale task version
fails rather than overwriting another agent's work. Board commits still use
the existing server-side revision compare-and-swap and session revalidation.
Legacy single-assignee commands may omit the version; multi-assignee commands
must supply it even for old operation names, preventing silent shared-task
progress overwrites by an older client.

Manager permissions are rechecked in both the HTTP handler and engine. Worker
creation authority is unchanged: coordinators may create unassigned tasks;
workers may claim Ready tasks under their own identity. Workers cannot edit
assignment lists, task definitions, delete or restore. The server reads the
current agent session; caller-supplied owner/role fields confer no authority.

Account reset/deletion must use the accompanying SQL lifecycle compatibility
change. Reset renews every matching unfinished assignment. Deleting an account
removes only that account from unfinished tasks and promotes the first surviving
agent. Soft-deleted unfinished tasks receive the same maintenance. Completed
task attribution remains unchanged, including its recorded sessions.

## API operations

Use the existing authenticated `operation` action, one stable unique operation
ID per attempted change, and the task version from the latest context:

```json
{"action":"operation","data":{"op":{"id":"unique-operation-id","type":"task.assign","payload":{"taskId":"task-id","expectedVersion":0,"agentIds":["agent-a","agent-b"]}}}}
```

New manager-only operations:

- `task.assign`: taskId, expectedVersion, agentIds (empty list releases everyone)
- `task.edit`: taskId, expectedVersion, title, description, acceptance, priority
- `task.delete`: taskId, expectedVersion
- `task.restore`: taskId, expectedVersion

`task.add` optionally accepts `agentIds` for managers. Nonempty assignment starts
work only when dependencies are done. Existing operations remain supported.
Use `taskAssignees`, `assignedTo`, `activeTasks` and `taskVersion` exports instead
of interpreting only `owner` in new clients. Never attempt to update the stored
board JSON directly from an untrusted client.

## Activation order and rollback

The normal website Update button updates static files. It does not deploy the
private Edge function or install database function changes. A frontend-only
publication is insufficient for this feature.

1. Recheck the actual deployed Edge handler and database RPC versions and back
   up the current board and function definitions. This package only proves
   source-level compatibility with the verified repository baseline, not the
   current deployed private backend.
2. Review and test the focused SQL rollout in a non-production environment;
   it must refuse an unexpected RPC definition. Do not blindly reinstall the
   complete schema against an existing deployment with unrelated features.
3. Under authorized deployment, install the compatible SQL lifecycle function
   and deploy `backend/handler.mjs` together with the new root `engine.mjs` in
   the existing Edge bundle. Preserve every unrelated deployed feature. Refer
   to the backend rollout notes supplied with this package.
4. Verify create/assign/progress/delete/restore and account reset/delete with
   disposable test accounts and tasks in the authorized test environment.
   Then publish matching `app.mjs`, `engine.mjs`, `ui.css`, `index.html` cache
   references together. Merge independent branding changes before publishing.
5. Refresh clients. Old UI versions may show only the first agent and do not
   hide deleted tasks. They must not be treated as the supported interface.

After new-format tasks are written, reverting to the old engine/RPC is unsafe:
old release/reset/delete behavior can leave assignments inconsistent, and an
old UI may resurface deleted tasks. Prefer a forward fix. If emergency UI
rollback is needed, retain the new backend compatibility and stop affected
writes; do not drop array data or deleted-task records to force compatibility.
No destructive reverse migration is included.

## Validation

- `npm test`: 131 Node tests pass, including 16 new engine/HTTP regression tests.
- `node --experimental-vm-modules --test tests/task-controls-dom.mjs`: 6 actual
  app DOM tests pass. This exercises the real HTML, modules, dialogs and event
  handlers with jsdom; only the network config is replaced with an empty
  endpoint. No external requests occur.
- `tests/task-lifecycle-pglite.mjs`: 22 actual SQL schema/RPC lifecycle and API checks
  run against disposable local PostgreSQL-in-WASM with pgcrypto. See backend
  validation notes for the final test count and exact invocation.
- `node --check` and `git diff --check` pass.
- Chromium browser test is supplied at `tests/task-controls-browser.mjs`, but
  actual browser/mobile screenshot validation was blocked: this executor
  denies Chromium's required process socket even outside its ordinary sandbox.
  It was not worked around. No screenshots or rendered mobile-layout claims
  are provided. DOM escaping/checkbox semantics passed; real layout remains a
  pre-release check in a browser-enabled environment.

Test-only dependencies are externally installed, pinned by their validation
setup, and are not shipped as runtime dependencies. The fixture reads no real
user credentials, production database or live task state.

## Combined manager identity release

This tree integrates manager branding in authenticated manager and worker sessions, using only manager.name from context. SQL advertises taskLifecycleV1; the matching Edge converts that to taskControlsV1. Frontend task writes remain disabled without the latter; direct task operations fail with 503 BACKEND_NOT_READY without the former. Final aggregate logs are in validation/combined-release. Update-room replacements exclude protected bridge.mjs, which requires separate owner-reviewed maintenance. See the delivery RELEASE-README.md for remaining activation gates.
