-- Views the live dashboard reads (one per panel). Times are formatted in Bangkok time here.

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
  (select round(100 * sum(t.pay_eth) * (n.data->>'eth_usd')::numeric / nullif(sum(t.amount), 0), 1) from stusds_alert.takers t where t.kind = 'arb' and t.traced and t.block_ts > now() - interval '3 days') as arb_pay_pct_3d
from stusds_alert.dash_now n where n.id = 1;

create or replace view stusds_alert.v_dash_history with (security_invoker = true) as
select (extract(epoch from h.at) * 1000)::bigint as t, h.util_pct, h.available, h.sky_usd, h.dex_discount_pct, h.arb_profit_150k
from stusds_alert.dash_history h
where h.at > now() - interval '72 hours' and (extract(minute from h.at)::int % 5 = 0 or h.at > now() - interval '3 hours')
order by h.at;

create or replace view stusds_alert.v_dash_loans with (security_invoker = true) as
select l.urn, l.owner, l.debt, l.sky, l.cover_pct, l.liq_price,
  case when l.under_line then 'Under the 120% line' else 'Covered' end as state,
  round(100 * l.debt / nullif((n.data->>'debt')::numeric, 0), 1) as share_pct
from stusds_alert.dash_now n, jsonb_to_recordset(n.data->'loans') as l(urn text, owner text, debt numeric, sky numeric, cover_pct numeric, liq_price numeric, under_line boolean)
where n.id = 1 order by l.debt desc;

create or replace view stusds_alert.v_dash_daily with (security_invoker = true) as
with t as (
  select tk.*, (tk.block_ts at time zone 'Asia/Bangkok')::date as day,
    min((tk.block_ts at time zone 'Asia/Bangkok')::date) over (partition by tk.entity) as first_day
  from stusds_alert.takers tk)
select to_char(t.day, 'YYYY-MM-DD') as day,
  count(distinct t.entity) filter (where t.kind = 'arb') as arb_bots,
  count(distinct t.entity) filter (where t.kind = 'arb' and t.first_day = t.day) as new_arb_bots,
  count(distinct t.entity) filter (where t.kind = 'holder') as holders,
  coalesce(round(sum(t.amount) filter (where t.kind = 'arb')), 0) as arb_usds,
  coalesce(round(sum(t.amount) filter (where t.kind = 'holder')), 0) as holder_usds,
  coalesce(round(sum(t.amount) filter (where t.kind = 'self')), 0) as self_usds,
  round(100 * sum(t.pay_eth) filter (where t.kind = 'arb' and t.traced) * (select (data->>'eth_usd')::numeric from stusds_alert.dash_now where id = 1)
    / nullif(sum(t.amount) filter (where t.kind = 'arb' and t.traced), 0), 2) as arb_pay_pct
from t group by t.day order by t.day;

create or replace view stusds_alert.v_dash_rivals with (security_invoker = true) as
select t.entity,
  case t.kind when 'arb' then 'Arb bot' when 'holder' then 'Holder exiting' else 'Borrower itself' end as kind,
  count(*) as takes, round(sum(t.amount)) as usds,
  round(100 * sum(t.pay_eth) filter (where t.traced) * (select (data->>'eth_usd')::numeric from stusds_alert.dash_now where id = 1) / nullif(sum(t.amount) filter (where t.traced), 0), 2) as pay_pct,
  min(t.lag_blocks) as best_lag,
  to_char(min(t.block_ts) at time zone 'Asia/Bangkok', 'DD Mon') as first_bkk,
  to_char(max(t.block_ts) at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as last_bkk
from stusds_alert.takers t group by t.entity, t.kind order by sum(t.amount) desc limit 30;

create or replace view stusds_alert.v_dash_flows with (security_invoker = true) as
select e.tx, to_char(e.block_ts at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk,
  case e.kind when 'Wipe' then 'Loan repaid' else 'Deposit' end as kind, e.who, e.amount,
  tk.entity as taken_by,
  case tk.kind when 'arb' then 'Arb bot' when 'holder' then 'Holder exiting' when 'self' then 'Same transaction' end as taker_kind,
  tk.amount as taken, tk.lag_blocks,
  round(100 * tk.pay_eth * (select (data->>'eth_usd')::numeric from stusds_alert.dash_now where id = 1) / nullif(tk.amount, 0), 2) as pay_pct
from stusds_alert.chain_events e
left join lateral (
  select t.* from stusds_alert.takers t
  where t.block >= e.block and t.block <= e.block + 100 and t.amount >= 0.2 * e.amount
  order by t.block, t.tx_index limit 1) tk on true
where e.kind in ('Wipe', 'Deposit') and e.amount >= 1000
order by e.block desc, e.log_index desc limit 25;

create or replace view stusds_alert.v_dash_botlog with (security_invoker = true) as
select a.id, to_char(a.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk, a.block,
  case a.action when 'backrun_fired' then 'Fired behind a pending repayment' when 'fired' then 'Fired (' || coalesce(a.detail->>'route', '') || ')'
    when 'not_included' then 'Did not land' when 'included' then 'Landed' when 'nothing' then 'Looked, nothing to take'
    when 'drill_deposit' then 'Test deposit' when 'safe_route_sim_failed' then 'Safe route check failed' else a.action end as what,
  concat_ws('; ',
    'withdrawal of ' || to_char(round((a.detail->'exit'->>'expected_usds')::numeric), 'FM999,999,999') || ' USDS',
    'arb bid for ' || to_char(round((a.detail->'arb'->>'buy_usds')::numeric), 'FM999,999,999') || ' USDS with a ' || to_char(round((a.detail->'arb'->>'tip_usds')::numeric), 'FM999,999,999') || ' USDS tip',
    'no arb: ' || (a.detail->'arb'->>'skipped'),
    a.detail->>'reason',
    case when a.action in ('not_included', 'included') then (jsonb_array_length(coalesce(a.detail->'hashes', '[]'::jsonb)))::text || ' transaction(s)' end) as note
from stusds_alert.exit_attempts a where a.action <> 'safe_poll_failed' order by a.id desc limit 20;

create or replace view stusds_alert.v_dash_sims with (security_invoker = true) as
select s.id, s.title, s.block, to_char(s.run_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as run_bkk,
  s.data->>'setup' as setup, s.data->>'route' as route,
  (s.data->>'exit_usds')::numeric as exit_usds, (s.data->>'exit_tip_usd')::numeric as exit_tip_usd,
  (s.data->>'arb_buy')::numeric as arb_buy, (s.data->>'arb_profit')::numeric as arb_profit, (s.data->>'arb_tip')::numeric as arb_tip,
  s.data->>'note' as note
from stusds_alert.sim_results s order by s.id;

create or replace view stusds_alert.v_dash_alerts with (security_invoker = true) as
select j.id, to_char(j.sent_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as time_bkk, j.title, j.body
from public.jarvis_notices j where j.kind like 'stusds%' order by j.id desc limit 12;
