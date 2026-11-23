-- stUSDS utilization alert: status view and scheduling.
-- Apply after the edge function is deployed and stusds_alert.config has its row.

-- Read-only status, served by the function's public GET endpoint.
create or replace function public.stusds_alert_health()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', c.enabled and s.last_eval_at > now() - make_interval(secs => c.stale_after_seconds),
    'enabled', c.enabled,
    'threshold_ppm', c.threshold_ppm,
    'armed', s.armed,
    'last_block', s.last_block,
    'last_block_ts', s.last_block_ts,
    'last_eval_at', s.last_eval_at,
    'age_seconds', round(extract(epoch from now() - s.last_eval_at)::numeric, 1),
    'util_ppm', s.last_util_ppm,
    'available_usds', s.last_available,
    'last_alert', (
      select jsonb_build_object('block', a.block, 'created_at', a.created_at, 'util_ppm', a.util_ppm,
                                'email_ok', a.email_ok, 'latency_ms', a.latency_ms)
      from stusds_alert.alerts a order by a.id desc limit 1),
    'last_hour', (
      select jsonb_build_object(
        'blocks', count(*),
        'lag_ms_p50', percentile_disc(0.5) within group (order by b.lag_ms),
        'lag_ms_p99', percentile_disc(0.99) within group (order by b.lag_ms),
        'lag_ms_max', max(b.lag_ms),
        'over_5s', count(*) filter (where b.lag_ms > 5000))
      from stusds_alert.blocks b
      where b.eval_at > now() - interval '1 hour' and b.source is distinct from 'test'))
  from stusds_alert.config c, stusds_alert.state s
  where c.id = 1 and s.id = 1;
$$;

revoke execute on function public.stusds_alert_health() from public, anon, authenticated;
grant execute on function public.stusds_alert_health() to service_role;

-- Start a watcher run every minute; each run lasts ~110s, so runs overlap.
select cron.schedule('stusds-alert-tick', '* * * * *', $cron$
  select net.http_post(
    url := c.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000)
  from stusds_alert.config c
  where c.id = 1 and c.enabled;
$cron$);

-- Keep a week of per-block history.
select cron.schedule('stusds-alert-prune', '17 3 * * *', $cron$
  delete from stusds_alert.blocks where eval_at < now() - interval '7 days';
$cron$);
