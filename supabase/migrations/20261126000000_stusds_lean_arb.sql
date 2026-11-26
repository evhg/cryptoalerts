-- Lean arb contract (StUsdsArbLite): about a third of the gas of the earlier arb contracts, because builders rank
-- competing transactions by what they pay per unit of gas. Used for the standing arb and for the race routes.
alter table stusds_alert.exit_config add column if not exists arb4_address text;
-- From this many USDS the arb buys through the pool's two-step route (better price, more gas).
alter table stusds_alert.exit_config add column if not exists arb_two_step_from numeric not null default 5000;

-- The standing arb and the race routes now use the same contract. This tells the standing-bundle check whether a
-- landed arb was one the bot sent behind a known transaction, so it is reported once, by that route.
create or replace function public.stusds_exit_seen_hash(p_secret text, p_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return false;
  end if;
  return exists (
    select 1 from stusds_alert.exit_attempts a
    where a.action = 'fired' and a.created_at > now() - interval '15 minutes'
      and lower(p_hash) in (lower(a.detail->'arb'->>'hash'), lower(a.detail->'arb_direct'->>'hash'))
  );
end $$;
revoke execute on function public.stusds_exit_seen_hash(text, text) from public, anon, authenticated;
grant execute on function public.stusds_exit_seen_hash(text, text) to service_role;
