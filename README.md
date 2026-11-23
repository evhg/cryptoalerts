# cryptoalerts

## stUSDS utilization alert

Emails (and posts in a Claude Code session) when stUSDS utilization drops to
**99.9% or lower**, i.e. when USDS becomes withdrawable from stUSDS again.

### What is measured

Utilization is computed the way the stUSDS contract itself limits withdrawals
(`StUsds._burn` / `maxWithdraw`):

```
debt        = Vat.ilks(LSEV2-SKY-A).Art * rate' + LockstakeClipper.Due()
utilization = debt / stUSDS.totalAssets()
withdrawable = totalAssets - debt
```

`rate'` is the Vat rate with Jug interest accrued up to the block timestamp.
That matters: using the stored rate understates debt between drips and shows
phantom liquidity. All values are read in one Multicall3 `eth_call` pinned to
a block, so they are consistent. The alert is based on end-of-block state.

### How it runs

```
pg_cron (every minute)
   └─ pg_net POST ─► edge function stusds-watch  (runs ~110s, so runs overlap)
                        ├─ newHeads over WebSocket on 3 public RPC endpoints
                        ├─ eth_blockNumber poll every 2s as a floor
                        └─ per new block: read state ─► public.stusds_alert_observe()
                                                           └─ 'alert' ─► Resend email
```

- `supabase/functions/stusds-watch/` – the watcher (`index.ts`) and the
  dependency-free chain logic (`chain.ts`).
- `supabase/migrations/` – private `stusds_alert` schema (config, state,
  per-block history, alerts), four service-role-only RPC functions in
  `public`, and the cron jobs.
- `watcher/session-watch.ts` – a second, independent watcher that runs inside
  a Claude Code session and exits when utilization crosses, which wakes the
  session so it can post in chat.

Postgres decides whether to alert, under a row lock: one alert per downward
crossing, re-armed when utilization goes back above the threshold, and at
least `cooldown_seconds` (10 min) between alerts. Overlapping runs can never
double-send. If the email fails, the alert re-arms and the next block retries.

### Settings

```sql
-- threshold (parts per million), cooldown, on/off
update stusds_alert.config set threshold_ppm = 999000, cooldown_seconds = 600, enabled = true;
```

The Resend API key is the only secret and is set as the edge function secret
`RESEND_API_KEY`. `RPC_ENDPOINTS` (optional secret, JSON array of
`{"name","http","ws"}`) replaces the public RPC endpoints with your own.

### Checking on it

```bash
curl -s https://<project-ref>.supabase.co/functions/v1/stusds-watch
```

returns current utilization, the age of the last evaluated block, the last
alert, and the last hour's detection delay (`lag_ms_*`, measured from the
block timestamp to the moment the block was evaluated).

```sql
select * from stusds_alert.alerts order by id desc;
select block, block_ts, lag_ms, util_ppm, available from stusds_alert.blocks order by block desc limit 20;
```

If no block is evaluated for 3 minutes, the next run emails a "watcher was
stalled" notice (at most every 6 hours).

### Deploying from scratch

1. Apply `supabase/migrations/20261123000000_stusds_alert.sql`.
2. Insert the config row (see the comment at the top of that file).
3. Deploy `supabase/functions/stusds-watch` with JWT verification off (it
   authenticates callers against the secret stored in `stusds_alert.config`)
   and set the `RESEND_API_KEY` secret.
4. Apply `supabase/migrations/20261123000100_stusds_alert_schedule.sql`.

### Session watcher runbook

```bash
npm run watch    # run in the background; exits only when there is news
npm run status
npm test
```

Exit codes: `10` ALERT (post it), `20` STALE (the deployed watcher stopped
evaluating blocks), `30` RPC_FAILURE, `0` SUPERSEDED / EXPIRED / STOPPED.
After any exit, start it again; arming state persists in `~/.stusds-watch`,
so a restart does not repeat an alert. On ALERT, check `last_alert.email_ok`
on the health endpoint: if the deployed watcher did not get the email out,
send it from the session instead.
