# Learnings from the stUSDS exit and arb work (November 2026)

What was tested, what turned out to be true, and what turned out to be wrong. Written so that a later session can
start from here instead of rediscovering it. All times are Bangkok time (UTC+7). The detailed how-to for each
component is in `README.md`; this file is the experience behind it.

## 1. The situation

- stUSDS is an ERC-4626 vault (`0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9`) that lends USDS against staked SKY.
  From about 14 November 2026 all of it was lent out (utilization 100%), so nothing could be withdrawn at par. The
  rate went to its 50% maximum. A Curve pool (`0x2C7C98A3b1582D83c43987202aEFf638312478aE`) trades stUSDS at a
  discount (11% at worst, about 2% on 27 November).
- Liquidity appears only when a borrower repays or someone deposits. It is taken within the same block, usually by
  the transaction directly behind the one that freed it.
- Two ways to profit from an opening: withdraw your own stUSDS at par (the "exit"), or buy discounted stUSDS on
  Curve with a flash loan and redeem it at par (the "arb").

## 2. Who takes openings, and how (measured)

Fifty-one openings between 14 and 24 November, 5.2M USDS in total:

| Fact | Number |
|---|---|
| Taker directly behind the freeing transaction | 39 of 51 blocks, 2.87M USDS |
| Something left for a later transaction in the same block | 1 block, 20,000 USDS |
| Taken in a later block, or freeing transaction not identified | 11 blocks, 2.32M USDS |
| Share of volume by builder | BuilderNet 52%, Titan 24%, Eureka 20%, others 4%, Quasar 0.3% |

- Openings do not follow builders' overall block share. Quasar builds 10 to 28% of blocks but saw one opening in
  eleven days. Check where the events actually land before investing in a builder.
- Rivals are of two kinds: holders with their own exit bots (they pay 5 to 11% of the amount to get out), and arb
  bots (they pay 2 to 14% of the amount, close to the whole margin).
- Holder exit bots can outbid an arb, because being stuck is worth more to them than the discount is to an arb.
- On 23 November a 3M repayment was gone in three blocks. A large opening lasts minutes at most.

## 3. Getting a transaction to run right after someone else's

This was the central technical problem. A transaction that only works after another one in the same block needs one
of four things.

### 3.1 You have the other transaction: bundle it

`eth_sendBundle` with `[their transaction, ours]` works at every builder. This is how a repayment visible in a Safe's
signing queue or in the public mempool is handled. It is an auction: the builder takes the bundle that pays most.

### 3.2 You do not have it: conditional ("end of block") bundles

An ordinary bundle is simulated at the top of the block and dropped if it fails there. A waiting bundle fails there
by design, so sending it every block as an ordinary bundle does nothing. This cost several lost races before it was
understood.

| Builder | Method | Notes |
|---|---|---|
| Titan | `eth_sendEndOfBlockBundle` with `targetPools` and `targetSlots` | Works. Tracing: `titan_getBundleStats` on `stats.titanbuilder.xyz` |
| BuilderNet | `eth_sendBundle` with `version: "v2"`, `desiredState: "AnyPosition"`, `targetAddresses`, `targetSlots` | Works |
| Eureka | `eth_sendEndOfBlockBundle` (same shape as Titan) | Allow-list. Access is requested on Telegram (`t.me/EurekaBuilder`); it was granted within a day without notice. Tracing `eureka_getBundleStats` is open to everyone |
| bombora | `eth_sendEndOfBlockBundle` | Accepted, never confirmed (too few blocks). Tracing on `stats.bombora.build` |
| Quasar | `eth_sendEndOfBlockBundle` with `targetPools` only | Returns `result: null` (documented as normal), offers no tracing, and never ran ours in three tests, also with busy trading pools named |
| beaverbuild, Flashbots relay | none | "Invalid method" and "rpc method is not whitelisted" |

The slots to watch for stUSDS: the vault's own slots 1 and 5 (written by every deposit and repayment), and in the
Vat (`0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B`) the ilk's `Art` slot
`0x0b2fb9dcfebfeb5c8f6985ea98125a38a1adb70b7194dc26531c5e9ab986e533` and that slot plus 3.

### 3.3 No conditional method: a transaction that is always in the block

Quasar's and Eureka's ordinary `eth_sendBundle` is open and accepts `revertingTxHashes`. A bundle of one transaction
that "may revert" is included whatever happens. The builder values it at almost nothing at the top of the block, so it
is placed behind better-paying transactions, where a repayment sits. It then succeeds if liquidity is there and
reverts if not.

- Tested with the no-token probe: three runs, three times placed behind the trigger (Eureka positions 9 then 82;
  Quasar 14 then 15, and 19 then 94).
- It does not block our own better-paying bundle with the same nonce: tested at Eureka and Quasar, the better-paying
  bundle took positions 0 and 1 and the may-revert one stayed out.
- In this mode the tip does not decide the position, so the withdrawal carries only the minimum tip. On a fork the
  whole 1.28M position came out behind an unseen 25M for 0.57 USD, against about 1,279 USD in the bid-based routes.
- Cost: a failed attempt uses about 80,000 gas, in every block of the chosen builders.
- It cannot beat a rival bundled directly behind the freeing transaction, which is the common case (section 2).
- Verdict: works, rarely matters. Worth switching on only for a short, important window.

### 3.4 Otherwise: the next block

For large openings this is fine. For small ones nothing is left.

### 3.5 Testing a builder without risking money

`CondProbe` (`contracts/src/CondProbe.sol`): one wallet's `set()` writes a slot, another's `claim()` only works later
in the same block and pays a small tip. Put `claim()` with the builder in the form under test, send `set()` privately
to that builder only, and see whether the pair lands together. A run that meets no block from that builder costs
nothing. This settled every builder question in minutes where real deposits had only produced lost races.

## 4. Seeing pending transactions

- The bot listens to two free full feeds (publicnode, 0xrpc) and an Alchemy feed filtered to our contracts.
- In a four-block sample the free feeds showed 58% of mined transactions; 3% were certainly private (zero priority
  fee); 39% were unknown, a mix of private flow and public transactions the feeds missed.
- A repayment of 33,380 USDS on 27 November was not delivered by any of the three feeds, including the filtered one,
  and was not offered on MEV-Share. It was most likely sent through a private route. A better public feed would not
  have shown it.
- So: more vision helps only for the public part. The durable answer to private flow is section 3.2, not a feed.
- Other pending-feed hosts refused the connection or needed keys. MEV Blocker's searcher stream needs registration.

## 5. Bidding

- Paying more per unit of gas is not what lost the early races. That diagnosis was wrong (see section 9).
- A race for a visible transaction is won by total payment to the builder. The arb's bid is a share of its profit
  (99.5% during testing); the exit's bid is capped at 0.1% of the amount by the owner's rule.
- Being on time matters as much as the bid: a bundle that reaches the builder a second into the slot loses. Sign
  everything in advance each block and send before simulating.
- Start a test at the beginning of a slot, never at the end.

## 6. Contracts

| Contract | Address | Role |
|---|---|---|
| `StUsdsExit` (main wallet) | `0xbF54F2AA78b4c240e34224073aff9E89Cd915897` | Withdrawal helper: can only redeem to the owner, tip capped per USDS |
| `StUsdsExit` (test wallet) | `0x01662b082432859c366ab16362eab10fb72c73e6` | Same, for tests |
| `StUsdsArbLite` | `0x47d40588adac1af6b4d9d33ab7774c3bccd6dbc8` | Self-sizing arb, Morpho flash loan, about 310k gas, profit only to the main wallet |
| `StUsdsArbAuto` | `0x5139a9951f3cdc8de4c0a627ef8d9bc706eb2caf` | Older self-sizing arb, about 1.1M gas |
| `CondProbe` | `0xa2ed66b89e6676de9a4f4d2201c4fdee1c1d212f` | Builder test fixture (out of ETH since 27 November) |

- Morpho Blue (`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`) lends USDS for free in a flash loan; the DAI flash mint
  is the fallback for sizes Morpho cannot cover.
- A self-sizing contract (reads what is withdrawable when it runs) is what makes waiting bundles possible. A bot
  that computes the size off-chain cannot wait inside a block.
- Passing the pool price in as a parameter instead of quoting on-chain saved most of the gas.
- Design rule that held up: a helper that can only ever send to the owner makes the approval the single risk.

## 7. Sky specifics

- Rate: `stUSDS rate = utilization x borrow rate + (1 - utilization) x savings rate`, target utilization 90%. The
  rate setter (`0x30784615252B13E1DbE2bDf598627eaC297Bf4C5`) allows 2% to 50%, at most 5 points per change, one change
  per 16 hours. The algorithm that picks the step is off-chain.
- Governance: an executive proposal passes when its approvals exceed those of the chief's current hat. Read the hat
  from the chief contract (`0x929d9A1435662357F54AdcF64DcEE4d6b867a6f9`, `hat()` and `approvals(address)`); the
  vote.sky.money API lists proposals but does not say which one is the hat, and the hat can be an old proposal.
  After passing, a 48-hour delay runs before execution.
- The largest borrower repayments come from Safes. A Safe's signing queue is public (Safe Transaction Service), so a
  queued repayment is visible before it executes. This is the most reliable early signal there is.
- The Sky Frontier Foundation's Safe is `0xca5183FB9997046fbd9bA8113139bf5a5Af122A0` (owes the largest loan);
  rune.eth's Safe is `0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d`.
- Vat debt only updates on `drip`, while the vault's assets accrue every second. A quick "assets minus debt" on a
  fork therefore shows phantom liquidity. Use the vault's own `maxWithdraw` or apply the accrual.

## 8. Operations

- **Never hold a `net.http_post` call open for long.** A call that takes a minute or more stalls every scheduled job
  in the Supabase project. Call test actions with a timeout of a few seconds; the function keeps running and logs
  its result.
- **Edge function uploads must be byte-exact and verified.** Upload, fetch back, `cmp` and compare sha256. The tool
  layer decodes a JSON escape like backslash-u-2026 into the character, so avoid such escapes in source files.
- **Read the confirmation, not the response.** Builders answer "accepted" for bundles they will never run. Only an
  on-chain result or the builder's tracing counts.
- A test wallet's gas top-up from the bot key changes the bot key's nonce. Top up well before a test and wait two
  blocks.
- The fork harness refuses to act twice on the same Safe transaction. Change the amount by one unit between runs.
- Public RPC hosts sometimes answer with a long HTML block page. Always trim command output.
- Every pre-signed transaction shares the bot key's nonce. One landing invalidates the rest for later blocks, so
  everything is re-signed on every new block.
- Arming the main wallet needs about 0.75 ETH on the bot key for a 0.1% tip on the full position at 1,700 USD per
  ETH. The tip is capped by the balance, so a low balance silently lowers the bid.

## 9. Mistakes worth not repeating

| What was said | What was true | Lesson |
|---|---|---|
| "We lose because rivals pay more per unit of gas" | Ordinary waiting bundles were dropped at the top of the block | Find out whether the transaction was even tried before explaining why it lost |
| "Quasar restricts its end-of-block method" | Its docs say open and `null` is the normal reply | Read the docs before describing a service |
| "The vote is about to pass" | It was compared against the wrong proposal; the real bar was 7.02 billion SKY, not 4.80 | Read the threshold from the contract |
| "Switch the Quasar backup on, about 15 to 45 USD a day" | Quasar gets almost none of these events | Check how often something would matter before recommending to pay for it |
| A 33,380 USDS repayment went unreported | The hourly check only looked at utilization rounded to one decimal | Report events, not just a threshold |
| Test deposits to "see who takes them" | Each one handed money to a rival | Use the no-token probe to test mechanics |

## 10. The owner's standing rules

- The withdrawal only ever takes USDS that Sky itself pays out at par. It never goes through the Curve pool.
- Withdrawal fee at most 0.1% of the amount withdrawn. The arb may bid aggressively, since that only costs profit.
- Withdrawing the main position comes first; arb only if still possible afterwards.
- No risk of loss is accepted outside the test wallet and the bot key.
- Keys live only in Supabase Vault and are never shown. Anything swept can only go to the main wallet.
- All times in Bangkok time, never UTC.
- Do not make test deposits that rivals can take.

## 11. A checklist for the next opportunity

1. Measure first: who takes it today, in which builders' blocks, how fast, and what they pay.
2. Decide whether you will see the triggering transaction in advance. If not, you need section 3.2 or 3.3.
3. Put the logic that needs fresh state on-chain (self-sizing), so the transaction can be signed before the event.
4. Prove each builder path with a no-token probe before sending anything of value.
5. Rehearse the real event on a fork with the real contracts' settings.
6. Keep an off switch and a cost cap on anything that spends continuously.
7. Report what happened, including what was missed.

## 12. Tools kept from the investigation

`tools/research/` holds the scripts used above (block-builder counts, flow census, holder analysis, vote and Safe
checks, the fork scenario harness). They were written for a scratch directory and expect `viem`, Foundry's `anvil`
and Deno next to them; adjust the paths at the top of each file before running.
