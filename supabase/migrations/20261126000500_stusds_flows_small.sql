-- "What freed USDS and who took it" on the dashboard: from 20 USDS up (was 1,000), so test deposits show too.
do $$
declare d text;
begin
  d := pg_get_viewdef('stusds_alert.v_dash_flows'::regclass, true);
  d := replace(d, 'e.amount >= 1000::numeric', 'e.amount >= 20::numeric');
  d := replace(d, 'LIMIT 25', 'LIMIT 40');
  execute 'create or replace view stusds_alert.v_dash_flows with (security_invoker = true) as ' || d;
end $$;
