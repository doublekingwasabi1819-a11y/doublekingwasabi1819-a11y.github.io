begin;
alter table relay_private.update_room add column policy jsonb not null default '{"mode":"one","allowSelfApproval":false}'::jsonb check(jsonb_typeof(policy)='object');
create or replace function public.relay_updates_rpc(p_action text,p_token text default '',p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare c jsonb; r relay_private.update_room%rowtype; members jsonb; roles jsonb;
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
    if p_data ? 'expectedContextRevision' and (jsonb_typeof(p_data->'expectedContextRevision') is distinct from 'number' or p_data->>'expectedContextRevision' is distinct from c->'state'->>'revision') then
      return relay_private.error('CONFLICT','Account eligibility changed. Refresh and retry.',409);
    end if;
    if jsonb_typeof(p_data->'expectedRevision') is distinct from 'number'
      or (p_data->>'expectedRevision')::bigint<>r.revision then
      return relay_private.error('CONFLICT','The Update room changed. Refresh and retry.',409);
    end if;
    if jsonb_typeof(p_data->'proposals') is distinct from 'array'
      or jsonb_array_length(p_data->'proposals')>30 or octet_length((p_data->'proposals')::text)>6000000 then
      return relay_private.error('CAPACITY','The Update room is full. Ask the manager to arrange storage cleanup before adding more.',413);
    end if;
    if p_data ? 'policy' then
      if c->'user'->>'role' is distinct from 'manager' then return relay_private.error('FORBIDDEN','Only the manager can change approvals.',403); end if;
      if jsonb_typeof(p_data->'policy') is distinct from 'object'
        or p_data->'policy'->>'mode' is null or p_data->'policy'->>'mode' not in ('one','manager','agents')
        or jsonb_typeof(p_data->'policy'->'allowSelfApproval') is distinct from 'boolean' then
        return relay_private.error('VALIDATION','Invalid approval policy.',400);
      end if;
      if exists(select 1 from jsonb_array_elements(r.proposals) p where p->>'status'='publishing') then
        return relay_private.error('CONFLICT','Wait for the current publication.',409);
      end if;
    end if;
    -- Only the trusted Edge Function can invoke this internal compare-and-swap.
    update relay_private.update_room set proposals=p_data->'proposals',policy=case when p_data ? 'policy' then jsonb_build_object('mode',p_data->'policy'->>'mode','allowSelfApproval',p_data->'policy'->'allowSelfApproval') else policy end,revision=revision+1 where singleton returning * into r;
  end if;
  select coalesce(jsonb_agg(id),'[]'::jsonb) into members from relay_private.accounts where enabled;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'role',role)),'[]'::jsonb) into roles from relay_private.accounts where enabled;
  return jsonb_build_object('contextRevision',c->'state'->'revision','policy',r.policy,'activeAccounts',roles,'user',c->'user','revision',r.revision,'proposals',r.proposals,'activeAccountIds',members);
exception when invalid_text_representation or numeric_value_out_of_range then
  return relay_private.error('VALIDATION','Invalid update values.',400);
end;
$$;
revoke all on function public.relay_updates_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.relay_updates_rpc(text,text,jsonb) to service_role;
commit;
