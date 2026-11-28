-- Telegram bridge: groups where guests may put questions to the main session.
--
-- By default a guest only gets what the fast responder can answer from public facts, and is never handed to the
-- session. An owner can open one group for questions (asked for in the group on 28 November and confirmed in the
-- private chat, as the rules require for anything that costs usage on every use). In such a group a guest question
-- the fast responder cannot answer is handed to the session, which looks it up and answers. Nothing else changes for
-- guests: nothing private, and no changes to code, settings, logins or schedules.

alter table stusds_alert.tg_chats add column if not exists guest_questions boolean not null default false;

-- The session sees with each waiting message whether it came from such a group.
create or replace view stusds_alert.v_tg_pending as
select m.id, m.chat_id, c.title as chat_title, case when m.chat_id = m.user_id then 'private' else coalesce(c.type, 'group') end as chat_type,
       m.message_id, m.user_id, m.sender, m.role, u.label as owner_label, m.text, m.reply_to,
       to_char(m.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk,
       coalesce(c.guest_questions, false) as guest_questions
from stusds_alert.tg_messages m
left join stusds_alert.tg_chats c on c.chat_id = m.chat_id
left join stusds_alert.tg_users u on u.user_id = m.user_id
where m.direction = 'in' and m.answered_at is null and (m.hold_until is null or m.hold_until < now())
order by m.id;

-- The fast responder is told the same, so it knows it may hand a guest's question on.
do $$
declare
  src text;
  a text := '''private_chat'', m.chat_id = m.user_id,';
  b text := '''private_chat'', m.chat_id = m.user_id,
    ''guest_questions'', coalesce((select c.guest_questions from stusds_alert.tg_chats c where c.chat_id = m.chat_id), false),';
begin
  select pg_get_functiondef('public.tg_fast_context(bigint)'::regprocedure) into src;
  if position(a in src) = 0 then
    raise exception 'tg_fast_context: the line to extend was not found';
  end if;
  if position('''guest_questions''' in src) = 0 then
    execute replace(src, a, b);
  end if;
end $$;

-- Open or close a group for guest questions, by its title or its chat id.
create or replace function stusds_alert.tg_guest_questions(p_chat text, p_on boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  update stusds_alert.tg_chats set guest_questions = p_on, updated_at = now()
  where chat_id::text = p_chat or lower(title) = lower(p_chat);
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return 'no such chat';
  end if;
  return 'guest questions ' || case when p_on then 'on' else 'off' end || ' for ' || v_n || ' chat(s)';
end $$;
revoke execute on function stusds_alert.tg_guest_questions(text, boolean) from public, anon, authenticated;
