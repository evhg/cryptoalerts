-- Telegram bridge: hourly question limits per group.
--
-- The limits for guests (questions per hour for a whole chat, and per person) were one pair of numbers for every
-- group. A group can now carry its own; where it has none, the general numbers in tg_config apply.

alter table stusds_alert.tg_chats add column if not exists guest_per_chat_hour int;
alter table stusds_alert.tg_chats add column if not exists guest_per_user_hour int;

do $$
declare
  src text;
  a1 text := 'if v_n >= t.guest_per_chat_hour then';
  b1 text := 'if v_n >= coalesce((select c.guest_per_chat_hour from stusds_alert.tg_chats c where c.chat_id = v_chat), t.guest_per_chat_hour) then';
  a2 text := 'if v_n >= t.guest_per_user_hour then';
  b2 text := 'if v_n >= coalesce((select c.guest_per_user_hour from stusds_alert.tg_chats c where c.chat_id = v_chat), t.guest_per_user_hour) then';
begin
  select pg_get_functiondef('public.tg_ingest(jsonb)'::regprocedure) into src;
  if position(b1 in src) > 0 then
    return;
  end if;
  if position(a1 in src) = 0 or position(a2 in src) = 0 then
    raise exception 'tg_ingest: the limit checks were not found';
  end if;
  execute replace(replace(src, a1, b1), a2, b2);
end $$;

-- Set or clear (null) a group's own limits, by its title or chat id.
create or replace function stusds_alert.tg_group_limits(p_chat text, p_per_chat_hour int, p_per_user_hour int)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  update stusds_alert.tg_chats set guest_per_chat_hour = p_per_chat_hour, guest_per_user_hour = p_per_user_hour, updated_at = now()
  where chat_id::text = p_chat or lower(title) = lower(p_chat);
  get diagnostics v_n = row_count;
  return case when v_n = 0 then 'no such chat' else 'limits set for ' || v_n || ' chat(s)' end;
end $$;
revoke execute on function stusds_alert.tg_group_limits(text, int, int) from public, anon, authenticated;
