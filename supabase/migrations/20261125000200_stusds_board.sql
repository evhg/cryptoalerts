-- Read-only data for the dashboard hosted outside Claude (dashboard/vercel).
-- The link carries a random key; without it nothing is returned.
alter table stusds_alert.config add column if not exists board_key text;
update stusds_alert.config set board_key = encode(extensions.gen_random_bytes(18), 'hex') where id = 1 and board_key is null;

create or replace function public.stusds_board(p_key text)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  if p_key is null or length(p_key) < 20 or not exists (select 1 from stusds_alert.config c where c.id = 1 and c.board_key = p_key) then
    return jsonb_build_object('authorized', false);
  end if;
  return jsonb_build_object(
    'authorized', true,
    'now', (select coalesce(jsonb_agg((to_jsonb(x) - 'd') || x.d), '[]'::jsonb) from stusds_alert.v_dash_now x),
    'history', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_history x),
    'loans', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_loans x),
    'daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_daily x),
    'rivals', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_rivals x),
    'flows', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_flows x),
    'botlog', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_botlog x),
    'sims', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_sims x),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stusds_alert.v_dash_alerts x));
end $$;
revoke execute on function public.stusds_board(text) from public;
grant execute on function public.stusds_board(text) to anon, authenticated, service_role;
