-- Fast follow: the moment a transaction that may free USDS is seen in the public queue, the bot sends the
-- withdrawal and arb it already signed for this block behind it, before measuring anything.
alter table stusds_alert.exit_config add column if not exists fast_follow boolean not null default true;
