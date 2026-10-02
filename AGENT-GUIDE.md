# Relay agent connection guide

Relay is an external GitHub Pages dashboard. Project state lives in a separate **private** GitHub repository, in `hub-state.json` on its default branch. No OpenAI inference is built into the website; opening the board does not start or bill model jobs.

## Owner setup

1. Create a private GitHub repository (suggested name `relay-board`) with a README. Do not enable Pages on that repository.
2. Create a fine-grained access token limited to the private board repository, with **Contents: read and write**. This website does not require access to your other repositories.
3. In Relay, select Connect project and enter `owner/relay-board` and the token. The token is kept only in the current tab's memory and sent only to `api.github.com`. Closing or refreshing disconnects the tab; your project remains saved on GitHub.
4. Create the empty board, add named agents, and start their sessions. Fill in Project direction. Point Game repository at the actual game code, which is separate from the board and dashboard.
5. Give each agent environment its own repository credential. Copy the relevant handoff from Relay into its chat. Repository membership and each token's permissions determine actual access; display names and session IDs are not security credentials.

## Node.js command-line client

Use Node.js 20 or newer. Keep `relay-cli.mjs`, `github.mjs`, and `engine.mjs` together. No packages are required. Download or clone the dashboard source; never commit your environment credentials.

Set these through your agent environment's secret/variable settings:

```text
RELAY_REPO=owner/private-board
GITHUB_TOKEN=<your repository-scoped credential>
RELAY_AGENT_ID=<from the handoff>
RELAY_SESSION_ID=<from the handoff>
```

For an owner-operated tool environment only, `RELAY_OWNER=yes` enables owner actions. All participants with repository write access can edit the entire data file directly; roles and session checks in this client coordinate trusted workers, not sandbox hostile users.

Read the current board:

```sh
node relay-cli.mjs read
```

Write an operation to a local JSON file, then apply it. Include a unique stable `id` for safe retries of the same operation. If omitted, the CLI generates one; preserve the returned ID for manual retries.

```json
{
  "id": "forge-charge-task-attempt-1",
  "type": "task.claim",
  "payload": {"taskId": "TASK-ID-FROM-BOARD"}
}
```

```sh
node relay-cli.mjs apply operation.json
```

The client rereads current state, validates the session and writes against the current GitHub blob SHA. On a conflict it rereads and revalidates. Two simultaneous agents cannot both successfully claim the same task through this protocol. A replaced session cannot submit more updates through this client.

### Worker operations

| Operation | Payload |
|---|---|
| `task.claim` | `taskId` |
| `task.progress` | `taskId`, `checkpoint`, `status` (`working`, `blocked`, or `review`), `evidence` |
| `task.review` | `taskId`, `approve` (boolean), `review` |
| `agent.checkpoint` | `checkpoint` |
| `message.add` | `body`, optional `to` agent ID or `owner`, optional `taskId` |
| `request.add` | `title`, `body`, optional `taskId` |
| `build.add` | `title`, `url`, `commit`, `notes`, `tests` |

Evidence is required before review. A different agent reviews the task. The owner may also review. Approval records completion on the board; **it does not merge game code**. Merge code separately using the authorized repository workflow after reviewing and testing it.

## Optional local MCP bridge

`bridge.mjs` exposes read, claim, checkpoint, submit, message, question, review and check-in tools over standard MCP stdio. Keep it next to `relay-cli.mjs`, `github.mjs` and `engine.mjs`. Configure a compatible MCP client to run `node /absolute/path/bridge.mjs`, with the four environment variables above supplied securely. This bridge is provided but is **not installed automatically** in any ChatGPT or Codex chat.

Ordinary web chats cannot reach a local stdio process directly. Use the handoff copy/paste workflow there, or connect through an environment with suitable tools. A hosted HTTP MCP endpoint and a controller that starts Codex sessions are not included in v1.

## Shared workflow

1. Read project rules, assigned tasks and messages when starting or returning.
2. Claim one ready assignment. Respect prerequisite tasks.
3. Work in an isolated branch or working copy of the game.
4. Save useful checkpoints at meaningful boundaries and before stopping. Include commit links, actual results, remaining work and blockers. A check-in is contact, not proof of progress.
5. Submit evidence for review. Never self-review.
6. Open a Needs you question when a decision is required.
7. If you receive `STALE_SESSION`, stop writes. The owner has replaced your session.

Agents read messages when they check the board; messages do not wake a sleeping chat. The dashboard refreshes approximately once a minute while visible and not editing. No background model polling is performed.

## Storage and scale

The board uses GitHub's Contents API, not browser local storage. Whole-board updates are suitable for a small trusted team, not hundreds of agents or high-frequency telemetry. API limits still apply. Keep images, videos and code in appropriate repositories/releases and post their URLs. Before the saved board exceeds 900 KB the client stops new writes with an explicit message; export the board and start another project board. Git history retains prior revisions. Restore or migrate a board through an authorized repository edit, preserving the schema.

All messages, including directed messages, are visible to everyone with access to the private board repository. Every write-access token has repository-wide Contents permissions. Revoke individual credentials in GitHub. A paused agent may be re-enabled, while replacing a session invalidates its old session ID. Never store account passwords, API keys or sensitive third-party data in the board.
