-- Telegram bridge: a bot that posts updates into group chats and passes questions to the Claude session.
--
-- The edge function `tg-bot` receives Telegram's webhook, decides who is speaking from the Telegram user id
-- (never from what a message says), stores the message here and wakes the session. The session reads
-- `stusds_alert.v_tg_pending` and answers with `stusds_alert.tg_send`.

create table if not exists stusds_alert.tg_config (
  id int primary key default 1 check (id = 1),
  function_url text not null default '',
  webhook_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  bot_username text,
  enabled boolean not null default true,
  guest_per_chat_hour int not null default 8,   -- questions from non-owners answered per chat per hour
  guest_per_user_hour int not null default 4,   -- and per person
  fires_per_hour int not null default 25        -- session wake-ups per hour (the platform allows 30 per task)
);
insert into stusds_alert.tg_config (id) values (1) on conflict (id) do nothing;

create table if not exists stusds_alert.tg_users (
  user_id bigint primary key,
  username text,
  name text,
  role text not null default 'guest' check (role in ('owner', 'guest')),
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time codes: sending "/claim CODE" to the bot in a private chat makes that Telegram account an owner.
create table if not exists stusds_alert.tg_claims (
  code text primary key,
  label text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by bigint,
  used_at timestamptz
);

-- Group chats the bot serves. Only an owner can add it; added by anyone else, it leaves.
create table if not exists stusds_alert.tg_chats (
  chat_id bigint primary key,
  title text,
  type text,
  added_by bigint,
  active boolean not null default true,
  auto_posts boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stusds_alert.tg_messages (
  id bigint generated always as identity primary key,
  direction text not null check (direction in ('in', 'out')),
  chat_id bigint not null,
  message_id bigint,
  user_id bigint,
  sender text,
  role text,
  text text,
  reply_to text,
  note text,
  created_at timestamptz not null default now(),
  fired_at timestamptz,
  answered_at timestamptz
);
create index if not exists tg_messages_pending on stusds_alert.tg_messages (id) where direction = 'in' and answered_at is null;
create index if not exists tg_messages_recent on stusds_alert.tg_messages (created_at);

alter table stusds_alert.tg_config enable row level security;
alter table stusds_alert.tg_users enable row level security;
alter table stusds_alert.tg_claims enable row level security;
alter table stusds_alert.tg_chats enable row level security;
alter table stusds_alert.tg_messages enable row level security;

-- What the session reads when it is woken.
create or replace view stusds_alert.v_tg_pending as
select m.id, m.chat_id, c.title as chat_title, case when m.chat_id = m.user_id then 'private' else coalesce(c.type, 'group') end as chat_type,
       m.message_id, m.user_id, m.sender, m.role, u.label as owner_label, m.text, m.reply_to,
       to_char(m.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk
from stusds_alert.tg_messages m
left join stusds_alert.tg_chats c on c.chat_id = m.chat_id
left join stusds_alert.tg_users u on u.user_id = m.user_id
where m.direction = 'in' and m.answered_at is null
order by m.id;

-- Who is calling the function: Telegram (webhook secret) or the session (cron secret).
create or replace function public.tg_begin(p_webhook_secret text, p_cron_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t stusds_alert.tg_config;
  v_caller text := null;
begin
  select * into t from stusds_alert.tg_config where id = 1;
  if not found then
    return jsonb_build_object('caller', null);
  end if;
  if coalesce(p_webhook_secret, '') <> '' and p_webhook_secret = t.webhook_secret then
    v_caller := 'telegram';
  elsif coalesce(p_cron_secret, '') <> '' and exists (select 1 from stusds_alert.config c where c.id = 1 and c.cron_secret = p_cron_secret) then
    v_caller := 'session';
  end if;
  if v_caller is null then
    return jsonb_build_object('caller', null);
  end if;
  return jsonb_build_object('caller', v_caller, 'enabled', t.enabled, 'bot_username', t.bot_username,
    'webhook_secret', case when v_caller = 'session' then t.webhook_secret end);
end $$;

create or replace function public.tg_set_bot(p_username text, p_function_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update stusds_alert.tg_config set bot_username = p_username, function_url = p_function_url where id = 1;
end $$;

-- One incoming message, already reduced by the function to: chat, from, message_id, text, reply_to, addressed.
-- Returns what the function should do: ignore, reply (with text), fire (wake the session) or queued.
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
  insert into stusds_alert.tg_messages (direction, chat_id, message_id, user_id, sender, role, text, reply_to)
  values ('in', v_chat, (p->>'message_id')::bigint, v_user,
          coalesce(nullif(p->'from'->>'name', ''), p->'from'->>'username', v_user::text), u.role, v_text, left(p->>'reply_to', 600))
  returning id into v_id;

  select count(*) into v_n from stusds_alert.tg_messages m where m.fired_at > now() - interval '1 hour';
  if v_n >= t.fires_per_hour then
    return jsonb_build_object('action', 'queued', 'id', v_id, 'text', 'Received. I am at my hourly wake-up limit, so the answer comes with my next hourly check.');
  end if;
  update stusds_alert.tg_messages set fired_at = now() where id = v_id;
  return jsonb_build_object('action', 'fire', 'id', v_id, 'role', u.role,
    'pending', (select count(*) from stusds_alert.tg_messages m where m.direction = 'in' and m.answered_at is null));
end $$;

-- The wake-up call failed: leave the message pending for the hourly check and say why.
create or replace function public.tg_fire_failed(p_id bigint, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update stusds_alert.tg_messages set fired_at = null, note = left(p_note, 300) where id = p_id;
end $$;

-- The bot was added to or removed from a chat.
create or replace function public.tg_chat_member(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_chat bigint := (p->'chat'->>'id')::bigint;
  v_from bigint := (p->'from'->>'id')::bigint;
  v_status text := p->>'status';
begin
  if v_status in ('member', 'administrator') then
    if exists (select 1 from stusds_alert.tg_chats c where c.chat_id = v_chat and c.active) then
      update stusds_alert.tg_chats set title = p->'chat'->>'title', type = p->'chat'->>'type', updated_at = now() where chat_id = v_chat;
      return jsonb_build_object('action', 'ignore');
    end if;
    if exists (select 1 from stusds_alert.tg_users u where u.user_id = v_from and u.role = 'owner') then
      insert into stusds_alert.tg_chats (chat_id, title, type, added_by)
      values (v_chat, p->'chat'->>'title', p->'chat'->>'type', v_from)
      on conflict (chat_id) do update set title = excluded.title, type = excluded.type, added_by = excluded.added_by, active = true, updated_at = now();
      return jsonb_build_object('action', 'greet', 'text', 'Hello. I post stUSDS alerts here and answer questions when I am mentioned or replied to.');
    end if;
    return jsonb_build_object('action', 'leave');
  end if;
  update stusds_alert.tg_chats set active = false, updated_at = now() where chat_id = v_chat;
  return jsonb_build_object('action', 'ignore');
end $$;

revoke execute on function public.tg_begin(text, text) from public, anon, authenticated;
revoke execute on function public.tg_set_bot(text, text) from public, anon, authenticated;
revoke execute on function public.tg_ingest(jsonb) from public, anon, authenticated;
revoke execute on function public.tg_fire_failed(bigint, text) from public, anon, authenticated;
revoke execute on function public.tg_chat_member(jsonb) from public, anon, authenticated;
grant execute on function public.tg_begin(text, text) to service_role;
grant execute on function public.tg_set_bot(text, text) to service_role;
grant execute on function public.tg_ingest(jsonb) to service_role;
grant execute on function public.tg_fire_failed(bigint, text) to service_role;
grant execute on function public.tg_chat_member(jsonb) to service_role;

-- Send a message through the bot. p_answers: ids of pending messages this reply settles.
create or replace function stusds_alert.tg_send(p_chat bigint, p_text text, p_reply_to bigint default null, p_answers bigint[] default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  t stusds_alert.tg_config;
  c stusds_alert.config;
  v_req bigint;
begin
  select * into t from stusds_alert.tg_config where id = 1;
  select * into c from stusds_alert.config where id = 1;
  if coalesce(t.function_url, '') = '' then
    raise exception 'the Telegram function is not set up yet';
  end if;
  select net.http_post(
    url := t.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := jsonb_build_object('action', 'send', 'chat_id', p_chat, 'text', p_text, 'reply_to_message_id', p_reply_to),
    timeout_milliseconds := 8000) into v_req;
  insert into stusds_alert.tg_messages (direction, chat_id, text, note) values ('out', p_chat, p_text, 'request ' || v_req);
  if p_answers is not null then
    update stusds_alert.tg_messages set answered_at = now() where id = any(p_answers);
  end if;
  return v_req;
end $$;

-- Settle pending messages without a reply.
create or replace function stusds_alert.tg_done(p_ids bigint[])
returns void language sql security definer set search_path = '' as $$
  update stusds_alert.tg_messages set answered_at = now() where id = any(p_ids);
$$;

-- Post to every group that takes automatic updates.
create or replace function stusds_alert.tg_broadcast(p_text text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in select chat_id from stusds_alert.tg_chats where active and auto_posts loop
    perform stusds_alert.tg_send(r.chat_id, p_text);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function stusds_alert.tg_send(bigint, text, bigint, bigint[]) from public, anon, authenticated;
revoke execute on function stusds_alert.tg_done(bigint[]) from public, anon, authenticated;
revoke execute on function stusds_alert.tg_broadcast(text) from public, anon, authenticated;

-- Automatic post 1: the utilization alert (same event as the email and the push).
create or replace function stusds_alert.tg_on_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform stusds_alert.tg_broadcast(
      'stUSDS utilization ' || to_char(trunc(new.util_ppm / 10000, 3), 'FM990.000') || '%: '
      || to_char(trunc(new.available), 'FM999,999,999,990') || ' USDS withdrawable now (block ' || new.block
      || '). Liquidity can be taken at any moment.');
  exception when others then
    null; -- a Telegram problem must never block the alert itself
  end;
  return new;
end $$;
create or replace trigger tg_alert after insert on stusds_alert.alerts for each row execute function stusds_alert.tg_on_alert();

-- Automatic post 2: a large repayment moving through one of the watched Safes.
create or replace function stusds_alert.tg_on_safe_tx()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_who text;
  v_amount text;
  v_msg text := null;
begin
  if new.repay_usds < 100000 then
    return new;
  end if;
  v_who := case lower(new.safe)
    when '0xca5183fb9997046fbd9ba8113139bf5a5af122a0' then 'the Sky Frontier Foundation Safe'
    when '0xf65475e74c1ed6d004d5240b06e3088724dfda5d' then 'the rune.eth Safe'
    else 'Safe ' || left(new.safe, 8) end;
  v_amount := to_char(trunc(new.repay_usds), 'FM999,999,999,990') || ' USDS';
  if tg_op = 'INSERT' then
    v_msg := 'A repayment of ' || v_amount || ' has been queued in ' || v_who || ' (' || new.confirmations || ' of ' || new.required || ' signatures).';
    if new.executed_at is not null then
      v_msg := 'A repayment of ' || v_amount || ' from ' || v_who || ' has been executed.';
    end if;
  elsif new.executed_at is not null and old.executed_at is null then
    v_msg := 'The repayment of ' || v_amount || ' from ' || v_who || ' has been executed.';
  elsif new.required > 0 and new.confirmations >= new.required and old.confirmations < old.required then
    v_msg := 'The repayment of ' || v_amount || ' in ' || v_who || ' is fully signed and can be executed at any moment.';
  end if;
  if v_msg is not null then
    begin
      perform stusds_alert.tg_broadcast(v_msg);
    exception when others then
      null;
    end;
  end if;
  return new;
end $$;
create or replace trigger tg_safe_tx after insert or update on stusds_alert.safe_txs for each row execute function stusds_alert.tg_on_safe_tx();
