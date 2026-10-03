-- First installation only: these object names were confirmed absent before deployment.
-- Creates only Update room objects; never replaces existing objects or data.
-- No public table or client-supplied identity access.
begin;
create table relay_private.update_room (
  singleton boolean primary key default true references relay_private.studio(singleton) on delete cascade check(singleton),
  revision bigint not null default 0,
  proposals jsonb not null default '[]'::jsonb check(jsonb_typeof(proposals)='array' and octet_length(proposals::text)<=6000000)
);
alter table relay_private.update_room enable row level security;
insert into relay_private.update_room(singleton) values(true) on conflict do nothing;

create function public.relay_updates_rpc(p_action text,p_token text default '',p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare c jsonb; r relay_private.update_room%rowtype; members jsonb;
begin
  if p_action not in ('updates.load','updates.commit') or p_action is null or jsonb_typeof(p_data) is distinct from 'object' then
    return relay_private.error('VALIDATION','Invalid update request.',400);
  end if;
  -- relay_rpc locks studio and checks live session, disabled accounts and worker runs.
  c:=public.relay_rpc('context',p_token,'{}'::jsonb);
  if c ? 'error' then return c; end if;
  select * into r from relay_private.update_room where singleton for update;
  if not found then return relay_private.error('NOT_CONFIGURED','Update room is unavailable.',503); end if;
  if p_action='updates.commit' then
    if jsonb_typeof(p_data->'expectedRevision') is distinct from 'number'
      or (p_data->>'expectedRevision')::bigint<>r.revision then
      return relay_private.error('CONFLICT','The Update room changed. Refresh and retry.',409);
    end if;
    if jsonb_typeof(p_data->'proposals') is distinct from 'array'
      or jsonb_array_length(p_data->'proposals')>30 or octet_length((p_data->'proposals')::text)>6000000 then
      return relay_private.error('CAPACITY','The Update room is full. Ask the manager to arrange storage cleanup before adding more.',413);
    end if;
    -- Only the trusted Edge Function can invoke this internal compare-and-swap.
    update relay_private.update_room set proposals=p_data->'proposals',revision=revision+1 where singleton returning * into r;
  end if;
  select coalesce(jsonb_agg(id),'[]'::jsonb) into members from relay_private.accounts where enabled;
  return jsonb_build_object('user',c->'user','revision',r.revision,'proposals',r.proposals,'activeAccountIds',members);
exception when invalid_text_representation or numeric_value_out_of_range then
  return relay_private.error('VALIDATION','Invalid update values.',400);
end;
$$;
-- Honour the existing studio-deletion contract without changing its account RPC.
create function relay_private.clear_update_room() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.deleted then delete from relay_private.update_room where singleton; end if;
  return new;
end;
$$;
create trigger relay_clear_updates after update of deleted on relay_private.studio for each row when(new.deleted) execute function relay_private.clear_update_room();
revoke all on relay_private.update_room from public,anon,authenticated;
grant select,insert,update,delete on relay_private.update_room to service_role;
revoke all on function public.relay_updates_rpc(text,text,jsonb),relay_private.clear_update_room() from public,anon,authenticated;
grant execute on function public.relay_updates_rpc(text,text,jsonb),relay_private.clear_update_room() to service_role;
commit;
