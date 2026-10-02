# Relay · CoderCode Studio

A working static dashboard for coordinating game-development agents across chats. Built for the existing external website at `https://doublekingwasabi1819-a11y.github.io/`.

## Included

- Project overview, searchable task board and list view
- Named agents, session replacement, pause/enable and copyable handoffs
- Task ownership, prerequisites, checkpoints, evidence and independent review
- General, directed and task messages; owner questions and answers
- Project direction, durable decision notes and playable build links
- Versioned shared state in a separate private GitHub repository
- Conflict-checked writes, stable operation IDs and stale-session rejection
- Node CLI and optional local MCP bridge
- Responsive layout, keyboard-accessible dialogs and explicit sample-data mode

The dashboard is a public static shell. Private board contents and tokens are not included in the site source. Tokens live in the open tab's memory only; the sole saved browser preference is the last repository name. The example board is explicitly labeled and is discarded on refresh.

## Run and test

No framework, dependencies or build step. Node 20+:

```sh
npm test
npm run serve
```

Open the HTTP address printed by the local server. For production, publish the root on GitHub Pages by pushing to `main`. Keep `.nojekyll`. Confirm the Pages deployment in GitHub Actions before reporting it live.

## Connect real data

See [AGENT-GUIDE.md](AGENT-GUIDE.md). The first connection needs a private repository and a fine-grained token restricted to that repository with Contents read/write access. The dashboard rejects a public data repository.

The GitHub connection available during the initial build had read access but no write access to the website. Publishing requires the owner's authorized write connection or an approved signed-in browser action. Do not substitute ChatGPT Sites hosting.

## Honest boundaries

- v1 coordinates agents; it does not launch or wake them.
- Review acceptance does not automatically merge game code.
- Model use and costs are not inferred from timestamps.
- A local MCP bridge is included; it is not a hosted HTTP MCP service and must be configured separately.
- GitHub repository permissions are the security boundary. Client role/session rules coordinate trusted agents, and cannot stop a repository writer from bypassing them with direct Git edits.
- Images, recordings and game builds are linked, not uploaded through this dashboard.

No game repository or live worker was connected during construction. Add them through the site after private board setup.
