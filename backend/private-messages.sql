-- Additive DM feature only. Existing authentication RPC and account permissions are unchanged.
begin;
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

revoke all on relay_private.direct_messages from public,anon,authenticated;
grant select,insert,update,delete on relay_private.direct_messages to service_role;
revoke all on function relay_private.dm_json(relay_private.direct_messages) from public,anon,authenticated;
revoke all on function relay_private.dm_action(relay_private.accounts,text,jsonb) from public,anon,authenticated;
grant execute on function relay_private.dm_json(relay_private.direct_messages),relay_private.dm_action(relay_private.accounts,text,jsonb) to service_role;
revoke all on function public.relay_dm_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.relay_dm_rpc(text,text,jsonb) to service_role;

commit;
