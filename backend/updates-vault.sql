-- Optional encrypted publisher configuration. No secret values belong here.
begin;
create function relay_private.update_publisher_secret()
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare config jsonb;
begin
  -- PostgREST sets the caller role before invoking the public wrapper.
  -- current_user inside this narrow definer would be the function owner.
  if current_setting('role',true) is distinct from 'service_role' then
    raise insufficient_privilege using message='Server access required.';
  end if;
  if not exists(select 1 from relay_private.studio where singleton and not deleted) then
    return null;
  end if;
  select decrypted_secret::jsonb into config from vault.decrypted_secrets
    where name='relay_update_publisher';
  return config;
end;
$$;
revoke all on function relay_private.update_publisher_secret() from public,anon,authenticated;
grant execute on function relay_private.update_publisher_secret() to service_role;

create function public.relay_update_publisher_credentials()
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if current_user <> 'service_role' then
    raise insufficient_privilege using message='Server access required.';
  end if;
  return relay_private.update_publisher_secret();
end;
$$;
revoke all on function public.relay_update_publisher_credentials() from public,anon,authenticated;
grant execute on function public.relay_update_publisher_credentials() to service_role;
commit;
