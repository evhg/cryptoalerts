-- Bot v9 support and the data behind the live dashboard.
--
-- 1. claims: at most one run acts on a given event (cron runs overlap on purpose).
-- 2. heartbeats: "the pending-transaction feed is alive".
-- 3. Safe API pacing: without an API key Safe allows about 5,000 requests a month
--    per address; the fetch function now spaces its requests to what the quota
--    allows and serves its last answer in between, instead of burning the quota.
-- 4. Dashboard: a collector edge function (stusds-dash) writes one snapshot a
--    minute, a history row, new on-chain events and who took the liquidity.
-- 5. Significant-event pushes, each sent once.

create table if not exists stusds_alert.claims (key text primary key, at timestamptz not null default now());
create table if not exists stusds_alert.heartbeats (kind text primary key, at timestamptz not null default now(), detail jsonb);
create table if not exists stusds_alert.safe_poll_state (
  safe text primary key,
  next_at timestamptz not null default now(),
  last_try_at timestamptz,
  last_status int,
  last_ok_at timestamptz,
  quota_remaining int,
  quota_reset_at timestamptz,
  body jsonb
);
create table if not exists stusds_alert.dash_now (id int primary key default 1 check (id = 1), at timestamptz not null default now(), data jsonb not null);
create table if not exists stusds_alert.dash_history (
  at timestamptz primary key,
  block bigint,
  util_pct numeric, available numeric, total_assets numeric, debt numeric, nav numeric,
  str_pct numeric, duty_pct numeric, sky_usd numeric, eth_usd numeric,
  dex_discount_pct numeric, arb_profit_150k numeric, keeper_eth numeric, main_value numeric
);
create table if not exists stusds_alert.chain_events (
  tx text not null, log_index int not null, block bigint not null, block_ts timestamptz,
  kind text not null, who text, amount numeric not null,
  primary key (tx, log_index)
);
create index if not exists chain_events_block on stusds_alert.chain_events (block desc);
-- Everyone who took stUSDS liquidity: arb bots, racing holders, borrowers who repay and withdraw at once.
create table if not exists stusds_alert.takers (
  tx text primary key, block bigint not null, block_ts timestamptz, tx_index int,
  amount numeric not null, kind text not null, entity text, tx_from text, tx_to text,
  lag_blocks int, pay_eth numeric, traced boolean
);
create index if not exists takers_block on stusds_alert.takers (block desc);
create table if not exists stusds_alert.sim_results (id text primary key, run_at timestamptz not null default now(), block bigint, title text, data jsonb);

alter table stusds_alert.claims enable row level security;
alter table stusds_alert.heartbeats enable row level security;
alter table stusds_alert.safe_poll_state enable row level security;
alter table stusds_alert.dash_now enable row level security;
alter table stusds_alert.dash_history enable row level security;
alter table stusds_alert.chain_events enable row level security;
alter table stusds_alert.takers enable row level security;
alter table stusds_alert.sim_results enable row level security;

alter table stusds_alert.exit_config add column if not exists safe_poll_seconds int not null default 10 check (safe_poll_seconds >= 3);
-- Open races are won by whoever gives the builder most of the profit; 70% lost on Nov 25.
alter table stusds_alert.exit_config alter column arb_tip_share_race set default 0.85;
update stusds_alert.exit_config set arb_tip_share_race = 0.85, updated_at = now() where id = 1 and arb_tip_share_race < 0.85;

create or replace function public.stusds_exit_claim(p_secret text, p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then return false; end if;
  insert into stusds_alert.claims (key) values (p_key) on conflict do nothing;
  get diagnostics n = row_count;
  if random() < 0.02 then delete from stusds_alert.claims where at < now() - interval '3 days'; end if;
  return n = 1;
end $$;

create or replace function public.stusds_exit_heartbeat(p_secret text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then return; end if;
  insert into stusds_alert.heartbeats (kind, at, detail) values (p_kind, now(), p_detail)
  on conflict (kind) do update set at = now(), detail = excluded.detail;
end $$;

-- The Safe queue, fetched from Postgres and paced to the quota Safe reports.
create or replace function public.stusds_exit_safe_fetch(p_secret text, p_safe text, p_limit int default 12)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_res extensions.http_response;
  s stusds_alert.safe_poll_state;
  v_key text := lower(p_safe);
  v_rem int;
  v_reset int;
  v_safes int;
  v_wait interval;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  if p_safe !~ '^0x[0-9a-fA-F]{40}$' then
    return jsonb_build_object('authorized', true, 'status', 400, 'error', 'bad safe address');
  end if;
  select * into s from stusds_alert.safe_poll_state where safe = v_key;
  if found and s.next_at > now() then
    if s.body is not null and s.last_ok_at > now() - interval '45 minutes' then
      return jsonb_build_object('authorized', true, 'status', 200, 'cached', true,
        'age_seconds', extract(epoch from now() - s.last_ok_at)::int, 'body', s.body);
    end if;
    return jsonb_build_object('authorized', true, 'status', coalesce(s.last_status, 425), 'cached', true,
      'error', 'waiting for the Safe API quota until ' || to_char(s.next_at at time zone 'Asia/Bangkok', 'Mon DD HH24:MI') || ' Bangkok time');
  end if;

  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '6000');
    select * into v_res from extensions.http_get(
      'https://api.safe.global/tx-service/eth/api/v1/safes/' || p_safe
      || '/multisig-transactions/?limit=' || greatest(1, least(coalesce(p_limit, 12), 50)));
  exception when others then
    insert into stusds_alert.safe_poll_state (safe, next_at, last_try_at, last_status) values (v_key, now() + interval '2 minutes', now(), 0)
    on conflict (safe) do update set next_at = excluded.next_at, last_try_at = now(), last_status = 0;
    return jsonb_build_object('authorized', true, 'status', 0, 'error', left(sqlerrm, 200));
  end;
  select (h.value)::int into v_rem from unnest(v_res.headers) h where lower(h.field) = 'x-ratelimit-remaining' limit 1;
  select (h.value)::int into v_reset from unnest(v_res.headers) h where lower(h.field) = 'x-ratelimit-reset' limit 1;
  select greatest(1, count(*)) into v_safes from regexp_split_to_table(coalesce((select watch_safe from stusds_alert.exit_config where id = 1), ''), ',') x where trim(x) <> '';

  if v_res.status = 200 then
    -- Spend the remaining quota evenly until it resets; never faster than once a minute per Safe.
    v_wait := greatest(interval '60 seconds',
      make_interval(secs => coalesce(v_reset, 2592000)::double precision / greatest(coalesce(v_rem, 1), 1) * 1.15 * v_safes));
    insert into stusds_alert.safe_poll_state (safe, next_at, last_try_at, last_status, last_ok_at, quota_remaining, quota_reset_at, body)
    values (v_key, now() + v_wait, now(), 200, now(), v_rem, now() + make_interval(secs => coalesce(v_reset, 0)), v_res.content::jsonb)
    on conflict (safe) do update set next_at = excluded.next_at, last_try_at = now(), last_status = 200, last_ok_at = now(),
      quota_remaining = excluded.quota_remaining, quota_reset_at = excluded.quota_reset_at, body = excluded.body;
    return jsonb_build_object('authorized', true, 'status', 200, 'body', v_res.content::jsonb);
  end if;
  -- Refused (429 = quota used up): look again in a few hours, not every few seconds.
  insert into stusds_alert.safe_poll_state (safe, next_at, last_try_at, last_status, quota_remaining, quota_reset_at)
  values (v_key, now() + least(make_interval(secs => coalesce(v_reset, 3600)), interval '6 hours'), now(), v_res.status, v_rem, now() + make_interval(secs => coalesce(v_reset, 0)))
  on conflict (safe) do update set next_at = excluded.next_at, last_try_at = now(), last_status = excluded.last_status,
    quota_remaining = excluded.quota_remaining, quota_reset_at = excluded.quota_reset_at;
  return jsonb_build_object('authorized', true, 'status', v_res.status, 'error', left(v_res.content, 200));
end $$;

-- What the collector needs to start: where it left off and the last snapshot (to spot changes).
create or replace function public.stusds_dash_begin(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e stusds_alert.exit_config;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  select * into e from stusds_alert.exit_config where id = 1;
  return jsonb_build_object(
    'authorized', true,
    'last_event_block', (select max(block) from stusds_alert.chain_events),
    'prev', (select data from stusds_alert.dash_now where id = 1),
    'config', jsonb_build_object('enabled', e.enabled, 'target_name', e.target_name, 'helper_address', e.helper_address,
      'arb_address', e.arb_address, 'arb_enabled', e.arb_enabled, 'mempool_enabled', e.mempool_enabled, 'safe_route', e.safe_route,
      'watch_safe', e.watch_safe, 'fee_bps', e.fee_bps, 'arb_tip_share_safe', e.arb_tip_share_safe, 'arb_tip_share_race', e.arb_tip_share_race));
end $$;

-- One call a minute from the collector: snapshot, history, events, takers, and pushes (each key once).
create or replace function public.stusds_dash_ingest(p_secret text, p_now jsonb, p_events jsonb, p_takers jsonb, p_notices jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  n int;
  v_pushed int := 0;
  v_safe_ok timestamptz;
  v_hour numeric;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  if p_now is not null then
  insert into stusds_alert.dash_now (id, at, data) values (1, now(), p_now)
  on conflict (id) do update set at = now(), data = excluded.data;
  insert into stusds_alert.dash_history (at, block, util_pct, available, total_assets, debt, nav, str_pct, duty_pct, sky_usd, eth_usd, dex_discount_pct, arb_profit_150k, keeper_eth, main_value)
  values (date_trunc('minute', now()), (p_now->>'block')::bigint, (p_now->>'util_pct')::numeric, (p_now->>'available')::numeric, (p_now->>'total_assets')::numeric,
    (p_now->>'debt')::numeric, (p_now->>'nav')::numeric, (p_now->>'str_pct')::numeric, (p_now->>'duty_pct')::numeric, (p_now->>'sky_usd')::numeric, (p_now->>'eth_usd')::numeric,
    (p_now->>'dex_discount_pct')::numeric, (p_now->>'arb_profit_150k')::numeric, (p_now->>'keeper_eth')::numeric, (p_now->>'main_value')::numeric)
  on conflict (at) do nothing;
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into stusds_alert.chain_events (tx, log_index, block, block_ts, kind, who, amount)
    values (r->>'tx', (r->>'log_index')::int, (r->>'block')::bigint, (r->>'block_ts')::timestamptz, r->>'kind', r->>'who', (r->>'amount')::numeric)
    on conflict do nothing;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_takers, '[]'::jsonb)) loop
    insert into stusds_alert.takers (tx, block, block_ts, tx_index, amount, kind, entity, tx_from, tx_to, lag_blocks, pay_eth, traced)
    values (r->>'tx', (r->>'block')::bigint, (r->>'block_ts')::timestamptz, (r->>'tx_index')::int, (r->>'amount')::numeric, r->>'kind', r->>'entity',
      r->>'tx_from', r->>'tx_to', (r->>'lag_blocks')::int, (r->>'pay_eth')::numeric, coalesce((r->>'traced')::boolean, false))
    on conflict do nothing;
  end loop;

  if p_now is null then
    return jsonb_build_object('authorized', true, 'pushed', 0); -- history backfill: no pushes
  end if;
  -- Many mid-sized repayments add up: say so at each further 100,000 USDS repaid within an hour.
  select coalesce(sum(amount), 0) into v_hour from stusds_alert.chain_events where kind = 'Wipe' and block_ts > now() - interval '1 hour';
  if v_hour >= 100000 then
    p_notices := coalesce(p_notices, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'key', 'wipe_hour:' || to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD') || ':' || floor(v_hour / 100000)::text,
      'title', 'stUSDS: ' || to_char(v_hour, 'FM999,999,999') || ' USDS repaid in the last hour',
      'body', 'Borrowers repaid ' || to_char(v_hour, 'FM999,999,999') || ' USDS over the last hour in ' ||
        (select count(*) from stusds_alert.chain_events where kind = 'Wipe' and block_ts > now() - interval '1 hour')::text ||
        ' repayments. Withdrawable right now: ' || to_char((p_now->>'available')::numeric, 'FM999,999,999') || ' USDS.'));
  end if;
  -- The Safe watch has seen nothing for half an hour: say so once a day.
  select greatest((select max(last_ok_at) from stusds_alert.safe_poll_state), (select max(updated_at) from stusds_alert.safe_txs)) into v_safe_ok;
  if v_safe_ok is null or v_safe_ok < now() - interval '30 minutes' then
    p_notices := coalesce(p_notices, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'key', 'safe_blind:' || to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD'),
      'title', 'stUSDS bot: Safe watch is blind',
      'body', 'Cannot read the borrower Safes'' queues (Safe API quota). The Safe route is off until a Safe API key is added.'));
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_notices, '[]'::jsonb)) loop
    insert into stusds_alert.claims (key) values ('notice:' || (r->>'key')) on conflict do nothing;
    get diagnostics n = row_count;
    if n = 1 then
      begin
        perform private.jarvis_push('stusds:notice', r->>'title', r->>'body');
        v_pushed := v_pushed + 1;
      exception when others then
        raise warning 'stusds notice push failed: %', sqlerrm;
      end;
    end if;
  end loop;
  return jsonb_build_object('authorized', true, 'pushed', v_pushed);
end $$;

-- The exit bot also gets the DEX price ladder the collector keeps fresh (for sizing its arb).
create or replace function public.stusds_exit_begin(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c stusds_alert.config;
  e stusds_alert.exit_config;
begin
  select * into c from stusds_alert.config where id = 1;
  if not found or p_secret is null or p_secret <> c.cron_secret then
    return jsonb_build_object('authorized', false);
  end if;
  select * into e from stusds_alert.exit_config where id = 1;
  return jsonb_build_object(
    'authorized', true,
    'config', to_jsonb(e),
    'email_to', c.email_to,
    'email_from', c.email_from,
    'dex_ladder', (select d.data->'dex_ladder' from stusds_alert.dash_now d where d.id = 1),
    'keeper_key', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'stusds_exit_keeper_key' limit 1),
    'test_owner_key', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'stusds_exit_test_owner_key' limit 1));
end $$;

revoke execute on function public.stusds_exit_claim(text, text) from public, anon, authenticated;
revoke execute on function public.stusds_exit_heartbeat(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.stusds_exit_safe_fetch(text, text, int) from public, anon, authenticated;
revoke execute on function public.stusds_dash_begin(text) from public, anon, authenticated;
revoke execute on function public.stusds_dash_ingest(text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.stusds_exit_claim(text, text) to service_role;
grant execute on function public.stusds_exit_heartbeat(text, text, jsonb) to service_role;
grant execute on function public.stusds_exit_safe_fetch(text, text, int) to service_role;
grant execute on function public.stusds_dash_begin(text) to service_role;
grant execute on function public.stusds_dash_ingest(text, jsonb, jsonb, jsonb, jsonb) to service_role;

select cron.unschedule('stusds-dash') where exists (select 1 from cron.job where jobname = 'stusds-dash');
select cron.schedule('stusds-dash', '* * * * *', $$
  select net.http_post(
    url := replace(e.function_url, '/stusds-exit', '/stusds-dash'),
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000)
  from stusds_alert.exit_config e, stusds_alert.config c
  where e.id = 1 and c.id = 1;
$$);
