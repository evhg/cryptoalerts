-- Arb transactions pay the builder out of their profit, so their priority fee (paid from the bot key's ETH) stays minimal.
alter table stusds_alert.exit_config add column if not exists arb_priority_gwei numeric not null default 0.05;
