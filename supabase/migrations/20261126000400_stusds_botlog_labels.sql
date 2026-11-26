-- Bot log on the dashboard: plain names for the newer entries (lean arb, tip money, fast follow, the conditional
-- bundle check), who made a test deposit and where it was sent, and no per-block debug rows.
create or replace view stusds_alert.v_dash_botlog with (security_invoker = true) as
select a.id, to_char(a.created_at at time zone 'Asia/Bangkok', 'DD Mon HH24:MI:SS') as time_bkk, a.block,
  case a.action when 'backrun_fired' then 'Fired behind a pending repayment' when 'fired' then 'Fired (' || coalesce(a.detail->>'route', '') || ')'
    when 'not_included' then 'Did not land' when 'included' then 'Landed' when 'nothing' then 'Looked, nothing to take'
    when 'drill_deposit' then 'Test deposit' when 'safe_route_sim_failed' then 'Safe route check failed'
    when 'race_result' then case when (a.detail->>'won')::boolean then 'Won an open race' else 'Lost an open race' end
    when 'deployed_arb2' then 'Deployed the direct arb contract' when 'deployed_arb' then 'Deployed the arb contract' when 'deployed' then 'Deployed a helper contract'
    when 'deployed_arb3' then 'Deployed the self-sizing arb contract' when 'deployed_arb4' then 'Deployed the lean arb contract'
    when 'arb_tip_money' then 'Tip money for the lean arb'
    when 'fast_follow' then 'Fast follow sent behind a pending transaction'
    when 'cond_probe' then case when a.detail ? 'deployed' then 'Deployed the conditional-bundle test contract'
      when (a.detail->>'conditional_bundle_ran')::boolean then 'Conditional bundle check: ran'
      else 'Conditional bundle check: did not run' end
    when 'sweep' then 'Returned test funds to the main wallet'
    else a.action end as what,
  concat_ws('; ',
    'withdrawal of ' || to_char(round((a.detail->'exit'->>'expected_usds')::numeric), 'FM999,999,999') || ' USDS',
    'arb bid for ' || to_char(round((a.detail->'arb'->>'buy_usds')::numeric), 'FM999,999,999') || ' USDS with a ' || to_char(round((a.detail->'arb'->>'tip_usds')::numeric), 'FM999,999,999') || ' USDS tip',
    'arb through the lean contract, ' || round((a.detail->'arb'->>'net')::numeric, 2) || ' USDS expected to the main wallet, builder share ' || round(100 * (a.detail->'arb'->>'tip_share')::numeric, 1) || '%, ' || (a.detail->'arb'->>'gas_used') || ' gas',
    'no arb: ' || (a.detail->'arb'->>'skipped'),
    a.detail->>'reason',
    'builder''s share of the profit goes from ' || round(100 * (a.detail->>'tip_share_before')::numeric, 1) || '% to ' || round(100 * (a.detail->>'tip_share_after')::numeric, 1) || '%',
    case when a.action = 'drill_deposit' then (a.detail->>'usds') || ' USDS (' || coalesce(a.detail->>'mode', case when (a.detail->>'private')::boolean then 'private' else 'public' end)
      || coalesce(', from the ' || (a.detail->>'from'), '')
      || coalesce(', sent only to ' || (select string_agg(x, ' and ') from jsonb_array_elements_text(a.detail->'builders_only') x), '') || ')' end,
    case when a.action = 'included' and a.detail ? 'route' then (a.detail->>'kind') || ' via ' || (a.detail->>'route')
      || coalesce(', ' || round((a.detail->>'usds')::numeric, 2) || ' USDS', '') || coalesce(', ' || round((a.detail->>'net')::numeric, 2) || ' USDS to the main wallet', '') end,
    case when a.action = 'not_included' then (jsonb_array_length(coalesce(a.detail->'hashes', '[]'::jsonb)))::text || ' transaction(s)' end,
    case when a.action = 'cond_probe' and not a.detail ? 'deployed' then 'block built by ' || coalesce(a.detail->>'block_built_by', 'nobody in the window')
      || ', sent to ' || coalesce((select string_agg(x, ' and ') from jsonb_array_elements_text(a.detail->'conditional_bundles_accepted_by') x), '-')
      || case when a.detail ? 'trigger' then ', watching the stUSDS list' else '' end end,
    case when a.action = 'fast_follow' then (a.detail->>'bundles') || ' bundle(s), sent ' || (a.detail->>'ms_seen_to_sent') || ' ms after it was seen' end,
    case when a.action = 'arb_tip_money' then 'contract holds ' || (a.detail->>'tip_money_eth') || ' ETH' end) as note
from stusds_alert.exit_attempts a where a.action not in ('safe_poll_failed', 'standing_sent') order by a.id desc limit 40;
