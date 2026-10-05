-- Prepared local artifact. Do not apply without approval for the target database.
-- Current task-controls base: fc7cd34c75fa320047c00dfa76fbdd8bfba0419f.
-- Requires exact verified account/lifecycle/DM definitions and restricted privileges.
-- Adds only the durable message contract; never reapplies the account schema.
-- No account/session/task/board rows, account RPC, or task helper are rewritten.
-- Legacy private messages are imported without outbox notifications.
-- Run as database owner. Read MESSAGING-MERGE-TEST-NOTES.md before rollout.
begin;

do $message_guard$
declare v_oid oid; v_installed boolean; v_expected text; v_item record; v_table text;
begin
  -- The same row lock serializes account, board and message RPCs.
  perform 1 from relay_private.studio where singleton for update;
  if not found then raise exception 'Relay studio row is missing; no changes applied.'; end if;
  if has_schema_privilege('anon','relay_private','USAGE')
    or has_schema_privilege('authenticated','relay_private','USAGE')
    or not has_schema_privilege('service_role','relay_private','USAGE') then
    raise exception 'Unexpected relay_private schema privileges; no changes applied.';
  end if;
  v_installed := to_regprocedure('public.relay_message_rpc(text,text,jsonb)') is not null;
  if not v_installed and (
    to_regclass('relay_private.message_records') is not null or to_regclass('relay_private.message_outbox') is not null
    or exists (select 1 from information_schema.columns where table_schema='relay_private' and table_name='studio' and column_name in ('workspace_id','message_room_id'))
  ) then raise exception 'Partial or unexpected message installation; no changes applied.'; end if;
  for v_item in select * from (values
      ('public.relay_rpc(text,text,jsonb)', 'a1828d6823d03c92c15e96e5460f6ee0', 'a1828d6823d03c92c15e96e5460f6ee0', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.update_task_worker(jsonb,text,text,timestamptz)', '0a35847000b1587329990102943670df', '0a35847000b1587329990102943670df', 'plpgsql', 's', 'jsonb'),
      ('public.relay_dm_rpc(text,text,jsonb)', '5ab0e7a4a8506c485953a1617d85bf13', '5ab0e7a4a8506c485953a1617d85bf13', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.dm_json(relay_private.direct_messages)', '683b16f4a06814ef8e7107dc0f4502f6', '683b16f4a06814ef8e7107dc0f4502f6', 'sql', 's', 'jsonb'),
      ('relay_private.dm_action(relay_private.accounts,text,jsonb)', '010ed18119173991062d2f6798d6fb8a', 'b5536ea24723753b46bbc89d3463c9a5', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_json(relay_private.message_records)', null, '52e02119fc88f00fd592c0f08a6687d6', 'sql', 's', 'jsonb'),
      ('relay_private.message_rejected(text)', null, 'fa30df26b8760854d0345a0d74611a66', 'sql', 'i', 'jsonb'),
      ('relay_private.message_delete_dm()', null, 'a79ce864e91a11a9da2f6764a2ad12b2', 'plpgsql', 'v', 'trigger'),
      ('relay_private.message_delete_workspace()', null, '53d707e073aa4c3265c02a4cb7b0e9e5', 'plpgsql', 'v', 'trigger'),
      ('relay_private.message_action(relay_private.accounts,text,jsonb)', null, '56ddc22fbf55ae4671687bdcde14d89b', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_composer_send(relay_private.accounts,jsonb)', null, '310aee1659a5440b23a34804a40e1284', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_legacy_dm_send(relay_private.accounts,jsonb)', null, '96f903daf68bb4f7aa9d5e07adc0777b', 'plpgsql', 'v', 'jsonb'),
      ('public.relay_message_rpc(text,text,jsonb)', null, '4ea26389c1350282d614a60d7c70713e', 'plpgsql', 'v', 'jsonb')
    ) as expected(signature,baseline_hash,message_hash,language,volatility,result_type)
  loop
    v_expected := case when v_installed then v_item.message_hash else v_item.baseline_hash end;
    if v_expected is null then
      if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=split_part(v_item.signature,'(',1)) then
        raise exception 'Unexpected existing message function %; no changes applied.',v_item.signature;
      end if;
      continue;
    end if;
    v_oid := to_regprocedure(v_item.signature);
    if v_oid is null then raise exception 'Required function % is missing; no changes applied.',v_item.signature; end if;
    if exists (select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=v_oid and
      (md5(p.prosrc)<>v_expected or l.lanname<>v_item.language or p.provolatile::text<>v_item.volatility
       or p.prorettype<>v_item.result_type::regtype or p.prosecdef
       or p.proconfig is distinct from array['search_path=pg_catalog']::text[])) then
      raise exception 'Unexpected definition for %; no changes applied.',v_item.signature;
    end if;
    if has_function_privilege('anon',v_oid,'EXECUTE') or has_function_privilege('authenticated',v_oid,'EXECUTE')
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then
      raise exception 'Unexpected privileges for %; no changes applied.',v_item.signature;
    end if;
  end loop;
  foreach v_table in array array['studio','accounts','sessions','rooms','throttle','direct_messages','message_records','message_outbox']
  loop
    v_oid := to_regclass('relay_private.'||v_table);
    if v_oid is null and not v_installed and v_table in ('message_records','message_outbox') then continue; end if;
    if v_oid is null or exists(select 1 from pg_class where oid=v_oid and (relkind<>'r' or not relrowsecurity)) then
      raise exception 'Missing or unsafe Relay table %; no changes applied.',v_table;
    end if;
    if has_table_privilege('anon',v_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',v_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or not (has_table_privilege('service_role',v_oid,'SELECT') and has_table_privilege('service_role',v_oid,'INSERT')
        and has_table_privilege('service_role',v_oid,'UPDATE') and has_table_privilege('service_role',v_oid,'DELETE')) then
      raise exception 'Unexpected Relay table privileges for %; no changes applied.',v_table;
    end if;
  end loop;
  for v_item in select * from (values
    ('relay_message_dm_deleted','relay_private.direct_messages','relay_private.message_delete_dm()',9),
    ('relay_message_workspace_deleted','relay_private.studio','relay_private.message_delete_workspace()',17)
  ) as expected(trigger_name,table_name,function_name,trigger_type)
  loop
    if not v_installed then
      if exists(select 1 from pg_trigger where tgrelid=v_item.table_name::regclass and tgname=v_item.trigger_name) then
        raise exception 'Unexpected message trigger %; no changes applied.',v_item.trigger_name;
      end if;
    elsif not exists(select 1 from pg_trigger where tgrelid=v_item.table_name::regclass and tgname=v_item.trigger_name
      and tgfoid=v_item.function_name::regprocedure and tgtype=v_item.trigger_type and tgenabled='O'
      and not tgisinternal and tgqual is null and tgnargs=0 and tgattr=''::int2vector) then
      raise exception 'Unexpected message trigger definition %; no changes applied.',v_item.trigger_name;
    end if;
  end loop;
end;
$message_guard$;

-- BEGIN GUARDED MESSAGE CONTRACT
alter table relay_private.studio add column if not exists workspace_id uuid not null default gen_random_uuid();
alter table relay_private.studio add column if not exists message_room_id uuid not null default gen_random_uuid();

create table if not exists relay_private.message_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  room_id uuid not null,
  sender_id uuid not null,
  client_id uuid not null,
  visibility text not null check (visibility in ('public','private')),
  participant_ids uuid[] not null,
  request jsonb,
  fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique(workspace_id,sender_id,client_id),
  check ((deleted_at is null and request is not null) or deleted_at is not null)
);
alter table relay_private.message_records add column if not exists composer_context jsonb;
-- Scrub content retained by older tombstones on an additive reinstall.
update relay_private.message_records set request=null,composer_context=null
  where deleted_at is not null and (request is not null or composer_context is not null);
create index if not exists relay_message_history on relay_private.message_records(workspace_id,created_at desc,id desc) where deleted_at is null;
create table if not exists relay_private.message_outbox (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references relay_private.message_records(id),
  recipient_id uuid not null references relay_private.accounts(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  handoff_acknowledged_at timestamptz,
  unique(message_id,recipient_id)
);
alter table relay_private.message_records enable row level security;
alter table relay_private.message_outbox enable row level security;

create or replace function relay_private.message_json(m relay_private.message_records)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select m.request || jsonb_build_object('id',m.id,'createdAt',m.created_at);
$$;
create or replace function relay_private.message_rejected(code text)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('status','rejected','commit','not_applied','code',code);
$$;

-- Deletion scrubs content but preserves a dedup tombstone. Retried IDs can never
-- resurrect a deleted message. Private account deletion cascades through DMs.
create or replace function relay_private.message_delete_dm()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  update relay_private.message_records set request=null,composer_context=null,deleted_at=clock_timestamp()
    where id=old.id and visibility='private';
  delete from relay_private.message_outbox where message_id=old.id;
  return old;
end;
$$;
drop trigger if exists relay_message_dm_deleted on relay_private.direct_messages;
create trigger relay_message_dm_deleted after delete on relay_private.direct_messages
  for each row execute function relay_private.message_delete_dm();
create or replace function relay_private.message_delete_workspace()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.deleted and not old.deleted then
    update relay_private.message_records set request=null,composer_context=null,deleted_at=clock_timestamp() where workspace_id=old.workspace_id;
    delete from relay_private.message_outbox;
  end if;
  return new;
end;
$$;
drop trigger if exists relay_message_workspace_deleted on relay_private.studio;
create trigger relay_message_workspace_deleted after update on relay_private.studio
  for each row execute function relay_private.message_delete_workspace();

-- Import existing DMs without re-notifying anyone. Original IDs, client IDs,
-- bodies, timestamps and read receipts remain unchanged.
insert into relay_private.message_records(id,workspace_id,room_id,sender_id,client_id,visibility,participant_ids,request,fingerprint,created_at)
select d.id,s.workspace_id,s.message_room_id,d.sender_id,d.client_id,'private',array[least(d.sender_id,d.recipient_id),greatest(d.sender_id,d.recipient_id)],
  c.command,encode(extensions.digest(c.command::text,'sha256'),'hex'),d.created_at
from relay_private.direct_messages d cross join relay_private.studio s
cross join lateral (select jsonb_build_object('clientId',d.client_id,'workspaceId',s.workspace_id,'roomId',s.message_room_id,
  'visibility','private','senderId',d.sender_id,'recipientIds',jsonb_build_array(d.recipient_id),
  'participantIds',jsonb_build_array(least(d.sender_id,d.recipient_id),greatest(d.sender_id,d.recipient_id)),
  'notificationRecipientIds',jsonb_build_array(d.recipient_id),'body',d.body,'replyToMessageId',null) as command) c
where not s.deleted on conflict do nothing;

create or replace function relay_private.message_action(u relay_private.accounts,action text,data jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare
  s relay_private.studio%rowtype; m relay_private.message_records%rowtype; original relay_private.message_records%rowtype;
  command jsonb; digest text; peer uuid; participants uuid[]; notifications uuid[]; client uuid; reply uuid;
  next_state jsonb; view_message jsonb; rows jsonb; item jsonb; n integer; notice relay_private.message_outbox%rowtype;
begin
  -- Every call already validated the live session/run and holds this same lock.
  select * into s from relay_private.studio where singleton for update;
  if action='messages.composer.send' then
    return relay_private.message_composer_send(u,data);
  end if;
  if action='messages.capabilities' then
    return jsonb_build_object('contractVersion','relay-message-source/1','sourceRevision','relay-message-contract-v1',
      'historyDurable',true,'explicitAudienceMetadata',true,'stableClientIdDedup',true,
      'notificationsExplicitRecipientsOnly',true,'publicWorkspaceOnly',true,
      'privateParticipantsAndManagerOnly',true,'atomicSameAudienceReplies',true,
      'workspaceId',s.workspace_id,'roomId',s.message_room_id);
  end if;
  if action='messages.get' then
    if jsonb_typeof(data->'messageId') is distinct from 'string' or coalesce(data->>'messageId','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
      return relay_private.error('VALIDATION','Supply a message ID.',400);
    end if;
    select * into m from relay_private.message_records where id=(data->>'messageId')::uuid and workspace_id=s.workspace_id and deleted_at is null
      and (visibility='public' or u.role='manager' or u.id=any(participant_ids));
    if not found then return jsonb_build_object('status','not_found'); end if;
    return jsonb_build_object('message',relay_private.message_json(m));
  end if;
  if action='messages.metadata' then
    if jsonb_typeof(data->'messageIds') is distinct from 'array' then return relay_private.error('VALIDATION','Supply message IDs.',400); end if;
    if jsonb_array_length(data->'messageIds')>100 or exists(select 1 from jsonb_array_elements(data->'messageIds') x
      where jsonb_typeof(x)<>'string' or (x#>>'{}')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
      return relay_private.error('VALIDATION','Supply at most 100 message IDs.',400);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'visibility',d.visibility,'workspaceId',d.workspace_id,'roomId',d.room_id,
      'replyToMessageId',d.request->'replyToMessageId')),'[]'::jsonb) into rows
      from relay_private.message_records d where d.workspace_id=s.workspace_id and d.deleted_at is null
        and d.id in(select (x#>>'{}')::uuid from jsonb_array_elements(data->'messageIds') x)
        and (d.visibility='public' or u.role='manager' or u.id=any(d.participant_ids));
    return jsonb_build_object('messages',rows);
  end if;
  if action='messages.history' then
    if data ? 'beforeId' then
      if jsonb_typeof(data->'beforeId') is distinct from 'string' or coalesce(data->>'beforeId','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
        return relay_private.error('VALIDATION','Invalid message cursor.',400);
      end if;
      select * into original from relay_private.message_records where id=(data->>'beforeId')::uuid and workspace_id=s.workspace_id and deleted_at is null
        and (visibility='public' or u.role='manager' or u.id=any(participant_ids));
      if not found then return jsonb_build_object('status','not_found'); end if;
    end if;
    select coalesce(jsonb_agg(relay_private.message_json(d) order by d.created_at,d.id),'[]'::jsonb) into rows from (
      select * from relay_private.message_records where workspace_id=s.workspace_id and deleted_at is null
        and (visibility='public' or u.role='manager' or u.id=any(participant_ids))
        and (original.id is null or (created_at,id)<(original.created_at,original.id))
        order by created_at desc,id desc limit 100) d;
    return jsonb_build_object('messages',rows,'hasMore',jsonb_array_length(rows)=100,'workspaceId',s.workspace_id,'roomId',s.message_room_id);
  end if;
  if action='messages.notifications' then
    n:=100;
    if data ? 'limit' then
      if jsonb_typeof(data->'limit') is distinct from 'number' or coalesce(data->>'limit','')!~'^[0-9]{1,3}$' then
        return relay_private.error('VALIDATION','Use a notification limit from 1 to 100.',400);
      end if;
      n:=(data->>'limit')::integer;
      if n not between 1 and 100 then return relay_private.error('VALIDATION','Use a notification limit from 1 to 100.',400); end if;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'messageId',o.message_id,'recipientId',o.recipient_id,'createdAt',o.created_at) order by o.created_at,o.id),'[]'::jsonb)
      into rows from (select o.* from relay_private.message_outbox o join relay_private.message_records d on d.id=o.message_id
        where o.recipient_id=u.id and o.handoff_acknowledged_at is null and d.deleted_at is null and d.workspace_id=s.workspace_id
        order by o.created_at,o.id limit n) o;
    return jsonb_build_object('notifications',rows,'hasMore',(select count(*)>n from relay_private.message_outbox o
      join relay_private.message_records d on d.id=o.message_id where o.recipient_id=u.id and o.handoff_acknowledged_at is null and d.deleted_at is null and d.workspace_id=s.workspace_id));
  end if;
  if action='messages.notifications.ack' then
    if jsonb_typeof(data->'notificationId') is distinct from 'string' or coalesce(data->>'notificationId','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
      return relay_private.error('VALIDATION','Supply a notification ID.',400);
    end if;
    update relay_private.message_outbox set handoff_acknowledged_at=coalesce(handoff_acknowledged_at,clock_timestamp())
      where recipient_id=u.id and id=(data->>'notificationId')::uuid returning * into notice;
    if not found then return relay_private.error('NOT_FOUND','Notification unavailable.',404); end if;
    return jsonb_build_object('notificationId',notice.id,'handoffAcknowledgedAt',notice.handoff_acknowledged_at);
  end if;
  if action<>'messages.send' then return relay_private.error('UNKNOWN_ACTION','Unknown message action.',400); end if;

  command:=data->'command';
  if jsonb_typeof(command) is distinct from 'object' then return relay_private.message_rejected('VALIDATION'); end if;
  if (select count(*) from jsonb_object_keys(command))<>10 or exists(select 1 from jsonb_object_keys(command) k where k not in
    ('clientId','workspaceId','roomId','visibility','senderId','recipientIds','participantIds','notificationRecipientIds','body','replyToMessageId')) then
    return relay_private.message_rejected('VALIDATION');
  end if;
  if command->>'senderId' is distinct from u.id::text or command->>'workspaceId' is distinct from s.workspace_id::text
    or command->>'roomId' is distinct from s.message_room_id::text then return relay_private.message_rejected('FORBIDDEN'); end if;
  if jsonb_typeof(command->'clientId') is distinct from 'string' or coalesce(command->>'clientId','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or command->>'visibility' not in ('public','private') or jsonb_typeof(command->'visibility') is distinct from 'string'
    or jsonb_typeof(command->'body') is distinct from 'string' or char_length(command->>'body') not between 1 and 12000
    or char_length(btrim(command->>'body',E' \t\n\r\v\f' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0 or octet_length(command->>'body')>48000
    or jsonb_typeof(command->'recipientIds') is distinct from 'array' or jsonb_typeof(command->'participantIds') is distinct from 'array'
    or jsonb_typeof(command->'notificationRecipientIds') is distinct from 'array' then return relay_private.message_rejected('VALIDATION'); end if;
  if jsonb_array_length(command->'notificationRecipientIds')>100 or exists(select 1 from jsonb_array_elements(command->'notificationRecipientIds') x
    where jsonb_typeof(x)<>'string' or (x#>>'{}')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then return relay_private.message_rejected('VALIDATION'); end if;
  select coalesce(array_agg((x#>>'{}')::uuid),'{}'::uuid[]) into notifications from jsonb_array_elements(command->'notificationRecipientIds') x;
  if cardinality(notifications)<>(select count(distinct id) from unnest(notifications) id) then return relay_private.message_rejected('VALIDATION'); end if;
  if command->>'visibility'='private' then
    if jsonb_array_length(command->'recipientIds')<>1 or jsonb_typeof(command->'recipientIds'->0) is distinct from 'string'
      or coalesce(command->'recipientIds'->>0,'')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then return relay_private.message_rejected('VALIDATION'); end if;
    peer:=(command->'recipientIds'->>0)::uuid; participants:=array[least(u.id,peer),greatest(u.id,peer)];
    if peer=u.id or command->'participantIds'<>to_jsonb(participants) or command->'notificationRecipientIds'<>command->'recipientIds' then return relay_private.message_rejected('VALIDATION'); end if;
  else
    participants:='{}'::uuid[];
    if command->'recipientIds'<>'[]'::jsonb or command->'participantIds'<>'[]'::jsonb then return relay_private.message_rejected('VALIDATION'); end if;
  end if;
  if command->'replyToMessageId'<>'null'::jsonb then
    if jsonb_typeof(command->'replyToMessageId') is distinct from 'string' or coalesce(command->>'replyToMessageId','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then return relay_private.message_rejected('VALIDATION'); end if;
    reply:=(command->>'replyToMessageId')::uuid;
  end if;
  client:=(command->>'clientId')::uuid; digest:=encode(extensions.digest(command::text,'sha256'),'hex');
  select * into m from relay_private.message_records where workspace_id=s.workspace_id and sender_id=u.id and client_id=client;
  if found then
    if m.fingerprint<>digest then return relay_private.message_rejected('CONFLICT'); end if;
    if m.deleted_at is not null then return relay_private.message_rejected('NOT_FOUND'); end if;
    return jsonb_build_object('status','persisted','historyStore','relay-chat','message',relay_private.message_json(m));
  end if;
  if exists(select 1 from unnest(notifications) as target(recipient_id) where not exists(select 1 from relay_private.accounts a where a.id=target.recipient_id and a.enabled)) then
    return relay_private.message_rejected('NOT_FOUND');
  end if;
  if reply is not null then
    select * into original from relay_private.message_records where id=reply and workspace_id=s.workspace_id and deleted_at is null;
    if not found or original.room_id<>s.message_room_id or original.visibility<>command->>'visibility'
      or (original.visibility='private' and original.participant_ids<>participants) then return relay_private.message_rejected('REPLY_MISMATCH'); end if;
  end if;
  if not relay_private.take_attempt('messages:send:'||u.id::text,120) then return relay_private.message_rejected('RATE_LIMIT'); end if;
  m.id:=gen_random_uuid();m.workspace_id:=s.workspace_id;m.room_id:=s.message_room_id;m.sender_id:=u.id;m.client_id:=client;
  m.visibility:=command->>'visibility';m.participant_ids:=participants;m.request:=command;m.fingerprint:=digest;m.created_at:=clock_timestamp();
  if m.visibility='public' then
    view_message:=jsonb_build_object('id',m.id,'from',case when u.role='manager' then 'owner' else u.agent_id::text end,
      'to',null,'taskId',null,'body',command->>'body','createdAt',m.created_at,'visibility','public','messageId',m.id,
      'senderId',u.id,'recipientIds','[]'::jsonb,'workspaceId',s.workspace_id,'roomId',s.message_room_id,'replyToMessageId',reply,
      'notificationRecipientIds',command->'notificationRecipientIds');
    next_state:=relay_private.bump_state(jsonb_set(s.state,'{messages}',(s.state->'messages')||jsonb_build_array(view_message)),s.revision+1);
    if octet_length(next_state::text)>900000 then return relay_private.message_rejected('CAPACITY'); end if;
  end if;
  insert into relay_private.message_records(id,workspace_id,room_id,sender_id,client_id,visibility,participant_ids,request,fingerprint,created_at)
    values(m.id,m.workspace_id,m.room_id,m.sender_id,m.client_id,m.visibility,m.participant_ids,m.request,m.fingerprint,m.created_at);
  if m.visibility='private' then
    insert into relay_private.direct_messages(id,sender_id,recipient_id,client_id,body,created_at)
      values(m.id,u.id,peer,client,command->>'body',m.created_at);
  else
    update relay_private.studio set state=next_state,revision=revision+1,updated_at=m.created_at where singleton;
  end if;
  insert into relay_private.message_outbox(message_id,recipient_id,created_at) select m.id,id,m.created_at from unnest(notifications) id;
  return jsonb_build_object('status','persisted','historyStore','relay-chat','message',relay_private.message_json(m));
end;
$$;

-- Compatibility adapter for the existing public message.add composer. The live
-- account/run is resolved by relay_message_rpc, never from the operation payload.
-- Keep the canonical ten-field command unchanged; UI-only channel/task context
-- participates in durable deduplication alongside the canonical command.
create or replace function relay_private.message_composer_send(u relay_private.accounts,data jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare
  s relay_private.studio%rowtype; m relay_private.message_records%rowtype;
  op jsonb; p jsonb; saved_context jsonb; result jsonb; command jsonb; next_state jsonb;
  client uuid; target uuid; target_name text; task text; body text; reply jsonb; sender text; broadcast boolean; recipients jsonb;
begin
  select * into s from relay_private.studio where singleton for update;
  op:=data->'op'; p:=op->'payload';
  if jsonb_typeof(op) is distinct from 'object' or op->>'type' is distinct from 'message.add'
    or jsonb_typeof(op->'id') is distinct from 'string' or (op->>'id')!~'^[A-Za-z0-9_.:-]{1,128}$'
    or jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'body') is distinct from 'string'
    or (p ? 'to' and jsonb_typeof(p->'to') not in ('string','null'))
    or (p ? 'taskId' and jsonb_typeof(p->'taskId') not in ('string','null'))
    or (p ? 'notifyWorkspace' and jsonb_typeof(p->'notifyWorkspace') is distinct from 'boolean') then
    return relay_private.error('VALIDATION','Invalid public message operation.',400);
  end if;
  body:=btrim(p->>'body'); target_name:=nullif(p->>'to',''); task:=nullif(p->>'taskId','');
  broadcast:=coalesce((p->>'notifyWorkspace')::boolean,false);
  if broadcast and (target_name is not null or task is not null) then return relay_private.error('VALIDATION','Choose a broadcast or a directed/task message.',400); end if;
  reply:=case when jsonb_typeof(p->'replyToMessageId')='string' then to_jsonb(lower(p->>'replyToMessageId')) else coalesce(p->'replyToMessageId','null'::jsonb) end;
  saved_context:=jsonb_build_object('operationId',op->>'id','to',target_name,'taskId',task,'body',body,'replyToMessageId',reply,'notifyWorkspace',broadcast);
  -- Deterministic, sender-scoped ID supports old non-UUID operation IDs as well.
  client:=substr(encode(extensions.digest('relay-composer-v1:'||u.id::text||':'||(op->>'id'),'sha256'),'hex'),1,32)::uuid;
  select * into m from relay_private.message_records where workspace_id=s.workspace_id and sender_id=u.id and client_id=client;
  if found then
    if m.composer_context is distinct from saved_context then return relay_private.error('CONFLICT','This message operation was already used.',409); end if;
    if m.deleted_at is not null then return relay_private.error('NOT_FOUND','Message unavailable.',404); end if;
    return jsonb_build_object('state',s.state,'message',relay_private.message_json(m));
  end if;
  -- Do not silently re-send an operation already stored by the old board path.
  if s.state->'operations' ? (op->>'id') then
    return relay_private.error('CONFLICT','This operation predates durable messaging. Refresh the board before posting again.',409);
  end if;
  if task is not null and not exists(select 1 from jsonb_array_elements(s.state->'tasks') t where t->>'id'=task) then
    return relay_private.error('NOT_FOUND','Task no longer exists.',404);
  end if;
  if target_name is not null then
    select id into target from relay_private.accounts where enabled and
      ((target_name='owner' and role='manager') or (target_name<>'owner' and agent_id::text=target_name));
    if not found then return relay_private.error('NOT_FOUND','Recipient no longer exists or is paused.',404); end if;
  end if;
  recipients:=case when target is null then '[]'::jsonb else jsonb_build_array(target) end;
  if broadcast then select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into recipients from relay_private.accounts where enabled and role='worker' and id<>u.id; end if;
  command:=jsonb_build_object('clientId',client,'workspaceId',s.workspace_id,'roomId',s.message_room_id,
    'visibility','public','senderId',u.id,'recipientIds','[]'::jsonb,'participantIds','[]'::jsonb,
    'notificationRecipientIds',recipients,
    'body',body,'replyToMessageId',reply);
  result:=relay_private.message_action(u,'messages.send',jsonb_build_object('command',command));
  if result->>'status'='rejected' then
    return relay_private.error(result->>'code','Public message was not sent.',case result->>'code' when 'FORBIDDEN' then 403 when 'NOT_FOUND' then 404 when 'CONFLICT' then 409 when 'RATE_LIMIT' then 429 else 400 end);
  end if;
  update relay_private.message_records set composer_context=saved_context where id=(result->'message'->>'id')::uuid;
  select state into next_state from relay_private.studio where singleton;
  select jsonb_set(next_state,'{messages}',jsonb_agg(case when v->>'id'=result->'message'->>'id'
    then v||jsonb_build_object('to',target_name,'taskId',task,'operationId',op->>'id') else v end order by ordinal))
    into next_state from jsonb_array_elements(next_state->'messages') with ordinality as messages(v,ordinal);
  sender:=case when u.role='manager' then 'owner' else u.agent_id::text end;
  next_state:=jsonb_set(next_state,'{operations}',(select coalesce(jsonb_agg(v order by ordinal),'[]'::jsonb)
    from jsonb_array_elements((next_state->'operations')||jsonb_build_array(op->>'id')) with ordinality a(v,ordinal)
    where ordinal>greatest(0,jsonb_array_length(next_state->'operations')+1-2000)));
  next_state:=jsonb_set(next_state,'{activity}',(select jsonb_agg(v order by ordinal) from jsonb_array_elements(
    jsonb_build_array(jsonb_build_object('id',op->>'id','title',u.name||' posted a message','by',sender,'createdAt',result->'message'->'createdAt'))||(next_state->'activity')) with ordinality a(v,ordinal) where ordinal<=500));
  if u.role<>'manager' then
    select jsonb_set(next_state,'{agents}',jsonb_agg(case when v->>'id'=u.agent_id::text
      then v||jsonb_build_object('lastSeen',result->'message'->'createdAt') else v end order by ordinal))
      into next_state from jsonb_array_elements(next_state->'agents') with ordinality a(v,ordinal);
  end if;
  if octet_length(next_state::text)>900000 then raise exception using errcode='P0001',message='composer_capacity'; end if;
  update relay_private.studio set state=next_state where singleton;
  return jsonb_build_object('state',next_state,'message',result->'message');
exception when sqlstate 'P0001' then
  -- Roll back the canonical insert/outbox too if the enriched board is full.
  if sqlerrm='composer_capacity' then return relay_private.error('CAPACITY','The board is full.',400); end if;
  raise;
end;
$$;

create or replace function relay_private.message_legacy_dm_send(u relay_private.accounts,data jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s relay_private.studio%rowtype; result jsonb; peer text; pair jsonb; m relay_private.direct_messages%rowtype;
begin
  select * into s from relay_private.studio where singleton;
  peer:=lower(data->>'recipientId'); pair:=jsonb_build_array(least(u.id::text,peer),greatest(u.id::text,peer));
  result:=relay_private.message_action(u,'messages.send',jsonb_build_object('command',jsonb_build_object(
    'clientId',case when jsonb_typeof(data->'clientId')='string' then to_jsonb(lower(data->>'clientId')) else data->'clientId' end,'workspaceId',s.workspace_id,'roomId',s.message_room_id,'visibility','private','senderId',u.id,
    'recipientIds',jsonb_build_array(peer),'participantIds',pair,'notificationRecipientIds',jsonb_build_array(peer),
    'body',case when jsonb_typeof(data->'body')='string' then to_jsonb(btrim(data->>'body')) else data->'body' end,
    'replyToMessageId',case when jsonb_typeof(data->'replyToMessageId')='string' then to_jsonb(lower(data->>'replyToMessageId')) else coalesce(data->'replyToMessageId','null'::jsonb) end)));
  if result->>'status'='rejected' then
    return relay_private.error(result->>'code','Private message was not sent.',case result->>'code' when 'FORBIDDEN' then 403 when 'NOT_FOUND' then 404 when 'CONFLICT' then 409 when 'RATE_LIMIT' then 429 else 400 end);
  end if;
  select * into m from relay_private.direct_messages where id=(result->'message'->>'id')::uuid;
  return jsonb_build_object('message',relay_private.dm_json(m));
end;
$$;

create or replace function relay_private.dm_json(m relay_private.direct_messages)
returns jsonb language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object('id',m.id,'senderId',m.sender_id,'recipientId',m.recipient_id,
    'body',m.body,'createdAt',m.created_at,'readAt',m.read_at);
$$;

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
    return relay_private.message_legacy_dm_send(u,data);
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

create or replace function public.relay_message_rpc(p_action text,p_token text default '',p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare context jsonb; u relay_private.accounts%rowtype;
begin
  if p_action is null or p_action not in ('messages.composer.send','messages.capabilities','messages.get','messages.metadata','messages.history','messages.send','messages.notifications','messages.notifications.ack')
    or jsonb_typeof(p_data) is distinct from 'object' then return relay_private.error('VALIDATION','Invalid message request.',400); end if;
  context:=public.relay_rpc('context',p_token,'{}'::jsonb);
  if context ? 'error' then return context; end if;
  select * into u from relay_private.accounts where id=(context->'user'->>'id')::uuid;
  return relay_private.message_action(u,p_action,p_data);
end;
$$;

revoke all on relay_private.message_records,relay_private.message_outbox from public,anon,authenticated;
grant select,insert,update,delete on relay_private.message_records,relay_private.message_outbox to service_role;
revoke all on function relay_private.message_json(relay_private.message_records),relay_private.message_rejected(text),relay_private.message_delete_dm(),relay_private.message_delete_workspace(),relay_private.message_action(relay_private.accounts,text,jsonb),relay_private.message_legacy_dm_send(relay_private.accounts,jsonb),relay_private.message_composer_send(relay_private.accounts,jsonb) from public,anon,authenticated;
grant execute on function relay_private.message_json(relay_private.message_records),relay_private.message_rejected(text),relay_private.message_delete_dm(),relay_private.message_delete_workspace(),relay_private.message_action(relay_private.accounts,text,jsonb),relay_private.message_legacy_dm_send(relay_private.accounts,jsonb),relay_private.message_composer_send(relay_private.accounts,jsonb) to service_role;
revoke all on function public.relay_message_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.relay_message_rpc(text,text,jsonb) to service_role;
-- END GUARDED MESSAGE CONTRACT

do $message_guard$
declare v_oid oid; v_installed boolean; v_expected text; v_item record; v_table text;
begin
  -- The same row lock serializes account, board and message RPCs.
  perform 1 from relay_private.studio where singleton for update;
  if not found then raise exception 'Relay studio row is missing; no changes applied.'; end if;
  if has_schema_privilege('anon','relay_private','USAGE')
    or has_schema_privilege('authenticated','relay_private','USAGE')
    or not has_schema_privilege('service_role','relay_private','USAGE') then
    raise exception 'Unexpected relay_private schema privileges; no changes applied.';
  end if;
  v_installed := to_regprocedure('public.relay_message_rpc(text,text,jsonb)') is not null;
  if not v_installed and (
    to_regclass('relay_private.message_records') is not null or to_regclass('relay_private.message_outbox') is not null
    or exists (select 1 from information_schema.columns where table_schema='relay_private' and table_name='studio' and column_name in ('workspace_id','message_room_id'))
  ) then raise exception 'Partial or unexpected message installation; no changes applied.'; end if;
  for v_item in select * from (values
      ('public.relay_rpc(text,text,jsonb)', 'a1828d6823d03c92c15e96e5460f6ee0', 'a1828d6823d03c92c15e96e5460f6ee0', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.update_task_worker(jsonb,text,text,timestamptz)', '0a35847000b1587329990102943670df', '0a35847000b1587329990102943670df', 'plpgsql', 's', 'jsonb'),
      ('public.relay_dm_rpc(text,text,jsonb)', '5ab0e7a4a8506c485953a1617d85bf13', '5ab0e7a4a8506c485953a1617d85bf13', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.dm_json(relay_private.direct_messages)', '683b16f4a06814ef8e7107dc0f4502f6', '683b16f4a06814ef8e7107dc0f4502f6', 'sql', 's', 'jsonb'),
      ('relay_private.dm_action(relay_private.accounts,text,jsonb)', '010ed18119173991062d2f6798d6fb8a', 'b5536ea24723753b46bbc89d3463c9a5', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_json(relay_private.message_records)', null, '52e02119fc88f00fd592c0f08a6687d6', 'sql', 's', 'jsonb'),
      ('relay_private.message_rejected(text)', null, 'fa30df26b8760854d0345a0d74611a66', 'sql', 'i', 'jsonb'),
      ('relay_private.message_delete_dm()', null, 'a79ce864e91a11a9da2f6764a2ad12b2', 'plpgsql', 'v', 'trigger'),
      ('relay_private.message_delete_workspace()', null, '53d707e073aa4c3265c02a4cb7b0e9e5', 'plpgsql', 'v', 'trigger'),
      ('relay_private.message_action(relay_private.accounts,text,jsonb)', null, '56ddc22fbf55ae4671687bdcde14d89b', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_composer_send(relay_private.accounts,jsonb)', null, '310aee1659a5440b23a34804a40e1284', 'plpgsql', 'v', 'jsonb'),
      ('relay_private.message_legacy_dm_send(relay_private.accounts,jsonb)', null, '96f903daf68bb4f7aa9d5e07adc0777b', 'plpgsql', 'v', 'jsonb'),
      ('public.relay_message_rpc(text,text,jsonb)', null, '4ea26389c1350282d614a60d7c70713e', 'plpgsql', 'v', 'jsonb')
    ) as expected(signature,baseline_hash,message_hash,language,volatility,result_type)
  loop
    v_expected := case when v_installed then v_item.message_hash else v_item.baseline_hash end;
    if v_expected is null then
      if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=split_part(v_item.signature,'(',1)) then
        raise exception 'Unexpected existing message function %; no changes applied.',v_item.signature;
      end if;
      continue;
    end if;
    v_oid := to_regprocedure(v_item.signature);
    if v_oid is null then raise exception 'Required function % is missing; no changes applied.',v_item.signature; end if;
    if exists (select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=v_oid and
      (md5(p.prosrc)<>v_expected or l.lanname<>v_item.language or p.provolatile::text<>v_item.volatility
       or p.prorettype<>v_item.result_type::regtype or p.prosecdef
       or p.proconfig is distinct from array['search_path=pg_catalog']::text[])) then
      raise exception 'Unexpected definition for %; no changes applied.',v_item.signature;
    end if;
    if has_function_privilege('anon',v_oid,'EXECUTE') or has_function_privilege('authenticated',v_oid,'EXECUTE')
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then
      raise exception 'Unexpected privileges for %; no changes applied.',v_item.signature;
    end if;
  end loop;
  foreach v_table in array array['studio','accounts','sessions','rooms','throttle','direct_messages','message_records','message_outbox']
  loop
    v_oid := to_regclass('relay_private.'||v_table);
    if v_oid is null and not v_installed and v_table in ('message_records','message_outbox') then continue; end if;
    if v_oid is null or exists(select 1 from pg_class where oid=v_oid and (relkind<>'r' or not relrowsecurity)) then
      raise exception 'Missing or unsafe Relay table %; no changes applied.',v_table;
    end if;
    if has_table_privilege('anon',v_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',v_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or not (has_table_privilege('service_role',v_oid,'SELECT') and has_table_privilege('service_role',v_oid,'INSERT')
        and has_table_privilege('service_role',v_oid,'UPDATE') and has_table_privilege('service_role',v_oid,'DELETE')) then
      raise exception 'Unexpected Relay table privileges for %; no changes applied.',v_table;
    end if;
  end loop;
  for v_item in select * from (values
    ('relay_message_dm_deleted','relay_private.direct_messages','relay_private.message_delete_dm()',9),
    ('relay_message_workspace_deleted','relay_private.studio','relay_private.message_delete_workspace()',17)
  ) as expected(trigger_name,table_name,function_name,trigger_type)
  loop
    if not v_installed then
      if exists(select 1 from pg_trigger where tgrelid=v_item.table_name::regclass and tgname=v_item.trigger_name) then
        raise exception 'Unexpected message trigger %; no changes applied.',v_item.trigger_name;
      end if;
    elsif not exists(select 1 from pg_trigger where tgrelid=v_item.table_name::regclass and tgname=v_item.trigger_name
      and tgfoid=v_item.function_name::regprocedure and tgtype=v_item.trigger_type and tgenabled='O'
      and not tgisinternal and tgqual is null and tgnargs=0 and tgattr=''::int2vector) then
      raise exception 'Unexpected message trigger definition %; no changes applied.',v_item.trigger_name;
    end if;
  end loop;
end;
$message_guard$;

commit;
