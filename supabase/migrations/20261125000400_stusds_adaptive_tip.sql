-- Open races: the builder's share of the arb profit adapts to results, and the arb has a configurable minimum opening.
alter table stusds_alert.exit_config add column if not exists arb_min_usds numeric not null default 1000;
alter table stusds_alert.exit_config add column if not exists arb_tip_share_floor numeric not null default 0.70;
alter table stusds_alert.exit_config add column if not exists arb_tip_share_cap numeric not null default 0.995;
alter table stusds_alert.exit_config add column if not exists arb_tip_step_down numeric not null default 0.01;
alter table stusds_alert.exit_config add column if not exists arb_tip_step_up numeric not null default 0.03;
update stusds_alert.exit_config set arb_tip_share_race = 0.995, updated_at = now() where id = 1;

-- After a won open race the bot offers builders a little less next time; after a lost one, more (within floor and cap).
create or replace function public.stusds_exit_race_result(p_secret text, p_won boolean, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e stusds_alert.exit_config;
  v_new numeric;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  select * into e from stusds_alert.exit_config where id = 1 for update;
  v_new := case when p_won then greatest(e.arb_tip_share_floor, e.arb_tip_share_race - e.arb_tip_step_down)
                else least(e.arb_tip_share_cap, e.arb_tip_share_race + e.arb_tip_step_up) end;
  update stusds_alert.exit_config set arb_tip_share_race = v_new, updated_at = now() where id = 1;
  insert into stusds_alert.exit_attempts (block, action, detail)
  values (null, 'race_result', coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('won', p_won, 'tip_share_before', e.arb_tip_share_race, 'tip_share_after', v_new));
  return jsonb_build_object('authorized', true, 'tip_share', v_new);
end $$;
revoke execute on function public.stusds_exit_race_result(text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.stusds_exit_race_result(text, boolean, jsonb) to service_role;

create or replace view stusds_alert.v_dash_now with (security_invoker = true) as
select to_char(n.at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as updated_bkk,
  round(extract(epoch from now() - n.at)) as age_s,
  n.data - 'loans' - 'dex_ladder' - 'safes' - 'clip' as d,
  to_char((n.data->>'rates_next_change')::timestamptz at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as rates_next_bkk,
  ((n.data->>'rates_next_change')::timestamptz <= now()) as rates_change_due,
  round((n.data->>'main_value')::numeric * (n.data->>'fee_bps')::numeric / 10000 / (n.data->>'eth_usd')::numeric, 3) as tip_cap_eth,
  round((n.data->>'main_value')::numeric * (n.data->>'fee_bps')::numeric / 10000) as tip_cap_usd,
  (select round(extract(epoch from now() - max(h.at))) from stusds_alert.heartbeats h where h.kind = 'mempool') as mempool_age_s,
  coalesce((select greatest((select max(last_ok_at) from stusds_alert.safe_poll_state), (select max(updated_at) from stusds_alert.safe_txs)) > now() - interval '30 minutes'), false) as safe_ok,
  (select count(*) from stusds_alert.safe_txs s where s.executed_at is null and s.repay_usds > 0) as safe_queued,
  (select coalesce(round(sum(s.repay_usds)), 0) from stusds_alert.safe_txs s where s.executed_at is null and s.repay_usds > 0) as safe_queued_usds,
  (select coalesce(round(sum(e.amount)), 0) from stusds_alert.chain_events e where e.kind = 'Wipe' and e.block_ts > now() - interval '24 hours') as repaid_24h,
  (select count(*) from stusds_alert.chain_events e where e.kind = 'Wipe' and e.amount >= 1000 and e.block_ts > now() - interval '24 hours') as repayments_24h,
  (select count(distinct t.entity) from stusds_alert.takers t where t.kind = 'arb' and t.block_ts > now() - interval '7 days') as arb_bots_7d,
  (select count(distinct t.entity) from stusds_alert.takers t where t.kind = 'arb') as arb_bots_all,
  (select count(distinct t.entity) from stusds_alert.takers t where t.kind = 'holder') as holders_all,
  (select to_char(min(t.block_ts) at time zone 'Asia/Bangkok', 'DD Mon') from stusds_alert.takers t) as takers_since,
  (select round(100 * sum(t.pay_eth) * (n.data->>'eth_usd')::numeric / nullif(sum(t.amount), 0), 1) from stusds_alert.takers t where t.kind = 'arb' and t.traced and t.block_ts > now() - interval '3 days') as arb_pay_pct_3d,
  (select round(100 * e.arb_tip_share_race, 1) from stusds_alert.exit_config e where e.id = 1) as arb_tip_share_race_pct
from stusds_alert.dash_now n where n.id = 1;

create or replace view stusds_alert.v_dash_botlog with (security_invoker = true) as
select a.id, to_char(a.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk, a.block,
  case a.action when 'backrun_fired' then 'Fired behind a pending repayment' when 'fired' then 'Fired (' || coalesce(a.detail->>'route', '') || ')'
    when 'not_included' then 'Did not land' when 'included' then 'Landed' when 'nothing' then 'Looked, nothing to take'
    when 'drill_deposit' then 'Test deposit' when 'safe_route_sim_failed' then 'Safe route check failed'
    when 'race_result' then case when (a.detail->>'won')::boolean then 'Won an open race' else 'Lost an open race' end
    when 'deployed_arb2' then 'Deployed the direct arb contract' when 'deployed_arb' then 'Deployed the arb contract' when 'deployed' then 'Deployed a helper contract'
    else a.action end as what,
  concat_ws('; ',
    'withdrawal of ' || to_char(round((a.detail->'exit'->>'expected_usds')::numeric), 'FM999,999,999') || ' USDS',
    'arb bid for ' || to_char(round((a.detail->'arb'->>'buy_usds')::numeric), 'FM999,999,999') || ' USDS with a ' || to_char(round((a.detail->'arb'->>'tip_usds')::numeric), 'FM999,999,999') || ' USDS tip',
    'no arb: ' || (a.detail->'arb'->>'skipped'),
    a.detail->>'reason',
    'builder''s share of the profit goes from ' || round(100 * (a.detail->>'tip_share_before')::numeric, 1) || '% to ' || round(100 * (a.detail->>'tip_share_after')::numeric, 1) || '%',
    case when a.action = 'drill_deposit' then (a.detail->>'usds') || ' USDS (' || coalesce(a.detail->>'mode', case when (a.detail->>'private')::boolean then 'private' else 'public' end) || ')' end,
    case when a.action in ('not_included', 'included') then (jsonb_array_length(coalesce(a.detail->'hashes', '[]'::jsonb)))::text || ' transaction(s)' end) as note
from stusds_alert.exit_attempts a where a.action <> 'safe_poll_failed' order by a.id desc limit 20;
