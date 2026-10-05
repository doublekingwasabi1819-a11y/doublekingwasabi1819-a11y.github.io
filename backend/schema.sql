-- Relay accounts, private rooms, sessions, and shared board.
-- Install as the database owner in a Supabase PostgreSQL project.
-- The Edge Function alone receives the service-role key. Browsers never do.
-- After installation provision setup_hash separately, using a random 32-byte
-- setup code kept out of source control; see SQL-TEST-NOTES.md.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists relay_private;

create table if not exists relay_private.studio (
  singleton boolean primary key default true check (singleton),
  initialized boolean not null default false,
  deleted boolean not null default false,
  setup_hash text,
  dummy_hash text not null,
  state jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  check (not (deleted and state is not null))
);

create table if not exists relay_private.accounts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid unique,
  name text not null check (char_length(name) between 1 and 60),
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  role text not null check (role in ('manager', 'worker')),
  enabled boolean not null default true,
  work_role text not null default '' check (char_length(work_role) <= 100),
  model text not null default '' check (char_length(model) <= 80),
  password_hash text not null,
  recovery_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role = 'manager' and agent_id is null)
      or (role = 'worker' and agent_id is not null)),
  check (role = 'manager' or recovery_hash is null)
);
create unique index if not exists relay_one_manager
  on relay_private.accounts (role) where role = 'manager';

create table if not exists relay_private.sessions (
  token_hash text primary key,
  account_id uuid not null references relay_private.accounts(id) on delete cascade,
  run_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists relay_sessions_account
  on relay_private.sessions(account_id);
create index if not exists relay_sessions_expiry
  on relay_private.sessions(expires_at);

create table if not exists relay_private.rooms (
  account_id uuid primary key references relay_private.accounts(id) on delete cascade,
  body text not null default '' check (octet_length(body) <= 100000),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists relay_private.throttle (
  bucket text primary key,
  window_start timestamptz not null,
  attempts integer not null check (attempts >= 0)
);

alter table relay_private.studio enable row level security;
alter table relay_private.accounts enable row level security;
alter table relay_private.sessions enable row level security;
alter table relay_private.rooms enable row level security;
alter table relay_private.throttle enable row level security;
-- Intentionally no end-user RLS policies: only service_role can access these
-- tables, through an invoker RPC. The private schema must never be exposed.

insert into relay_private.studio (singleton, dummy_hash)
values (true, extensions.crypt('Unusable timing-comparison password', extensions.gen_salt('bf', 12)))
on conflict (singleton) do nothing;

create or replace function relay_private.error(p_code text, p_message text, p_status integer)
returns jsonb language sql immutable security invoker set search_path = pg_catalog
as $$ select jsonb_build_object('error', jsonb_build_object(
  'code', p_code, 'message', p_message, 'status', p_status)); $$;

create or replace function relay_private.digest_token(p_token text)
returns text language sql immutable strict security invoker set search_path = pg_catalog
as $$ select encode(extensions.digest(p_token, 'sha256'), 'hex'); $$;

create or replace function relay_private.valid_password(p_password text)
returns boolean language sql immutable security invoker set search_path = pg_catalog
as $$ select coalesce(char_length(p_password) >= 12 and octet_length(p_password) <= 72, false); $$;

create or replace function relay_private.public_user(p_account relay_private.accounts)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select jsonb_build_object(
  'id', p_account.id, 'agentId', p_account.agent_id,
  'name', p_account.name, 'username', p_account.username,
  'role', p_account.role, 'enabled', p_account.enabled,
  'workRole', p_account.work_role, 'model', p_account.model); $$;

-- All callers hold studio's singleton row lock before touching rate buckets.
-- Ordinary invalid credentials return values, not exceptions, so these counters
-- are committed even when authentication is denied.
create or replace function relay_private.take_attempt(p_bucket text, p_limit integer)
returns boolean language plpgsql security invoker set search_path = pg_catalog
as $$
declare v_row relay_private.throttle%rowtype;
begin
  select * into v_row from relay_private.throttle where bucket = p_bucket;
  if not found or v_row.window_start <= clock_timestamp() - interval '15 minutes' then
    insert into relay_private.throttle(bucket, window_start, attempts)
    values (p_bucket, clock_timestamp(), 1)
    on conflict (bucket) do update set window_start = excluded.window_start, attempts = 1;
    return true;
  end if;
  if v_row.attempts >= p_limit then return false; end if;
  update relay_private.throttle set attempts = attempts + 1 where bucket = p_bucket;
  return true;
end;
$$;

create or replace function relay_private.bump_state(p_state jsonb, p_revision bigint)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select jsonb_set(jsonb_set(p_state, '{revision}', to_jsonb(p_revision)),
  '{updatedAt}', to_jsonb(clock_timestamp())); $$;

-- Account lifecycle changes must update every assignment, not only the legacy
-- primary-owner mirror. A null run removes the worker; a non-null run renews
-- that worker's unfinished assignments. Completed attribution snapshots and
-- soft-deletion/task-history fields survive.
create or replace function relay_private.update_task_worker(
  p_task jsonb, p_agent_id text, p_run_id text, p_now timestamptz
)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog
as $$
declare v_assignees jsonb; v_task jsonb;
begin
  if p_task->>'status' = 'done' then return p_task; end if;
  v_assignees := case when jsonb_typeof(p_task->'assignees') = 'array'
    then p_task->'assignees'
    when nullif(p_task->>'owner', '') is not null then
      jsonb_build_array(jsonb_build_object('agentId', p_task->>'owner', 'session', p_task->'session'))
    else '[]'::jsonb end;
  if not exists (select 1 from jsonb_array_elements(v_assignees) a
      where a->>'agentId' = p_agent_id) then
    return p_task;
  end if;
  select coalesce(jsonb_agg(case when item->>'agentId' = p_agent_id
      then item || jsonb_build_object('session', p_run_id) else item end order by ord), '[]'::jsonb)
    into v_assignees
    from jsonb_array_elements(v_assignees) with ordinality as a(item, ord)
    where p_run_id is not null or item->>'agentId' is distinct from p_agent_id;
  v_task := p_task || jsonb_build_object('assignees', v_assignees,
    'owner', v_assignees->0->>'agentId', 'session', v_assignees->0->'session',
    'version', coalesce((p_task->>'version')::bigint, 0) + 1, 'updatedAt', p_now);
  if p_run_id is null and jsonb_array_length(v_assignees) = 0
      and p_task->>'status' is distinct from 'done' then
    v_task := v_task || jsonb_build_object('status', 'ready');
  end if;
  return v_task;
end;
$$;

-- Direct messages never enter the shared studio JSON or activity log.
create table if not exists relay_private.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references relay_private.accounts(id) on delete cascade,
  recipient_id uuid not null references relay_private.accounts(id) on delete cascade,
  client_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 12000 and octet_length(body) <= 48000),
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  check (sender_id <> recipient_id),
  unique (sender_id, client_id)
);
create index if not exists relay_dm_sender on relay_private.direct_messages(sender_id, recipient_id, created_at desc, id desc);
create index if not exists relay_dm_recipient on relay_private.direct_messages(recipient_id, sender_id, created_at desc, id desc);
create index if not exists relay_dm_unread on relay_private.direct_messages(recipient_id) where read_at is null;
alter table relay_private.direct_messages enable row level security;

create or replace function relay_private.dm_json(m relay_private.direct_messages)
returns jsonb language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object('id',m.id,'senderId',m.sender_id,'recipientId',m.recipient_id,
    'body',m.body,'createdAt',m.created_at,'readAt',m.read_at);
$$;

-- Called only after relay_rpc validates the live account, token, and worker run.
-- service_role is the sole caller; the private schema is not exposed.
create or replace function relay_private.dm_action(u relay_private.accounts, action text, data jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare
  a uuid; b uuid; cursor_message relay_private.direct_messages%rowtype;
  m relay_private.direct_messages%rowtype;
  recipient relay_private.accounts%rowtype;
  client uuid; messages jsonb; contacts jsonb; threads jsonb;
  body text; n integer;
begin
  if action = 'dm.notifications' then
    return jsonb_build_object('unreadDirectMessages',
      (select count(*) from relay_private.direct_messages where recipient_id=u.id and read_at is null));
  end if;
  if action = 'dm.inbox' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'role',role,'enabled',enabled) order by lower(name)), '[]'::jsonb)
      into contacts from relay_private.accounts where id <> u.id;
    with visible as (
      select d.*,least(sender_id,recipient_id) as a,greatest(sender_id,recipient_id) as b
      from relay_private.direct_messages d
      where u.role = 'manager' or sender_id = u.id or recipient_id = u.id
    ), latest as (
      select distinct on (v.a,v.b) v.* from visible v order by v.a,v.b,v.created_at desc,v.id desc
    )
    select coalesce(jsonb_agg(jsonb_build_object('participantA',l.a,'participantB',l.b,
      'lastMessage',relay_private.dm_json(row(l.id,l.sender_id,l.recipient_id,l.client_id,l.body,l.created_at,l.read_at)::relay_private.direct_messages),
      'unreadCount',(select count(*) from visible v where v.a=l.a and v.b=l.b and v.recipient_id=u.id and v.read_at is null))
      order by l.created_at desc,l.id desc),'[]'::jsonb) into threads from latest l;
    return jsonb_build_object('contacts',contacts,'threads',threads,'unreadCount',
      (select count(*) from relay_private.direct_messages where recipient_id=u.id and read_at is null));
  end if;

  if action = 'dm.send' then
    if jsonb_typeof(data->'recipientId') is distinct from 'string'
      or coalesce(data->>'recipientId','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or jsonb_typeof(data->'clientId') is distinct from 'string'
      or coalesce(data->>'clientId','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or jsonb_typeof(data->'body') is distinct from 'string' then
      return relay_private.error('VALIDATION','Choose a recipient, message, and unique client message ID.',400);
    end if;
    a := (data->>'recipientId')::uuid; client := (data->>'clientId')::uuid; body := btrim(data->>'body');
    if char_length(body) not between 1 and 12000 or octet_length(body)>48000 or a=u.id then
      return relay_private.error('VALIDATION','Send 1–12,000 characters to another account.',400);
    end if;
    select * into m from relay_private.direct_messages where sender_id=u.id and client_id=client;
    if found then
      if m.recipient_id<>a or m.body<>body then return relay_private.error('CONFLICT','This message ID was already used for different content.',409); end if;
      return jsonb_build_object('message',relay_private.dm_json(m));
    end if;
    select * into recipient from relay_private.accounts where id=a and enabled;
    if not found then return relay_private.error('NOT_FOUND','This recipient is unavailable.',404); end if;
    if not relay_private.take_attempt('dm:send:'||u.id::text,120) then
      return relay_private.error('RATE_LIMIT','Too many messages. Try again in a few minutes.',429);
    end if;
    insert into relay_private.direct_messages(sender_id,recipient_id,client_id,body)
      values(u.id,a,client,body) returning * into m;
    return jsonb_build_object('message',relay_private.dm_json(m));
  end if;

  if action = 'dm.thread' then
    if jsonb_typeof(data->'participantA') is distinct from 'string'
      or coalesce(data->>'participantA','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or jsonb_typeof(data->'participantB') is distinct from 'string'
      or coalesce(data->>'participantB','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
      return relay_private.error('VALIDATION','Choose two conversation participants.',400);
    end if;
    a:=(data->>'participantA')::uuid; b:=(data->>'participantB')::uuid;
    if a=b or (u.role<>'manager' and u.id not in (a,b)) then
      return relay_private.error('FORBIDDEN','This conversation is private to its participants and manager.',403);
    end if;
    if data ? 'beforeId' then
      if coalesce(data->>'beforeId','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
        return relay_private.error('VALIDATION','Invalid message cursor.',400);
      end if;
      select * into cursor_message from relay_private.direct_messages
        where id=(data->>'beforeId')::uuid and ((sender_id=a and recipient_id=b) or (sender_id=b and recipient_id=a));
      if not found then return relay_private.error('NOT_FOUND','Message not found in this conversation.',404); end if;
    end if;
    select coalesce(jsonb_agg(relay_private.dm_json(d) order by d.created_at,d.id),'[]'::jsonb) into messages from (
      select * from relay_private.direct_messages
      where ((sender_id=a and recipient_id=b) or (sender_id=b and recipient_id=a))
        and (cursor_message.id is null or (created_at,id)<(cursor_message.created_at,cursor_message.id))
      order by created_at desc,id desc limit 50
    ) d;
    return jsonb_build_object('messages',messages,'hasMore',jsonb_array_length(messages)=50);
  end if;

  if action = 'dm.read' then
    if jsonb_typeof(data->'messageIds') is distinct from 'array' then
      return relay_private.error('VALIDATION','Supply the IDs of received messages you have read.',400);
    end if;
    if jsonb_array_length(data->'messageIds')>100 or exists(
      select 1 from jsonb_array_elements(data->'messageIds') x where jsonb_typeof(x)<>'string'
        or (x#>>'{}') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
      return relay_private.error('VALIDATION','Supply at most 100 valid message IDs.',400);
    end if;
    -- Managers inspecting other workers' messages do not consume their unread state.
    update relay_private.direct_messages set read_at=clock_timestamp()
      where recipient_id=u.id and read_at is null and id in (
        select (x#>>'{}')::uuid from jsonb_array_elements(data->'messageIds') x);
    get diagnostics n = row_count;
    return jsonb_build_object('markedRead',n,'unreadCount',
      (select count(*) from relay_private.direct_messages where recipient_id=u.id and read_at is null));
  end if;
  return relay_private.error('UNKNOWN_ACTION','Unknown message action.',400);
end;
$$;

create or replace function public.relay_rpc(
  p_action text,
  p_token text default '',
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_studio relay_private.studio%rowtype;
  v_user relay_private.accounts%rowtype;
  v_target relay_private.accounts%rowtype;
  v_session relay_private.sessions%rowtype;
  v_room relay_private.rooms%rowtype;
  v_username text;
  v_name text;
  v_password text;
  v_role text;
  v_work_role text;
  v_model text;
  v_capabilities text;
  v_hash text;
  v_ok boolean;
  v_rate_key text;
  v_account_bucket text;
  v_token text;
  v_recovery text;
  v_expires timestamptz;
  v_agent_id uuid;
  v_run_id text;
  v_target_id uuid;
  v_state jsonb;
  v_agent jsonb;
  v_agents jsonb;
  v_tasks jsonb;
  v_workers jsonb;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_action is null or char_length(p_action) > 64
      or jsonb_typeof(p_data) is distinct from 'object' then
    return relay_private.error('VALIDATION', 'Invalid request.', 400);
  end if;

  -- A common lock makes account changes, revocation, board CAS, initial setup,
  -- and full deletion atomic relative to one another, including in concurrent
  -- Edge invocations. This is appropriate for a small private agent studio.
  select * into v_studio from relay_private.studio where singleton = true for update;
  if not found then
    return relay_private.error('CONFIGURATION', 'The studio database is not initialized.', 503);
  end if;

  if p_action = 'status' then
    return jsonb_build_object('needsSetup', not v_studio.initialized and not v_studio.deleted,
      'deleted', v_studio.deleted);
  end if;
  if v_studio.deleted then
    return relay_private.error('DELETED', 'This studio has been permanently deleted.', 410);
  end if;

  -- Edge supplies a privacy-preserving hash of its trusted client IP. Caller
  -- JSON must never be allowed to override that value in the Edge Function.
  v_rate_key := relay_private.digest_token(left(coalesce(p_data->>'rateKey', 'unknown'), 256));
  v_username := lower(btrim(coalesce(p_data->>'username', '')));

  if p_action = 'setup' then
    if v_studio.initialized then
      return relay_private.error('SETUP_CLOSED', 'A manager already exists. Sign in instead.', 409);
    end if;
    if v_studio.setup_hash is null then
      return relay_private.error('SETUP_DISABLED', 'Owner setup must first be enabled by the deployment owner.', 503);
    end if;
    if not relay_private.take_attempt('setup:ip:' || v_rate_key, 10)
      or not relay_private.take_attempt('setup:global', 30) then
      return relay_private.error('RATE_LIMIT', 'Too many setup attempts. Try again in 15 minutes.', 429);
    end if;
    if jsonb_typeof(p_data->'setupCode') is distinct from 'string'
      or octet_length(p_data->>'setupCode') > 256
      or relay_private.digest_token(p_data->>'setupCode') is distinct from v_studio.setup_hash then
      return relay_private.error('AUTH', 'The setup code is incorrect.', 401);
    end if;
    v_name := btrim(coalesce(p_data->>'name', ''));
    v_password := p_data->>'password';
    if jsonb_typeof(p_data->'name') is distinct from 'string'
      or char_length(v_name) not between 1 and 60
      or jsonb_typeof(p_data->'username') is distinct from 'string'
      or v_username !~ '^[a-z0-9][a-z0-9._-]{2,39}$'
      or jsonb_typeof(p_data->'password') is distinct from 'string'
      or not relay_private.valid_password(v_password) then
      return relay_private.error('VALIDATION', 'Use a name up to 60 characters, a 3–40 character login, and a password of at least 12 characters and at most 72 UTF-8 bytes.', 400);
    end if;
    v_state := p_data->'state';
    -- Setup accepts only the server's empty engine state. Never import accounts,
    -- rooms, credentials, or an old board through an untrusted setup request.
    if jsonb_typeof(v_state) is distinct from 'object'
      or v_state->>'schema' is distinct from '1'
      or v_state->>'revision' is distinct from '0'
      or jsonb_typeof(v_state->'project') is distinct from 'object'
      or exists (select 1 from unnest(array['agents','tasks','messages','requests','builds','memory','activity','operations']) k
                 where v_state->k is distinct from '[]'::jsonb)
      or octet_length(v_state::text) > 20000 then
      return relay_private.error('VALIDATION', 'Setup needs a fresh empty project state.', 400);
    end if;
    v_recovery := encode(extensions.gen_random_bytes(32), 'hex');
    insert into relay_private.accounts(name, username, role, password_hash, recovery_hash)
    values (v_name, v_username, 'manager',
      extensions.crypt(v_password, extensions.gen_salt('bf', 12)),
      relay_private.digest_token(v_recovery)) returning * into v_user;
    insert into relay_private.rooms(account_id) values (v_user.id);
    update relay_private.studio set initialized = true, setup_hash = null,
      state = v_state, revision = 0, updated_at = v_now where singleton = true;
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_expires := v_now + interval '24 hours';
    insert into relay_private.sessions(token_hash, account_id, expires_at)
      values (relay_private.digest_token(v_token), v_user.id, v_expires);
    return jsonb_build_object('token', v_token, 'expiresAt', v_expires,
      'user', relay_private.public_user(v_user), 'recoveryCode', v_recovery);
  end if;

  if not v_studio.initialized then
    return relay_private.error('SETUP_REQUIRED', 'The owner must create the manager account first.', 409);
  end if;

  if p_action = 'login' then
    v_account_bucket := 'login:account:' || relay_private.digest_token(v_username);
    if not relay_private.take_attempt('login:ip:' || v_rate_key, 60)
      or not relay_private.take_attempt(v_account_bucket, 10) then
      return relay_private.error('RATE_LIMIT', 'Too many sign-in attempts. Try again in 15 minutes.', 429);
    end if;
    v_password := p_data->>'password';
    v_role := p_data->>'role';
    select * into v_user from relay_private.accounts where username = v_username;
    v_hash := coalesce(v_user.password_hash, v_studio.dummy_hash);
    -- Always perform one bcrypt operation for ordinary credential failures,
    -- including unknown usernames, disabled accounts, and wrong role choices.
    if jsonb_typeof(p_data->'password') = 'string' and relay_private.valid_password(v_password) then
      v_ok := extensions.crypt(v_password, v_hash) = v_hash;
    else
      perform extensions.crypt('Invalid submitted password', v_studio.dummy_hash);
      v_ok := false;
    end if;
    if not coalesce(v_ok and v_user.id is not null and v_user.enabled
        and v_user.role = v_role and v_role in ('manager', 'worker'), false) then
      return relay_private.error('AUTH', 'Incorrect login, password, or account type.', 401);
    end if;
    v_run_id := null;
    if v_user.role = 'worker' then
      select item into v_agent from jsonb_array_elements(v_studio.state->'agents') item
        where item->>'id' = v_user.agent_id::text;
      if v_agent is null or v_agent->>'enabled' is distinct from 'true'
          or coalesce(v_agent->>'session', '') = '' then
        return relay_private.error('AUTH', 'Incorrect login, password, or account type.', 401);
      end if;
      v_run_id := v_agent->>'session';
    end if;
    delete from relay_private.throttle where bucket = v_account_bucket;
    delete from relay_private.sessions where expires_at <= v_now;
    delete from relay_private.throttle where window_start < v_now - interval '2 days';
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_expires := v_now + interval '24 hours';
    insert into relay_private.sessions(token_hash, account_id, run_id, expires_at)
    values (relay_private.digest_token(v_token), v_user.id, v_run_id, v_expires);
    return jsonb_build_object('token', v_token, 'expiresAt', v_expires,
      'user', relay_private.public_user(v_user));
  end if;

  if p_action = 'recovery.reset' then
    v_account_bucket := 'recovery:account:' || relay_private.digest_token(v_username);
    if not relay_private.take_attempt('recovery:ip:' || v_rate_key, 20)
      or not relay_private.take_attempt(v_account_bucket, 5) then
      return relay_private.error('RATE_LIMIT', 'Too many recovery attempts. Try again in 15 minutes.', 429);
    end if;
    select * into v_user from relay_private.accounts where username = v_username and role = 'manager';
    v_recovery := p_data->>'recoveryCode';
    if v_user.id is null or jsonb_typeof(p_data->'recoveryCode') is distinct from 'string'
      or v_recovery !~ '^[a-f0-9]{64}$'
      or relay_private.digest_token(v_recovery) is distinct from v_user.recovery_hash then
      return relay_private.error('AUTH', 'Incorrect manager login or recovery code.', 401);
    end if;
    v_password := p_data->>'newPassword';
    if jsonb_typeof(p_data->'newPassword') is distinct from 'string'
      or not relay_private.valid_password(v_password) then
      return relay_private.error('VALIDATION', 'Passwords need at least 12 characters and at most 72 UTF-8 bytes.', 400);
    end if;
    v_recovery := encode(extensions.gen_random_bytes(32), 'hex');
    update relay_private.accounts set password_hash = extensions.crypt(v_password, extensions.gen_salt('bf', 12)),
      recovery_hash = relay_private.digest_token(v_recovery), updated_at = v_now where id = v_user.id;
    delete from relay_private.sessions where account_id = v_user.id;
    delete from relay_private.throttle where bucket in (v_account_bucket,
      'login:account:' || relay_private.digest_token(v_username));
    update relay_private.studio set revision = revision + 1,
      state = relay_private.bump_state(state, revision + 1), updated_at = v_now where singleton = true;
    return jsonb_build_object('ok', true, 'recoveryCode', v_recovery);
  end if;

  -- No client-provided actor, role, agent ID or owner flag is trusted here.
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    return relay_private.error('SESSION', 'Sign in to continue.', 401);
  end if;
  select * into v_session from relay_private.sessions
    where token_hash = relay_private.digest_token(p_token) and expires_at > v_now;
  if not found then return relay_private.error('SESSION', 'Your session expired. Sign in again.', 401); end if;
  select * into v_user from relay_private.accounts where id = v_session.account_id and enabled;
  if not found then return relay_private.error('SESSION', 'Your session expired. Sign in again.', 401); end if;

  if p_action = 'logout' then
    delete from relay_private.sessions where token_hash = v_session.token_hash;
    return jsonb_build_object('ok', true);
  end if;
  if v_user.role = 'worker' then
    select item into v_agent from jsonb_array_elements(v_studio.state->'agents') item
      where item->>'id' = v_user.agent_id::text;
    if v_agent is null or v_agent->>'enabled' is distinct from 'true' then
      return relay_private.error('SESSION', 'This worker is disabled. Ask the manager.', 401);
    end if;
    if v_session.run_id is distinct from v_agent->>'session' then
      return relay_private.error('STALE_SESSION', 'This worker run was replaced. Sign in again and read the current handoff.', 409);
    end if;
  end if;

  if p_action = 'context' then
    select * into v_room from relay_private.rooms where account_id = v_user.id;
    v_workers := '[]'::jsonb;
    if v_user.role = 'manager' then
      select coalesce(jsonb_agg(relay_private.public_user(a) order by a.created_at), '[]'::jsonb)
        into v_workers from relay_private.accounts a where role = 'worker';
    end if;
    return jsonb_build_object('user', relay_private.public_user(v_user),
      'actor', jsonb_build_object('id', case when v_user.role = 'manager' then 'owner' else v_user.agent_id::text end,
        'owner', v_user.role = 'manager', 'session', v_session.run_id),
      'state', v_studio.state,
      'room', jsonb_build_object('accountId', v_user.id, 'body', coalesce(v_room.body, ''),
        'version', coalesce(v_room.version, 0), 'updatedAt', v_room.updated_at),
      'workers', v_workers,
      'manager', (select jsonb_build_object('name', a.name)
        from relay_private.accounts a where a.role = 'manager'),
      'capabilities', jsonb_build_object('taskLifecycleV1', true));
  end if;

  if p_action in ('room.read', 'room.save') then
    v_target_id := v_user.id;
    if p_data ? 'accountId' then
      if jsonb_typeof(p_data->'accountId') is distinct from 'string'
        or p_data->>'accountId' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
        return relay_private.error('VALIDATION', 'Invalid room account.', 400);
      end if;
      v_target_id := (p_data->>'accountId')::uuid;
    end if;
    if v_target_id <> v_user.id and v_user.role <> 'manager' then
      return relay_private.error('FORBIDDEN', 'You can only access your own room.', 403);
    end if;
    select * into v_room from relay_private.rooms where account_id = v_target_id;
    if not found then return relay_private.error('NOT_FOUND', 'Room not found.', 404); end if;
    if p_action = 'room.save' then
      if jsonb_typeof(p_data->'body') is distinct from 'string'
        or octet_length(p_data->>'body') > 100000
        or jsonb_typeof(p_data->'expectedVersion') is distinct from 'number'
        or (p_data->>'expectedVersion') !~ '^[0-9]{1,18}$' then
        return relay_private.error('VALIDATION', 'Room notes are limited to 100,000 bytes and require their saved version.', 400);
      end if;
      if (p_data->>'expectedVersion')::bigint <> v_room.version then
        return relay_private.error('CONFLICT', 'This room changed in another session. Reload it before saving.', 409);
      end if;
      update relay_private.rooms set body = p_data->>'body', version = version + 1, updated_at = v_now
        where account_id = v_target_id returning * into v_room;
    end if;
    return jsonb_build_object('accountId', v_room.account_id, 'body', v_room.body,
      'version', v_room.version, 'updatedAt', v_room.updated_at);
  end if;

  if p_action = 'board.commit' then
    -- Internal only: Edge must NEVER dispatch an incoming board.commit request.
    -- It computes the next board using the authenticated context and engine,
    -- then passes it here. Session and run are revalidated under the same lock.
    if jsonb_typeof(p_data->'expectedRevision') is distinct from 'number'
      or p_data->>'expectedRevision' !~ '^[0-9]{1,18}$' then
      return relay_private.error('VALIDATION', 'A board revision is required.', 400);
    end if;
    v_revision := (p_data->>'expectedRevision')::bigint;
    if v_revision <> v_studio.revision then
      return relay_private.error('CONFLICT', 'The board changed. Read the latest state and retry.', 409);
    end if;
    v_state := p_data->'state';
    if jsonb_typeof(v_state) is distinct from 'object'
      or v_state->>'schema' is distinct from '1'
      or v_state->>'revision' is distinct from (v_revision + 1)::text
      or jsonb_typeof(v_state->'project') is distinct from 'object'
      or octet_length(v_state::text) > 2000000
      or exists (select 1 from unnest(array['agents','tasks','messages','requests','builds','memory','activity','operations']) k
                 where jsonb_typeof(v_state->k) is distinct from 'array') then
      return relay_private.error('VALIDATION', 'Invalid next board state or board exceeds 2 MB.', 400);
    end if;
    -- Account endpoints alone control the credential-associated agent fields.
    if exists (
      select 1 from relay_private.accounts a where a.role = 'worker'
      and not exists (select 1 from jsonb_array_elements(v_state->'agents') item
        where item->>'id' = a.agent_id::text and item->>'name' = a.name
          and item->>'role' = a.work_role and coalesce(item->>'model', '') = a.model
          and item->>'enabled' = a.enabled::text)
    ) then
      return relay_private.error('ACCOUNT_CONFLICT', 'Use worker account settings to change account-associated agents.', 409);
    end if;
    update relay_private.studio set state = v_state, revision = v_revision + 1,
      updated_at = v_now where singleton = true;
    return jsonb_build_object('state', v_state, 'revision', v_revision + 1);
  end if;

  if v_user.role <> 'manager' then
    return relay_private.error('FORBIDDEN', 'Only the manager can perform this action.', 403);
  end if;

  -- Sensitive manager operations require a fresh password proof. Keeping the
  -- rate counter in this transaction preserves it on normal failed responses.
  if p_action in ('workers.reset', 'workers.delete', 'password.change', 'recovery.rotate', 'workspace.delete') then
    v_account_bucket := 'reauth:account:' || v_user.id::text;
    if not relay_private.take_attempt(v_account_bucket, 8) then
      return relay_private.error('RATE_LIMIT', 'Too many password attempts. Try again in 15 minutes.', 429);
    end if;
    v_password := p_data->>'currentPassword';
    if jsonb_typeof(p_data->'currentPassword') is distinct from 'string'
      or not relay_private.valid_password(v_password) then
      perform extensions.crypt('Invalid submitted password', v_studio.dummy_hash);
      return relay_private.error('AUTH', 'The current manager password is incorrect.', 401);
    end if;
    if extensions.crypt(v_password, v_user.password_hash) <> v_user.password_hash then
      return relay_private.error('AUTH', 'The current manager password is incorrect.', 401);
    end if;
    delete from relay_private.throttle where bucket = v_account_bucket;
  end if;

  if p_action = 'workers.create' then
    v_name := btrim(coalesce(p_data->>'name', ''));
    v_password := p_data->>'password';
    v_work_role := btrim(coalesce(p_data->>'workRole', 'Builder'));
    v_model := btrim(coalesce(p_data->>'model', ''));
    v_capabilities := btrim(coalesce(p_data->>'capabilities', ''));
    if jsonb_typeof(p_data->'name') is distinct from 'string'
      or char_length(v_name) not between 1 and 60
      or jsonb_typeof(p_data->'username') is distinct from 'string'
      or v_username !~ '^[a-z0-9][a-z0-9._-]{2,39}$'
      or jsonb_typeof(p_data->'password') is distinct from 'string'
      or not relay_private.valid_password(v_password)
      or (p_data ? 'workRole' and jsonb_typeof(p_data->'workRole') is distinct from 'string')
      or (p_data ? 'model' and jsonb_typeof(p_data->'model') is distinct from 'string')
      or (p_data ? 'capabilities' and jsonb_typeof(p_data->'capabilities') is distinct from 'string')
      or char_length(v_work_role) not between 1 and 100
      or char_length(v_model) > 80 or char_length(v_capabilities) > 1000 then
      return relay_private.error('VALIDATION', 'Check the worker name, login, password, and role lengths.', 400);
    end if;
    if exists (select 1 from relay_private.accounts where username = v_username or lower(name) = lower(v_name)) then
      return relay_private.error('CONFLICT', 'Choose a unique worker name and login.', 409);
    end if;
    if (select count(*) from relay_private.accounts where role = 'worker') >= 100 then
      return relay_private.error('LIMIT', 'This studio supports up to 100 worker slots.', 400);
    end if;
    v_agent_id := gen_random_uuid();
    v_run_id := gen_random_uuid()::text;
    insert into relay_private.accounts(agent_id, name, username, role, work_role, model, password_hash)
    values (v_agent_id, v_name, v_username, 'worker', v_work_role, v_model,
      extensions.crypt(v_password, extensions.gen_salt('bf', 12))) returning * into v_target;
    insert into relay_private.rooms(account_id) values (v_target.id);
    v_agent := jsonb_build_object('id', v_agent_id, 'name', v_name, 'role', v_work_role,
      'model', v_model, 'capabilities', v_capabilities, 'enabled', true, 'session', v_run_id,
      'lastSeen', null, 'lastProgress', null, 'checkpoint', '', 'createdAt', v_now);
    v_state := jsonb_set(v_studio.state, '{agents}', (v_studio.state->'agents') || jsonb_build_array(v_agent));
    v_state := relay_private.bump_state(v_state, v_studio.revision + 1);
    update relay_private.studio set state = v_state, revision = revision + 1, updated_at = v_now where singleton = true;
    return relay_private.public_user(v_target);
  end if;

  if p_action in ('workers.update', 'workers.reset', 'workers.delete') then
    if jsonb_typeof(p_data->'workerId') is distinct from 'string'
      or p_data->>'workerId' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
      return relay_private.error('VALIDATION', 'Choose a worker account.', 400);
    end if;
    select * into v_target from relay_private.accounts
      where id = (p_data->>'workerId')::uuid and role = 'worker';
    if not found then return relay_private.error('NOT_FOUND', 'Worker account not found.', 404); end if;
    v_agent_id := v_target.agent_id;
    if p_action = 'workers.update' then
      v_name := case when p_data ? 'name' then btrim(p_data->>'name') else v_target.name end;
      v_work_role := case when p_data ? 'workRole' then btrim(p_data->>'workRole') else v_target.work_role end;
      if v_name is null or char_length(v_name) not between 1 and 60
        or v_work_role is null or char_length(v_work_role) not between 1 and 100
        or (p_data ? 'name' and jsonb_typeof(p_data->'name') is distinct from 'string')
        or (p_data ? 'workRole' and jsonb_typeof(p_data->'workRole') is distinct from 'string')
        or (p_data ? 'enabled' and jsonb_typeof(p_data->'enabled') is distinct from 'boolean') then
        return relay_private.error('VALIDATION', 'Use a valid worker name, role, and enabled flag.', 400);
      end if;
      if exists (select 1 from relay_private.accounts where id <> v_target.id and lower(name) = lower(v_name)) then
        return relay_private.error('CONFLICT', 'Choose a unique worker name.', 409);
      end if;
      update relay_private.accounts set name = v_name, work_role = v_work_role,
        enabled = case when p_data ? 'enabled' then (p_data->>'enabled')::boolean else enabled end,
        updated_at = v_now where id = v_target.id returning * into v_target;
      select coalesce(jsonb_agg(case when item->>'id' = v_agent_id::text then
        item || jsonb_build_object('name', v_target.name, 'role', v_target.work_role, 'enabled', v_target.enabled)
        else item end order by ord), '[]'::jsonb) into v_agents
      from jsonb_array_elements(v_studio.state->'agents') with ordinality as a(item, ord);
      v_state := jsonb_set(v_studio.state, '{agents}', v_agents);
      if not v_target.enabled then delete from relay_private.sessions where account_id = v_target.id; end if;
    elsif p_action = 'workers.reset' then
      v_password := p_data->>'newPassword';
      if jsonb_typeof(p_data->'newPassword') is distinct from 'string'
        or not relay_private.valid_password(v_password) then
        return relay_private.error('VALIDATION', 'Passwords need at least 12 characters and at most 72 UTF-8 bytes.', 400);
      end if;
      update relay_private.accounts set password_hash = extensions.crypt(v_password, extensions.gen_salt('bf', 12)),
        updated_at = v_now where id = v_target.id returning * into v_target;
      delete from relay_private.sessions where account_id = v_target.id;
      delete from relay_private.throttle where bucket = 'login:account:' || relay_private.digest_token(v_target.username);
      v_run_id := gen_random_uuid()::text;
      select coalesce(jsonb_agg(case when item->>'id' = v_agent_id::text then
        item || jsonb_build_object('session', v_run_id, 'lastSeen', null)
        else item end order by ord), '[]'::jsonb) into v_agents
      from jsonb_array_elements(v_studio.state->'agents') with ordinality as a(item, ord);
      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, v_run_id, v_now) order by ord), '[]'::jsonb) into v_tasks
      from jsonb_array_elements(v_studio.state->'tasks') with ordinality as t(item, ord);
      v_state := jsonb_set(jsonb_set(v_studio.state, '{agents}', v_agents), '{tasks}', v_tasks);
    else
      if p_data->>'confirmation' is distinct from v_target.username then
        return relay_private.error('CONFIRMATION', 'Type the worker login to delete this slot.', 400);
      end if;
      -- Shared posts/history remain attributed to a disabled anonymous tombstone.
      -- Remove this worker's assignments while preserving other workers' runs.
      -- The private account, room, password, and all sessions are removed.
      select coalesce(jsonb_agg(case when item->>'id' = v_agent_id::text then
        item || jsonb_build_object('name', 'Deleted worker', 'role', 'Removed', 'model', '',
          'capabilities', '', 'enabled', false, 'session', null, 'checkpoint', '',
          'lastSeen', null, 'lastProgress', null, 'deleted', true)
        else item end order by ord), '[]'::jsonb) into v_agents
      from jsonb_array_elements(v_studio.state->'agents') with ordinality as a(item, ord);
      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, null, v_now) order by ord), '[]'::jsonb) into v_tasks
      from jsonb_array_elements(v_studio.state->'tasks') with ordinality as t(item, ord);
      v_state := jsonb_set(jsonb_set(v_studio.state, '{agents}', v_agents), '{tasks}', v_tasks);
      delete from relay_private.accounts where id = v_target.id;
      delete from relay_private.throttle where bucket in (
        'login:account:' || relay_private.digest_token(v_target.username),
        'reauth:account:' || v_target.id::text);
    end if;
    v_state := relay_private.bump_state(v_state, v_studio.revision + 1);
    update relay_private.studio set state = v_state, revision = revision + 1, updated_at = v_now where singleton = true;
    if p_action = 'workers.delete' then return jsonb_build_object('ok', true); end if;
    return relay_private.public_user(v_target);
  end if;

  if p_action = 'password.change' then
    v_password := p_data->>'newPassword';
    if jsonb_typeof(p_data->'newPassword') is distinct from 'string'
      or not relay_private.valid_password(v_password) then
      return relay_private.error('VALIDATION', 'Passwords need at least 12 characters and at most 72 UTF-8 bytes.', 400);
    end if;
    update relay_private.accounts set password_hash = extensions.crypt(v_password, extensions.gen_salt('bf', 12)),
      updated_at = v_now where id = v_user.id;
    delete from relay_private.sessions where account_id = v_user.id;
    update relay_private.studio set revision = revision + 1,
      state = relay_private.bump_state(state, revision + 1), updated_at = v_now where singleton = true;
    return jsonb_build_object('ok', true);
  end if;

  if p_action = 'recovery.rotate' then
    v_recovery := encode(extensions.gen_random_bytes(32), 'hex');
    update relay_private.accounts set recovery_hash = relay_private.digest_token(v_recovery),
      updated_at = v_now where id = v_user.id;
    update relay_private.studio set revision = revision + 1,
      state = relay_private.bump_state(state, revision + 1), updated_at = v_now where singleton = true;
    return jsonb_build_object('recoveryCode', v_recovery);
  end if;

  if p_action = 'workspace.delete' then
    if p_data->>'confirmation' is distinct from 'DELETE MY STUDIO' then
      return relay_private.error('CONFIRMATION', 'Type DELETE MY STUDIO to permanently delete it.', 400);
    end if;
    delete from relay_private.accounts; -- sessions and rooms cascade
    delete from relay_private.throttle;
    update relay_private.studio set state = null, revision = 0, setup_hash = null,
      initialized = true, deleted = true, updated_at = v_now where singleton = true;
    return jsonb_build_object('ok', true, 'deleted', true);
  end if;

  return relay_private.error('UNKNOWN_ACTION', 'Unknown action.', 400);
exception
  when unique_violation then
    return relay_private.error('CONFLICT', 'This account already exists. Choose a different name or login.', 409);
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    return relay_private.error('VALIDATION', 'Invalid request values.', 400);
end;
$$;

create or replace function public.relay_dm_rpc(p_action text, p_token text default '', p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare context jsonb; u relay_private.accounts%rowtype;
begin
  if p_action not in ('dm.inbox','dm.thread','dm.send','dm.read','dm.notifications') or p_action is null
    or jsonb_typeof(p_data) is distinct from 'object' then
    return relay_private.error('VALIDATION','Invalid private message request.',400);
  end if;
  -- Reuse the unchanged account RPC: it validates live sessions and worker runs,
  -- and holds the studio row lock through this transaction.
  context := public.relay_rpc('context',p_token,'{}'::jsonb);
  if context ? 'error' then return context; end if;
  select * into u from relay_private.accounts where id=(context->'user'->>'id')::uuid;
  if not found then return relay_private.error('SESSION','Sign in again.',401); end if;
  return relay_private.dm_action(u,p_action,p_data);
end;
$$;

revoke all on schema relay_private from public, anon, authenticated, service_role;
revoke all on all tables in schema relay_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema relay_private from public, anon, authenticated, service_role;
revoke all on all functions in schema relay_private from public, anon, authenticated, service_role;
alter default privileges in schema relay_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema relay_private revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema relay_private revoke execute on functions from public, anon, authenticated, service_role;
revoke all on function public.relay_rpc(text, text, jsonb) from public, anon, authenticated;
grant usage on schema relay_private to service_role;
grant usage on schema extensions to service_role;
grant execute on function extensions.digest(text, text),
  extensions.crypt(text, text), extensions.gen_salt(text, integer),
  extensions.gen_random_bytes(integer) to service_role;
grant select, insert, update, delete on all tables in schema relay_private to service_role;
grant execute on all functions in schema relay_private to service_role;
grant execute on function public.relay_rpc(text, text, jsonb) to service_role;
revoke all on function public.relay_dm_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.relay_dm_rpc(text,text,jsonb) to service_role;

commit;
