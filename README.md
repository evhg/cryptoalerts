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

The Resend API key is the only secret. Set it as the edge function secret
`RESEND_API_KEY`, or store it in Vault through the function's one-time setup
route (see `20261123000200_stusds_alert_push_and_key.sql`).

An alert also sends a Web Push through the sleep-lab app's own sender
(`private.jarvis_push`), which reaches every device subscribed to Jarvis
notifications. Turn it off with `update stusds_alert.config set push_enabled = false`.

`RPC_ENDPOINTS` (optional secret, JSON array of `{"name","http","ws"}`)
replaces the public RPC endpoints with your own.

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
5. Apply `supabase/migrations/20261123000200_stusds_alert_push_and_key.sql`
   (Jarvis push, Vault key).

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

## stUSDS exit bot and arb (`supabase/functions/stusds-exit`)

Gets the main wallet's stUSDS out at Sky's 1:1 redemption value whenever liquidity frees up, and puts any liquidity left after that to work in a risk-free arb whose profit goes to the main wallet.

Contracts (`contracts/src`, fork tests in `contracts/test`):
- `StUsdsExit` — redeems the owner's stUSDS to the owner, only what Sky can pay, tip to the builder capped and paid from the caller's ETH. Main wallet: `0xbF54F2AA78b4c240e34224073aff9E89Cd915897`; test wallet: `0x01662b082432859c366ab16362eab10fb72c73e6`. The owner arms it with one `approve` on stUSDS (see `contracts/review/` for the second-opinion packet and an independent bytecode check).
- `StUsdsArb` — flash-mints DAI, buys stUSDS below its redemption value through the KyberSwap router, redeems it at Sky, repays, tips the builder out of profit (checked against Chainlink) and sends the rest to the main wallet. Holds nothing between transactions and has no approval on anyone's funds. Deployed at `0xa2749a6d8de66523c9132d964b5c61d363a5fbe3`.

Three routes, each sending the same bundle — the exit first, then the arb on what is left, plus a fallback bundle without the arb:
- end of block (`fire`, from the block observer);
- Safe route (`tick`, every ~5 s): a fully signed repayment in a watched borrower Safe is executed by the bot with its transactions right behind it;
- backrun (`mempool`, pending-transaction feed): public repayments and stUSDS deposits.

Settings (`stusds_alert.exit_config`): `enabled`, `target_name`/`helper_address`, `fee_bps` (exit fee cap, default 10 = 0.1%), `fee_floor_usd`, `safe_route`, `watch_safe` (comma-separated), `arb_enabled`, `arb_address`, `arb_tip_share_safe` (0.3), `arb_tip_share_race` (0.7), `arb_min_net_usd` (25), `mempool_enabled`.

Tests: `cd contracts && forge test` (42 fork tests; `node test/fixtures/build-arb-fixture.mjs` refreshes the Kyber calldata fixture), `deno run --allow-net supabase/functions/stusds-exit/pending_test.ts` (pending-transaction decoder against real transactions).
