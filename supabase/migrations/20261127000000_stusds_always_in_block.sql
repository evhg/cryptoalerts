-- Always-in-the-block withdrawal for builders whose conditional method does not run our bundles (Quasar, Eureka).
-- always_builders: comma-separated builder names; empty = off.
-- always_priority_gwei: the transaction's own priority fee (low on purpose: it has to sit behind the repayment).
-- always_max_fee_gwei: it cannot be included while gas costs more than this, which caps what a failed attempt costs.
-- always_arb: also send the standing arb behind it the same way.
alter table stusds_alert.exit_config add column if not exists always_builders text not null default '';
alter table stusds_alert.exit_config add column if not exists always_priority_gwei numeric not null default 0.05;
alter table stusds_alert.exit_config add column if not exists always_max_fee_gwei numeric not null default 1;
alter table stusds_alert.exit_config add column if not exists always_arb boolean not null default false;
