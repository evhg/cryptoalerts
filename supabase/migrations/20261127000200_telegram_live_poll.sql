-- Telegram bridge: answers within seconds instead of at the hourly check.
--
-- The session runs `watcher/tg-wait.mjs` as a background command. It long-polls the function, which calls
-- `tg_poll`: that records that a watcher is listening and says how many messages are waiting. When the watcher
-- sees one it exits, and that exit starts a turn in the session.
alter table stusds_alert.tg_config add column if not exists last_poll_at timestamptz;
alter table stusds_alert.tg_config add column if not exists poll_key text not null default replace(gen_random_uuid()::text, '-', '');

create or replace function public.tg_poll(p_key text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  if not exists (select 1 from stusds_alert.tg_config t where t.id = 1 and t.poll_key = p_key) then
    return -1;
  end if;
  update stusds_alert.tg_config set last_poll_at = now() where id = 1;
  select count(*) into v_n from stusds_alert.tg_messages m where m.direction = 'in' and m.answered_at is null;
  return v_n;
end $$;
revoke execute on function public.tg_poll(text) from public, anon, authenticated;
grant execute on function public.tg_poll(text) to service_role;

-- tg_ingest: while a watcher polled within the last two minutes, a stored message needs no "wait an hour" reply.
-- The function then returns action 'wait' and the bot only shows "typing".
do $$
declare
  src text;
  a text := '    return jsonb_build_object(''action'', ''queued'', ''id'', v_id, ''text'', ''Received. I read messages once an hour, so the answer comes with my next check.'');';
  b text := '    if t.last_poll_at is not null and t.last_poll_at > now() - interval ''2 minutes'' then
      return jsonb_build_object(''action'', ''wait'', ''id'', v_id);
    end if;
    return jsonb_build_object(''action'', ''queued'', ''id'', v_id, ''text'', ''Received. I read messages once an hour, so the answer comes with my next check.'');';
begin
  select pg_get_functiondef('public.tg_ingest(jsonb)'::regprocedure) into src;
  if position(a in src) = 0 then
    raise exception 'tg_ingest: the line to replace was not found';
  end if;
  if position('''action'', ''wait''' in src) = 0 then
    src := replace(src, a, b);
    execute src;
  end if;
end $$;
