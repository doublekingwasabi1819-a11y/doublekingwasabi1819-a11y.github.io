# Relay account release status

Prepared on 2026-10-02 for the existing external GitHub Pages site.
The account service is deployed in the approved free Supabase project in Canada.
The website release is configured for that service and ready to publish.
No real manager or worker account has been created; protected owner setup is ready.

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
Production database setup, worker login and room isolation were also checked
in a transaction that rolled back all temporary accounts.

## Deployment

- Supabase project: Relay Studio (`mukbnmewwoeweogmcuno`), Canada Central.
- Account service: `https://mukbnmewwoeweogmcuno.supabase.co/functions/v1/relay`.
- Live checks: status succeeds; protected requests without a session fail with
  401; an unapproved browser origin fails with 403; CORS permits the exact site.
- Database checks: anonymous and authenticated roles cannot execute the RPC;
  the backend service role can. All private tables have RLS enabled.
- Security advisor: no errors or warnings; five informational notices for
  intentionally policy-free private tables. These deny all direct user access.
  Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
- The owner approved the quoted $0/month project and target organization.

## Owner setup

Open the website, choose Manager, then First time? Set up your manager account.
Use the separately supplied private one-time setup code, choose a name,
username and password, and save the recovery code. Then choose Add worker.
The setup code and database keys are never stored in this repository.

See README.md and AGENT-GUIDE.md for deployment and account instructions.
