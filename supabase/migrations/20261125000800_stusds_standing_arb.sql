-- Standing arb bundle (contracts/src/StUsdsArbAuto.sol): an arb that waits in every block and sizes itself on-chain.
alter table stusds_alert.exit_config add column if not exists arb3_address text;
alter table stusds_alert.exit_config add column if not exists standing_arb boolean not null default true;
-- Most the standing arb may spend in one run; beyond roughly this the Curve pool's price reaches the redemption value.
alter table stusds_alert.exit_config add column if not exists arb_auto_max_spend numeric not null default 400000;
