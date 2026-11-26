-- While on, every block's conditional submissions are logged with the builders' bundle ids (for tracing a miss).
alter table stusds_alert.exit_config add column if not exists standing_debug boolean not null default false;
