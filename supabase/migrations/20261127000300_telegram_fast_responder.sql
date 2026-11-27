-- Telegram bridge: a fast responder in front of the session.
--
-- The function asks a small model (through an OpenAI-compatible gateway) to answer simple questions within a few
-- seconds from public facts only: a briefing the session keeps up to date plus live numbers. Anything else an owner
-- says is handed to the session. While the fast attempt runs, the message is held so the session's watcher does not
-- wake for it; the hold expires by itself if the function dies.

alter table stusds_alert.tg_config add column if not exists fast_enabled boolean not null default true;
alter table stusds_alert.tg_config add column if not exists fast_model text not null default 'claude-haiku-5-5';
alter table stusds_alert.tg_config add column if not exists brief text not null default '';
alter table stusds_alert.tg_messages add column if not exists hold_until timestamptz;
alter table stusds_alert.tg_messages add column if not exists answered_by text;

-- The watcher and the session only see messages that are not being held for the fast responder.
create or replace view stusds_alert.v_tg_pending as
select m.id, m.chat_id, c.title as chat_title, case when m.chat_id = m.user_id then 'private' else coalesce(c.type, 'group') end as chat_type,
       m.message_id, m.user_id, m.sender, m.role, u.label as owner_label, m.text, m.reply_to,
       to_char(m.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk
from stusds_alert.tg_messages m
left join stusds_alert.tg_chats c on c.chat_id = m.chat_id
left join stusds_alert.tg_users u on u.user_id = m.user_id
where m.direction = 'in' and m.answered_at is null and (m.hold_until is null or m.hold_until < now())
order by m.id;

create or replace function public.tg_poll(p_key text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  if not exists (select 1 from stusds_alert.tg_config t where t.id = 1 and t.poll_key = p_key) then
    return -1;
  end if;
  update stusds_alert.tg_config set last_poll_at = now() where id = 1;
  select count(*) into v_n from stusds_alert.tg_messages m
  where m.direction = 'in' and m.answered_at is null and (m.hold_until is null or m.hold_until < now());
  return v_n;
end $$;

create or replace function public.tg_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t stusds_alert.tg_config;
  u stusds_alert.tg_users;
  cl stusds_alert.tg_claims;
  v_chat bigint := (p->'chat'->>'id')::bigint;
  v_user bigint := (p->'from'->>'id')::bigint;
  v_private boolean := (p->'chat'->>'type') = 'private';
  v_text text := coalesce(p->>'text', '');
  v_addressed boolean := coalesce((p->>'addressed')::boolean, false);
  v_fast boolean;
  v_listening boolean;
  v_code text;
  v_id bigint;
  v_n int;
begin
  select * into t from stusds_alert.tg_config where id = 1;
  insert into stusds_alert.tg_users (user_id, username, name)
  values (v_user, p->'from'->>'username', p->'from'->>'name')
  on conflict (user_id) do update set username = excluded.username, name = excluded.name, updated_at = now()
  returning * into u;

  if v_private and v_text ~* '^/claim(@\w+)?\s+\S+' then
    v_code := upper(trim(regexp_replace(v_text, '^/claim(@\w+)?\s+', '', 'i')));
    update stusds_alert.tg_claims set used_by = v_user, used_at = now()
    where code = v_code and used_by is null and expires_at > now()
    returning * into cl;
    if found then
      update stusds_alert.tg_users set role = 'owner', label = cl.label, updated_at = now() where user_id = v_user;
      return jsonb_build_object('action', 'reply', 'text', 'Done. You are registered as an owner (' || cl.label || '). Add me to a group and mention me there, or write to me here.');
    end if;
    return jsonb_build_object('action', 'reply', 'text', 'That code is not valid or has expired.');
  end if;

  if not t.enabled then
    return jsonb_build_object('action', 'ignore');
  end if;

  if v_private then
    if u.role <> 'owner' then
      return jsonb_build_object('action', 'reply', 'text', 'I only answer in group chats that an owner has added me to.');
    end if;
  else
    if not v_addressed or not exists (select 1 from stusds_alert.tg_chats c where c.chat_id = v_chat and c.active) then
      return jsonb_build_object('action', 'ignore');
    end if;
    if u.role <> 'owner' then
      select count(*) into v_n from stusds_alert.tg_messages m
      where m.direction = 'in' and m.role = 'guest' and m.chat_id = v_chat and m.created_at > now() - interval '1 hour';
      if v_n >= t.guest_per_chat_hour then
        return jsonb_build_object('action', 'reply', 'text', 'I have reached my hourly limit for questions in this chat. Please try again later.');
      end if;
      select count(*) into v_n from stusds_alert.tg_messages m
      where m.direction = 'in' and m.role = 'guest' and m.user_id = v_user and m.created_at > now() - interval '1 hour';
      if v_n >= t.guest_per_user_hour then
        return jsonb_build_object('action', 'reply', 'text', 'You have reached the hourly limit for questions. Please try again later.');
      end if;
    end if;
  end if;

  if length(v_text) > 2000 then
    v_text := left(v_text, 2000) || ' [cut]';
  end if;
  -- `fast`: the function has a key for the fast responder and will try it first.
  v_fast := t.fast_enabled and coalesce((p->>'fast')::boolean, false);
  v_listening := t.last_poll_at is not null and t.last_poll_at > now() - interval '2 minutes';
  insert into stusds_alert.tg_messages (direction, chat_id, message_id, user_id, sender, role, text, reply_to, hold_until)
  values ('in', v_chat, (p->>'message_id')::bigint, v_user,
          coalesce(nullif(p->'from'->>'name', ''), p->'from'->>'username', v_user::text), u.role, v_text, left(p->>'reply_to', 600),
          case when v_fast then now() + interval '12 seconds' end)
  returning id into v_id;

  return jsonb_build_object('action', case when v_listening then 'wait' else 'queued' end, 'id', v_id, 'role', u.role,
    'fast', v_fast, 'listening', v_listening,
    'text', 'Received. I read messages once an hour, so the answer comes with my next check.');
end $$;

-- What the fast responder is given: the briefing, live public numbers, recent public events, and the recent
-- exchange in this chat. Nothing private is in here.
create or replace function public.tg_fast_context(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t stusds_alert.tg_config;
  m stusds_alert.tg_messages;
  d jsonb;
begin
  select * into t from stusds_alert.tg_config where id = 1;
  select * into m from stusds_alert.tg_messages where id = p_id;
  if not found then
    return null;
  end if;
  select n.data into d from stusds_alert.dash_now n where n.id = 1;
  return jsonb_build_object(
    'model', t.fast_model,
    'brief', t.brief,
    'role', m.role,
    'sender', m.sender,
    'text', m.text,
    'reply_to', m.reply_to,
    'private_chat', m.chat_id = m.user_id,
    'now_bkk', to_char(now() at time zone 'Asia/Bangkok', 'DD Mon YYYY HH24:MI'),
    'live', jsonb_build_object(
      'utilization_pct', d->'util_pct', 'withdrawable_usds', d->'available', 'vault_total_usds', d->'total_assets',
      'lent_out_usds', d->'debt', 'stusds_rate_pct', d->'str_pct', 'borrow_rate_pct', d->'duty_pct',
      'curve_discount_pct', d->'dex_discount_pct', 'sky_price_usd', d->'sky_usd', 'eth_price_usd', d->'eth_usd',
      'deposit_cap_usds', d->'deposit_cap', 'debt_ceiling_usds', d->'debt_ceiling',
      'data_as_of_bkk', (select to_char(n.at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') from stusds_alert.dash_now n where n.id = 1)),
    'recent_events', (select coalesce(jsonb_agg(jsonb_build_object('time_bkk', f.time_bkk, 'kind', f.kind, 'usds', f.amount,
        'taken_by', f.taker_kind, 'taken_usds', f.taken, 'blocks_later', f.lag_blocks, 'paid_pct', f.pay_pct)), '[]'::jsonb)
      from (select * from stusds_alert.v_dash_flows limit 6) f),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('from', case when h.direction = 'out' then 'bot' else coalesce(h.role, 'guest') end,
        'text', left(h.text, 500)) order by h.id), '[]'::jsonb)
      from (select * from stusds_alert.tg_messages x where x.chat_id = m.chat_id and x.id < m.id order by x.id desc limit 6) h));
end $$;

-- The fast responder answered: record the reply and settle the message.
create or replace function public.tg_fast_done(p_id bigint, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m stusds_alert.tg_messages;
begin
  update stusds_alert.tg_messages set answered_at = now(), answered_by = 'fast', hold_until = null where id = p_id returning * into m;
  if found then
    insert into stusds_alert.tg_messages (direction, chat_id, text, note) values ('out', m.chat_id, p_text, 'fast responder');
  end if;
end $$;

-- The fast responder could not or should not answer: let the session have it now.
create or replace function public.tg_fast_release(p_id bigint, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update stusds_alert.tg_messages set hold_until = null, note = left(p_note, 300) where id = p_id;
end $$;

revoke execute on function public.tg_fast_context(bigint) from public, anon, authenticated;
revoke execute on function public.tg_fast_done(bigint, text) from public, anon, authenticated;
revoke execute on function public.tg_fast_release(bigint, text) from public, anon, authenticated;
grant execute on function public.tg_fast_context(bigint) to service_role;
grant execute on function public.tg_fast_done(bigint, text) to service_role;
grant execute on function public.tg_fast_release(bigint, text) to service_role;
