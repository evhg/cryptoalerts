-- Telegram bridge: long messages.
--
-- Telegram cuts a long text into parts of up to 4096 characters and delivers each part as its own message; only the
-- first carries the mention. Until now a stored message was also cut at 2000 characters. A stored message may now be
-- one whole part, and a part that follows an addressed message from the same person within a few seconds is added
-- to it instead of being dropped.

do $$
declare
  src text;
begin
  select pg_get_functiondef('public.tg_ingest(jsonb)'::regprocedure) into src;
  if position('length(v_text) > 2000' in src) > 0 then
    src := replace(src, 'length(v_text) > 2000', 'length(v_text) > 4200');
    src := replace(src, 'left(v_text, 2000)', 'left(v_text, 4200)');
    execute src;
  end if;
end $$;

create or replace function public.tg_append(p jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  select m.id into v_id from stusds_alert.tg_messages m
  where m.direction = 'in' and m.chat_id = (p->>'chat_id')::bigint and m.user_id = (p->>'user_id')::bigint
    and m.created_at > now() - interval '20 seconds' and length(m.text) >= 3000 and length(m.text) < 12000
  order by m.id desc limit 1;
  if v_id is null then
    return false;
  end if;
  update stusds_alert.tg_messages set text = left(text || E'\n' || coalesce(p->>'text', ''), 12000) where id = v_id;
  return true;
end $$;
revoke execute on function public.tg_append(jsonb) from public, anon, authenticated;
grant execute on function public.tg_append(jsonb) to service_role;
