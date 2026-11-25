-- Builders that refund overpayment (BuilderNet, and the Flashbots relay that feeds it) get a second, higher bid for the same arb.
alter table stusds_alert.exit_config add column if not exists arb_tip_share_buildernet numeric not null default 0.999 check (arb_tip_share_buildernet >= 0 and arb_tip_share_buildernet <= 0.9995);
