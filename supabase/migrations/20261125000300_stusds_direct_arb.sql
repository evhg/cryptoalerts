-- Direct-routing arb (contracts/src/StUsdsArb2.sol) and its exact-quote helper (StUsdsQuoter.sol).
alter table stusds_alert.exit_config add column if not exists arb2_address text;
alter table stusds_alert.exit_config add column if not exists arb_quoter_address text;
-- From this much freed liquidity on, the slower KyberSwap route (which also reaches resting limit orders) is sent as a second bundle.
alter table stusds_alert.exit_config add column if not exists arb_kyber_min_usds numeric not null default 100000;
-- The earlier ceiling of 90% on the builder's share no longer matches the market.
alter table stusds_alert.exit_config drop constraint if exists exit_config_arb_tip_share_race_check;
alter table stusds_alert.exit_config add constraint exit_config_arb_tip_share_race_check check (arb_tip_share_race >= 0 and arb_tip_share_race <= 0.999);
alter table stusds_alert.exit_config drop constraint if exists exit_config_arb_tip_share_safe_check;
alter table stusds_alert.exit_config add constraint exit_config_arb_tip_share_safe_check check (arb_tip_share_safe >= 0 and arb_tip_share_safe <= 0.999);
-- Open races: winners on Nov 25 gave the builder 99.0-99.4% of the profit. Bid 99% and keep at least 2 USDS.
alter table stusds_alert.exit_config alter column arb_tip_share_race set default 0.99;
alter table stusds_alert.exit_config alter column arb_min_net_usd set default 2;
update stusds_alert.exit_config set arb_tip_share_race = 0.99, arb_min_net_usd = 2, updated_at = now() where id = 1;
