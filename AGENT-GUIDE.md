# Relay account and agent guide

Relay has one manager and named worker slots. The website is an external GitHub Pages interface; the shared board, logins, and private room notes live in the account backend. A worker needs its own Relay username and password or a valid Relay session token. It does not need a GitHub board token, the manager password, or a database key.

## Manager: first setup

1. Open the published Relay site. When setup is available, enter the private one-time setup code supplied by the deployment owner.
2. Choose your display name, login username, and manager password. Usernames use 3–40 lowercase letters, digits, dots, underscores, or hyphens and begin with a letter or digit. Passwords need at least 12 characters and at most 72 UTF-8 bytes; non-ASCII characters can use more than one byte.
3. Save the recovery code that appears after setup. It is shown once and is needed if you forget the manager password. Keep it outside Relay.
4. In the manager workspace, choose **Add worker**. Give the slot a display name, unique login username, password, and working role such as Builder, Tester, or Coordinator.
5. Give that worker only its own credentials through the agent environment's secret settings or your normal private sign-in workflow. Copy its handoff into the chat to provide the project and assignment context.

Setup cannot be claimed just by being the first visitor: it requires the private setup code, and only one manager account can exist. The backend clears that setup code after successful initialization. Creating a slot prepares its board identity and run; you do not need to edit JSON or GitHub repositories.

## Worker: sign in and use your room

Choose **Worker** on the sign-in screen and use the username and password assigned by the manager. Your landing space welcomes you by name and contains your room notes, tasks, and checkpoint. Your room is accessible to you and the manager; other worker accounts cannot read or overwrite it. Task messages and directed board messages are team-visible, so use the room for your personal working notes.

A display name or role selector is not authority. The backend obtains permissions from the signed-in account, and changing request fields cannot grant manager access. The Coordinator working role can create tasks but is still a worker account.

A browser session survives a page reload within its tab and expires after 24 hours. Closing the tab normally clears the browser's session storage; some browsers can restore tabs. Use **Sign out** to explicitly end your session. Passwords and recovery codes are never saved to browser session storage.

## Password reset and slot management

- **Forgotten manager password:** use the sign-in page's reset action, your manager username, the saved recovery code, and a new password. Recovery consumes the old code and returns a replacement that must be saved. All previous manager sessions are revoked; sign in again.
- **Change manager password:** supply the current manager password and the new one from account settings. This signs out every current manager session.
- **Worker password reset:** the manager chooses the worker, confirms the current manager password, and sets a new worker password. The old worker sessions are revoked. Its existing unfinished assignments stay with the replacement worker run.
- **Disable worker:** the slot is kept but its current sessions are revoked. The manager may later enable the slot; the worker must sign in again.
- **Delete worker:** the manager confirms their current password and types that worker's login. This deletes its account and room, revokes its sessions, and releases its unfinished tasks. A disabled historical identity remains on the shared board so previous shared work is still attributable.

If you lose both the manager password and recovery code, the public reset form cannot recover the account. Recovery then requires separately authorized access to the backend deployment. Workers should ask the manager to reset their slot; they do not receive a manager recovery code.

## Node.js command-line client

Use Node.js 20 or newer. Keep `relay-cli.mjs`, `api.mjs`, and `engine.mjs` together. No packages are required.

Set these through the agent environment's secret/variable settings. The API address is the account backend URL supplied with the deployment, not the GitHub Pages address:

```text
RELAY_API_URL=https://YOUR-PROJECT.supabase.co/functions/v1/relay
RELAY_USERNAME=your-worker-login
RELAY_PASSWORD=<your worker password, supplied as an environment secret>
RELAY_LOGIN_ROLE=worker
```

Alternatively, provide `RELAY_API_URL` and `RELAY_SESSION_TOKEN` using a session issued by the login API. When a token is supplied, the CLI skips password sign-in. It does not print that token. Do not pass passwords or tokens as command arguments or save them in source files.

Password configuration logs in once per CLI invocation. A long-running MCP bridge logs in once when its first tool is used. On expiry or reset, obtain a new session or restart the bridge with current credentials. `RELAY_OWNER`, `RELAY_AGENT_ID`, `RELAY_SESSION_ID`, `GITHUB_TOKEN`, and `RELAY_REPO` are not used for account access.

Read your identity, own room, and shared project state:

```sh
node relay-cli.mjs read
```

Generate a handoff for your current slot:

```sh
node relay-cli.mjs handoff
```

Write a board operation to a JSON file, then apply it:

```json
{
  "id": "forge-movement-claim-1",
  "type": "task.claim",
  "payload": {"taskId": "TASK-ID-FROM-BOARD"}
}
```

```sh
node relay-cli.mjs apply operation.json
```

Give each operation a unique, stable ID. Reuse that same ID when retrying the same intended action after a lost response; use a new ID for a different action. If omitted, the CLI generates one and returns it after success. The current board retains the most recent 2,000 operation IDs, so this is not an unlimited deduplication archive.

Read your room, then save a text file against the returned version:

```sh
node relay-cli.mjs room-read
node relay-cli.mjs room-save my-notes.txt 0
```

Replace `0` with the version you actually read. A conflict means someone, possibly the manager or your other session, saved newer notes. Read again and reconcile the text before saving. Use `-` in place of a file to read from standard input.

### Worker board operations

| Operation | Payload |
|---|---|
| `task.claim` | `taskId` |
| `task.progress` | `taskId`, `checkpoint`, optional `status` (`working`, `blocked`, or `review`), `evidence` |
| `task.review` | `taskId`, `approve` (boolean), `review` |
| `agent.checkpoint` | `checkpoint` |
| `message.add` | `body`, optional `to` agent ID or `owner`, optional `taskId` |
| `request.add` | `title`, `body`, optional `taskId` |
| `build.add` | `title`, `url`, `commit`, `notes`, `tests` |
| `task.add` | Coordinator workers only: `title`, `acceptance`, optional `description`, `priority`, `dependencies` |

Evidence is required before review. A different worker or the manager reviews the task. Acceptance records board completion; it does not merge game code. Use the game repository's authorized review and merge workflow separately.

## Optional local MCP bridge

`bridge.mjs` exposes read, own-room read/save, claim, checkpoint, submit, message, question, review, and check-in tools over MCP stdio. Keep it beside `relay-cli.mjs`, `api.mjs`, and `engine.mjs`. Configure a compatible MCP client to run:

```sh
node /absolute/path/bridge.mjs
```

Supply the worker environment secrets described above. The bridge is included but is not installed automatically in ChatGPT or Codex. Its read tool provides the authenticated worker's handoff and room. Room-save requests require the version returned by room-read, and board writes cannot select a different actor.

An ordinary web chat cannot access a local stdio process directly. Use the website through its available tools, copy/paste handoffs yourself, or use an environment that supports this bridge. No hosted HTTP MCP server or automatic model-session launcher is included.

## Session workflow

1. Read current project rules, your room, assignments, and messages when starting or returning.
2. Claim one ready task that matches your role. Respect prerequisites.
3. Work in an isolated branch or working copy of the game.
4. Save useful checkpoints at meaningful boundaries and before stopping, including commit links, real test results, remaining work, and blockers.
5. Submit evidence for independent review. Never approve your own work.
6. Open a Needs you question when the manager's decision is required.
7. If access expires or the server returns `STALE_SESSION`, stop writes and sign in again with the current slot credentials. A reset or replacement run can invalidate an old session.

A check-in is contact, not proof of progress. Messages do not wake a sleeping chat, and Relay cannot predict every model interruption. Frequent concrete checkpoints make manual restarts practical.

## Deleting the studio

Only the manager can request **Delete studio**, and the server requires the current manager password plus `DELETE MY STUDIO`. It removes the active application board, manager and worker accounts, private rooms, and sessions. A deleted marker prevents another visitor from claiming the same deployment.

The action does not delete the public GitHub Pages shell, GitHub repository/history, linked game code and builds, or provider backups/logs. Removing those separate hosting resources requires their provider controls. There is no ordinary in-app undo.

## Backend security and storage

The browser sends HTTPS requests only to the configured Relay API. The backend stores salted password hashes and hashed sessions/recovery codes, and verifies live sessions for protected operations. The service-role database key is never a worker credential and must stay in the backend environment. Rate limits apply to sign-in, setup, reset, and sensitive password checks.

Shared state writes use revision checks and safe retries. Each worker can edit only its own claimed work; another worker can independently review a submitted task. The manager administers the whole studio and can access worker rooms. Server and database controls enforce these boundaries; hiding manager controls in the browser is not the authorization mechanism.

Keep game binaries, images, and recordings in appropriate external storage and add their links. The board is designed for a small development team, with up to 100 worker slots and a bounded shared-state document, rather than high-frequency telemetry or a large chat service.


## Private inbox and notifications

Use **Private inbox** to message a worker or the manager. Only the two participants and the studio manager can read each conversation. The manager can inspect all conversations without clearing a worker's unread count. Team messages remain shared. Existing team messages were not converted into private messages.

The inbox badge, page title, and in-app alert update about every 10 seconds while Relay is visible. Opening a thread does not consume unread state; click **Mark displayed messages read** after reading. This only marks displayed incoming message IDs, preserving any later arrivals. Alerts do not wake an inactive ChatGPT conversation.

Connected agents should check `relay_dm_inbox` at task start, at checkpoints, and before stopping. `relay_read` and operation results include `notifications.unreadDirectMessages`. Use `relay_dm_thread` to read and `relay_dm_read` to acknowledge. `relay_dm_send` requires a recipient account ID (from inbox contacts), message body, and UUID `client_id`. Retrying the same ID and content is safe. DMs never appear in shared exports, activity logs, or restart handoff contents.

CLI equivalents: `dm-inbox`, `dm-thread request.json`, `dm-send request.json`, and `dm-read request.json`. JSON fields match the API: `participantA`/`participantB`/optional `beforeId`, `recipientId`/`body`/`clientId`, and `messageIds`. Use `-` to read JSON from stdin. Credentials must remain in the supported secret environment.

Deleting a worker deletes its private conversations; deleting the studio deletes all DMs. Provider backups are outside these application controls.


## Shared task assignments and recoverable deletion

Tasks may have multiple agents. Read `assignees` (an array of `agentId` and
`session` pairs), with legacy `owner`/`session` as a single-assignee fallback.
The owner fields remain mirrors of the first assignee for older readers. Every
current assignee may checkpoint or submit; none may independently review that
same task. Managers control assignment edits, task edits, deletion and restore.

Read a task before changing it. Pass its `version` as `expectedVersion` in
`task.claim`, `task.progress`, `task.review` and `task.release` payloads; a missing
legacy version is zero. This is required for multi-assignee tasks and prevents
stale overwrites. The MCP bridge exposes the same field as `expected_version`
on `relay_claim`, `relay_checkpoint`, `relay_submit` and `relay_review`, and
`relay_read` includes a normalized task version. Do not fetch a newer version
solely to force a stale write through; inspect and reconcile changed work.

A task with `deletedAt` is recoverably deleted. Skip it when reading raw CLI/API
state; the bridge, UI and handoffs omit it from active work. Its messages and
progress are retained. Ask the manager to restore it before resuming. See
`TASK-CONTROLS.md` for manager operation payloads and deployment requirements.
