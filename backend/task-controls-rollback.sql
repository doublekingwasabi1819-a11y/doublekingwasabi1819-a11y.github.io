-- Local prepared artifact. Do not run without approval for the target database.
-- Verified source baseline: main 56c47abe01d807a52cde82ebc46d7038ae36cdcb.
-- No tables, rows, accounts, sessions, or existing RPC grants are rewritten.
-- Read TASK-CONTROLS-DEPLOYMENT.md first. Run as the database owner.

-- Rollback is safe only before new-format task data has been persisted.
-- If this guard refuses, retain the compatible backend and prepare a forward fix.
begin;

do $rollback$
declare v_rpc oid; v_helper oid; v_source text; v_definition text;
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
  if md5(v_source) = '6f6381892da4da201900f74e7fd6b8fb' then return; end if;
  if exists (select 1 from relay_private.studio s,
      lateral jsonb_array_elements(coalesce(s.state->'tasks','[]'::jsonb)) t
      where t ?| array['assignees','version','deletedAt','deletedBy']) then
    raise exception 'New-format tasks exist. Unsafe rollback refused; retain compatible backend and prepare a forward fix.';
  end if;
  v_definition := pg_get_functiondef(v_rpc);
  v_definition := replace(v_definition, $before$      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, v_run_id, v_now) order by ord), '[]'::jsonb) into v_tasks$before$, $after$      select coalesce(jsonb_agg(case when item->>'owner' = v_agent_id::text and item->>'status' <> 'done' then
        item || jsonb_build_object('session', v_run_id)
        else item end order by ord), '[]'::jsonb) into v_tasks$after$);
  v_definition := replace(v_definition, $before$      select coalesce(jsonb_agg(relay_private.update_task_worker(
        item, v_agent_id::text, null, v_now) order by ord), '[]'::jsonb) into v_tasks$before$, $after$      select coalesce(jsonb_agg(case when item->>'owner' = v_agent_id::text and item->>'status' <> 'done' then
        item || jsonb_build_object('owner', null, 'session', null, 'status', 'ready', 'updatedAt', v_now)
        else item end order by ord), '[]'::jsonb) into v_tasks$after$);
  v_definition := replace(v_definition, $before$      -- Shared posts/history remain attributed to a disabled anonymous tombstone.
      -- Remove this worker's assignments while preserving other workers' runs.$before$, $after$      -- Shared posts/tasks remain attributed to a disabled anonymous tombstone.$after$);
  v_definition := replace(v_definition, $before$      'workers', v_workers,
      'manager', (select jsonb_build_object('name', a.name)
        from relay_private.accounts a where a.role = 'manager'),
      'capabilities', jsonb_build_object('taskLifecycleV1', true));$before$, $after$      'workers', v_workers);$after$);
  execute v_definition;
  if (select md5(prosrc) from pg_proc where oid=v_rpc) <> '6f6381892da4da201900f74e7fd6b8fb' then
    raise exception 'Baseline RPC verification failed; transaction rolled back.';
  end if;
end;
$rollback$;

drop function if exists relay_private.update_task_worker(jsonb,text,text,timestamptz);
commit;
