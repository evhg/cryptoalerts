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

async function kyberQuote(tokenIn: string, tokenOut: string, amountIn: bigint) {
  const r = await fetch(`${KYBER}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: KYBER_HEADERS, signal: AbortSignal.timeout(4000) })
  const j = await r.json()
  if (!j?.data?.routeSummary) throw new Error(`kyber quote failed: ${JSON.stringify(j).slice(0, 120)}`)
  return j.data.routeSummary
}

async function kyberBuild(summary: unknown, arb: Hex, slippageBps: number) {
  const r = await fetch(`${KYBER}/route/build`, {
    method: 'POST',
    headers: KYBER_HEADERS,
    body: JSON.stringify({ routeSummary: summary, sender: arb, recipient: arb, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 300, skipSimulateTx: true }),
    signal: AbortSignal.timeout(4000),
  })
  const j = await r.json()
  if (j?.code !== 0 || !j?.data?.data) throw new Error(`kyber build failed: ${JSON.stringify(j).slice(0, 120)}`)
  if (getAddress(j.data.routerAddress) !== getAddress(KYBER_ROUTER)) throw new Error('kyber returned another router')
  return { data: j.data.data as Hex, amountOut: BigInt(j.data.amountOut) }
}

const LADDER = [2_000n, 5_000n, 10_000n, 25_000n, 50_000n, 100_000n, 200_000n, 300_000n, 500_000n, 750_000n, 1_000_000n]

/** Pick the buy size with the most profit that Sky can still pay out in full. */
export async function sizeArb(client: PublicClient, availableWad: bigint) {
  const nav = await client.readContract({ address: ST_USDS, abi: parseAbi(['function convertToAssets(uint256) view returns (uint256)']), functionName: 'convertToAssets', args: [10n ** 18n] })
  const sizes = LADDER.map((s) => s * 10n ** 18n).filter((s) => s <= availableWad)
  if (!sizes.length) return null
  const quotes = await Promise.all(sizes.map((s) => kyberQuote(USDS, ST_USDS, s).then((q) => ({ s, q })).catch(() => null)))
  let best: { amountIn: bigint; shares: bigint; profit: bigint; summary: unknown } | null = null
  for (const x of quotes) {
    if (!x) continue
    const shares = BigInt(x.q.amountOut)
    const value = (shares * nav) / 10n ** 18n
    if (value > (availableWad * 995n) / 1000n) continue // Sky must be able to pay all of it, with margin
    const profit = value - x.s
    if (profit > 0n && (!best || profit > best.profit)) best = { amountIn: x.s, shares, profit, summary: x.q }
  }
  return best ? { ...best, nav } : null
}

export type BundleSim = (raws: Hex[]) => Promise<{ ok: boolean; results: { error?: string; value?: string; gasUsed?: number }[]; raw?: unknown }>

/**
 * Plan, simulate and sign one arb run that follows `preceding` (already signed
 * transactions, e.g. the Safe repayment and the main exit) in the same bundle.
 * Returns null when there is no profitable run.
 */
export async function planArb(opts: {
  client: PublicClient
  arb: Hex
  availableWad: bigint // USDS left for the arb after everything in `preceding`
  preceding: Hex[]
  sign: (to: Hex, data: Hex, gas: bigint) => Promise<{ raw: Hex; hash: Hex }>
  simulate: BundleSim
  tipShare: number // share of the profit offered to the builder
  minNetUsds: number
}) {
  const size = await sizeArb(opts.client, opts.availableWad)
  if (!size) return { skipped: 'no profitable size' }
  const buy = await kyberBuild(size.summary, opts.arb, 100)
  const plan = (tipUsds: bigint, tipData: Hex, minNet: bigint) =>
    encodeFunctionData({ abi: arbAbi, functionName: 'arb', args: [{ flash: size.amountIn, buyData: buy.data, tipUsds, tipData, minNet }] })

  // 1. Dry run without a tip: what does it really make, at the end of this exact bundle?
  const probe = await opts.sign(opts.arb, plan(0n, '0x', 0n), 3_000_000n)
  const sim1 = await opts.simulate([...opts.preceding, probe.raw])
  const r1 = sim1.results[sim1.results.length - 1]
  if (!sim1.ok || !r1 || r1.error || !r1.value) return { skipped: `simulation failed: ${r1?.error ?? 'no result'}`, size: formatUnits(size.amountIn, 18) }
  const net0 = BigInt(r1.value)
  const gasUsed = BigInt(r1.gasUsed ?? 2_000_000)

  // 2. Offer the builder a share of that profit, paid out of it inside the run.
  let tipUsds = (net0 * BigInt(Math.round(opts.tipShare * 10_000))) / 10_000n
  let tipData: Hex = '0x'
  if (tipUsds >= 10n ** 18n) {
    const q = await kyberQuote(USDS, NATIVE, tipUsds)
    // Loose router slippage: the contract itself rejects any rate below 97% of Chainlink.
    tipData = (await kyberBuild(q, opts.arb, 300)).data
  } else tipUsds = 0n
  const floor = parseUnits(String(opts.minNetUsds), 18)
  const keep = ((net0 - tipUsds) * 95n) / 100n
  const minNet = keep > floor ? keep : floor
  if (net0 - tipUsds < floor) return { skipped: 'profit below minimum', net0: formatUnits(net0, 18) }

  // 3. Final run, simulated once more exactly as it will be sent.
  // The dry run had no tip swap; leave room for it (gas is only paid for what is used).
  const gasLimit = ((gasUsed + (tipUsds > 0n ? 900_000n : 0n)) * 125n) / 100n + 100_000n
  const final = await opts.sign(opts.arb, plan(tipUsds, tipData, minNet), gasLimit)
  const sim2 = await opts.simulate([...opts.preceding, final.raw])
  const r2 = sim2.results[sim2.results.length - 1]
  if (!sim2.ok || !r2 || r2.error || !r2.value) return { skipped: `final simulation failed: ${r2?.error ?? 'no result'}` }
  if (BigInt(r2.gasUsed ?? 0) * 100n > gasLimit * 95n) return { skipped: 'final run too close to its gas limit' }
  return {
    raw: final.raw,
    hash: final.hash,
    buy_usds: formatUnits(size.amountIn, 18),
    shares: formatUnits(size.shares, 18),
    net_before_tip: formatUnits(net0, 18),
    tip_usds: formatUnits(tipUsds, 18),
    net: formatUnits(BigInt(r2.value), 18),
  }
}
