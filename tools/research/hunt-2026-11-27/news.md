# News-side hunt: what is dislocated in Ethereum DeFi (written 27 November 2026, about 19:45 Bangkok time)

Scope: public web sources only, read-only. All times are Bangkok time (UTC+7); sources that printed another zone
were converted. Every source carries its publication date. "Stated" = the source says it. "Inferred" = my own
reasoning or arithmetic, not confirmed by a source. Prices were read from two public price feeds at 19:35 on
27 November (ETH 1,720 USD, BTC 61,500 USD).

**Was November quiet? No.** Three things overlapped: the fallout of the Binance hot-wallet theft of 30 October
(6.3 billion USD, Aave froze many reserves, tBTC redemptions were shut for 11 days), a market crash on 20 to 21
November (ETH low 1,561 USD, BTC low about 55,100 USD), and a run on Sky (2 billion USD of USDS swapped to USDC on
19 to 20 November, stUSDS frozen since about 10 November). Most of the stress cleared without bad debt. What is left
that looks like a trade is mostly in the Sky ecosystem and in two announced wind-downs.

---

## Ranked list

### 1. Sky stUSDS: 25M USDS repayment waiting on a vote, plus three proposals that would change the trade

- **What and when (stated).** The stUSDS vault (`0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9`) has been fully lent
  since about 10 November (Credora: "no withdrawals possible since 10 November"; BA Labs: above 99.98% from
  13 November). Size about 158.6M USDS, rate at the 50% cap. Two borrowers owe 74%: rune.eth's Safe about 77M and the
  Sky Frontier Foundation (SFF) Safe `0xca5183FB9997046fbd9bA8113139bf5a5Af122A0` about 40M.
- **The dated event (stated).** An out-of-schedule executive spell `0xCFFa0aeA62794b883c20F2463ECdB0E20099106B`
  moves 25M USDS to the SFF Safe "to pay down debt" (6M from Amatsu, 4M from Ozone, 15M from CCEA1 sub-proxies).
  Posted on the forum 25 November (forum date; early 26 November in Bangkok at the latest), live for voting
  26 November. After passing, the 48-hour delay applies. The spell
  expires 26 December 19:33.
- **Status I read myself.** vote.sky.money API at 19:35 on 27 November: support 4.548 billion SKY, not scheduled,
  not cast. CoinMarketCap (26 November) reported 4.39 billion in support and "about 2.63 billion more" needed, which
  puts the bar near 7.02 billion (inferred from that sentence; read the hat from the chief contract to be sure). So
  roughly 65% of the bar, and it gained only about 0.16 billion in a day. **The earliest possible repayment is
  therefore not before 29 to 30 November, and may be much later.** The next scheduled spell is 3 December.
- **How the money lands is undecided (stated, forum thread 28499, 26 November).** Three camps:
  1. Martin Koeppelmann: do not repay naively; run a one-week TWAP (about 2,000 orders of 12,500 USDS every 5
     minutes) buying stUSDS up to redemption price, then "flashloan USDS, pay back, redeem stUSDS, repay flashloan".
     He states Rune's 3M repayment paid at least 60,000 USD to builders, with more kept by searchers.
  2. "bonhardt", "ares": one lump sum, because a single large repayment leaves only a small share to Curve arbitrage.
  3. "truescl", "ares": pro-rata withdrawal or a queue before any large repayment.
  The spell itself only transfers USDS to the Safe; the SFF chooses the method afterwards. Inferred: a TWAP through
  CoW Swap would close the discount slowly and leave almost nothing for a same-block arb; a lump sum of 25M is far
  larger than the Curve pool can feed, so it mostly helps direct exits.
- **Other moving parts (stated).**
  - Rune Christensen (23 November): repaid 3M, owes about 77M, exploring a sale of SKY to institutions, promised an
    update at least every 48 hours. 25 to 26 November (The Defiant via PANews): "support of institutional partners",
    "nothing has been finalized", next update due 27 November at the latest. I found no 27 November update yet.
  - Forum proposal 28465 (23 November, user "misher"): lock the rate at 10%, pause new borrowing, lower the minimum
    debt from 30k to 10k, and **use reserves to buy stUSDS in the market until it trades at 0.98 or higher**. A reply
    wants 20% with a mandatory repayment schedule and pro-rata distribution.
  - Forum proposal 28473 (23 November, "Conquercube"): 40 to 50M USDS of reserves buy SKY over the counter from
    borrowers, proceeds wiping debt in the same transaction; author estimates utilization would fall to 68 to 74%.
  - None of these three has a vote. Rune said on 23 November that governance participants are preparing a proposal
    "that will address the stUSDS situation more broadly".
- **Price gap (stated).** Curve pool `0x2C7C98A3b1582D83c43987202aEFf638312478aE`: discount 22% on 23 November,
  16.5% on 21 November, about 8% on 25 November; a 20,722 stUSDS sale on 25 November cleared at 0.969 against book
  1.093 (11%). Price feeds on 27 November show about 1.079 against a book value I estimate near 1.095 (inferred),
  so roughly 1.5 to 2%. Credora (20 November): the pool held about 0.1M USDS and a 100,000 stUSDS sale cleared 32%
  below redemption value. **A second venue a Curve screen will not see:** The Defiant reported a CoW Swap order book
  with about 8M USD of stUSDS sell orders, mostly below vault value, against about 2.5M of bids (25 November).
- **Who can use the exit.** Anyone; redemption is permissionless when USDS is in the vault.
- **Why it may not be an arbitrage.** (a) Real loss is possible: liquidations have been switched off since
  September 2025, the oracle caps SKY at 0.025 USD, SKY fell 44% between 21 October and 20 November, weighted loan
  to value rose from 26% to 41% (Credora). Loss starts if a borrower's SKY is worth less than the debt; for the
  largest borrower that is near 0.019 USD per SKY (inferred from 77M debt and about 185M collateral at 0.046).
  (b) A rate cap of 10 to 20% would cut the carry that pays for waiting. (c) A queue or pro-rata rule would end the
  race. (d) Korean exchanges put SKY and USDS on warning lists and stopped deposits (23 November).
- **Sources.** Forum thread 28499 (25 to 26 November) https://forum.skyeco.com/t/declaration-of-out-of-schedule-executive-vote-sky-frontier-foundation-genesis-capital/28499 ;
  vote page (26 November) https://vote.sky.money/executive/template-executive-vote-out-of-schedule-spell-sff-transfer-november-26-2026 ;
  CoinMarketCap (26 November) https://coinmarketcap.com/academy/article/sky-sff-transfer-stusds-vote ;
  Protos (26 November) https://protos.com/is-sky-frontier-foundations-25m-payment-plan-another-gift-to-mev-bots/ ;
  TokenPost (27 November) https://www.tokenpost.com/news/business/63451 ;
  The Block (23 November) https://www.theblock.co/news/defi/2026-11-23-sky-cofounder-weighs-sky-sale-repay-77-million-stusds-pool-runs-dry-445373 ;
  proposal 28465 https://forum.skyeco.com/t/proposed-stusds-liquidity-and-protection-plan/28465 ;
  PANews (26 November) https://www.panews.io/articles/01a2158a-1f89-7666-814d-efc7ef6002f9 and https://www.panews.io/articles/01a21574-fcdb-7493-9f36-163c365b9694 ;
  Credora report (updated 26 November) https://reports.credora.io/spark/latest.pdf ;
  4Pillars (24 November) https://research.4pillars.io/en/research/reflections-on-the-sky-protocol-incident ;
  Bitquery (19 November) https://bitquery.io/investigations/sky-stusds-rune-eth-loan

### 2. Balancer wind-down: BAL trades below the published per-token treasury value, redemption from end of May 2027

- **What and when (stated).** BIP-928 passed on 29 September 2026 (more than 99% of about 17.2M BAL). Pools went
  withdrawal-only on 30 October; the v3 Vault is paused on **30 November 2026**; "round one" opens at the end of
  May 2027: holders burn BAL and receive a pro-rata share of the treasury in kind, window six months, later sweeps in
  January and July 2028.
- **Numbers (stated, measured 18 September at ETH 2,550, stkAAVE 140.66, BAL 0.1114).** Distributable base
  9,959,416 USD, redeemable BAL 63,068,821, **0.1579 USD per BAL**; an independent rebuild (Arcobaleno, 10 November)
  reproduced it within 0.007%. The largest lines are stkAAVE (19,549, then 2.75M USD) and about 2.55M USDC in Morpho
  and Compound positions. An operating Safe with 0.76M USD sits outside the base and pays the wind-down budget.
- **Price gap.** BAL (`0xba100000625a3754423978a60c9317c58a424e3D`) 0.1146 USD at 19:35 on 27 November. Against the
  September figure that is a 27% discount. **Inferred:** at today's prices (AAVE near 97, ETH 1,720) the base is
  lower; my rough re-mark gives 0.13 to 0.14 per BAL, a 12 to 20% discount, for a wait of 6 to 12 months. The value
  is re-measured and audited at the opening snapshot, so it floats with AAVE and ETH until then (both can be hedged).
- **Size.** All redeemable BAL is worth about 7.2M USD at market. A position of 200,000 to 500,000 USD is realistic
  only if it can be bought without moving the price; Balancer's own pools are closed, so check where BAL still
  trades. Profit potential in the wanted range only at the upper end of that size.
- **Related legs (stated).** Aura is also closed: rAURA redeems unclaimed treasury plus 10% of the locked BAL/WETH
  pool tokens, auraBAL redeems the other 90%, both from **10 May 2027**. tetuBAL holders receive BAL equal to 50% of
  what is locked behind their tokens (2.538962 BAL each at 100%, so about 1.27 BAL). I did not find market prices
  for auraBAL, rAURA or tetuBAL: a job for the redemption-value screen.
- **Who can use the exit.** Any BAL holder; the team warns that any site offering redemption before May 2027 is a
  scam.
- **Why it may not be an arbitrage.** Long wait; value floats; budget overruns reduce the base; thin market; tax and
  securities-law treatment of a treasury distribution is unsettled; in-kind payout means selling stkAAVE and others.
- **Sources.** BIP-928 (14 September, updated) https://forum.balancer.fi/t/bip-928-orderly-winddown-of-balancer-and-distribution-of-the-treasury/7107 ;
  inventory (18 September) https://gist.github.com/marcusblabs/794a551c924bdac8a787045f4bc2a56c ;
  Balancer on X (29 September) https://x.com/Balancer/status/2105006446752731615 ;
  Arcobaleno check (10 November) http://arcobaleno.cloud/tools/report-balancer-winddown-2026.pdf ;
  Aura sunset page (read 27 November) https://app.aura.finance/

### 3. The same pattern inside the Sky ecosystem: stUSDS as collateral on Morpho, markets at 100% utilization

- **What (stated).** Sky markets stUSDS as collateral for borrowing USDS, USDC or USDT on Morpho ("Risk Capital
  Vaults"). The USDS/stUSDS 86% market (id `0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82`,
  oracle `0x0A976226d113B67Bd42D672Ac9f83f92B44b454C`) showed 1.0M USD supplied, **100.00% utilization**, borrow
  rate 22%, supply rate 15.9% (page read 27 November). Spark's dashboard (24 November) lists Morpho Blue
  (`0xbbbb…ffcb`) as the third-largest stUSDS holder with 9.02M stUSDS, worth 9.85M USD. Sky's own page says
  "stUSDS risk can affect the Risk Capital Vaults on Morpho".
- **Inferred, not confirmed.** Lenders in these markets are stuck in the same way as stUSDS holders, one level up.
  Borrowers earn 50% on the collateral and pay about 22%, so they have no reason to repay; Morpho's rate model keeps
  raising the rate while utilization stays at 100%. If Sky caps the stUSDS rate at 10 to 20% (proposal in item 1),
  that carry turns negative and these borrowers become forced sellers of stUSDS on Curve or CoW, which would widen
  the discount again. If the oracle uses the vault's book value (I did not verify the oracle), a market discount
  does not trigger liquidations, and a liquidation would hand out stUSDS at about 4% below book (inferred from the
  86% threshold), which is no better than the market on a bad day.
- **Use.** Not a clean arbitrage. It is a place where forced selling can start, and where 16 to 22% is paid to
  lenders who accept being stuck. I did not find the USDC and USDT sister markets' figures.
- **Elsewhere in Sky (stated): nothing else is frozen.** Spark's liquidity layer pulled 408M USD back from Ethereum
  and Base in 316 transactions on 19 to 20 November and still held 2.4 billion in stablecoins; the PSM never fell
  below 800M USDC (867M at the low, refilled by a 100M Obex repayment at 00:55 on 20 November) and was back above
  1.1 billion on 21 November; USDS held 1:1. sUSDS and the Spark Savings vaults kept instant liquidity. Grove
  (1.33 billion) and Obex (207M) show 100% collateral ratio on Sky's dashboard. I found no discount on sUSDS.
- **Sources.** Morpho market page (read 27 November) https://app.morpho.org/ethereum/variable/0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82/usds-stusds ;
  Spark data hub (24 November) https://data.spark.finance/savings/stusds ; Sky product page https://sky.money/stusds ;
  Crypto Briefing (23 November) https://cryptobriefing.com/spark-liquidity-layer-recalls-408m-outflows/ ;
  CryptoSlate (23 November) https://cryptoslate.com/more-than-2-billion-rushed-out-of-skys-stablecoin-in-a-single-day ;
  Sky statement (20 November) https://x.com/SkyEcosystem/status/2123791466216534264

### 4. Sky core vaults are being closed: collateral auctions with few bidders, and a possible forced unwind later

- **What and when (stated).** The 19 November spell, executed 23 November 21:11, set the debt ceilings of ETH-A,
  ETH-B, ETH-C, WSTETH-A and WSTETH-B to zero and removed them from the automatic ceiling module. BA Labs: 376M USDS
  of debt in 771 vaults; "existing vaults are not affected ... and remain subject to liquidation as before". The WBTC
  vault types were already at zero.
- **Recent auctions (stated, Sky's liquidation page, read 27 November).** About 14 November: one ETH-C vault,
  406 WETH seized, 675k debt repaid, **87.7k penalty**. About 21 November: six auctions (WBTC-A, -B, -C and ETH-C),
  the largest 1.76 WBTC against 104k debt; the WBTC ones show a penalty of 0. Sky's collateral auctions are Dutch
  auctions that settle instantly and allow flash-borrowing the collateral.
- **Inferred.** Three things for a searcher: the fixed reward for starting an auction, buying collateral as the
  price decays, and the fact that only a handful of keepers still watch a product with 771 vaults. Earlier Maker
  off-boardings ended with governance raising liquidation ratios so that the remaining vaults were auctioned with
  zero penalty on a known date; **no such step has been proposed for the ETH vaults**, so this is a watch item for
  the forum, not a dated trade. The other agents can measure how far below market these auctions actually cleared.
- **Why it may be nothing.** Small and irregular flow; proper keepers exist; a zero-penalty unwind may never be
  proposed.
- **Sources.** Forum thread 28399 (November) https://forum.skyeco.com/t/core-vaults-parameter-changes-set-dc-iam-line-to-0-on-eth-a-eth-b-eth-c-wsteth-a-and-wsteth-b/28399 ;
  liquidations page https://info.skyeco.com/liquidations ; auction docs https://developers.skyeco.com/protocol/vaults/collateral-liquidation

### 5. Aave V3 Core "repositioning": 862M USD of 12x to 14x loops on rsETH and osETH told to leave, no date yet

- **What and when (stated).** LlamaRisk proposal of 10 November: freeze osETH, LBTC, rETH and six small reserves on
  Core (rsETH has been frozen since April, tBTC since 31 October). rsETH backs 605.7M of WETH debt in eleven large
  positions (top three hold 69%); osETH backs 256.6M at about 14 times leverage (top ten hold 66%). Cutting the
  liquidation threshold by 2 to 5 points "would make most of that collateral liquidatable", so they promise not to
  do that abruptly; the last resort is a WETH borrow-rate increase of up to 1 point in half-point monthly steps.
  StakeWise (11 November) and Rocket Pool (12 November) asked to be taken out. No vote date. Supply caps on frozen
  reserves were recommended to be cut to 1 on 20 November (risk-steward process).
- **Where a gap could open (inferred).** If large loops unwind by selling instead of swapping collateral, osETH and
  rsETH would trade below their redemption value while exits take days (Kelp: 15 to 21 days free, or 0.5% instant
  "subject to available funds", per a 1 November review). Today rsETH is 1.0811 ETH and osETH 1.0807 ETH on price
  feeds; I could not confirm the redemption rates, so I cannot state a discount. The on-chain screen should track
  both against their contracts' rates and watch the Aave forum for the vote.
- **Why it may be nothing.** The plan is built to avoid forced selling; holders can swap collateral inside the
  category instead of repaying.
- **Sources.** Aave forum (10 November) https://governance.aave.com/t/arfc-repositioning-aave-v3-core-around-established-liquid-collateral/26191 ;
  Unchained via Yahoo (11 November) https://finance.yahoo.com/markets/crypto/articles/llamarisk-asks-aave-freeze-stakewise-190657959.html ;
  CryptoSlate (12 November) https://cryptoslate.com/aave-will-freeze-279m-in-oseth-unless-stakewise-wins-this-vote ;
  risk stewards (20 November) https://governance.aave.com/t/risk-stewards-supply-and-borrow-cap-and-irm-changes-on-aave-v3-2026-11-20/26457

### 6. K3 Capital sBOLD: a recovery plan with a number, but probably no claim that can be bought

- **What and when (stated).** 18 November, 19:25 to 19:33: attackers drained about 3.43M BOLD, 99.9% of K3 Capital's
  sBOLD vault (a wrapper over Liquity V2 stability pools) in 99 transactions; paused 20:05. Liquity V2 and 1inch were
  not exploited. Attackers paid about 986 ETH to block builders, almost all passed on to 21 validator fee recipients
  (Lido's rewards vault the largest).
- **Recovery plan (stated, postmortem 19 November).** Nine counterparties identified holding 894.50 ETH and 131,316
  yBOLD, "approximately 1.7M BOLD"; Bitcoin Suisse and Yearn committed. Recovery address
  `0x2f02BCd2163176B29C7B070B43A1660A5341C795`, 15% bounty. Collect ETH for four weeks (the summary says two; rekt
  noted the contradiction), convert to BOLD, then "redeem clients on a case-by-case basis through a dedicated
  channel". As of 24 November no result was announced.
- **Arithmetic (inferred).** Best case about 1.7M of 3.43M, less the 15% bounty, so 40 to 45% recovery; ETH has
  fallen since, and the pot is converted at the later price.
- **Why it is probably not a trade.** Shares in a paused vault; redemption is case by case, which suggests payment
  to pre-exploit depositors, not to whoever holds the token now. After the collapse bots minted large numbers of
  near-worthless shares and pushed them into Pendle's sBOLD wrapper (which held 12.79% of shares before the attack),
  so tokens bought today may carry no claim. I could not confirm whether any sBOLD or Pendle sBOLD token trades.
- **Sources.** K3 postmortem (19 November) https://x.com/k3_capital/article/2123395654214967426 ;
  rekt (25 November) https://rekt.news/k3-capital-rekt ; Bitquery (18 November) https://bitquery.io/investigations/k3-capital-sbold-hack ;
  Olympix (about 24 November) https://olympix.security/exploits/k3-capitals-3-43m-loss-and-how-olympix-would-have-prevented-it

### 7. Fee-conversion auctions: Uniswap's burn mechanism, and a one-off 300,000 USD backlog

- **Recurring (stated).** Uniswap protocol fees collect in a "TokenJar" on each chain; anyone can call
  `Firepit.release()`, burn a fixed threshold of UNI and take the jar's assets. Profit is the jar's value above the
  threshold. Uniswap's blog (30 October) describes the surplus when one large fee deposit lifts the jar well above
  the threshold, and says the same system ("TJAR") now runs for Robinhood's fees with USDC and USDG as payment.
  One estimate links at least 52M USD of UNI burned to these mechanisms over its study period (1 October).
- **One-off (stated).** On X Layer about 300,000 USD of fees are stranded because the installed releaser used a
  bridge route that rejects UNI (disclosed 6 November). The repair starts a declining price: **80,000 UNI at the
  start, floor 2,000 UNI, half-life two days**, about 10.8 days to the floor (the forum post says about six days).
  On 15 November the implementation was still a draft and governance had not executed it.
- **Inferred.** At UNI 4.88 USD the start price is 390,000 USD, and it crosses 300,000 after roughly 18 hours, so
  the backlog goes to whoever accepts the thinnest margin once the decay starts. The edge is knowing the start block
  from the governance execution and being able to sell long-tail fee tokens on X Layer. It is not on mainnet, and
  the margin may be a few percent of 300,000, so likely below the 10,000 USD floor unless competition is thin.
- **Sources.** Uniswap blog (30 October) https://blog.uniswap.org/how-tjar-works-uniswaps-onchain-fee-conversion-system ;
  developer docs (17 November) https://developers.uniswap.org/docs/protocols/protocol-fee/overview ;
  CryptoSlate (17 November) https://cryptoslate.com/uniswap-freezes-300000-in-stranded-fees-halting-automatic-token-burns/ ;
  governance post (6 November) https://gov.uniswap.org/t/temp-check-upgrade-volatilepair-hook-and-update-x-layer-releaser/26337 ;
  design https://github.com/Uniswap/protocol-fees/pull/167 ; study (1 October) https://thecryptomath.com/research/token-value-capture

### 8. Liquidations: where they paid well this month, and two timing facts a screen cannot see

- **Paid unusually well (stated).** Morpho, from 9 November to mid-month: 111M USD of debt liquidated in 8,238
  liquidations, about 6M USD of bonuses, **one liquidator took roughly 60% of it**, 95% of it on Base in the
  cbBTC/USDC market, zero bad debt in the large vaults (Steakhouse, via a 24 November summary). On 19 November that
  market had 2,836 liquidations repaying 82M with a fixed 4.38% penalty (The Defiant, 25 November). XRP-backed loans
  on Morpho: 883 liquidations, 53.5M of debt still open at the time of the report. This is Base, not mainnet.
- **Timing fact 1 (stated).** Price feeds for tokenized shares on Aave and Morpho held Friday's close for about 50
  hours over the 21 to 22 November weekend and then stepped 2.7% at the Sunday reopen, which is **Monday 08:00
  Bangkok**; perpetuals on Hyperliquid led the price in between. Inferred: the size and direction of the Monday
  step is known in advance from perpetuals, so liquidations in those markets happen at a known minute. US markets
  were shut on 26 November and close early on 27 November, so the same gap exists this weekend. These markets are
  small.
- **Timing fact 2 (stated).** Chainlink's liquidation auction for oracle updates (SVR) now runs through Titan's
  order-flow auction as well as Flashbots on mainnet, covering Aave V3, Aave V4, Compound V3, Morpho and Venus;
  searchers "should integrate with all supported order-flow auction providers". Access is by onboarding with
  Chainlink (docs dated 17 and 23 November).
- **Sky buyback (stated).** From about 20 November the Smart Burn Engine bought SKY with 6,000 USDS every 550
  seconds, 856k USDS a day for seven days (5.25M extra), then back to every 2,693 seconds. Each purchase is a
  small, fully predictable trade against the SKY/USDS pool. The seven days end about now.
- **Sources.** Summary (24 November) https://hoge.gg/defi-lending-november-2026-crash-stress-test/ ;
  Steakhouse (24 November) https://kitchen.steakhouse.financial/p/defi-markets-update-2026-11-24 ;
  The Defiant (25 November) https://thedefiant.io/newsletter/defi-daily/sky-s-outflow-raised-coinbase-bitcoin-loan-rates ;
  Chainlink docs https://docs.chain.link/data-feeds/svr-feeds ;
  Sky buyback thread (20 November 02:28) https://forum.skyeco.com/t/immediate-one-off-sky-buyback/28439

---

## Checked and nothing there

| What | Finding | Source and date |
|---|---|---|
| Binance hack, 30 October 03:04 to 06:56 | 6.3 billion USD from 17 hot wallets on nine chains; Binance covered users; withdrawals reopened in phases from 1 November. No lasting depeg found: Binance's staked-ETH token trades at 1.1085 ETH and I found no report of a discount. Arbitrum DAO is asked to return 8,426 ETH and 74.56M ARB to Binance (about 49 days, to late December); an Abu Dhabi court hears the asset-freeze case on 1 December. Neither gives outsiders a trade | Binance blog 3 November https://www.binance.com/en/blog/community/3229153443759566763 ; Cointelegraph 19 November https://cointelegraph.com/news/binance-hackers-stole-192-tokens-across-11-networks ; DAO Times 5 November https://daotimes.com/binance-asks-arbitrum-dao-to-release-frozen-eth-and-arb |
| tBTC redemptions shut | Shut 31 October to 10 November 10:00 (deposit-accounting bug plus signer patching), fully backed (4,320 BTC against 4,185 tBTC). Reopened; tBTC is 0.9989 BTC today. Closed. tBTC is now exit-only on BOB, Optimism and Polygon, no deadline | Threshold post-mortem 18 November https://www.threshold.network/blog/post-mortem-the-tbtc-bridge-pause ; 20 November https://www.threshold.network/blog/tbtc-is-now-exit-only-on-bob-optimism-and-polygon |
| Chainflip, 21 November 14:10 | 12.6M USD taken (133.34 BTC, 520 ETH, 3.25M USDC, 0.76M USDT) through stolen validator key shares. Bounty deadline 24 November 01:38 passed with nothing returned. Swaps, deposits and withdrawals still paused, no restart date, no compensation plan yet ("part 2" pending). Claims are account balances inside Chainflip, not tokens; FLIP is 0.19 USD (down about 59% in a week). Nothing to buy at a discount to a defined value | CryptoSlate 25 November https://cryptoslate.com/chainflips-post-hack-refunds-leave-liquidity-providers-facing-a-second-financial-problem/ ; Cryptopolitan 24 November https://www.cryptopolitan.com/chainflips-12-6m-hack-safe-restart-question/ |
| Lighter, 16 November | 10.4M USDC taken with leaked trader API keys; 5M recovered and withdrawals restored the same day. Closed | Cointelegraph 16 November https://cointelegraph.com/news/lighter-dex-pauses-withdrawals-10m-exploit |
| Gonka bridge, 18 November | 1.05M USD drained, "fully returned" 19 November. Closed | crypto.news 18 November https://crypto.news/gonka-bridge-sbold-vault-ethereum-exploits |
| Peapods, 18 November | Deployer key minted PEAS on layer-2 networks, about 254 ETH taken, bounty deadline passed, no plan. Token only, no redemption value | The Industry Spread 21 November https://theindustryspread.com/peapods-deployer-key-minted-and-sold-peas/ |
| Cyber bridge 21 November, Ankr bridge 9 November, ACryptoS 8 November, zkLink Nova 28 October, Loopscale (Solana) 5 November, Fusionist (BNB) 22 November | Small (0.2 to 3.7M USD), no announced redemption or repayment plan with a price; nothing on mainnet to buy below a defined value | The Block 21 November https://www.theblock.co/news/defi/2026-11-21-cyber-investigating-suspected-1-million-bridge-exploit-as-upbit-bithumb-freeze-transfers-444810 ; registry read 27 November https://itokenly.com/hacks |
| GnosisDAO redemption (GIP-151) | Finished: window closed 17 July 2026; 92 holders redeemed about 111,000 GNO and 48,000 osGNO. GNO is 87.6 USD now, but no redemption right exists any more. Background only | Gnosis summary 18 November https://gnosisdao.ghost.io/gnosis-dao-community-summary-october-2026 |
| stUSDT wind-down | Rewards ended 14 November; redeem 1:1 for USDT at stusdt.io until 15 May 2027 06:59, then via support until August 2027. Only about 18,700 USD is left on Ethereum (8.4M on Tron) and the operator gives no reserve figures. Too small and opaque | Coindaro 15 November https://www.coindaro.com/stusdt-shutdown-redemption-deadline/ |
| Lazy Summer wind-down | About 369k USD of user funds and 165k of treasury; proposal stage (5 November). Too small | https://forum.summer.fi/t/rfc-orderly-wind-down-protocol-closure-final-distribution-governance-shutdown/932 |
| ZetaChain move to Solana | 1:1 conversion at a snapshot about 9 December; tokens in pools or wrapper contracts are treated differently. A risk for holders, no price gap | crypto.news 5 November https://crypto.news/zetachain-zeta-solana-migration-december-9 |
| Morpho stuck markets | Newly stuck in November: three unlisted Base markets (COPS, GUARD, PROOF against USDC), 25.3M USD each since 5 November, "unrecognized collateral". I could not find who is behind them; they look like private arrangements, not public lenders trapped. Older stuck mainnet markets (msY/USDC 21M since June, wstUSR/USDC 6.3M since April) are background. Morpho's realized bad debt in the week of 23 November: 0 | MorphoWatch read 27 November https://morphowatch.com/bad-debt ; Morpho data 26 November https://data.morpho.org/liquidations |
| Morpho EURCV vault | Largest depositor (84% of a 144M EURCV vault) could not exit in full on 26 November: 13.8M short. Liquidity note, no discount, issuer redemption limited to eligible EEA residents | CryptoSlate 27 November https://cryptoslate.com/morphos-largest-euro-stablecoin-vault-is-e13-8-million-short-of-covering-its-biggest-depositors-exit/ |
| Liquid staking and restaking depegs | No depeg event reported in November. The rsETH bridge exploit (April) was repaired by 26 May; a deficit of about 53,000 WETH on Aave is reported as still on the books in mid-November (single source). Staked ETH is at a record 36% of supply with a 16-day entry queue | https://hoge.gg/defi-lending-november-2026-crash-stress-test/ (24 November) |
| Stablecoin depegs | USDS held 1:1 through the run. One monitor shows FRAX at 0.987 to 0.994 for the whole month and a LUSD reading of 1.16 on 30 October; I could not confirm either with a second source or find a redemption route for FRAX. USDe low 0.9944 on 30 October, crvUSD low 0.9939 on 15 November: noise | DeFiStar read 27 November https://defistar.io/stablecoin-pegs.php |
| "Liquity V2 warning, 17M USD outflow" | Appears in November articles but refers to February 2025. Old | crypto.news 18 November (link above) |
| New points or incentive programmes | Nothing on mainnet with a fixed, calculable payout: Delpho points (Hyperliquid, 12 November, no token promised), Metric points, Pendle fixed USDe pools at 5.2 to 6.0% (10 November, no extra rewards). The 500,000 USDS incentive on the Curve USDS/stUSDS pool that November articles mention was announced in November 2025 for three months; I could not confirm a new programme | https://www.airdroptracker.io/airdrops/archive/2026-11 ; Sky on X 29 November 2025 https://x.com/SkyEcosystem/status/1994863064206733440 |
| Research on builders and searchers | Only general pieces (Titan and Quasar built 73% of MEV-Boost blocks in October; a paper on builders not honouring their own auctions). Nothing naming a specific under-contested auction beyond items 7 and 8 | https://blockchaindose.com/builder-searcher-collusion-pbs (20 November) |

## Limits of this report

- I did not open X directly; quotes from X come through news sites or search excerpts.
- The forum's "latest" list came back from a cache dated around 9 November, so a brand-new Sky thread from 27
  November could be missing. The vote figure is my own API read at 19:35.
- Balancer's current value per BAL, the SKY price at which the largest stUSDS borrower is under water, the Morpho
  liquidation discount and the Uniswap crossing time are my arithmetic, not source statements.
- Redemption rates for rsETH, osETH and Binance's staked ETH were not checked, so no discount is claimed for them.
