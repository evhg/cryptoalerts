-- Exit bot: keep watching the Safes when the Safe API key is refused.
--
-- On 28 November Safe's transaction service answered "Monthly quota exceeded" for our key from 11:04 Bangkok time,
-- and the same for requests from the database's address. The exit function then had nothing to fall back on and the
-- watch on both Safes was blind for hours. Requests without a key from where the function itself runs still work
-- (about 5,000 in 30 days, for all Safes together). The function now asks that way at a pace the quota allows and
-- stores the answer here, where stusds_exit_safe_fetch serves it in between.

create or replace function public.stusds_exit_safe_store(p_secret text, p_safe text, p_status int, p_body jsonb, p_remaining int, p_reset int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := lower(p_safe);
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  if p_safe !~ '^0x[0-9a-fA-F]{40}$' then
    return jsonb_build_object('authorized', true, 'stored', false);
  end if;
  if p_status = 200 and p_body is not null then
    -- next_at lies beyond the function's own pace, so the database does not ask Safe itself in between.
    insert into stusds_alert.safe_poll_state (safe, next_at, last_try_at, last_status, last_ok_at, quota_remaining, quota_reset_at, body)
    values (v_key, now() + interval '40 minutes', now(), 200, now(), nullif(p_remaining, -1), now() + make_interval(secs => coalesce(p_reset, 0)), p_body)
    on conflict (safe) do update set next_at = excluded.next_at, last_try_at = now(), last_status = 200, last_ok_at = now(),
      quota_remaining = excluded.quota_remaining, quota_reset_at = excluded.quota_reset_at, body = excluded.body;
    return jsonb_build_object('authorized', true, 'stored', true);
  end if;
  insert into stusds_alert.safe_poll_state (safe, next_at, last_try_at, last_status) values (v_key, now() + interval '5 minutes', now(), p_status)
  on conflict (safe) do update set last_try_at = now(), last_status = excluded.last_status;
  return jsonb_build_object('authorized', true, 'stored', false);
end $$;
revoke execute on function public.stusds_exit_safe_store(text, text, int, jsonb, int, int) from public, anon, authenticated;
grant execute on function public.stusds_exit_safe_store(text, text, int, jsonb, int, int) to service_role;
