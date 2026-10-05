-- Local prepared artifact. Do not run without approval for the target database.
-- Verified source baseline: main 56c47abe01d807a52cde82ebc46d7038ae36cdcb.
-- No tables, rows, accounts, sessions, or existing RPC grants are rewritten.
-- Read TASK-CONTROLS-DEPLOYMENT.md first. Run as the database owner.

begin;

do $guard$
declare v_rpc oid; v_helper oid; v_source text;
begin
  v_rpc := to_regprocedure('public.relay_rpc(text,text,jsonb)');
  if v_rpc is null then raise exception 'Relay account RPC is missing; stop and inspect the target database.'; end if;
  select prosrc into v_source from pg_proc where oid=v_rpc;
  if md5(v_source) not in ('6f6381892da4da201900f74e7fd6b8fb', '48f80463867e20075a3f13fc5b641eb7', 'a1828d6823d03c92c15e96e5460f6ee0') then
    raise exception 'Unexpected relay_rpc definition (body hash %). Expected verified baseline 6f6381892da4da201900f74e7fd6b8fb or prior task-controls 48f80463867e20075a3f13fc5b641eb7 or branded task-controls a1828d6823d03c92c15e96e5460f6ee0; no changes applied.', md5(v_source);
  end if;
  if exists (select 1 from pg_proc where oid=v_rpc and
      (prosecdef or proconfig is distinct from array['search_path=pg_catalog']::text[]))
      or has_function_privilege('anon',v_rpc,'EXECUTE')
      or has_function_privilege('authenticated',v_rpc,'EXECUTE')
      or not has_function_privilege('service_role',v_rpc,'EXECUTE') then
    raise exception 'Unexpected Relay RPC privileges; stop and inspect before rollout or rollback.';
  end if;
  v_helper := to_regprocedure('relay_private.update_task_worker(jsonb,text,text,timestamptz)');
  if v_helper is not null and exists (select 1 from pg_proc where oid=v_helper and md5(prosrc)<>'0a35847000b1587329990102943670df') then
    raise exception 'Unexpected task lifecycle helper; no changes applied.';
  end if;
  perform 1 from relay_private.studio where singleton for update;
  if not found then raise exception 'Relay studio row is missing; no changes applied.'; end if;
end;
$guard$;

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

revoke all on function relay_private.update_task_worker(jsonb,text,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function relay_private.update_task_worker(jsonb,text,text,timestamptz) to service_role;

do $patch$
declare v_definition text;
begin
  if (select md5(prosrc) from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure) = 'a1828d6823d03c92c15e96e5460f6ee0' then return; end if;
  v_definition := pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure);
  v_definition := replace(v_definition, $before$      select coalesce(jsonb_agg(case when item->>'owner' = v_agent_id::text and item->>'status' <> 'done' then
        item || jsonb_build_object('session', v_run_id)
        else item end order by ord), '[]'::jsonb) into v_tasks$before$, $after$      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, v_run_id, v_now) order by ord), '[]'::jsonb) into v_tasks$after$);
  v_definition := replace(v_definition, $before$      select coalesce(jsonb_agg(case when item->>'owner' = v_agent_id::text and item->>'status' <> 'done' then
        item || jsonb_build_object('owner', null, 'session', null, 'status', 'ready', 'updatedAt', v_now)
        else item end order by ord), '[]'::jsonb) into v_tasks$before$, $after$      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, null, v_now) order by ord), '[]'::jsonb) into v_tasks$after$);
  v_definition := replace(v_definition, $before$      -- Shared posts/tasks remain attributed to a disabled anonymous tombstone.$before$, $after$      -- Shared posts/history remain attributed to a disabled anonymous tombstone.
      -- Remove this worker's assignments while preserving other workers' runs.$after$);
  v_definition := replace(v_definition, $before$      'workers', v_workers);$before$, $after$      'workers', v_workers,
      'manager', (select jsonb_build_object('name', a.name)
        from relay_private.accounts a where a.role = 'manager'),
      'capabilities', jsonb_build_object('taskLifecycleV1', true));$after$);
  execute v_definition;
  if (select md5(prosrc) from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure) <> 'a1828d6823d03c92c15e96e5460f6ee0' then
    raise exception 'Task controls RPC verification failed; transaction rolled back.';
  end if;
end;
$patch$;

commit;
