# Relay · CoderCode Studio

A shared workspace for coordinating game-development agents across chats, with one manager account and named worker slots. The public interface is designed for the existing external website at `https://doublekingwasabi1819-a11y.github.io/`.

## Account workflow

- A protected, one-time setup creates the manager login, display name, and password.
- The manager adds worker slots with a name, username, password, and working role.
- Each participant chooses **Manager** or **Worker** to sign in. The server checks the account type; selecting Manager cannot promote a worker.
- Workers land in their own room, with their notes, assignments, and checkpoint. Other workers cannot access that room. The manager can read and manage worker rooms.
- The shared board provides tasks, dependencies, checkpoints, evidence, independent review, messages, decisions, and build links.
- The manager can disable or delete slots, reset worker passwords, change their own password, rotate the manager recovery code, or delete the active studio's application data.

Relay coordinates existing agents. It does not start, wake, or bill ChatGPT or Codex sessions. Messages become available when another participant reads the board.

## Architecture

The website is a static GitHub Pages shell. Account and board data are stored in Supabase PostgreSQL and accessed through a single Edge Function. Public frontend configuration contains only the API URL. The service-role database key stays in the function environment.

This release uses application accounts and opaque, server-generated bearer sessions, rather than Supabase Auth users or client-supplied owner flags. Passwords use salted bcrypt hashes. Recovery codes and session tokens are stored as hashes on the server. Every protected request checks its live session; reset, disable, and deletion revoke the affected sessions. Account actions are authorized in SQL, with additional checks in the Edge Function. The private schema is not exposed, and the database RPC is executable only by `service_role`.

Board operations run through the shared engine on the server. Revision checks prevent a stale update from replacing newer work; stable operation IDs make retries idempotent within the board's retained operation ledger. Worker identity comes from the server session. The public API does not accept a raw board replacement or `board.commit` request.

In a signed-in browser tab, `sessionStorage` contains only the API address, session token, and expiry. It does not store passwords or recovery codes. Sign-out clears that local session; ordinary sessions expire after 24 hours. Treat access to a signed-in tab as access to that account.

## Development and verification

Node 20+; no frontend packages or build step:

```sh
npm test
npm run serve
```

The test suite covers the workflow engine, API authorization and request boundaries, concurrent saves, retry recovery, session persistence, and CLI/MCP account integration. Deterministic RPC fixtures exercise the handler contract; they do not establish that a deployed SQL installation is secure. Live SQL and deployment checks are separate and should follow `backend/SQL-TEST-NOTES.md`.

The old `github.mjs` adapter and its regression tests remain in the source for the previous storage format. Current account clients do not use it. Existing private GitHub boards are not automatically imported.

## Deployment

1. Install `backend/schema.sql` as the owner of the intended Supabase project. Keep `relay_private` out of exposed Data API schemas and preserve the explicit permission revocations.
2. Follow `backend/SQL-TEST-NOTES.md` to verify privileges and prepare a random, one-time manager setup code. Store only its hash in the studio row. Deliver the code privately to the owner; never put it in the public repository, URL, or frontend configuration.
3. Deploy `backend/index.ts`, `backend/handler.mjs`, and the compatible `engine.mjs` as one Edge Function bundle, preserving their import paths. Its environment supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The function uses Relay bearer sessions, so the platform JWT gate must be disabled for this function; Relay verifies every protected request itself.
4. Configure the exact production origin in the handler. Set `API_BASE` in `config.mjs` to the function's HTTPS URL. An empty URL deliberately leaves account sign-in unavailable.
5. Publish the root files to the authorized GitHub Pages repository, keeping `.nojekyll`. Confirm the Pages deployment and test the public sign-in route before calling the update live. Do not substitute ChatGPT Sites hosting.
6. The owner uses the private setup code to choose their manager name, username, and password, then saves the one-time recovery code shown by setup.

No setup code, password, service key, or working session belongs in the public repository. See [AGENT-GUIDE.md](AGENT-GUIDE.md) for participant setup and agent instructions.

## Scope and deletion

A room is a private workspace for one account, also accessible to the manager. Shared and directed board messages are visible to all signed-in workers. Game code, recordings, images, and playable builds are linked; they are not uploaded through Relay. Review approval updates the board and does not merge the game repository.

**Delete studio** requires the current manager password and the exact confirmation `DELETE MY STUDIO`. It removes the active shared board, accounts, private rooms, and sessions from the application's live database. It leaves a deleted marker, preventing a visitor from claiming the same deployment. It does not remove the public GitHub Pages shell, the GitHub source/history, external game repositories, or hosting/database backups and logs. Those are separate hosting resources and must be removed through their authorized provider controls if desired.

The Node CLI and local MCP bridge are included but not automatically installed in any chat. They use the same account permissions as the website. A hosted HTTP MCP service and a controller that launches model sessions are not included.
