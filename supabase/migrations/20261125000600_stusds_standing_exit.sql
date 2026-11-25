-- Standing withdrawal bundle: on by default; it does nothing until the served wallet has stUSDS and a signed approval.
alter table stusds_alert.exit_config add column if not exists standing_exit boolean not null default true;
