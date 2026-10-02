# Relay database verification

`schema.sql` is an install script, not a timestamped migration. Run it as the
project database owner. It preserves existing accounts, board, and deletion
tombstone on reinstall. It uses PostgreSQL plus `pgcrypto` installed in
`extensions`. The only public-schema function is `public.relay_rpc`; it is
`SECURITY INVOKER` and executable by `service_role` only. Keep `relay_private`
out of Supabase's exposed API schemas. Never send the service-role key to a
browser or worker.

## Owner setup

The installation intentionally leaves setup disabled. Generate an unpredictable
32-byte setup code using a secure random generator outside SQL logs. Store only
its SHA-256 hexadecimal digest with this parameterized owner query:

```sql
update relay_private.studio
set setup_hash = :setup_code_sha256_hex
where singleton and not initialized and not deleted;
```

The setup code is shown only to the owner, who enters it in the one-time manager
setup screen. Do not put it in a repository, URL, screenshot, or application log.
Setup consumes its hash atomically. Reinstalling this schema does not reopen
setup. `status.needsSetup` means no manager exists; a missing bootstrap hash
still causes setup to return `SETUP_DISABLED`.

## Security invariants to inspect

```sql
select p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname = 'relay_rpc')
   or n.nspname = 'relay_private';

select n.nspname, c.relname, c.relrowsecurity,
       has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_access,
       has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as user_access
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'relay_private' and c.relkind = 'r';
```

Expected: no security-definer functions; fixed `search_path=pg_catalog`; all
tables have RLS; anon/authenticated cannot execute these functions or use any
private table. Service-role access is expected and is limited to the backend.
Run Supabase database security advisors after installation.

## Runtime checks

Use a disposable project, or wrap all fixture setup/actions/assertions in a
transaction that ends with `ROLLBACK`. Never run destructive fixture tests
against the owner's populated studio. Use generated, temporary credentials.

1. With no setup hash, setup returns `SETUP_DISABLED`. With a wrong setup code,
   it returns `AUTH` and leaves the counter incremented. With the correct code,
   it creates exactly one manager, one room, one session, and returns a recovery
   code. A second setup returns `SETUP_CLOSED`.
2. Two concurrent transactions attempting setup cannot both win. The singleton
   row lock serializes them. Only one manager is allowed by the partial index.
3. Reject passwords shorter than 12 characters and longer than 72 UTF-8 bytes.
   Reject an over-limit multibyte password even when its character length is
   under 72. Preserve leading/trailing spaces; do not trim passwords.
4. Create two workers, log them in, and verify their account IDs and agent IDs
   differ. Their `context` results contain only their own room and an empty
   `workers` array. Manager context contains worker metadata but no password
   hashes, recovery hashes, session hashes, or room contents belonging to others.
5. A worker's `room.read`/`room.save` with another account ID returns `FORBIDDEN`.
   A manager may read/edit either room. A stale `expectedVersion` returns
   `CONFLICT`; failed CAS leaves body/version unchanged.
6. Worker account creation, password reset, worker deletion, and studio deletion
   return `FORBIDDEN`, even with forged role/owner fields. Role selection on the
   login form does not change the account's actual role.
7. Wrong current-manager password returns `AUTH`; the existing valid manager
   session remains usable. Missing, expired, revoked, or disabled sessions return
   `SESSION`. Frontends must not log the manager out merely for an `AUTH` typo.
8. Disabling/resetting/deleting a worker revokes its old login sessions. Reset
   also rotates the agent run and updates unfinished assignment session IDs.
   A fresh worker login binds the existing run without rotating it. An explicit
   manager run replacement yields `STALE_SESSION` to an older pinned login.
9. Board CAS rejects stale revisions. Every account modification bumps revision,
   so an in-flight Edge computation cannot overwrite an account change. The
   internal `board.commit` action rejects credential-associated agent changes.
   The Edge public dispatcher must never accept incoming `board.commit` or
   arbitrary replacement state.
10. Worker deletion removes its private room, account, password hash, and sessions,
    releases unfinished assignments, and leaves shared messages/completed work
    under a disabled `Deleted worker` tombstone.
11. Manager recovery consumes one code, rotates it, changes the password, and
    revokes every manager session. The old code/password cannot be reused.
    Manager password change also revokes every manager session. `recovery.rotate`
    replaces only the code after fresh manager password verification.
12. Repeated bad login/setup/recovery/reauth requests eventually return 429.
    Observe the throttle table in a separate transaction after failed API calls:
    normal authentication errors must preserve attempt counts. Different IP keys
    must still hit the shared normalized-account bucket. The Edge function must
    derive `rateKey` itself and discard any client value.
13. Deletion rejects wrong passwords and confirmation phrases. Valid manager
    deletion with `DELETE MY STUDIO` removes all application accounts, rooms,
    sessions, board data, recovery codes, setup hash, and throttles atomically.
    `status` then reports `deleted:true, needsSetup:false`; all non-status actions
    fail with `DELETED`, and reinstall does not reopen it. Provider backups/log
    retention and the public website deployment are managed separately.

## Return contract

- Ordinary failures return `{error:{code,message,status}}`, permitting failed
  attempt counters to commit. Do not turn them into database exceptions in an
  enclosing transaction that is then rolled back.
- `context` returns `{user,actor,state,room,workers}`; credentials never occur in
  these results. Room endpoints return the room object directly.
- Worker create/update/reset return the worker metadata object directly. Worker
  deletion returns `{ok:true}`.
- `board.commit` returns `{state,revision}`. The next revision must equal the
  current revision plus one; no-op/idempotent engine results should skip commit.
- `password.change` returns `{ok:true}` and invalidates its own caller token.
- Tokens expire after 24 hours. Worker run fencing is independent from token TTL.

## Verification completed

The schema compiled and all **14 PostgreSQL integration checks passed** against
the local, disposable PostgreSQL 16 database `relay_accounts_test`. These execute
real RPC calls as `service_role`, including two concurrent setup transactions,
anon/authenticated access rejection, private-room isolation, password resets,
revocation/recovery, rate-limit persistence, board/room CAS, worker deletion, and
permanent workspace deletion followed by reinstall.

The first runtime run found missing access to the `extensions` schema for the
invoker service role. The schema now explicitly grants that role schema usage
and execution of only the four pgcrypto functions it needs; the complete suite
then passed.

Rerun with permission to use the local PostgreSQL OS account:

```sh
node tests/sql-integration.mjs
```

This command destructively resets **only the local disposable test database**;
it refuses database names outside the `relay_*_test` pattern and never accepts a
remote connection string. It does not configure or test a cloud Supabase project.
Live installation still requires the permission inspection and Supabase security
advisors above before the account service is reported as deployed.
