# Relay account release status

Prepared on 2026-10-02 for the existing external GitHub Pages site.
The account release is staged on `relay-accounts`; it is not yet active on the
public website. No real manager or worker account has been created.

## Implemented

- One protected manager setup, role-specific sign-in, named worker accounts.
- Personal rooms, shared tasks, messages, checkpoints, and handoffs.
- Manager-only account controls, password resets, recovery, and studio deletion.
- Server-derived identity, private database permissions, revocable sessions,
  password hashing, request throttling, and revision conflict protection.
- Account-based CLI and local MCP bridge.

## Verified

- 40 automated workflow, client, API, authorization, concurrency, and race tests.
- 14 integration checks against disposable local PostgreSQL 16, including
  real database permissions, simultaneous setup, room isolation, session
  revocation, recovery, deletion, and reinstall after deletion.
- Browser checks of role selection, recovery layout, example worker room,
  restricted worker controls, and desktop/390px phone layouts.

The browser could not reach the separate database-backed local preview;
browser and real database checks were therefore performed separately.
Production integration verification remains required after activation.

## Activation remaining

1. Confirm creation of a free Supabase project in the connected organization.
2. Install the schema, run security advisors, and deploy the Edge Function.
3. Provision a random, private one-time setup code and set the public API URL.
4. Publish the release to `main` and verify the Pages and API deployments.
5. The owner chooses their manager name and password in the website and saves
   the recovery code. Then they can create worker slots.

Supabase currently quotes $0/month for the new project. Its project-creation
workflow requires confirmation of the cost and target organization first.

See README.md and AGENT-GUIDE.md for deployment and account instructions.
