-- Standing bundles also go out as conditional ("end of block") bundles, for this many blocks ahead.
alter table stusds_alert.exit_config add column if not exists standing_targets integer not null default 2;
