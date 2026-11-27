# Stuck-vault screen, Ethereum mainnet, 27 November 2026

All times are Bangkok time (UTC+7). On-chain reads were taken between 19:32 and 19:46 on 27 November 2026
(blocks 26506564 to 26506628). Read-only work: no transactions, no repository or database touched.

## Verdict

**No second stUSDS was found.** Nothing else on mainnet today combines (a) a clean, loss-free vault, (b) redemption
blocked only by utilization, and (c) a share token that can be bought on a DEX below redemption value in useful size.
Every DEX discount found outside stUSDS sits on top of a real loss or default. The nearest things are listed below,
ranked by how close they come to the shape.

Calibration: the method does find stUSDS. Curve pool `0x2C7C…78aE` quotes 1.0710 USDS per stUSDS for a 1,000 USD buy
against `convertToAssets` = 1.0955, a discount of 2.23%, with `maxRedeem(pool)` = 0 (measured, block 26506607, 19:41).
Two things the calibration showed about the method itself: stUSDS is **not** in DefiLlama `lendBorrow` (step 1 alone
misses it; the "base APY above 20%" list catches it at 50%), and the "underlying balance held by the vault" check is
misleading for it (the vault holds 158.6M USDS while nothing is withdrawable), so `maxRedeem`/`maxWithdraw` for a real
holder is the test that counts.

## Ranked candidates

| # | Candidate | Token | Size (USD) | Utilization / liquidity now | Redemption value vs DEX | DEX depth | Bad debt? | Fit |
|---|---|---|---|---|---|---|---|---|
| 1 | Morpho market USDC / stUSDS (86% LLTV), held through the vault "sky.money USDC Risk Capital" | vault `0x56bfa6f53669B836D1E0Dfa5e99706b12c373ecf` (not traded) | market 6.73M, vault 3.89M (measured) | 99.86%, 9,463 USDC available (measured, block 26506615) | No DEX market. Supply rate about 89% a year (Morpho API) | none | None today; real risk of it within weeks | High-rate branch only. A side-effect of stUSDS, not a new situation |
| 2 | Curve LlamaLend CRV-long vault | cvcrvUSD `0xcea18a8752bb7e7817f9ae7565328fe415c0f2ca` | 2.93M nominal (measured) | 100%, 0 crvUSD idle (measured, block 26506628) | 0.001251 vs 0.000725 crvUSD: **42.0% discount** (measured) | 250,000 USD in still leaves 28.5% (measured) | **Yes.** Backing at spot CRV is 76.0% (measured loans, spot price) | Distressed claim with a CRV-price option, not a par race |
| 3 | YieldNest ynETHx | `0x657d9aba1dbb59e53f9f3ecaa878447dcfc96dcb` | 4,209 WETH, about 7.2M | `maxRedeem` = 0, withdrawal buffer empty (measured, block 26506615) | 1.1011 vs 0.8895 WETH: **19.2% at 1,000 USD**, 4.2% at 100,000 USD (measured) | about 100,000 USD before the discount is under 4% | Probably yes, size unknown | Weak. Cause of the discount not verified |
| 4 | YieldNest ynRWAx (and ynUSDx) | `0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8` (`0x3db228fe836d99ccb25ec4dfdc80ed6d2cddcb4b`) | 9.24M nominal | `maxRedeem` = 0, 4,705 USDC idle (measured) | 1.0968 vs 0.6111 USDC: **44.3% at 500 USD**, 10.7% at 20,000 USD (measured) | about 20,000 USD | **Yes.** Underlying loan in default since August 2026 | Not an arbitrage |

Nothing in rows 2 to 4 pays par for certain. Row 1 pays a high rate but cannot be bought at a discount.

## Candidate notes

**1. Morpho USDC / stUSDS market, via "sky.money USDC Risk Capital".** Market id
`0xd570c19c0dc0fbe4ab7faf4a37c4150e1c141c8aada8ca3e1b4b6c1b712af93d`. Measured on Morpho Blue `market(id)` at block
26506615 (19:42): supply 6,726,072 USDC, borrow 6,716,609, available 9,463, utilization 99.859%. The vault (Morpho
vault v2, `totalAssets` 3,885,749 USDC, idle 0, measured) is entirely in this market. Borrow rate 89.3% a year and vault
net rate 89.1% (Morpho API fields `state.borrowApy`, `netApy`; DefiLlama still shows 62.1%, a lagging average). The
vault share has no DEX pair (DexScreener, measured). Why it is stuck: stUSDS holders who cannot redeem borrow USDC
against it instead; two borrowers hold 5.99M of the 6.72M (Morpho API `marketPositions`): one at 86.4% loan-to-value
with health factor 1.010, one at 82.7% with 1.055. The oracle values stUSDS at full redemption value (oracle `price()`
1.09538 against `convertToAssets` 1.09547, measured), while the market pays 2.2% less. Main risk: this is not bad debt
today, but the largest loan is 1% from liquidation and its debt grows faster than its collateral (89% against 50% a
year), which is roughly 16 days to the threshold if nothing changes (estimate). A liquidator would receive stUSDS that
cannot be redeemed and cannot be sold in that size (the Curve pool holds only about 140,000 USDS on the other side), so
liquidation may not happen and lenders would then carry the loss. Sister markets: USDT / stUSDS is 100% used (448,359
USDT, 27% a year, measured); USDS / stUSDS is at 90.3% with 113,833 USDS available (measured), so it is not stuck.
One angle relevant to the existing stUSDS work: liquidating the 3.0M loan when it crosses 86% would deliver stUSDS at
about 4.2% under redemption value (Morpho's liquidation bonus at 86% LLTV, estimate from the protocol formula), which
is a better price and far more size than the Curve pool offers. That needs USDC and a willingness to hold stUSDS.

**2. Curve LlamaLend CRV-long vault (cvcrvUSD).** Vault `0xcea1…f2ca`, controller `0xeda2…110a`. Measured at block
26506628 (19:45): `totalAssets` 2,926,873 crvUSD equals `total_debt`; crvUSD idle in the controller 0; `maxRedeem` of
the Curve pool's holding 0. Redemption value 0.0012505 crvUSD per share (`pricePerShare`); Curve pool "CRV LlamaLend
Recovery" `0x516C3eCfe45F0820653E08DD7c93633d71B93Cb5` (753,000 USD, measured by API) sells shares at 0.000725 for a
1,000 USD buy (42.0% discount), 0.000795 at 100,000 USD (36.4%) and 0.000894 at 250,000 USD (28.5%), all measured with
`get_dy`. Why it is stuck: bad debt from the CRV fall on 10 October 2025 (Curve governance forum, thread 11062). I read
all 64 loans (`loans`, `user_state`): 36 are underwater, owing 1,482,773 crvUSD against collateral worth 781,729 at CRV
0.1778 USD (52.7%); the 28 healthy loans owe 1,444,100. Recoverable value at spot is therefore 2,225,829 crvUSD, 76.0%
of nominal (measured loan data, spot price from DefiLlama; an estimate of value, since selling 12.5M CRV would move the
price). So the shares trade at 58% of nominal against roughly 76% backing. It is still not a stUSDS-style race: the
borrow rate has been set to practically zero (`rate()` = 2 wei per second, measured), so healthy borrowers have no
reason to repay; over the last 90 days only about 13,800 crvUSD came back and was redeemed (historical `total_debt` at
13 sampled blocks, idle was 0 at every one). The atomic route (buy shares, liquidate an underwater loan, redeem the
freed crvUSD) loses money today: the best-backed underwater loan of any size is 56.3% backed (334,630 debt) and shares
cost 58% or more. That route turns profitable if CRV rises. Main risk: the loss is real and grows if CRV falls; the
largest healthy loan (960,271 crvUSD, health 0.084) is close to liquidation. 24-hour volume in the pool is about 4 USD.
Confidence in the numbers: high. As an arbitrage: no. As a cheap option on CRV: possibly, outside this brief.

**3. YieldNest ynETHx.** Measured at block 26506608 (19:41): `totalAssets` 4,209.01 WETH, `convertToAssets` 1.101105
WETH per share, WETH idle in the vault 12.67, `maxRedeem`/`maxWithdraw` for the Curve pool 0, and the vault's buffer
(`buffer()` = `0x9a8b…61d8`, an MEV Capital WETH Morpho vault) gives the vault nothing to withdraw. Curve pool
`0xD65ed4BcE447195187f37cE7D82f56AdF1826F8F` (462,000 USD, of which 290 shares): 0.8895 WETH per share for 1,000 USD
(19.2% discount), 0.9415 at 10,000 (14.5%), 1.0251 at 50,000 (6.9%), 1.0553 at 100,000 (4.2%), 1.0807 at 250,000
(1.9%), all `get_dy`. The headline discount is a thin top of book; 24-hour volume is under 1 USD. Why it is stuck:
YieldNest's documentation says withdrawals pause when the buffer is depleted; its July 2026 report lists a strategy
that borrowed dollars against wstETH to deposit into ynRWAx, which has since defaulted (candidate 4). I could not
measure how much of ynETHx is exposed (the ynETHx contract itself holds no ynRWAx; the position would sit in a
sub-strategy), so the loss is unknown. Main risk: reported assets likely overstate what will be paid, and there is no
date for withdrawals. Confidence: low.

**4. YieldNest ynRWAx and ynUSDx.** ynRWAx measured at block 26506608: `totalAssets` 9,244,283 USDC, `convertToAssets`
1.096788, idle USDC 4,705, `maxRedeem` 0. Curve ynRWAx/USDC `0xf05Bc5C38a8F5E3D98c72f11bC59E713F8a32228` (33,000 USD):
0.6111 USDC for 500 USD (44.3% discount), 0.9020 at 10,000 (17.8%), 0.9792 at 20,000 (10.7%). ynUSDx (348,536 USDC,
`maxRedeem` 0) prices at about 0.61 USD through its scrvUSD pool (estimate, uses the API price of scrvUSD). Why it is
stuck: per YieldNest's governance forum, the borrowers behind ynRWAx have been behind on interest since 18 August 2026,
the loan was due on 20 October 2026 and was not repaid, the claim date of 20 November passed with no payout and no new
date; the share price on-chain has not been written down. This is a credit default, so the discount is the market's
loss estimate. Not an arbitrage. Confidence: high. One knock-on: Euler vault eUSDC-95 (1.2M USDC, 100% used) lends
against ynRWAx.

## Screened and ruled out

- **DefiLlama `lendBorrow` joined with `pools`** (344 Ethereum markets with supply of 1M USD or more): 9 at 97% or above.
  Five are Euler vaults (below; the on-chain scan added a sixth), three are Frankencoin positions (collateralized minting positions, not pooled lending,
  no receipt token), one is SparkLend USDC.
- **Euler v2, all 910 vaults read on-chain** (`cash`, `totalBorrows`, block 26506592, 19:38). Six with 250,000 USD or
  more are 100% used; none has a DEX pair, so none can be bought at a discount, and all look like bad debt:
  eUSDC-64 (14.39M USDC), eWBTC-9 (71.1 WBTC, 4.38M) and eWETH-33 (1,629 WETH, 2.80M) lend against Stream Finance
  xUSD / xBTC / xETH (collapsed November 2025), rate fixed near 0.2%; eUSDC-47 (3.82M, 60% borrow rate) lends against
  YU and PT-YU; eUSDC-58 (1.50M, 22%) against RZR; eUSDC-95 (1.20M, 0%, operations paused) against ynRWAx.
- **Morpho** (API, 214 Ethereum markets above 100,000 USD; 69 v1 and 113 v2 vaults of size): 28 markets at 97% or more
  or with bad debt. Apart from the stUSDS markets and one private EURCV market (4.96M, 2.3%), they are dead markets from
  the Elixir deUSD/sdeUSD, Resolv USR/RLP and similar failures, with borrow rates pinned at the cap and absurd dollar
  values in the API (ignore those). Stuck vaults checked on DexScreener, 25 addresses including MEV Capital Elixir USDC,
  Apostro Resolv USDC, Clearstar Yield USDC, Gauntlet USDC Frontier, Sentora PRIME (PYUSD, 131.7M, 2% liquid, 6.8%),
  Api3 dCOMP USDC, Apyx, Hyperithm USDC Apex, Mainstreet USDC and the two sky.money vaults: **no DEX pair for any**.
- **Aave v3 (Core, Prime, EtherFi, Horizon), SparkLend, Aave v2, Compound v2**, 169 reserves read on-chain (block
  26506624, 19:44): only Aave v2 AMPL (99.7%, a legacy frozen reserve, no pair), SparkLend USDC (98.0%, 33.5M, 662,000
  available, rate 4.3%: by design, no pair) and SparkLend USDT (95.2%, 14.6M available) exceed 95%.
- **Curve reverse screen**: every coin in the 288 Curve pools above 30,000 USD tested for ERC-4626 behaviour (36 vault
  tokens, 68 pool positions), comparing `maxRedeem(pool)` with the pool's balance and the price with redemption value.
  Beyond the candidates above: strUSD 0.2% under its trUSD value and fully redeemable (trUSD itself trades at 0.978, a
  different problem); apyUSD 0.8%, evaUSDC/evaUSDT 0.4 to 0.5%, sVUSD 0.5% (API prices, estimates); afCVX 2.7% in a
  39,000 USD position; pufETH redemption-limited (14.7% of one pool's holding) but trading at or above value; sfrxUSD,
  USD3 and sUSDx return `maxRedeem` 0 for the pool yet trade within 0.15%; sdeUSD is dead.
- **Near misses by utilization (90 to 97%)**: 18 markets, the largest SparkLend USDT; LlamaLend sDOLA 93.6% (10.2M);
  Flux DAI 92.4% and USDT 91.4%; Aave Horizon USDC 91.9% (9.4%). None blocked.
- **High base APY pools on DefiLlama** (above 15%, single asset): besides stUSDS and the sky.money vaults, these are
  yield products rather than utilization squeezes (Midas mM1USD 32%, yBOLD, ysyCRV, Accountable, Ensuro, Brix and
  others). Not checked individually.

## Not covered

Silo, Fluid, Gearbox, Compound v3 and Maple were screened only through DefiLlama (nothing at 97% or above), not
on-chain. Share tokens that trade only on Uniswap or Balancer were checked on DexScreener for the named candidates
only; there is no reverse screen for those venues as there is for Curve. Curve pools below 30,000 USD and pools missing
from the `big` list were skipped. Dollar sizes use DefiLlama spot prices.

## Files

- Scripts: `(session scratchpad)/hunt/vaults/scripts/`
- Downloaded data (untrusted, never executed): `(session scratchpad)/hunt/vaults/data/`
