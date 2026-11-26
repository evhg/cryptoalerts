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

- `StUsdsArb2` — the same arb with direct routing: the purchase and the tip conversion are lists of calls to a venue list fixed at deployment (the Curve stUSDS/USDS pool, Sky's USDS/USDC converter, Uniswap's router, the KyberSwap router). It buys through the Curve pool's add-liquidity / remove-one-coin path, which is cheaper than a swap while the pool is this lopsided, and needs no outside API. Same guarantees as `StUsdsArb`: flash-minted money only, profit only to the main wallet, no approvals on anyone's funds.
  Deployed at `0xc2a9c6e9a2d94e6dc3e94737bd57489042367bf1`.
- `StUsdsArbAuto` — the arb with its size decided on-chain at the moment it runs: it reads how much USDS Sky can pay out, buys that much stUSDS at the Curve pool, redeems, pays the builder its share and sends the rest to the main wallet. Every address it calls is fixed in the code; the keeper supplies only limits and the builder's share. Because it needs to know nothing in advance, it is what the standing arb bundle sends for every block.
- `StUsdsArbLite` — the same self-sizing arb in about a third of the gas (roughly 300k for a small opening against 1.1M). It borrows USDS directly with a free Morpho flash loan (the DAI route is the fallback for sizes Morpho cannot lend), buys with one swap at a pool price the keeper passes in (the two-step route from `arb_two_step_from` USDS up), and pays the builder out of ETH the contract itself holds, at an ETH price the keeper supplies and the contract caps; only when that ETH cannot cover a large tip is the missing part swapped from the profit, checked against Chainlink. The whole USDS profit goes to the main wallet; the ETH can only go to a builder as a share of profit made in the same transaction, or to the main wallet (`arb_tip_money` with `add_eth` moves ETH in from the bot key, `return_eth` sends it on to the main wallet). The bot uses it for the standing arb and the race routes when `arb4_address` is set.
- `StUsdsQuoter` — tells exactly how many stUSDS an amount of USDS buys on that path by doing the purchase with flash-minted DAI and reverting it. Called off-chain only; it has no owner and can move nothing. Deployed at `0x28be819701652347958709b1740e5f0ed3b0cedc`.

Three routes. Each one first simulates the withdrawal followed by a read-only "lens" call at the builder (Flashbots `eth_callBundle`), which tells exactly how much USDS is withdrawable behind the triggering transaction whatever shape that transaction has. It then sends the exit bundle at once and, a moment later, a second bundle with the arb on what is left:
- end of block (`fire`, from the block observer);
- Safe route (`tick`): a fully signed repayment in a watched borrower Safe is executed by the bot with its transactions right behind it. Needs the `SAFE_API_KEY` function secret (free key from developer.safe.global); without it Safe's public API allows about 5,000 requests a month and the route is blind;
- backrun (`mempool`, pending-transaction feed): any pending transaction that touches the lending engine's repay functions or deposits into stUSDS, directly or through a Safe, a multicall, an ERC-4337 bundle or an EIP-7702 batch.

The arb goes out in up to two bundles: the direct one (`arb2.ts`, sized with exact quotes from `StUsdsQuoter`, ready about a second after the liquidity is measured) and, from `arb_kyber_min_usds` of freed liquidity on, the KyberSwap one (`arb.ts`), which is slower but also reaches resting limit orders. Both use the same nonce, so at most one can land.

On routes where the opening only exists inside the bot's own bundle (a Safe repayment it executes, a private test deposit), the withdrawal and the arb travel as one bundle, with the arb marked as allowed to fail. Sent separately, a builder can pair the withdrawal with someone else's arb: several bots submit a transaction every block that simply takes whatever is withdrawable when it runs, which is how the first live test on 25 Nov lost its arb.

Besides reacting to what it sees, the bot keeps a standing withdrawal in front of the builders for every block (`standingLoop`): a small set of withdrawal bundles that are only valid if USDS is withdrawable at the moment they run, so liquidity freed mid-block by a transaction nobody saw is caught in that same block. There is one bundle per size class (the full position, then halves down to about 10,000 USDS, then a base class); each withdraws everything Sky can pay, counts only if that is at least its class minimum, and carries the tip the fee policy allows for that minimum, so the fee never exceeds the policy. They share a nonce, so at most one lands, and a bundle that is not valid costs nothing. Switch: `standing_exit`. Behind each of those withdrawals (or on its own when there is nothing to withdraw) rides a standing arb through `StUsdsArbLite` (or `StUsdsArbAuto` when no lean contract is configured); it uses the next nonce, so it can only run after the withdrawal, and may fail without holding it back. Switch: `standing_arb`; limit per run: `arb_auto_max_spend`.

How the standing bundles are submitted matters more than what they pay. A builder simulates an ordinary `eth_sendBundle` at the start of the block and drops it if it fails there, and a standing bundle fails there by design, because the USDS only appears later in the block. So each standing bundle goes out twice (`sendConditional`): as an ordinary bundle for the next block, which covers USDS that is already withdrawable when the block starts, and as a conditional bundle for the next `standing_targets` blocks (default 2) to the builders that support one: `eth_sendEndOfBlockBundle` with `targetPools`/`targetSlots` at Titan, Quasar and bombora, and `eth_sendBundle` with `version: "v2"`, `desiredState: "AnyPosition"` at BuilderNet. These name the storage the bundle depends on (stUSDS's own bookkeeping, slots 1 and 5, which every deposit and loan repayment writes, and the loan type's totals in the Vat) and are tried once a transaction in the block has written it. Eureka offers the same method to allow-listed signers only, and beaverbuild and the Flashbots relay do not offer it. Until 26 Nov the standing bundles were sent as ordinary bundles only, which is why none ever landed.

The pending-transaction watch listens to two public feeds and, when an Alchemy key is present in the function's secrets (any name containing "alchemy"), to Alchemy's filtered feed as a third.

`drill` with `mode: "alone"` or `mode: "race"` runs a live test: the bot key deposits USDS into stUSDS inside the bot's own bundle (alone) or also publicly (race), and the usual withdrawal and arb follow. A plain `drill` with `private: true` and `from: "test"` deposits from the test wallet instead, which is the test for the standing bundles (they cannot follow one of the bot key's own transactions); adding `builders: [...]` and `targets: N` keeps that deposit with the named builders for up to N blocks, so it can only land in a block one of them builds.

Live results, 25 Nov (Bangkok time): a 400 USDS public race at 23:02 was won (withdrawal and arb both landed behind the deposit in a Titan block). Two private deposits kept with BuilderNet at 23:20 and 23:23 showed the standing arb losing twice: the first opening was taken in the same block by another holder's standing withdrawal (helper `0x8acf82d9…`, about 190k gas, paying 3.04e13 wei per USDS), the second was left alone in the deposit's block and taken two blocks later by a 350k-gas arb. Replayed on a fork, our standing arb was valid both times and offered more ETH in total but two to three times less per unit of gas (it uses about 1.17M gas). That last reading was wrong: on 26 Nov the lean contract offered about nine times more per unit of gas than the winner of a 190 USDS public race and still lost (its bundle reached the builder about a second too late), and lost a private 40 USDS deposit in a BuilderNet block to a bot paying half as much; in every one of these cases the winner's transaction sat at the end of the block, placed there as a conditional bundle, while our ordinary bundle had been dropped at the start of the block.

Overlapping runs are de-duplicated through `stusds_exit_claim`. The arb sizes itself from the price ladder the collector keeps fresh, so only a handful of KyberSwap calls happen at fire time. `simcheck` runs the lens live; `status` reports wallets, code checks and whether the Safe API key is present.

Settings (`stusds_alert.exit_config`): `enabled`, `target_name`/`helper_address`, `fee_bps` (exit fee cap, default 10 = 0.1%), `fee_floor_usd`, `safe_route`, `watch_safe` (comma-separated), `safe_poll_seconds` (10), `arb_enabled`, `arb_address`, `arb_tip_share_safe` (0.3), `arb_tip_share_race` (starts at 0.995: winners of open races give the builder about 99% of the profit), `arb_min_net_usd` (0.2), `arb_tip_share_floor`/`arb_tip_share_cap`/`arb_tip_step_down`/`arb_tip_step_up` (0.70 / 0.995 / 0.01 / 0.03: the race share moves down after a win and up after a loss), `arb_min_usds` (150), `arb_priority_gwei` (0.05), `arb_tip_share_buildernet` (0.999: BuilderNet returns part of an overpaying bid under its refund rule, so it and the Flashbots relay get a second, higher bid for the same arb; 0 switches this off), `arb2_address`, `arb_quoter_address`, `arb_kyber_min_usds` (100000), `mempool_enabled`.

Tests: `cd contracts && forge test` (87 fork tests; `node test/fixtures/build-arb-fixture.mjs` refreshes the Kyber calldata fixture), `deno run --allow-net supabase/functions/stusds-exit/pending_test.ts` (pending-transaction decoder against real transactions).

## Dashboard and collector (`supabase/functions/stusds-dash`, `dashboard/`)

`stusds-dash` runs once a minute from pg_cron. It is read-only towards the chain and holds no keys. It stores a snapshot (`stusds_alert.dash_now`), a history row (`dash_history`), new repayments, deposits and withdrawals (`chain_events`), and who took freed liquidity and what they paid the block builder (`takers`). It also keeps the DEX price ladder the bot's arb uses, and sends a Jarvis push (each once) for: a repayment or new borrowing of 100,000 USDS or more, 100,000 or more repaid within an hour, a deposit of 250,000 or more, a rate change, a change of the liquidation switch, the borrowing limit or the deposit cap, SKY falling below $0.035 / $0.03 / $0.025 / $0.02, any change of the main wallet's stUSDS balance, the bot key running low on ETH, and the Safe watch being blind.

`POST {"backfill": {"from": <block>, "to": <block>}}` loads history for an older block range.

The live dashboard is a Claude dashboard artifact. Its page is `dashboard/index.html` and its queries are in `dashboard/datasets.json`; each one reads a view named `stusds_alert.v_dash_*` through the Supabase connector. All times are formatted in Bangkok time in the views.

A standalone copy for any browser lives in `dashboard/vercel` (built by `python3 dashboard/build-vercel.py` from the same page). It reads `public.stusds_board(p_key)`, which returns the same views as one JSON object and answers only to the random key stored in `stusds_alert.config.board_key`. The key travels in the link's fragment (`#k=...`), is kept in the browser and never reaches Vercel. Changing `board_key` cuts off every old link.
