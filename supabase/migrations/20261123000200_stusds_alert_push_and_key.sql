-- stUSDS utilization alert: Jarvis push on alert, and the Resend key in Vault.
--
-- Push: an alert also calls private.jarvis_push(), the sleep-lab app's own
-- Web Push sender, which notifies every device subscribed to Jarvis.
--
-- Resend key: stored in Supabase Vault under the name stusds_resend_api_key
-- and handed to the edge function by stusds_alert_begin(). It is written
-- once through the function's setup route, guarded by a one-time token whose
-- SHA-256 is placed in config.setup_token_hash:
--
--   update stusds_alert.config set setup_token_hash = '<sha256 hex of the token>';
--   curl -X POST <function_url> -H 'x-setup-token: <token>' \
--        -H 'content-type: application/json' -d '{"resend_api_key":"re_..."}'
--
-- A RESEND_API_KEY function secret, if set, takes precedence over the Vault key.

alter table stusds_alert.config add column if not exists setup_token_hash text;
alter table stusds_alert.config add column if not exists push_enabled boolean not null default true;

create or replace function public.stusds_alert_set_resend_key(p_token text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_id uuid;
begin
  select setup_token_hash into v_hash from stusds_alert.config where id = 1 for update;
  if v_hash is null or p_token is null
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_hash then
    return jsonb_build_object('ok', false, 'error', 'invalid or already used setup token');
  end if;
  if p_key is null or p_key !~ '^re_[A-Za-z0-9_-]{10,}$' then
    return jsonb_build_object('ok', false, 'error', 'that does not look like a Resend API key');
  end if;
  select id into v_id from vault.secrets where name = 'stusds_resend_api_key';
  if v_id is null then
    perform vault.create_secret(p_key, 'stusds_resend_api_key', 'Resend API key used by the stusds-watch edge function');
  else
    perform vault.update_secret(v_id, p_key);
  end if;
  update stusds_alert.config set setup_token_hash = null where id = 1;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.stusds_alert_set_resend_key(text, text) from public, anon, authenticated;
grant execute on function public.stusds_alert_set_resend_key(text, text) to service_role;

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
    'resend_api_key', (select d.decrypted_secret from vault.decrypted_secrets d
                        where d.name = 'stusds_resend_api_key' limit 1),
    'notify_stale', v_stale,
    'last_eval_at', s.last_eval_at,
    'last_block', s.last_block);
end $$;

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
