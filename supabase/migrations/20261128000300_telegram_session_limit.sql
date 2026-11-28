-- Telegram bridge: a separate hourly limit for guest questions that go to the main session.
--
-- A group's limits so far counted every message addressed to the bot. An owner asked (28 November) for quick
-- answers without a practical limit and a limit only on what reaches the main session, which is what costs. The
-- group's own number is in tg_chats.guest_session_per_hour; where it is empty, tg_config.guest_per_chat_hour applies.

alter table stusds_alert.tg_chats add column if not exists guest_session_per_hour int;

-- May this guest message be handed to the main session? Counts what was handed on in this chat in the last hour.
create or replace function public.tg_guest_handoff(p_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  m stusds_alert.tg_messages;
  v_limit int;
  v_n int;
begin
  select * into m from stusds_alert.tg_messages where id = p_id;
  if not found then
    return false;
  end if;
  if m.role = 'owner' then
    return true;
  end if;
  select coalesce(c.guest_session_per_hour, t.guest_per_chat_hour) into v_limit
  from stusds_alert.tg_config t left join stusds_alert.tg_chats c on c.chat_id = m.chat_id where t.id = 1;
  select count(*) into v_n from stusds_alert.tg_messages x
  where x.direction = 'in' and x.role = 'guest' and x.chat_id = m.chat_id and x.id <> m.id
    and x.created_at > now() - interval '1 hour' and x.note like 'fast responder handoff%';
  return v_n < v_limit;
end $$;
revoke execute on function public.tg_guest_handoff(bigint) from public, anon, authenticated;
grant execute on function public.tg_guest_handoff(bigint) to service_role;

-- Set a group's limit for main-session questions, by its title or chat id (null: back to the general number).
create or replace function stusds_alert.tg_group_session_limit(p_chat text, p_per_hour int)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  update stusds_alert.tg_chats set guest_session_per_hour = p_per_hour, updated_at = now()
  where chat_id::text = p_chat or lower(title) = lower(p_chat);
  get diagnostics v_n = row_count;
  return case when v_n = 0 then 'no such chat' else 'limit set for ' || v_n || ' chat(s)' end;
end $$;
revoke execute on function stusds_alert.tg_group_session_limit(text, int) from public, anon, authenticated;
