-- stUSDS utilization alert: state and dedupe.
--
-- Everything lives in the private `stusds_alert` schema except four RPC entry
-- points in `public` (PostgREST only serves exposed schemas), which are
-- executable by service_role only.
--
-- After applying, insert the single config row (kept out of this file so the
-- recipient address is not committed). The shared secret that lets pg_cron
-- call the edge function is generated here and never leaves the database:
--
--   insert into stusds_alert.config (function_url, email_to, email_from)
--   values ('https://<project-ref>.supabase.co/functions/v1/stusds-watch',
--           '<recipient>', 'stUSDS Alert <alerts@your-verified-domain>');

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists stusds_alert;
revoke all on schema stusds_alert from public, anon, authenticated;

create table if not exists stusds_alert.config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  threshold_ppm bigint not null default 999000,        -- 99.9%
  cooldown_seconds int not null default 600,           -- min gap between alerts
  stale_after_seconds int not null default 180,        -- "watcher stalled" if no block for this long
  stale_notice_every_seconds int not null default 21600,
  function_url text not null,
  email_to text not null,
  email_from text not null,
  cron_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);

create table if not exists stusds_alert.state (
  id int primary key default 1 check (id = 1),
  armed boolean not null default true,
  last_alert_at timestamptz,
  last_block bigint not null default 0,
  last_block_ts timestamptz,
  last_eval_at timestamptz,
  last_util_ppm numeric,
  last_available numeric,
  last_stale_notice_at timestamptz
);
insert into stusds_alert.state (id) values (1) on conflict do nothing;

-- One row per evaluated block: utilization history and latency evidence.
create table if not exists stusds_alert.blocks (
  block bigint primary key,
  block_ts timestamptz not null,
  eval_at timestamptz not null default now(),
  lag_ms int,                      -- evaluation finished this long after the block timestamp
  util_ppm numeric not null,
  available numeric not null,      -- USDS
  total_assets numeric not null,   -- USDS
  below boolean not null,
  source text
);
create index if not exists blocks_eval_at_idx on stusds_alert.blocks (eval_at);

create table if not exists stusds_alert.alerts (
  id bigint generated always as identity primary key,
  block bigint not null,
  block_ts timestamptz,
  created_at timestamptz not null default now(),
  util_ppm numeric,
  available numeric,
  total_assets numeric,
  email_ok boolean,
  email_id text,
  email_error text,
  latency_ms int                   -- email accepted this long after the block timestamp
);

alter table stusds_alert.config enable row level security;
alter table stusds_alert.state enable row level security;
alter table stusds_alert.blocks enable row level security;
alter table stusds_alert.alerts enable row level security;

-- Called at the start of each watcher run: authenticates the caller against
-- the stored secret and hands back the settings. p_run = false (test sends)
-- skips the stalled-watcher bookkeeping.
create or replace function public.stusds_alert_begin(p_secret text, p_run boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c stusds_alert.config;
  s stusds_alert.state;
  v_stale boolean;
begin
  select * into c from stusds_alert.config where id = 1;
  if not found or p_secret is null or p_secret <> c.cron_secret then
    return jsonb_build_object('authorized', false);
  end if;
  select * into s from stusds_alert.state where id = 1 for update;
  v_stale := p_run and c.enabled
    and s.last_eval_at is not null
    and s.last_eval_at < now() - make_interval(secs => c.stale_after_seconds)
    and (s.last_stale_notice_at is null
         or s.last_stale_notice_at < now() - make_interval(secs => c.stale_notice_every_seconds));
  if v_stale then
    update stusds_alert.state set last_stale_notice_at = now() where id = 1;
  end if;
  return jsonb_build_object(
    'authorized', true,
    'enabled', c.enabled,
    'threshold_ppm', c.threshold_ppm,
    'email_to', c.email_to,
    'email_from', c.email_from,
    'notify_stale', v_stale,
    'last_eval_at', s.last_eval_at,
    'last_block', s.last_block);
end $$;

-- Called once per evaluated block. Exactly one caller per block gets past the
-- insert, and the alert decision is made under a row lock, so overlapping
-- watcher runs can never send two alerts for one drop.
--   p_total_assets: stUSDS totalAssets, wad (1e18)
--   p_debt_rad:     Art * accrued rate + clip.Due, rad (1e45)
create or replace function public.stusds_alert_observe(
  p_block bigint, p_block_ts timestamptz, p_total_assets numeric,
  p_debt_rad numeric, p_lag_ms int, p_source text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c stusds_alert.config;
  s stusds_alert.state;
  ray constant numeric := 1000000000000000000000000000;
  wad constant numeric := 1000000000000000000;
  v_below boolean;
  v_util numeric;
  v_avail numeric;
  v_total numeric;
  v_alert_id bigint;
  n int;
begin
  if p_total_assets is null or p_total_assets <= 0 or p_debt_rad is null or p_debt_rad < 0 then
    raise exception 'invalid observation';
  end if;
  select * into c from stusds_alert.config where id = 1;
  v_below := p_debt_rad * 1000000 <= p_total_assets * ray * c.threshold_ppm;
  v_util := round(p_debt_rad * 1000000 / (p_total_assets * ray), 4);
  v_avail := round(greatest(p_total_assets - p_debt_rad / ray, 0) / wad, 2);
  v_total := round(p_total_assets / wad, 2);

  insert into stusds_alert.blocks (block, block_ts, lag_ms, util_ppm, available, total_assets, below, source)
  values (p_block, p_block_ts, p_lag_ms, v_util, v_avail, v_total, v_below, p_source)
  on conflict (block) do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('action', 'none', 'reason', 'duplicate');
  end if;

  select * into s from stusds_alert.state where id = 1 for update;
  if p_block < s.last_block then
    return jsonb_build_object('action', 'none', 'reason', 'out_of_order');
  end if;

  update stusds_alert.state
     set last_block = p_block, last_block_ts = p_block_ts, last_eval_at = now(),
         last_util_ppm = v_util, last_available = v_avail
   where id = 1;

  if v_below then
    if c.enabled and s.armed
       and (s.last_alert_at is null
            or now() >= s.last_alert_at + make_interval(secs => c.cooldown_seconds)) then
      update stusds_alert.state set armed = false, last_alert_at = now() where id = 1;
      insert into stusds_alert.alerts (block, block_ts, util_ppm, available, total_assets)
      values (p_block, p_block_ts, v_util, v_avail, v_total)
      returning id into v_alert_id;
      return jsonb_build_object('action', 'alert', 'alert_id', v_alert_id);
    end if;
  elsif not s.armed then
    update stusds_alert.state set armed = true where id = 1;
  end if;

  return jsonb_build_object('action', 'none', 'below', v_below);
end $$;

-- Records the outcome of the alert email. A failed send re-arms immediately
-- so the next block tries again.
create or replace function public.stusds_alert_email_result(
  p_alert_id bigint, p_ok boolean, p_email_id text, p_error text, p_latency_ms int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update stusds_alert.alerts
     set email_ok = p_ok, email_id = p_email_id, email_error = p_error, latency_ms = p_latency_ms
   where id = p_alert_id;
  if not p_ok then
    update stusds_alert.state set armed = true, last_alert_at = null where id = 1;
  end if;
end $$;

revoke execute on function public.stusds_alert_begin(text, boolean) from public, anon, authenticated;
revoke execute on function public.stusds_alert_observe(bigint, timestamptz, numeric, numeric, int, text) from public, anon, authenticated;
revoke execute on function public.stusds_alert_email_result(bigint, boolean, text, text, int) from public, anon, authenticated;
grant execute on function public.stusds_alert_begin(text, boolean) to service_role;
grant execute on function public.stusds_alert_observe(bigint, timestamptz, numeric, numeric, int, text) to service_role;
grant execute on function public.stusds_alert_email_result(bigint, boolean, text, text, int) to service_role;
