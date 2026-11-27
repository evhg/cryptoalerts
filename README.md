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

Whether a builder really runs these was checked on 26 Nov with `CondProbe` (`contracts/src/CondProbe.sol`, action `cond_probe`), a fixture with no tokens in it: the test wallet's `set()` writes one slot, and the bot key's `claim()` only works later in the same block. With `claim()` waiting as a conditional bundle and `set()` sent privately to one builder, the pair landed together at Titan (positions 1 and 32) and at BuilderNet (14 and 15); at Quasar the `set()` landed alone, and Quasar returns no bundle id for this method (its documented normal reply, and it offers no tracing for these bundles). Quasar's method tries a bundle only when a named "pool" changed, so since version 29 the Quasar copies also name venues that change in nearly every block (`BUSY_POOLS`); whether that makes Quasar run them is still to be confirmed on a Quasar block.

Running a test action from SQL: call it through `net.http_post` with a short `timeout_milliseconds` (a few seconds) and read the result from `stusds_alert.exit_attempts`. The function keeps running after the caller gives up. A call that holds its connection for a minute or more stalls every other scheduled call in the project for that long (on 26 Nov a two-minute probe paused the alert watcher for 120 seconds, and the backlog that followed ran the exit function out of compute). The same check with the real stUSDS watch list and a 1 USDS deposit as trigger also landed at Titan. Titan's tracing (`titan_getBundleStats` on stats.titanbuilder.xyz, `bombora_getBundleStats` on stats.bombora.build; action `bundle_stats`) then showed our standing arb as simulated successfully in a block where it lost: another holder's withdrawal simply paid more (10.7% of the amount against an arb margin of about 7%).

The same ready-signed transactions give the bot its fastest reaction to a public repayment (`fastFollow`, switch `fast_follow`). Every run keeps the current block's standing withdrawal and arb signed in memory; when the pending watch sees a transaction that may free USDS, it sends `[that transaction, withdrawal, arb]` to every builder at once, before measuring anything, because the two contracts size themselves on-chain. If the transaction frees nothing the bundle fails and is not included. The measured, exactly priced bundles of the `backrun` route follow about three seconds later as before, and a win by either copy is reported once.

The pending-transaction watch listens to two public feeds and, when an Alchemy key is present in the function's secrets (any name containing "alchemy"), to Alchemy's filtered feed as a third.

`drill` with `mode: "alone"` or `mode: "race"` runs a live test: the bot key deposits USDS into stUSDS inside the bot's own bundle (alone) or also publicly (race), and the usual withdrawal and arb follow. A plain `drill` with `private: true` and `from: "test"` deposits from the test wallet instead, which is the test for the standing bundles (they cannot follow one of the bot key's own transactions); adding `builders: [...]` and `targets: N` keeps that deposit with the named builders for up to N blocks, so it can only land in a block one of them builds.

Live results, 25 Nov (Bangkok time): a 400 USDS public race at 23:02 was won (withdrawal and arb both landed behind the deposit in a Titan block). Two private deposits kept with BuilderNet at 23:20 and 23:23 showed the standing arb losing twice: the first opening was taken in the same block by another holder's standing withdrawal (helper `0x8acf82d9…`, about 190k gas, paying 3.04e13 wei per USDS), the second was left alone in the deposit's block and taken two blocks later by a 350k-gas arb. Replayed on a fork, our standing arb was valid both times and offered more ETH in total but two to three times less per unit of gas (it uses about 1.17M gas). That last reading was wrong: on 26 Nov the lean contract offered about nine times more per unit of gas than the winner of a 190 USDS public race and still lost (its bundle reached the builder about a second too late), and lost a private 40 USDS deposit in a BuilderNet block to a bot paying half as much; in every one of these cases the winner's transaction sat at the end of the block, placed there as a conditional bundle, while our ordinary bundle had been dropped at the start of the block.

Overlapping runs are de-duplicated through `stusds_exit_claim`. The arb sizes itself from the price ladder the collector keeps fresh, so only a handful of KyberSwap calls happen at fire time. `simcheck` runs the lens live; `status` reports wallets, code checks and whether the Safe API key is present.

Settings (`stusds_alert.exit_config`): `enabled`, `target_name`/`helper_address`, `fee_bps` (exit fee cap, default 10 = 0.1%), `fee_floor_usd`, `safe_route`, `watch_safe` (comma-separated), `safe_poll_seconds` (10), `arb_enabled`, `arb_address`, `arb_tip_share_safe` (0.3), `arb_tip_share_race` (starts at 0.995: winners of open races give the builder about 99% of the profit), `arb_min_net_usd` (0.2), `arb_tip_share_floor`/`arb_tip_share_cap`/`arb_tip_step_down`/`arb_tip_step_up` (0.70 / 0.995 / 0.01 / 0.03: the race share moves down after a win and up after a loss), `arb_min_usds` (150), `arb_priority_gwei` (0.05), `arb_tip_share_buildernet` (0.999: BuilderNet returns part of an overpaying bid under its refund rule, so it and the Flashbots relay get a second, higher bid for the same arb; 0 switches this off), `arb2_address`, `arb_quoter_address`, `arb_kyber_min_usds` (100000), `mempool_enabled`.

Tests: `cd contracts && forge test` (87 fork tests; `node test/fixtures/build-arb-fixture.mjs` refreshes the Kyber calldata fixture), `deno run --allow-net supabase/functions/stusds-exit/pending_test.ts` (pending-transaction decoder against real transactions).

### Builders that do not run our waiting bundles: the always-in-the-block withdrawal (27 Nov 2026)

On 27 Nov at 01:31 Bangkok time a borrower repaid 33,380 USDS in an Eureka block; an arb bot's transaction sat directly behind it and took it for a 2.07% payment. The bot never saw the repayment (none of its three pending feeds delivered it, including the Alchemy feed filtered to the lending engine, so it was most likely sent privately), and Eureka did not yet run our conditional bundles.

Two things came out of that:

- **Eureka now runs our end-of-block bundles.** Its tracing (`eureka_getBundleStats`, open to everyone; action `bundle_stats` with `builder: "eureka"`) lists our order flow as registered, the method no longer refuses our signer, and the probe landed (block 26503349: `set()` at position 16, `claim()` at 499). Eureka is in `CONDITIONAL` since version 31; a refusal is remembered per worker so a closed method is not asked again.
- **For Quasar there is a way that needs no special access.** Quasar's and Eureka's ordinary `eth_sendBundle` is open and lets a transaction be listed in `revertingTxHashes`. A bundle of one such transaction is included whatever happens. The builder values it at almost nothing at the start of the block, so it is placed behind better-paying transactions, where a repayment sits; it then withdraws if USDS is withdrawable and reverts if not. Probe runs with `revert_allowed: true`: Eureka block 26502915 (trigger at 9, ours at 82), Quasar blocks 26503190 (14, 15) and 26503196 (19, 94). With `conflict: true` the probe also sends a better-paying `[set(), claim()]` bundle with the same nonce: at Eureka (block 26503321) and at Quasar (block 26503575) the better-paying bundle won, at positions 0 and 1, and the may-revert transaction stayed out. The probe contract has since paid out all of its ETH; a further run needs it funded again.

The bot can send the withdrawal this way per builder: `always_builders` (comma-separated, empty = off), `always_priority_gwei` (0.05, the value the probe used), `always_max_fee_gwei` (1: the transaction cannot be included while gas costs more), `always_arb` (the standing arb behind it, the same way). The transaction is `exit(all, smallest size class)` with that class's tip, because here the tip does not decide the place in the block.

Fork rehearsal (block 26503227): a failed attempt uses about 80,000 gas (the arb about 77,000), so it costs about 80,000 x (base fee + 0.05 gwei) in each block of the chosen builders; with the main wallet armed, 33,380 USDS appearing unseen was withdrawn in full for 0.57 USD, and the whole 1.28M position behind an unseen 25M for the same 0.57 USD. A fork plays the builder itself; it cannot show the order a real builder gives ours against a rival doing the same.

### Rehearsal of the 25M repayment (26 Nov 2026, fork at block 26500258)

Sky's out-of-schedule spell `0xCFFa0aeA62794b883c20F2463ECdB0E20099106B` sends 25M USDS to the Sky Frontier Foundation at Safe `0xca5183FB9997046fbd9bA8113139bf5a5Af122A0`, the owner of the largest SKY-backed loan (40.2M, engine loan index 1), "to pay down debt". With the main wallet armed on a fork, that Safe repaying 25M was played through version 29 of the bot with a helper configured like the real one (floor 100 USDS, 9e11 wei per USDS, 1 ETH cap):

| Case | Withdrawn to the main wallet | Tip | Route |
|---|---|---|---|
| Queued and fully signed, bot key at 0.76 ETH | 1,279,345 USDS (whole position) | 0.754 ETH | Safe route, same block |
| Same, bot key at 1.06 ETH | 1,279,349 USDS | 0.762 ETH | Safe route, same block |
| Queued as one plain `wipe` call | 1,279,345 USDS | 0.762 ETH | Safe route, same block |
| Never queued, seen in the public mempool | 1,279,345 USDS | 0.763 ETH | backrun, same block |
| Never seen at all | 1,279,345 USDS | 0.761 ETH incl. gas (0.0998%) | standing bundle, same block |
| Landed without us | 1,279,350 USDS | 0.763 ETH | end of block, next block |

The arb added 84 to 1,608 USDS on a 750,000 USDS purchase. At 0.76 ETH the bot key is left with about 0.005 ETH, and the tip is already capped by the balance, so a lower ETH price would lower the bid; hence the advice to add about 0.3 ETH. A fork plays the builder itself: these runs show the transactions are valid and sized right, not that a builder picks them over a rival's.

## Telegram bot (`supabase/functions/tg-bot`)

A Telegram bot that posts updates into group chats and passes questions to the Claude session that runs this project.

- **Who is who.** The function reads the numeric Telegram user id from each update and looks the role up in `stusds_alert.tg_users`. An owner is made by sending `/claim CODE` to the bot in a private chat, with a one-time code from `stusds_alert.tg_claims`. Everyone else is a guest.
- **Groups.** Only an owner can add the bot to a group; added by anyone else, it leaves. In a group it only reacts when it is mentioned, replied to, or given `/ask` or `/status` (Telegram's privacy mode stays on, so it does not receive other messages at all).
- **Limits.** Guests get 8 answers per chat and 4 per person per hour (`stusds_alert.tg_config`). Answers normally come within a minute; if the session's watcher is not running they come at the hourly check, and the bot says so.
- **Waking the session.** Nothing outside can start a turn in a Claude session, but a background command that ends does. The session runs `watcher/tg-wait.mjs`, which long-polls the function (`?poll=KEY`, key in `tg_config.poll_key`) and exits when a message is waiting; the session then reads `stusds_alert.v_tg_pending`, answers with `stusds_alert.tg_send` and starts the watcher again. The rules it follows are in `CLAUDE.md`. While a watcher polled in the last two minutes the bot only shows "typing"; otherwise it says the answer comes with the hourly check, which is the fallback. A scheduled task's public fire URL was tried first and starts a fresh session instead of waking this one (see `LEARNINGS.md`), so `tg_config.fires_per_hour` is 0.
- **Fast responder.** With `ROTEO_API_KEY` set (an OpenAI-compatible gateway; `ROTEO_BASE_URL` overrides the address), the function first asks a small model (`tg_config.fast_model`) and answers within a few seconds. The model is given public facts only: the briefing in `tg_config.brief`, live numbers, recent on-chain events and the last lines of the chat (`tg_fast_context`). An owner's instruction, a private question or anything it cannot answer comes back as `HANDOFF` and goes to the session; a guest is never handed off, only declined. While it tries, the message is held for 12 seconds so the session's watcher does not wake for it; if the gateway fails, the message goes to the session as before. `{"action":"fast_test","id":N}` shows what it would answer to a stored message without sending anything.
- **Automatic posts.** Database triggers post the utilization alert (`stusds_alert.alerts`) and any repayment of 100,000 USDS or more moving through a watched Safe (`stusds_alert.safe_txs`: queued, fully signed, executed). The session posts the Sky vote milestones itself with `stusds_alert.tg_broadcast`.

Setup: create the bot with BotFather; put its token in the function's secrets as `TELEGRAM_BOT_TOKEN`; add an API trigger to the scheduled task at claude.ai/code/routines and store its URL and token as `ROUTINE_FIRE_URL` and `ROUTINE_FIRE_TOKEN`; then call the function with `{"action":"setup"}` (it reads the bot's name and points Telegram's webhook at itself). `{"action":"status"}` reports what is configured.

## Dashboard and collector (`supabase/functions/stusds-dash`, `dashboard/`)

`stusds-dash` runs once a minute from pg_cron. It is read-only towards the chain and holds no keys. It stores a snapshot (`stusds_alert.dash_now`), a history row (`dash_history`), new repayments, deposits and withdrawals (`chain_events`), and who took freed liquidity and what they paid the block builder (`takers`). It also keeps the DEX price ladder the bot's arb uses, and sends a Jarvis push (each once) for: a repayment or new borrowing of 100,000 USDS or more, 100,000 or more repaid within an hour, a deposit of 250,000 or more, a rate change, a change of the liquidation switch, the borrowing limit or the deposit cap, SKY falling below $0.035 / $0.03 / $0.025 / $0.02, any change of the main wallet's stUSDS balance, the bot key running low on ETH, and the Safe watch being blind.

`POST {"backfill": {"from": <block>, "to": <block>}}` loads history for an older block range.

The live dashboard is a Claude dashboard artifact. Its page is `dashboard/index.html` and its queries are in `dashboard/datasets.json`; each one reads a view named `stusds_alert.v_dash_*` through the Supabase connector. All times are formatted in Bangkok time in the views.

A standalone copy for any browser lives in `dashboard/vercel` (built by `python3 dashboard/build-vercel.py` from the same page). It reads `public.stusds_board(p_key)`, which returns the same views as one JSON object and answers only to the random key stored in `stusds_alert.config.board_key`. The key travels in the link's fragment (`#k=...`), is kept in the browser and never reaches Vercel. Changing `board_key` cuts off every old link.
