-- Price and indicator alerts set from Telegram.
--
-- A person writes "/alert BTC below 58500" (or asks in words) in a chat with the bot. The rule is stored here, the
-- tg-bot function checks every active rule once a minute (action "alerts_tick", called by the job at the bottom) and
-- posts in that chat when one comes true. An alert fires once.
--
-- Who may set one: an owner anywhere, a guest only in a group an owner has opened for questions
-- (tg_chats.guest_questions). That is decided here from the stored message row, never from anything the caller says.
-- Limits: alerts_per_user active alerts for a guest across all chats, alerts_per_chat active alerts in one chat.

alter table stusds_alert.tg_config add column if not exists alerts_per_user int not null default 10;
alter table stusds_alert.tg_config add column if not exists alerts_per_chat int not null default 100;

create table if not exists stusds_alert.tg_alerts (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  user_id bigint not null,
  sender text,
  message_id bigint,                       -- the message that asked for it; the alert is posted as a reply to it
  symbol text not null check (symbol ~ '^[A-Z0-9]{2,12}$'),
  metric text not null check (metric in ('price', 'rsi', 'sma', 'ema')),
  op text not null check (op in ('above', 'below')),
  value numeric check (value is null or value > 0),
  "interval" text check ("interval" in ('15m', '1h', '4h', '1d')),   -- null: last traded price, checked every minute
  period int check (period is null or period between 2 and 250),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  checked_at timestamptz,
  checked_slot bigint,                     -- candle alerts: the candle period up to which this rule has been checked
  last_value numeric,
  last_error text,
  fail_count int not null default 0,
  fired_at timestamptz,
  fired_value numeric,
  ended_reason text,                       -- fired, deleted, expired, no_data, chat_gone, send_failed
  check (metric <> 'price' or value is not null),
  check (metric = 'price' or ("interval" is not null and period is not null)),
  check (metric <> 'rsi' or (value is not null and value < 100))
);
create index if not exists tg_alerts_active on stusds_alert.tg_alerts (chat_id) where active;
alter table stusds_alert.tg_alerts enable row level security;
revoke all on stusds_alert.tg_alerts from public, anon, authenticated;

create or replace function public.tg_alert_add(p_id bigint, p_rule jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m stusds_alert.tg_messages;
  t stusds_alert.tg_config;
  v_n int;
  v_id bigint;
  v_symbol text := upper(coalesce(p_rule->>'symbol', ''));
  v_metric text := p_rule->>'metric';
  v_op text := p_rule->>'op';
  v_value numeric := (p_rule->>'value')::numeric;
  v_interval text := p_rule->>'interval';
  v_period int := (p_rule->>'period')::int;
begin
  select * into m from stusds_alert.tg_messages where id = p_id and direction = 'in';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_message');
  end if;
  select * into t from stusds_alert.tg_config where id = 1;
  if m.role <> 'owner' and not exists (
    select 1 from stusds_alert.tg_chats c where c.chat_id = m.chat_id and c.active and c.guest_questions) then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  select a.id into v_id from stusds_alert.tg_alerts a
  where a.active and a.chat_id = m.chat_id and a.user_id = m.user_id and a.symbol = v_symbol and a.metric = v_metric and a.op = v_op
    and a.value is not distinct from v_value and a."interval" is not distinct from v_interval and a.period is not distinct from v_period;
  if found then
    return jsonb_build_object('ok', false, 'error', 'duplicate', 'id', v_id);
  end if;
  if m.role <> 'owner' then
    select count(*) into v_n from stusds_alert.tg_alerts a where a.active and a.user_id = m.user_id;
    if v_n >= t.alerts_per_user then
      return jsonb_build_object('ok', false, 'error', 'user_limit', 'limit', t.alerts_per_user);
    end if;
  end if;
  select count(*) into v_n from stusds_alert.tg_alerts a where a.active and a.chat_id = m.chat_id;
  if v_n >= t.alerts_per_chat then
    return jsonb_build_object('ok', false, 'error', 'chat_limit', 'limit', t.alerts_per_chat);
  end if;
  insert into stusds_alert.tg_alerts (chat_id, user_id, sender, message_id, symbol, metric, op, value, "interval", period)
  values (m.chat_id, m.user_id, m.sender, m.message_id, v_symbol, v_metric, v_op, v_value, v_interval, v_period)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'error', 'invalid');
end $$;

-- The asking person's active alerts in the chat the message came from.
create or replace function public.tg_alert_list(p_id bigint)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'symbol', a.symbol, 'metric', a.metric, 'op', a.op, 'value', a.value,
           'interval', a."interval", 'period', a.period) order by a.id), '[]'::jsonb)
  from stusds_alert.tg_messages m join stusds_alert.tg_alerts a on a.chat_id = m.chat_id and a.user_id = m.user_id and a.active
  where m.id = p_id and m.direction = 'in';
$$;

-- Remove an alert: one's own, or as an owner any alert in the chat the message came from.
create or replace function public.tg_alert_delete(p_id bigint, p_alert bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  m stusds_alert.tg_messages;
begin
  select * into m from stusds_alert.tg_messages where id = p_id and direction = 'in';
  if not found then
    return false;
  end if;
  update stusds_alert.tg_alerts a set active = false, ended_reason = 'deleted'
  where a.id = p_alert and a.active and (a.user_id = m.user_id or (m.role = 'owner' and a.chat_id = m.chat_id));
  return found;
end $$;

-- Everything the checker needs for one round: the active rules, and the rules that have just ended on their own
-- (too old, no data for half a day, or the bot is no longer in that group) so the bot can say so once.
create or replace function public.tg_alerts_due()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ended jsonb;
begin
  with gone as (
    update stusds_alert.tg_alerts a set active = false, ended_reason = 'chat_gone'
    where a.active and a.chat_id < 0 and not exists (select 1 from stusds_alert.tg_chats c where c.chat_id = a.chat_id and c.active)
  ), e as (
    update stusds_alert.tg_alerts a set active = false, ended_reason = case when a.expires_at <= now() then 'expired' else 'no_data' end
    where a.active and (a.expires_at <= now() or a.fail_count >= 720)
      and (a.chat_id > 0 or exists (select 1 from stusds_alert.tg_chats c where c.chat_id = a.chat_id and c.active))
    returning a.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'chat_id', e.chat_id, 'message_id', e.message_id, 'sender', e.sender, 'symbol', e.symbol,
           'metric', e.metric, 'op', e.op, 'value', e.value, 'interval', e."interval", 'period', e.period, 'reason', e.ended_reason)), '[]'::jsonb)
  into v_ended from e;
  return jsonb_build_object('ended', v_ended, 'alerts', (
    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'chat_id', a.chat_id, 'message_id', a.message_id, 'sender', a.sender, 'symbol', a.symbol,
             'metric', a.metric, 'op', a.op, 'value', a.value, 'interval', a."interval", 'period', a.period,
             'created_ms', floor(extract(epoch from a.created_at) * 1000), 'checked_slot', a.checked_slot) order by a.id), '[]'::jsonb)
    from (select * from stusds_alert.tg_alerts x where x.active and x.expires_at > now() and x.fail_count < 720
            and (x.chat_id > 0 or exists (select 1 from stusds_alert.tg_chats c where c.chat_id = x.chat_id and c.active))
          order by x.id limit 1000) a));
end $$;

-- Record one round of checks: [{id, value, slot, error}].
create or replace function public.tg_alerts_checked(p jsonb)
returns void language sql security definer set search_path = '' as $$
  update stusds_alert.tg_alerts a set
    checked_at = now(),
    last_value = coalesce((x->>'value')::numeric, a.last_value),
    checked_slot = coalesce((x->>'slot')::bigint, a.checked_slot),
    last_error = left(x->>'error', 200),
    fail_count = case when x->>'error' is null then 0 else a.fail_count + 1 end
  from jsonb_array_elements(p) x
  where a.id = (x->>'id')::bigint and a.active;
$$;

-- Claim an alert that has come true. True only for the first caller, so two overlapping rounds cannot both post it.
create or replace function public.tg_alert_fire(p_alert bigint, p_value numeric)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update stusds_alert.tg_alerts set active = false, fired_at = now(), fired_value = p_value, ended_reason = 'fired', checked_at = now()
  where id = p_alert and active;
  return found;
end $$;

-- After posting: keep the post in the chat record, or, when Telegram refused it, put the alert back for the next round
-- (up to 30 tries).
create or replace function public.tg_alert_sent(p_alert bigint, p_text text, p_ok boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a stusds_alert.tg_alerts;
begin
  select * into a from stusds_alert.tg_alerts where id = p_alert;
  if not found then
    return;
  end if;
  if p_ok then
    insert into stusds_alert.tg_messages (direction, chat_id, text, note) values ('out', a.chat_id, p_text, 'alert #' || a.id);
  elsif a.fail_count >= 30 then
    update stusds_alert.tg_alerts set ended_reason = 'send_failed', last_error = 'could not post' where id = p_alert;
  else
    update stusds_alert.tg_alerts set active = true, fired_at = null, fired_value = null, ended_reason = null,
      fail_count = fail_count + 1, last_error = 'could not post' where id = p_alert;
  end if;
end $$;

do $$
declare
  f text;
begin
  foreach f in array array['tg_alert_add(bigint, jsonb)', 'tg_alert_list(bigint)', 'tg_alert_delete(bigint, bigint)', 'tg_alerts_due()',
                           'tg_alerts_checked(jsonb)', 'tg_alert_fire(bigint, numeric)', 'tg_alert_sent(bigint, text, boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- For the session: what is set, by whom, and how the checks are going (times in Bangkok time).
create or replace view stusds_alert.v_tg_alerts as
select a.id, c.title as chat, a.sender, a.symbol, a.metric, a.op, a.value, a."interval", a.period, a.active, a.ended_reason,
       to_char(a.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as created_bkk,
       to_char(a.checked_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as checked_bkk,
       a.last_value, a.fail_count, a.last_error,
       to_char(a.fired_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as fired_bkk, a.fired_value
from stusds_alert.tg_alerts a left join stusds_alert.tg_chats c on c.chat_id = a.chat_id;
revoke all on stusds_alert.v_tg_alerts from public, anon, authenticated;

-- Check the alerts once a minute, but only while there is at least one.
select cron.unschedule(jobid) from cron.job where jobname = 'tg-alerts-tick';
select cron.schedule('tg-alerts-tick', '* * * * *', $job$
  select net.http_post(
    url := t.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{"action":"alerts_tick"}'::jsonb,
    timeout_milliseconds := 5000)
  from stusds_alert.tg_config t, stusds_alert.config c
  where t.id = 1 and c.id = 1 and t.function_url is not null
    and exists (select 1 from stusds_alert.tg_alerts a where a.active);
$job$);
