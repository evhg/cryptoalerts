# Redeemable tokens below redemption value, Ethereum mainnet

Screen run on 27 November 2026, 19:33 to 19:49 Bangkok time (UTC+7). Read-only: only `eth_call`-type requests and public price APIs; no transactions.

## Verdict

**No clean redemption arbitrage worth 10,000 USD or more for 1M USD of capital was found.** Liquid staking tokens, the large stablecoins, wrapped BTC and the MKR to SKY conversion are all within about 0.4% of redemption value, and where a discount exists it is roughly the time value of the exit queue or it sits behind a whitelist.

One item clears the 10,000 USD bar numerically, a Pendle PT (row 1). It is a fixed-rate credit position on a small issuer, not a mispricing, and I could not verify that an outsider can exit the underlying. The rest of the table are the nearest misses.

Legend: **M** = measured (source and time given), **E** = estimated. ETH = 1,719 USD, BTC = 61,468 USD (M, coins.llama.fi, 19:39).

## Ranked table

| # | Token | Discount to redemption value | Profit on 1M USD | Size before the gap is gone | Exit path, delay, fee, who | Annualized | Main risk |
|---|---|---|---|---|---|---|---|
| 1 | PT-sUSDfr 28 Jan 2027 (Forest Road), PT `0xdbd5fb715b833fbea448ab756f02c7617ecb97be` | 3.34% at 100k, 2.76% at 1M (M) | 28,400 USDfr (M) | About 1M to 1.5M (E); pool holds 3.34M PT (M) | Pendle PT redeems 1:1 into sUSDfr worth 1 USDfr at maturity, anyone, no PT fee; 61.5 days | 18.1% at 1M, 22.3% at 100k (M) | Priced credit risk: the underlying itself pays 16.9%. Exit of USDfr to USDC for outsiders not verified; DEX liquidity of sUSDfr is about 50k USD |
| 2 | PT-siUSD 7 Jan 2027 (infiniFi), PT `0x76543ac61ba84c6feeee76c6a918127bf0ca5fd1` | 0.91% at 100k, 0.88% at 1M (M) | 8,860 iUSD (M) | Several M (E); pool liquidity 21.8M USD (M) | PT redeems into siUSD worth 1 iUSD, anyone; 40.5 days | 8.3% (M), against 5.9% on siUSD itself | infiniFi credit and liquidity risk; iUSD to USDC exit not tested |
| 3 | PT-USD3 17 Dec 2026 (3Jane), PT `0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d` | 0.64% at 100k, 0.52% at 1M (M) | 5,240 USDC-equivalent (M) | About 1M to 2M (E) | PT redeems into USD3 worth 1 USDC, anyone; 19.5 days | 10.3% at 1M, 12.7% at 100k (M), against 7.4% on USD3 | Unsecured-credit vault; USD3 withdrawal terms not tested |
| 4 | LBTC `0x8236a87084f8B84306f72007F36F2618A5634494` | 0.38% against cbBTC (M) | About 3,500 USD (E) | 336k USD in the Uniswap v3 pool (M); the 8.4M USD v4 pool was not quoted | Lombard redemption to native BTC at the exchange rate, up to 10 days, fixed fee 0.0001 LBTC; direct users outside US/UK, address screening | About 14% in BTC terms (E) | You receive native BTC, so BTC price must be hedged and BTC brought back; rate comes from a covered-call strategy and can fall |
| 5 | frxETH `0x5E8422345238F34275888049021821E8E08CAa1f` | 0.34% at 100k, 0.19% at 1M (M) | About 2,500 USD (M) | Total extractable about 2.3 ETH, 4,000 USD, using 3.5M USD (M) | Frax redemption queue 1:1 into ETH, anyone, fee 0; queue length read as 30.0 days | About 4% (E) | Equals the time value of a 30-day queue at the staking rate. Not a finding |
| 6 | pumpBTC `0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e` | 3.5% at 10k, 2.2% at 100k, 1.0% at 300k (M) | About 3,000 USD at most (M) | 300k USD (M) | Unstake through the pumpBTC staking contract; delay, fee and whether it is open were not verified | Unknown | Thin pool with zero 24h volume; redemption not verified |
| 7 | apxUSD `0x98A878b1Cd98131B271883B390f68D2c90674665` | 1.9% under 1 USD at 100k, 0.75% at 1M on Curve (M) | None for outsiders | n/a | Redemption for whitelisted participants only, at a "redemption value" that follows the collateral, not at 1 USD (Apyx docs) | n/a | The discount is the market's view of the preferred-share collateral; outsiders cannot redeem |
| 8 | USDf `0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2` | 0.17% to 0.29% at 100k, 0.09% at 1M (M) | Under 1,000 USD (M) | Under 1M (M) | Falcon redemption: KYC accounts, 7-day cooldown (E, from memory, not re-verified) | n/a | Whitelist; gap too small |

## Notes per candidate

**1. PT-sUSDfr (Forest Road).** Pendle market `0x687dedecd5d2899ef497b3ff13af066ac3d152b0`, maturity 28 January 2027. On-chain quote through Pendle's static router (`swapExactSyForPtStatic`, block 26506642, 19:48): 100,000 USDfr of value buys 103,452 PT; 1,000,000 buys 1,028,384 PT. Pendle's API reports implied yield 23.7%, underlying yield 16.9%, pool liquidity 6.43M USD and only 1,100 USD of 24h volume (M, API, 19:47). So the PT pays about 7 points more than the token it redeems into, but the base rate of 17% already says the market treats USDfr as risky. Entry needs sUSDfr or USDfr: the only DEX pool found holds about 50,000 USD (DexScreener, 19:44), so 1M USD would have to be minted with the issuer. I did not verify who may mint or redeem USDfr. Confidence that this is a usable arbitrage: low.

**2. PT-siUSD (infiniFi).** Market `0xd44f2630260ff3805d7cb317d4f6740b0044c408`, maturity 7 January 2027. Static-router quote (block 26506639, 19:47): 1,000,000 buys 1,008,861 PT, 8.28% annualized; API underlying yield 5.9%. iUSD trades at 0.999 (M, llama). Just under the 10,000 USD bar, and the 2.4-point excess is a normal fixed-rate premium.

**3. PT-USD3 (3Jane).** Market `0x4a5067c3ff1abb7449244025b0e37feaf77d8e3e`, maturity 17 December 2026. Static-router quote (19:47): 1,000,000 buys 1,005,241 PT. Short and liquid (707k USD 24h volume), but 5,200 USD on 1M.

**4. LBTC.** Redemption value 1.006105 BTC per LBTC (M, `getRate()` on the token, block 26506598, 19:39). Uniswap v3 quoter on the LBTC/cbBTC 0.01% pool `0xBB0E3525d6d5E1a7Ecc627A82A44019B48cF84b3` (block 26506615, 19:43): 1.6 cbBTC buys 1.59643 LBTC, a price of 1.002237. Discount 0.38%. The same pool returns only 5.46 LBTC for 16 cbBTC, so its depth ends near 336k USD; DexScreener shows the v4 pool at the same price with 8.4M USD liquidity, not quoted directly. Redemption terms from Lombard's docs (updated 9 November 2026): up to 10 days, fee 0.0001 LBTC, not for US or UK persons. Ten days at the 2.5% target yield is worth 0.07%, so the discount is about five times the time value, but only about 3,500 USD per 1M per cycle before hedging and bringing BTC back. Confidence in the numbers: high. Worth it only as a repeated trade with a BTC hedge.

**5. frxETH.** Curve `get_dy` (block 26506630, 19:46): WETH/frxETH pool `0x9c3B46C0Ceb5B9e304FCd6D88Fc50f7DD24B31Bc` gives +0.344% for 58 ETH, +0.185% for 580 ETH, +0.105% for 1,200 ETH; stETH/frxETH pool `0x4d9f9D15101EEC665F77210cB999639f760F831E` gives +0.288%, +0.187%, +0.089%. Redemption queue `0x82bA8da44Cd5261762e629dd5c605b17715727bd` `redemptionQueueState()` returns queue length 2,591,136 seconds (30.0 days), redemption fee 0, early-exit fee 0.5% (M; field order assumed from the contract's known layout, E). A newer queue contract `0xfDC69e6BE352BD5644C438302DE4E311AAD5565b` also exists and I could not decode which is live.

**6. pumpBTC.** Curve pool `0xEA659B615b48EC6e2D55cD82FCBE5F43d79aeea0` `get_dy` (19:43): 0.16 WBTC at 0.9649, 1.6 WBTC at 0.9783, 5 WBTC at 0.9904. Supply about 28M USD.

**7. apxUSD and apyUSD.** Curve apxUSD/USDC `0x6F63deEDc9870D6c16FC644C6654748352cdc87c` (19:43): 100,000 USDC buys 101,941 apxUSD. apyUSD converts into 1.46518 apxUSD (M, `convertToAssets`, 19:45) and trades 0.8% below that at 100k and above it at 1M (M, Curve `0xe41be7B340f7c2EDA4DA1e99b42Ee1b228b526b7`); the unlock is open to anyone but takes 20 days at a fixed rate with a 0.1% fee (M, `unlockingFee()`; delay from Apyx docs), and 20 days of the forgone 14.7% yield is 0.8%. So the apyUSD discount is exactly its time value.

**8. USDf.** Curve USDf/USDC `0x72310DAAed61321b02B08A547150c07522c6a976`: 0.99708 at 100k; Uniswap v3 USDf/USDT `0xC275a7390966E4bcbf331B837cD7316C4A3EFa83`: 0.99833 at 100k, 0.99905 at 1M (M, 19:43). The 0.9957 shown by price APIs is not available in size.

## Screened and in line

Exchange rates read on-chain at block 26506598 (19:39 Bangkok). "Pool" = quote from the actual pool for about 100,000 USD; "API" = coins.llama.fi price against WETH, not confirmed by a pool quote (all API-only deviations are below the 0.5% confirmation threshold).

**Withdrawal queue (E):** Lido's own estimator (wq-api.lido.fi, 19:40) gives 2 days for up to 5,000 ETH, 3 days for 50,000 ETH, 9 days for 200,000 ETH. The validator exit queue is therefore short. I did not read the beacon chain directly. At a 2.4% staking rate (Pendle wstETH implied yield, M) two to nine days are worth 0.01% to 0.06%.

| Token | Redemption value (M) | Market against it | Source |
|---|---|---|---|
| stETH | 1 ETH | +0.002% (58 ETH), -0.001% (580 ETH) | Pool, Curve `0xDC24...7022` |
| wstETH | 1.250280 stETH | 0.000% | Pool, Uniswap v3 0.01% |
| rETH | 1.176508 ETH | 0.06% discount | Pool, Uniswap v3 0.01% |
| weETH | 1.109064 ETH | 0.06% discount | Pool, Curve `0xDB74...dEd5` |
| osETH | 1.083835 ETH | 0.05% premium against rETH | Pool, Curve osETH/rETH |
| cbETH | 1.145032 ETH | 0.05% premium | API |
| mETH | 1.103573 ETH | 0.24% premium | API |
| ETHx | 1.102497 ETH | 0.00% | API |
| LsETH | 1.122912 ETH | 0.08% premium | API |
| wBETH | 1.111631 ETH | 0.00% | API |
| ezETH | 1.090127 ETH (TVL / supply) | 0.31% discount | API |
| rsETH | 1.085302 ETH | 0.36% discount | API |
| sfrxETH | 1.175465 frxETH | 0.19% discount in ETH, mostly the frxETH leg | API |
| wOETH, tETH, rswETH | 1.174555, 1.260518, 1.083817 | within 0.06% | API |
| swETH, ankrETH, uniETH, pufETH | supply under 20M USD | 0.2% to 0.6% discount, thin pools | API, not pursued |

| Stablecoin or savings token | Redemption value (M) | Market | Note |
|---|---|---|---|
| USDC, DAI, USDS, USDe, RLUSD, PYUSD, USDtb, USDG, USD1, AUSD, frxUSD, fxUSD, iUSD, cUSD | 1 USD | 0.9997 to 1.0002 | API |
| USDT | 1 USD | 0.9987 | API; redemption for verified customers only |
| sUSDS 1.117796, sDAI 1.183495, scrvUSD 1.116227, syrupUSDC 1.195218, syrupUSDT 1.154714, sUSDf 1.143435 | in underlying | within 0.03% (sUSDf 0.4% under) | API |
| sUSDe 1.260434 USDe | | 0.03% under | API; `cooldownDuration()` reads 0, so redemption is currently instant |
| sfrxUSD 1.222671 frxUSD | | 0.01% under at 100k to 3M | Pool, Curve `0xF292...5978` |
| GHO, crvUSD, USD0 | 1 USD | 0.9984, 0.9980, 0.9986 to 0.9991 | API; within the fee or no open redemption |
| USD0++ (bUSD0) | 1 USD0 on 11 June 2028; early-exit floor 0.92 (M) | 0.9761 | 1.6% a year to maturity, below the risk-free rate |
| reUSD (Resupply) | redeemable against collateral at a fee of about 1% (E) | 0.9908 | at the fee |
| FRAX (legacy), DOLA, FDUSD, USDP, TUSD | no open redemption at 1 USD | 0.994, 0.995, 0.996, 0.997, 0.999 | API and pools agree |
| LUSD, BOLD | 1 USD of collateral less fee | 1.005, 1.003 (premium) | API |

| Other | Redemption value (M) | Market | Note |
|---|---|---|---|
| MKR to SKY | 24,000 SKY less 5% fee = 22,800 SKY (M, converter `0xA1Ea...3f9a`) | 22,965 SKY per MKR (DexScreener, Uniswap v4, 19:39) | MKR is 0.7% above conversion value; no gap |
| OCEAN to FET | 0.433226 FET = 0.056 USD (rate from memory, E) | 0.097 USD | far above; no gap |
| MATIC to POL | 1:1 | 0.0785 both | API |
| sENA | 1.018269 ENA, 7-day cooldown (M) | 0.06% discount for 107k USD | Pool, Uniswap v3 |
| stkAAVE | 1 AAVE | 0.05% to 0.1% discount | DexScreener |
| tBTC | 1 BTC less 0.2% treasury fee (M, bridge `redemptionParameters()`) | 0.9976 WBTC for 16 BTC | at the fee |
| WBTC, cbBTC, FBTC, solvBTC, uniBTC | 1 BTC | +0.15%, +0.04%, +0.2%, 0.0%, -0.1% against BTC | API; merchant or custodian redemption only |
| USDY, OUSG, BUIDL, USYC, USTB | fund NAV | no DEX liquidity above 20k USD | whitelist only |
| PAXG, XAUt | 1 oz gold | agree with each other within 0.05% | not compared with spot gold |
| Other Pendle PTs under 90 days (sUSDx, reUSD of re.xyz, strUSD, sUSDat, apyUSD) | 1 unit of accounting asset | 0.1% to 2.8% discount (M, static router) | implied yield within 0 to 4 points of the underlying yield; under 3,500 USD per 1M, or (apyUSD) below the underlying yield |

## Not covered

- Balancer pools and Uniswap v4 pools were not quoted directly (v4 prices are from DexScreener only).
- Distressed tokens with no verified open redemption were noted and left: deUSD (0 USD), USR (0.033 USD), msUSD of Metronome (0.81) and of Main Street (0.54), pmUSD (0.40), trUSD (0.978 in a 30k USD pool).
- Redemption access for USDfr, iUSD, USD3 and pumpBTC was not tested on-chain.
- Lending markets and vaults at full utilization are left to the other agent.

Scripts: `(session scratchpad)/hunt/redeemables/scripts/`. Downloaded data: `(session scratchpad)/hunt/redeemables/data/`.
