-- Also broadcast the exit to the public mempool, so blocks that validators build
-- themselves (no MEV-Boost, unreachable by bundles) can include it too.
alter table stusds_alert.exit_config add column if not exists public_broadcast boolean not null default true;
