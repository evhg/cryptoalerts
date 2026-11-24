-- Forward TikTok verification codes that arrive at alerts@kicksma.sh (Resend
-- inbound) to the household inboxes. The edge function `mail-forward` polls
-- Resend every ~5 s for ~55 s per minute; this table makes each email forward
-- at most once, even when runs overlap.

create schema if not exists mailfwd;

create table if not exists mailfwd.config (
  id int primary key default 1 check (id = 1),
  cron_secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  function_url text not null,
  enabled boolean not null default true,
  watch_to text not null default 'alerts@kicksma.sh',
  forward_to text[] not null default array['cath.tunti@gmail.com', 'verspui@gmail.com'],
  email_from text not null default 'Code forward <alerts@kicksma.sh>'
);

create table if not exists mailfwd.forwarded (
  resend_id text primary key,
  received_at timestamptz,
  sender text,
  subject text,
  claimed_at timestamptz not null default now(),
  forwarded_at timestamptz,
  ok boolean,
  email_id text,
  error text,
  note text
);

alter table mailfwd.config enable row level security;
alter table mailfwd.forwarded enable row level security;

insert into mailfwd.config (function_url)
values ('https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/mail-forward')
on conflict (id) do nothing;

-- Settings for an authorised caller.
create or replace function public.mailfwd_begin(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c mailfwd.config;
begin
  select * into c from mailfwd.config where id = 1;
  if not found or p_secret is null or p_secret <> c.cron_secret then
    return jsonb_build_object('authorized', false);
  end if;
  return jsonb_build_object('authorized', true, 'enabled', c.enabled, 'watch_to', c.watch_to, 'forward_to', to_jsonb(c.forward_to), 'email_from', c.email_from);
end $$;

-- Claim an email before forwarding it: true only for the first caller.
create or replace function public.mailfwd_claim(p_secret text, p_id text, p_received_at timestamptz, p_sender text, p_subject text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not exists (select 1 from mailfwd.config where id = 1 and cron_secret = p_secret) then return false; end if;
  insert into mailfwd.forwarded (resend_id, received_at, sender, subject) values (p_id, p_received_at, p_sender, p_subject)
  on conflict (resend_id) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.mailfwd_done(p_secret text, p_id text, p_ok boolean, p_email_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from mailfwd.config where id = 1 and cron_secret = p_secret) then return; end if;
  update mailfwd.forwarded set forwarded_at = now(), ok = p_ok, email_id = p_email_id, error = p_error where resend_id = p_id;
end $$;

revoke execute on function public.mailfwd_begin(text) from public, anon, authenticated;
revoke execute on function public.mailfwd_claim(text, text, timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.mailfwd_done(text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.mailfwd_begin(text) to service_role;
grant execute on function public.mailfwd_claim(text, text, timestamptz, text, text) to service_role;
grant execute on function public.mailfwd_done(text, text, boolean, text, text) to service_role;

-- The codes that arrived before forwarding existed are not sent now.
insert into mailfwd.forwarded (resend_id, sender, subject, note) values
  ('f544c447-2b35-438a-87df-deae77c9272c', 'noreply@account.tiktok.com', '946771 is your TikTok code', 'before forwarding was set up'),
  ('c8693d00-f6ad-4d37-8bd3-03a7bcb45258', 'noreply@account.tiktok.com', '946771 is your TikTok code', 'before forwarding was set up'),
  ('21810219-9600-4b2d-baa1-fe8037eed0ba', 'noreply@account.tiktok.com', '946771 is your TikTok code', 'before forwarding was set up')
on conflict do nothing;

select cron.unschedule('mail-forward') where exists (select 1 from cron.job where jobname = 'mail-forward');
select cron.schedule('mail-forward', '* * * * *', $$
  select net.http_post(
    url := c.function_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000)
  from mailfwd.config c where c.id = 1 and c.enabled;
$$);
