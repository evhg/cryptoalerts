-- stUSDS exit bot: configuration, attempt log, Safe-queue watch, and the
-- hooks that call the stusds-exit edge function.
--
-- Keys live in Supabase Vault under fixed names and are generated inside the
-- edge function, so they are never typed, pasted or shown anywhere:
--   stusds_exit_keeper_key      pays gas and triggers the exit contract
--   stusds_exit_test_owner_key  holds the small test position only

create table if not exists stusds_alert.exit_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,        -- master switch for firing withdrawals
  function_url text not null,
  target_name text,                              -- 'test' or 'main'
  owner_address text,                            -- wallet whose stUSDS is redeemed (and paid)
  helper_address text,                           -- its StUsdsExit contract
  trigger_min_usds numeric not null default 50,  -- fire when at least this much is withdrawable
  min_assets_usds numeric not null default 10,   -- minAssets passed to exit()
  tip_gwei numeric not null default 0,           -- ETH offered to the builder, in gwei (the contract caps it)
  priority_gwei numeric not null default 2,
  watch_safe text,                               -- Safe whose queued repayments are announced
  updated_at timestamptz not null default now()
);

create table if not exists stusds_alert.exit_attempts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  block bigint,
  action text not null,
  detail jsonb
);

create table if not exists stusds_alert.safe_txs (
  safe_tx_hash text primary key,
  safe text not null,
  nonce bigint not null,
  proposed_at timestamptz,
  summary text,
  repay_usds numeric not null default 0,
  confirmations int not null default 0,
  required int not null default 0,
  executed_at timestamptz,
  notified_proposed boolean not null default false,
  notified_ready boolean not null default false,
  notified_executed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table stusds_alert.exit_config enable row level security;
alter table stusds_alert.exit_attempts enable row level security;
alter table stusds_alert.safe_txs enable row level security;

-- Authenticates the caller and hands the edge function its settings and keys.
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
    'keeper_key', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'stusds_exit_keeper_key' limit 1),
    'test_owner_key', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'stusds_exit_test_owner_key' limit 1));
end $$;

-- Stores a freshly generated key, only under a known name and only once.
create or replace function public.stusds_exit_store_key(p_secret text, p_name text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_name not in ('stusds_exit_keeper_key', 'stusds_exit_test_owner_key') or p_key !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'bad name or key');
  end if;
  if exists (select 1 from vault.secrets where name = p_name) then
    return jsonb_build_object('ok', true, 'created', false);
  end if;
  perform vault.create_secret(p_key, p_name, 'stUSDS exit bot key (generated inside the edge function)');
  return jsonb_build_object('ok', true, 'created', true);
end $$;

create or replace function public.stusds_exit_log(p_secret text, p_block bigint, p_action text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return;
  end if;
  insert into stusds_alert.exit_attempts (block, action, detail) values (p_block, p_action, p_detail);
end $$;

-- Records what the watched Safe has queued and returns the events worth
-- announcing (each at most once): a repayment proposed, fully signed, executed.
-- Also sends the Jarvis push for each.
create or replace function public.stusds_exit_safe_upsert(p_secret text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  t stusds_alert.safe_txs;
  v_events jsonb := '[]'::jsonb;
  v_kind text;
  v_title text;
  v_body text;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into stusds_alert.safe_txs (safe_tx_hash, safe, nonce, proposed_at, summary, repay_usds, confirmations, required, executed_at)
    values (r->>'safe_tx_hash', r->>'safe', (r->>'nonce')::bigint, (r->>'proposed_at')::timestamptz, r->>'summary',
            coalesce((r->>'repay_usds')::numeric, 0), (r->>'confirmations')::int, (r->>'required')::int, (r->>'executed_at')::timestamptz)
    on conflict (safe_tx_hash) do update
      set confirmations = excluded.confirmations, required = excluded.required,
          executed_at = excluded.executed_at, updated_at = now()
    returning * into t;

    if t.repay_usds <= 0 then
      continue;
    end if;
    v_kind := null;
    if t.executed_at is not null and not t.notified_executed then
      v_kind := 'executed';
      update stusds_alert.safe_txs set notified_executed = true, notified_ready = true, notified_proposed = true where safe_tx_hash = t.safe_tx_hash;
    elsif t.executed_at is null and t.confirmations >= t.required and t.required > 0 and not t.notified_ready then
      v_kind := 'ready';
      update stusds_alert.safe_txs set notified_ready = true, notified_proposed = true where safe_tx_hash = t.safe_tx_hash;
    elsif t.executed_at is null and not t.notified_proposed then
      v_kind := 'proposed';
      update stusds_alert.safe_txs set notified_proposed = true where safe_tx_hash = t.safe_tx_hash;
    end if;
    -- Do not announce history the first time the watcher runs.
    if v_kind = 'executed' and t.executed_at < now() - interval '10 minutes' then
      v_kind := null;
    end if;
    if v_kind is null then
      continue;
    end if;

    v_title := case v_kind
      when 'proposed' then 'stUSDS: repayment proposed'
      when 'ready' then 'stUSDS: repayment fully signed'
      else 'stUSDS: repayment executed' end;
    v_body := to_char(trunc(t.repay_usds), 'FM999,999,999,990') || ' USDS repay, '
      || t.confirmations || '/' || t.required || ' signatures (Safe nonce ' || t.nonce || ').'
      || case v_kind when 'ready' then ' Can execute at any moment.' when 'proposed' then ' Not yet executable.' else '' end;
    begin
      perform private.jarvis_push('stusds:safe', v_title, v_body);
    exception when others then
      raise warning 'stusds safe push failed: %', sqlerrm;
    end;
    v_events := v_events || jsonb_build_object('kind', v_kind, 'title', v_title, 'body', v_body,
      'nonce', t.nonce, 'repay_usds', t.repay_usds, 'safe_tx_hash', t.safe_tx_hash);
  end loop;
  return jsonb_build_object('authorized', true, 'events', v_events);
end $$;

-- Sends a Jarvis push on behalf of the edge function (e.g. "withdrawal landed").
create or replace function public.stusds_exit_notify(p_secret text, p_kind text, p_title text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return;
  end if;
  perform private.jarvis_push(p_kind, p_title, p_body);
end $$;
revoke execute on function public.stusds_exit_notify(text, text, text, text) from public, anon, authenticated;
grant execute on function public.stusds_exit_notify(text, text, text, text) to service_role;

revoke execute on function public.stusds_exit_begin(text) from public, anon, authenticated;
revoke execute on function public.stusds_exit_store_key(text, text, text) from public, anon, authenticated;
revoke execute on function public.stusds_exit_log(text, bigint, text, jsonb) from public, anon, authenticated;
revoke execute on function public.stusds_exit_safe_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.stusds_exit_begin(text) to service_role;
grant execute on function public.stusds_exit_store_key(text, text, text) to service_role;
grant execute on function public.stusds_exit_log(text, bigint, text, jsonb) to service_role;
grant execute on function public.stusds_exit_safe_upsert(text, jsonb) to service_role;

-- Called from stusds_alert_observe for every evaluated block: when the exit
-- bot is armed and enough is withdrawable, ask the edge function to fire.
create or replace function stusds_alert.maybe_fire_exit(p_block bigint, p_available numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  e stusds_alert.exit_config;
  v_secret text;
begin
  select * into e from stusds_alert.exit_config where id = 1;
  if not found or not e.enabled or e.helper_address is null or p_available < e.trigger_min_usds then
    return;
  end if;
  select cron_secret into v_secret from stusds_alert.config where id = 1;
  perform net.http_post(
    url := e.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('action', 'fire', 'block', p_block, 'available', p_available),
    timeout_milliseconds := 60000);
exception when others then
  raise warning 'stusds maybe_fire_exit failed: %', sqlerrm;
end $$;
revoke execute on function stusds_alert.maybe_fire_exit(bigint, numeric) from public, anon, authenticated;

-- stusds_alert_observe, unchanged except for the exit hook after the state update.
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

  -- Exit bot: independent of the alert arming state.
  perform stusds_alert.maybe_fire_exit(p_block, v_avail);

  if v_below then
    if c.enabled and s.armed
       and (s.last_alert_at is null
            or now() >= s.last_alert_at + make_interval(secs => c.cooldown_seconds)) then
      update stusds_alert.state set armed = false, last_alert_at = now() where id = 1;
      insert into stusds_alert.alerts (block, block_ts, util_ppm, available, total_assets)
      values (p_block, p_block_ts, v_util, v_avail, v_total)
      returning id into v_alert_id;
      if c.push_enabled then
        -- Queued with pg_net, so it goes out as this transaction commits.
        -- A push problem must never block the alert itself.
        begin
          perform private.jarvis_push(
            'stusds',
            'stUSDS utilization ' || to_char(trunc(v_util / 10000, 3), 'FM990.000') || '%',
            to_char(trunc(v_avail), 'FM999,999,999,990') || ' USDS withdrawable now (block '
              || p_block || '). Liquidity can be taken at any moment.');
        exception when others then
          raise warning 'stusds_alert push failed: %', sqlerrm;
        end;
      end if;
      return jsonb_build_object('action', 'alert', 'alert_id', v_alert_id);
    end if;
  elsif not s.armed then
    update stusds_alert.state set armed = true where id = 1;
  end if;

  return jsonb_build_object('action', 'none', 'below', v_below);
end $$;

-- Poll the watched Safe's queue once a minute (the function polls a few times per run).
select cron.schedule('stusds-exit-tick', '* * * * *', $cron$
  select net.http_post(
    url := e.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000)
  from stusds_alert.exit_config e, stusds_alert.config c
  where e.id = 1 and c.id = 1 and e.watch_safe is not null;
$cron$);
