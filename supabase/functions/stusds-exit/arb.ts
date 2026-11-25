// Arb leg of the stUSDS exit bot: buy stUSDS below its redemption value and
// redeem it at Sky in the same transaction, through StUsdsArb (contracts/src).
//
// The arb never touches the owner's stUSDS and runs only after the owner's
// exit in the same bundle, so it only ever uses liquidity the exit left.
// Every run is simulated as part of its exact bundle first; anything that does
// not end in profit is never sent.

import {
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  keccak256,
  parseAbi,
  parseUnits,
  type PublicClient,
} from 'npm:viem@2.58.4'
import { ARB_CREATION_BYTECODE } from './arb-bytecode.ts'

export const ARB_CREATION_HASH = '0x96488b5b95e0585ab37832197589c3b72fd6383ffd61fb6d1a5d3d8e59e8e272'
export const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
export const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'
export const ST_USDS = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'
export const DAI_USDS = '0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A'
export const DSS_FLASH = '0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA'
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
export const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const KYBER = 'https://aggregator-api.kyberswap.com/ethereum/api/v1'
const KYBER_HEADERS = { 'x-client-id': 'stusds-exit-bot', 'content-type': 'application/json' }
const VAT = '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B'
const JUG = '0x19c0976f590D67707E62397C87829d896Dc0f1F1'
const RAY = 10n ** 27n

export const arbAbi = parseAbi([
  'constructor(address dai_, address usds_, address stUsds_, address daiUsds_, address flash_, address router_, address ethUsd_, address profitTo_, address keeper_)',
  'function arb((uint256 flash, bytes buyData, uint256 tipUsds, bytes tipData, uint256 minNet) p) returns (uint256 net)',
  'function keeper() view returns (address)',
  'function profitTo() view returns (address)',
])

export function arbDeployData(profitTo: Hex, keeper: Hex): Hex {
  if (keccak256(ARB_CREATION_BYTECODE as Hex) !== ARB_CREATION_HASH) throw new Error('arb bytecode does not match the tested build')
  return encodeDeployData({
    abi: arbAbi,
    bytecode: ARB_CREATION_BYTECODE as Hex,
    args: [DAI, USDS, ST_USDS, DAI_USDS, DSS_FLASH, KYBER_ROUTER, ETH_USD_FEED, profitTo, keeper],
  })
}

/**
 * The arb contract must be byte-for-byte what the tested build deploys with
 * exactly these constructor arguments (profit to the main wallet). The keeper
 * lives in storage and is checked separately.
 */
const verifiedArb = new Set<string>()
export async function verifyArb(client: PublicClient, address: Hex, profitTo: Hex, keeper: Hex) {
  const a = getAddress(address)
  if (verifiedArb.has(a)) return a
  const [code, expected, onchainKeeper, onchainProfitTo] = await Promise.all([
    client.getCode({ address: a }),
    client.call({ data: arbDeployData(profitTo, keeper) }).then((r) => r.data),
    client.readContract({ address: a, abi: arbAbi, functionName: 'keeper' }),
    client.readContract({ address: a, abi: arbAbi, functionName: 'profitTo' }),
  ])
  if (!code || code !== expected) throw new Error('arb contract is not the tested build')
  if (getAddress(onchainProfitTo) !== getAddress(profitTo)) throw new Error('arb contract pays someone else')
  if (getAddress(onchainKeeper) !== getAddress(keeper)) throw new Error('arb contract has another keeper')
  verifiedArb.add(a)
  return a
}

/** USDS withdrawable from stUSDS right now (same formula as the contract's own check). */
export async function availableUsds(client: PublicClient): Promise<bigint> {
  const ilk = '0x4c534556322d534b592d41000000000000000000000000000000000000000000'
  const [assets, ilkData, rate, clip] = await Promise.all([
    client.readContract({ address: ST_USDS, abi: parseAbi(['function totalAssets() view returns (uint256)']), functionName: 'totalAssets' }),
    client.readContract({ address: VAT, abi: parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), functionName: 'ilks', args: [ilk] }),
    // Jug.drip returns the rate with interest accrued to this block.
    client.simulateContract({ address: JUG, abi: parseAbi(['function drip(bytes32) returns (uint256)']), functionName: 'drip', args: [ilk] }).then((r) => r.result),
    client.readContract({ address: ST_USDS, abi: parseAbi(['function clip() view returns (address)']), functionName: 'clip' }),
  ])
  const due = await client.readContract({ address: clip, abi: parseAbi(['function Due() view returns (uint256)']), functionName: 'Due' })
  const debt = ilkData[0] * rate + due
  const total = assets * RAY
  return total > debt ? (total - debt) / RAY : 0n
}

/** KyberSwap's API turns away bursts with 403/429; wait a moment and ask again. */
async function kyberFetch(url: string, init: RequestInit): Promise<any> {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 350 : 1100))
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) })
      const text = await r.text()
      if (r.status === 403 || r.status === 429 || r.status >= 500) {
        last = `${r.status} ${text.slice(0, 80)}`
        continue
      }
      return JSON.parse(text)
    } catch (e) {
      last = String(e).slice(0, 80)
    }
  }
  throw new Error(`kyber unavailable: ${last}`)
}

async function kyberQuote(tokenIn: string, tokenOut: string, amountIn: bigint) {
  const j = await kyberFetch(`${KYBER}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: KYBER_HEADERS })
  if (!j?.data?.routeSummary) throw new Error(`kyber quote failed: ${JSON.stringify(j).slice(0, 120)}`)
  return j.data.routeSummary
}

async function kyberBuild(summary: unknown, arb: Hex, slippageBps: number) {
  const j = await kyberFetch(`${KYBER}/route/build`, {
    method: 'POST',
    headers: KYBER_HEADERS,
    body: JSON.stringify({ routeSummary: summary, sender: arb, recipient: arb, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 300, skipSimulateTx: true }),
  })
  if (j?.code !== 0 || !j?.data?.data) throw new Error(`kyber build failed: ${JSON.stringify(j).slice(0, 120)}`)
  if (getAddress(j.data.routerAddress) !== getAddress(KYBER_ROUTER)) throw new Error('kyber returned another router')
  return { data: j.data.data as Hex, amountOut: BigInt(j.data.amountOut) }
}

// Buy sizes whose prices bracket any opening. The collector (stusds-dash) refreshes this
// ladder every minute and the bot reads it from Postgres, so that at fire time only the
// chosen size has to be quoted: KyberSwap turns away bursts of requests.
export const LADDER = [5_000n, 20_000n, 60_000n, 150_000n, 350_000n, 750_000n]

export type Ladder = { nav: bigint; quotes: { amountIn: bigint; shares: bigint }[] }

/** Price the ladder now (fallback when the stored one is missing or old). One request at a time. */
export async function ladderQuotes(client: PublicClient): Promise<Ladder> {
  const nav = await client.readContract({ address: ST_USDS, abi: parseAbi(['function convertToAssets(uint256) view returns (uint256)']), functionName: 'convertToAssets', args: [10n ** 18n] })
  const quotes: Ladder['quotes'] = []
  for (const s of LADDER) {
    const amountIn = s * 10n ** 18n
    const q = await kyberQuote(USDS, ST_USDS, amountIn).catch(() => null)
    if (q) quotes.push({ amountIn, shares: BigInt(q.amountOut) })
  }
  return { nav, quotes }
}

/**
 * How much USDS to spend: the most profitable size whose redemption Sky can pay
 * in full. The ladder only brackets it, so a 39.9k opening is bid for as 39.9k
 * and not as the step below it. Pure arithmetic; the size is quoted afterwards.
 */
export function chooseSize(l: Ladder, availableWad: bigint): bigint | null {
  const value = (q: { shares: bigint }) => (q.shares * l.nav) / 10n ** 18n
  const cap = (availableWad * 990n) / 1000n
  const quotes = [...l.quotes].sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1))
  const fits = quotes.filter((q) => value(q) <= cap)
  const over = quotes.find((q) => value(q) > cap)
  let best: { amountIn: bigint; profit: bigint } | null = null
  for (const q of fits) {
    const profit = value(q) - q.amountIn
    if (profit > 0n && (!best || profit > best.profit)) best = { amountIn: q.amountIn, profit }
  }
  if (over) {
    // Below `over`, each USDS buys at least as many shares as at the lower step's
    // average price, so sizing with that price can only undershoot the cap.
    const lower = fits[fits.length - 1]
    const target = lower ? (cap * lower.amountIn) / value(lower) : (cap * over.amountIn * 97n) / (value(over) * 100n)
    const amountIn = (target / 10n ** 18n) * 10n ** 18n
    // Value it at the worse of the two neighbouring prices.
    const estValue = (amountIn * value(over)) / over.amountIn
    const profit = estValue - amountIn
    if (amountIn >= 500n * 10n ** 18n && profit > 0n && (!best || profit > best.profit)) best = { amountIn, profit }
  }
  return best ? best.amountIn : null
}

export type BundleSim = (raws: Hex[]) => Promise<{ ok: boolean; results: { error?: string; value?: string; gasUsed?: number }[]; raw?: unknown }>

const ARB_GAS_LIMIT = 4_200_000n // measured 2.1M without and 2.4M with the tip swap

/**
 * Plan, simulate and sign one arb run that follows `preceding` (already signed
 * transactions, e.g. a repayment and the owner's exit) in the same bundle.
 * One simulation only: the tip is set from the quoted profit, and the contract's
 * own minimum-profit check is the backstop.
 */
export async function planArb(opts: {
  arb: Hex
  availableWad: bigint // USDS left for the arb after everything in `preceding`
  ladder: Ladder // price ladder, at most a few minutes old
  preceding: Hex[]
  sign: (to: Hex, data: Hex, gas: bigint) => Promise<{ raw: Hex; hash: Hex }>
  simulate: BundleSim
  tipShare: number // share of the profit offered to the builder
  minNetUsds: number
}) {
  let amountIn = chooseSize(opts.ladder, opts.availableWad)
  if (amountIn === null) return { skipped: 'no profitable size' }
  // Quote exactly that size; if it turns out a touch too big for what Sky can pay, shrink once.
  let best: { amountIn: bigint; shares: bigint; summary: unknown; profit: bigint } | null = null
  for (let i = 0; i < 2 && !best; i++) {
    const q = await kyberQuote(USDS, ST_USDS, amountIn)
    const shares = BigInt(q.amountOut)
    const value = (shares * opts.ladder.nav) / 10n ** 18n
    if (value <= (opts.availableWad * 995n) / 1000n) best = { amountIn, shares, summary: q, profit: value - amountIn }
    else amountIn = (((amountIn * 97n) / 100n) / 10n ** 18n) * 10n ** 18n
  }
  if (!best) return { skipped: 'no size fits what Sky can pay out' }
  if (best.profit <= 0n) return { skipped: 'no profit at this size', buy_usds: formatUnits(best.amountIn, 18) }
  const floor = parseUnits(String(opts.minNetUsds), 18)
  const attempt = async (share: number) => {
    let tipUsds = (best.profit * BigInt(Math.round(share * 0.97 * 10_000))) / 10_000n
    if (tipUsds < 10n ** 18n) tipUsds = 0n
    if (best.profit - tipUsds < floor) return { skipped: 'profit below minimum', quoted_profit: formatUnits(best.profit, 18) }
    const [buy, tip] = await Promise.all([
      kyberBuild(best.summary, opts.arb, 100),
      // Loose router slippage on the tip swap: the contract itself rejects any rate below 97% of Chainlink.
      tipUsds > 0n ? kyberQuote(USDS, NATIVE, tipUsds).then((q) => kyberBuild(q, opts.arb, 300)) : Promise.resolve(null),
    ])
    // The buy may come in up to 1% short on shares; keep at least 70% of what is left after the tip.
    const keep = ((best.profit - tipUsds) * 70n) / 100n
    const minNet = keep > floor ? keep : floor
    const data = encodeFunctionData({ abi: arbAbi, functionName: 'arb', args: [{ flash: best.amountIn, buyData: buy.data, tipUsds, tipData: (tip?.data ?? '0x') as Hex, minNet }] })
    const signed = await opts.sign(opts.arb, data, ARB_GAS_LIMIT)
    const sim = await opts.simulate([...opts.preceding, signed.raw])
    const r = sim.results[opts.preceding.length]
    if (!r || r.error || !r.value) return { skipped: `simulation failed: ${r?.error ?? JSON.stringify(sim.raw ?? 'no result').slice(0, 160)}` }
    if (BigInt(r.gasUsed ?? 0) * 100n > ARB_GAS_LIMIT * 95n) return { skipped: 'run too close to its gas limit' }
    return {
      raw: signed.raw,
      hash: signed.hash,
      buy_usds: formatUnits(best.amountIn, 18),
      shares: formatUnits(best.shares, 18),
      quoted_profit: formatUnits(best.profit, 18),
      tip_usds: formatUnits(tipUsds, 18),
      net: formatUnits(BigInt(r.value), 18),
      gas_used: r.gasUsed,
    }
  }
  const first: any = await attempt(opts.tipShare)
  if (first.raw || first.skipped === 'profit below minimum') return first
  // One retry with a smaller tip, in case the quote was optimistic.
  const second: any = await attempt(opts.tipShare * 0.6)
  return second.raw ? { ...second, retried: first.skipped } : first
}

export { ARB_GAS_LIMIT }
