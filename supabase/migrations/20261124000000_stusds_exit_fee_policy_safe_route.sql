-- Fee policy and Safe route for the exit bot.
--   fee_bps        total cost of one exit (gas + builder tip) as basis points of the USDS withdrawn (10 = 0.1%)
--   fee_floor_usd  minimum budget, so very small exits can still go through when gas is cheap
--   safe_route     submit a fully signed Safe repayment ourselves, bundled with the exit right behind it
alter table stusds_alert.exit_config add column if not exists fee_bps numeric not null default 10;
alter table stusds_alert.exit_config add column if not exists fee_floor_usd numeric not null default 1;
alter table stusds_alert.exit_config add column if not exists safe_route boolean not null default true;
update stusds_alert.exit_config set priority_gwei = 1, updated_at = now() where id = 1;
