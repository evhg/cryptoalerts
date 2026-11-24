-- Safe's transaction API rate-limits (HTTP 429) the shared outbound addresses
-- of edge functions, which left the Safe watch blind. Postgres reaches it from
-- a different address, so the edge function fetches the Safe queue through
-- this function first and only falls back to fetching it itself.
--
-- Deliberately narrow: one fixed URL template, the Safe address must be a
-- plain hex address, and only callers holding the cron secret may use it.

create extension if not exists http with schema extensions;

create or replace function public.stusds_exit_safe_fetch(p_secret text, p_safe text, p_limit int default 12)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_res extensions.http_response;
begin
  if not exists (select 1 from stusds_alert.config where id = 1 and cron_secret = p_secret) then
    return jsonb_build_object('authorized', false);
  end if;
  if p_safe !~ '^0x[0-9a-fA-F]{40}$' then
    return jsonb_build_object('authorized', true, 'status', 400, 'error', 'bad safe address');
  end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '6000');
  select * into v_res from extensions.http_get(
    'https://api.safe.global/tx-service/eth/api/v1/safes/' || p_safe
    || '/multisig-transactions/?limit=' || greatest(1, least(coalesce(p_limit, 12), 50)));
  if v_res.status <> 200 then
    return jsonb_build_object('authorized', true, 'status', v_res.status, 'error', left(v_res.content, 200));
  end if;
  return jsonb_build_object('authorized', true, 'status', 200, 'body', v_res.content::jsonb);
end $$;

revoke execute on function public.stusds_exit_safe_fetch(text, text, int) from public, anon, authenticated;
grant execute on function public.stusds_exit_safe_fetch(text, text, int) to service_role;

-- Watch both Safes that hold most SKY-backed debt (comma-separated list):
-- rune.eth's 3-of-5 Safe (~47% of debt) and a 3-of-6 Safe (~25%).
update stusds_alert.exit_config
set watch_safe = '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d,0xca5183FB9997046fbd9bA8113139bf5a5Af122A0',
    updated_at = now()
where id = 1;
