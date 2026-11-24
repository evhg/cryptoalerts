-- v8: arb leg and pending-transaction watch.
--
-- The arb contract (contracts/src/StUsdsArb.sol) buys stUSDS below its
-- redemption value and redeems it at Sky in the same transaction, with
-- flash-minted DAI. Its profit can only go to the main wallet. It always runs
-- after the owner's exit in the same bundle, so it only uses liquidity the exit
-- left. Everything here starts switched off.

alter table stusds_alert.exit_config add column if not exists arb_address text;
alter table stusds_alert.exit_config add column if not exists arb_enabled boolean not null default false;
-- Share of the arb profit offered to the block builder: lower on the Safe route
-- (we are first in line there), higher in open races.
alter table stusds_alert.exit_config add column if not exists arb_tip_share_safe numeric not null default 0.3
  check (arb_tip_share_safe >= 0 and arb_tip_share_safe <= 0.9);
alter table stusds_alert.exit_config add column if not exists arb_tip_share_race numeric not null default 0.7
  check (arb_tip_share_race >= 0 and arb_tip_share_race <= 0.9);
alter table stusds_alert.exit_config add column if not exists arb_min_net_usd numeric not null default 25
  check (arb_min_net_usd >= 0);
alter table stusds_alert.exit_config add column if not exists mempool_enabled boolean not null default false;

-- Pending-transaction watch: one ~110 s run a minute (runs overlap by design).
select cron.unschedule('stusds-exit-mempool') where exists (select 1 from cron.job where jobname = 'stusds-exit-mempool');
select cron.schedule('stusds-exit-mempool', '* * * * *', $$
  select net.http_post(
    url := e.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{"action":"mempool"}'::jsonb,
    timeout_milliseconds := 5000)
  from stusds_alert.exit_config e, stusds_alert.config c
  where e.id = 1 and c.id = 1 and e.mempool_enabled and e.enabled;
$$);
