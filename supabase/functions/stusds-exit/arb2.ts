// Direct-routing arb leg (StUsdsArb2, contracts/src/StUsdsArb2.sol).
//
// Buys stUSDS at the Curve stUSDS/USDS pool through its add-liquidity /
// remove-one-coin path (cheaper than a swap in a pool this lopsided), redeems
// at Sky, converts the builder's tip from USDS to ETH at Sky's USDC converter
// and Uniswap, and sends the rest to the main wallet.
//
// Everything is priced from on-chain reads, so planning needs no outside API
// and takes about a second: that is what a same-block race requires.

import { encodeDeployData, encodeFunctionData, formatUnits, getAddress, type Hex, keccak256, parseAbi, parseUnits, type PublicClient } from 'npm:viem@2.58.4'
import { ARB2_CREATION_BYTECODE, QUOTER_CREATION_BYTECODE } from './arb2-bytecode.ts'
import { type BundleSim, DAI, DAI_USDS, DSS_FLASH, ETH_USD_FEED, KYBER_ROUTER, ST_USDS, USDS } from './arb.ts'

export const ARB2_CREATION_HASH = '0xbd319199f97465ea4bbf075a2e7d878c167b84d3c15daabf0ee9e3683e42928d'
export const QUOTER_CREATION_HASH = '0xff6446276d8695360e34a66a18250a06f1aef6296f64f31fa2d39124511e34af'
export const CURVE_POOL = '0x2C7C98A3b1582D83c43987202aEFf638312478aE' // stUSDS/USDS, also its own LP token
export const PSM_USDS = '0xA188EEC8F81263234dA3622A406892F3D630f98c' // Sky's USDS <-> USDC converter, 1:1
export const SWAP_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' // Uniswap
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002' // Uniswap's marker for "keep it in the router"
export const ARB2_VENUES: Hex[] = [CURVE_POOL, PSM_USDS, SWAP_ROUTER02, KYBER_ROUTER]
const NONE = 2n ** 256n - 1n
export const ARB2_GAS_LIMIT = 2_000_000n // measured about 1.1M without and 1.4M with the tip

export const arb2Abi = parseAbi([
  'constructor(address dai_, address usds_, address stUsds_, address daiUsds_, address flash_, address ethUsd_, address profitTo_, address keeper_, address[] venues_)',
  'struct Step { address target; address token; uint256 amount; uint256 patch; bytes data; }',
  'struct Plan { uint256 flash; Step[] buy; uint256 tipUsds; Step[] tip; uint256 minNet; }',
  'function arb(Plan p) returns (uint256 net)',
  'function keeper() view returns (address)',
  'function profitTo() view returns (address)',
  'function venue(address) view returns (bool)',
])
const curveAbi = parseAbi([
  'function add_liquidity(uint256[] amounts, uint256 minMint) returns (uint256)',
  'function remove_liquidity_one_coin(uint256 burn, int128 i, uint256 minOut) returns (uint256)',
  'function calc_token_amount(uint256[] amounts, bool deposit) view returns (uint256)',
  'function calc_withdraw_one_coin(uint256 burn, int128 i) view returns (uint256)',
])
const psmAbi = parseAbi(['function buyGem(address usr, uint256 gemAmt) returns (uint256)'])
const routerAbi = parseAbi([
  'struct In { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(In params) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
])
const stAbi = parseAbi(['function convertToAssets(uint256) view returns (uint256)'])
const quoterAbi = parseAbi(['function quote(uint256[] amounts) returns (uint256[] poolTokens, uint256[] shares)'])

export function arb2DeployData(profitTo: Hex, keeper: Hex): Hex {
  if (keccak256(ARB2_CREATION_BYTECODE as Hex) !== ARB2_CREATION_HASH) throw new Error('arb2 bytecode does not match the tested build')
  return encodeDeployData({
    abi: arb2Abi,
    bytecode: ARB2_CREATION_BYTECODE as Hex,
    args: [DAI, USDS, ST_USDS, DAI_USDS, DSS_FLASH, ETH_USD_FEED, profitTo, keeper, ARB2_VENUES],
  })
}

/**
 * The contract must be byte-for-byte what the tested build deploys with exactly
 * these constructor arguments (profit to the main wallet), and its venue list
 * must be exactly the one above.
 */
const verified = new Set<string>()
export async function verifyArb2(client: PublicClient, address: Hex, profitTo: Hex, keeper: Hex) {
  const a = getAddress(address)
  if (verified.has(a)) return a
  const [code, expected, onchainKeeper, onchainProfitTo, ...venues] = await Promise.all([
    client.getCode({ address: a }),
    client.call({ data: arb2DeployData(profitTo, keeper) }).then((r) => r.data),
    client.readContract({ address: a, abi: arb2Abi, functionName: 'keeper' }),
    client.readContract({ address: a, abi: arb2Abi, functionName: 'profitTo' }),
    ...ARB2_VENUES.map((v) => client.readContract({ address: a, abi: arb2Abi, functionName: 'venue', args: [v] })),
  ])
  if (!code || code !== expected) throw new Error('arb2 contract is not the tested build')
  if (getAddress(onchainProfitTo) !== getAddress(profitTo)) throw new Error('arb2 contract pays someone else')
  if (getAddress(onchainKeeper) !== getAddress(keeper)) throw new Error('arb2 contract has another keeper')
  if (venues.some((v) => v !== true)) throw new Error('arb2 contract has another venue list')
  verified.add(a)
  return a
}

/** The exact-quote helper (contracts/src/StUsdsQuoter.sol): no constructor arguments, so its code is the same wherever it is deployed. */
export function quoterDeployData(): Hex {
  if (keccak256(QUOTER_CREATION_BYTECODE as Hex) !== QUOTER_CREATION_HASH) throw new Error('quoter bytecode does not match the tested build')
  return QUOTER_CREATION_BYTECODE as Hex
}
const verifiedQuoter = new Set<string>()
export async function verifyQuoter(client: PublicClient, address: Hex) {
  const a = getAddress(address)
  if (verifiedQuoter.has(a)) return a
  const [code, expected] = await Promise.all([client.getCode({ address: a }), client.call({ data: quoterDeployData() }).then((r) => r.data)])
  if (!code || code !== expected) throw new Error('quoter is not the tested build')
  verifiedQuoter.add(a)
  return a
}

/**
 * stUSDS shares that `amounts` of USDS buy through the pool's liquidity path, for several amounts at once.
 * With the quoter the answer is exact (it makes the purchase and undoes it); without it, the pool's own
 * estimate, which runs about 0.25% low.
 */
async function quoteShares(client: PublicClient, amounts: bigint[], quoter?: Hex): Promise<{ lp: bigint; shares: bigint }[]> {
  if (quoter) {
    const { result } = await client.simulateContract({ address: quoter, abi: quoterAbi, functionName: 'quote', args: [amounts], gas: 45_000_000n })
    return amounts.map((_, i) => ({ lp: result[0][i], shares: result[1][i] }))
  }
  const lps = await client.multicall({
    contracts: amounts.map((x) => ({ address: CURVE_POOL as Hex, abi: curveAbi, functionName: 'calc_token_amount', args: [[x, 0n], true] }) as const),
    allowFailure: true,
  })
  const outs = await client.multicall({
    contracts: lps.map((r) => ({ address: CURVE_POOL as Hex, abi: curveAbi, functionName: 'calc_withdraw_one_coin', args: [r.status === 'success' ? (r.result as bigint) : 0n, 1n] }) as const),
    allowFailure: true,
  })
  return amounts.map((_, i) => ({
    lp: lps[i].status === 'success' ? (lps[i].result as bigint) : 0n,
    shares: lps[i].status === 'success' && outs[i].status === 'success' ? (outs[i].result as bigint) : 0n,
  }))
}

const GRID = [50n, 100n, 200n, 300n, 400n, 500n, 600n, 700n, 800n, 860n, 900n, 930n, 960n, 980n, 1000n] // thousandths of the cap
const WAD = 10n ** 18n

/**
 * How much USDS to spend: the most profitable amount whose shares Sky can pay
 * out in full. Returns null when no size makes a profit.
 */
export async function sizeDirect(client: PublicClient, availableWad: bigint, quoter?: Hex, minBuyUsds = 500) {
  const nav = await client.readContract({ address: ST_USDS, abi: stAbi, functionName: 'convertToAssets', args: [WAD] })
  // What the bought shares redeem for must fit in what Sky can pay; a share costs less than it redeems for, so the spend does too.
  const cap = (availableWad * 999n) / 1000n
  const value = (shares: bigint) => (shares * nav) / WAD
  const minBuy = BigInt(Math.max(1, Math.round(minBuyUsds))) * WAD
  const xs = GRID.map((g) => (((cap * g) / 1000n) / WAD) * WAD).filter((x) => x >= minBuy)
  if (!xs.length) return null
  const grid = (await quoteShares(client, xs, quoter)).map((q, i) => ({ x: xs[i], ...q, value: value(q.shares) }))
  type Pick = { x: bigint; lp: bigint; shares: bigint; value: bigint }
  let best: Pick | null = null
  const consider = (q: Pick) => {
    if (q.shares === 0n || q.value > cap || q.value <= q.x) return
    if (!best || q.value - q.x > best.value - best.x) best = q
  }
  grid.forEach(consider)
  // Between the largest size that fits and the first that does not, aim for the cap itself.
  const fitsIdx = grid.reduce((k, q, i) => (q.shares > 0n && q.value <= cap ? i : k), -1)
  const over = grid[fitsIdx + 1]
  if (over && over.value > cap) {
    const a = fitsIdx >= 0 ? grid[fitsIdx] : { x: 0n, value: 0n }
    const target = a.x + ((cap - a.value) * (over.x - a.x)) / (over.value - a.value)
    // The value curve bends downward, so the straight line overshoots a little: try a few sizes just under it.
    const tries = [9998n, 9993n, 9985n, 9970n, 9940n, 9900n].map((k) => (((target * k) / 10000n) / WAD) * WAD).filter((x) => x > a.x && x >= minBuy)
    if (tries.length) (await quoteShares(client, tries, quoter)).forEach((q, i) => consider({ x: tries[i], ...q, value: value(q.shares) }))
  }
  const b = best as Pick | null
  return b ? { amountIn: b.x, lp: b.lp, shares: b.shares, profit: b.value - b.x, nav } : null
}

type Step = { target: Hex; token: Hex; amount: bigint; patch: bigint; data: Hex }
const ZERO = '0x0000000000000000000000000000000000000000' as Hex

export function buySteps(amountIn: bigint, lpQuoted: bigint): Step[] {
  return [
    // 0.5% under the quoted pool tokens: if the pool moved more than that, do not trade.
    { target: CURVE_POOL, token: USDS, amount: amountIn, patch: NONE, data: encodeFunctionData({ abi: curveAbi, functionName: 'add_liquidity', args: [[amountIn, 0n], (lpQuoted * 995n) / 1000n] }) },
    // Burn every pool token just received; the contract writes the amount into the first argument.
    { target: CURVE_POOL, token: CURVE_POOL, amount: NONE, patch: 4n, data: encodeFunctionData({ abi: curveAbi, functionName: 'remove_liquidity_one_coin', args: [0n, 1n, 0n] }) },
  ]
}

export function tipSteps(arb: Hex, tipUsds: bigint): Step[] {
  const gem = tipUsds / 10n ** 12n // USDC has 6 decimals
  const swap = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: ROUTER_ITSELF, amountIn: gem, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] })
  const unwrap = encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [0n, arb] })
  return [
    { target: PSM_USDS, token: USDS, amount: gem * 10n ** 12n, patch: NONE, data: encodeFunctionData({ abi: psmAbi, functionName: 'buyGem', args: [arb, gem] }) },
    // The contract itself refuses any conversion below 97% of the Chainlink price.
    { target: SWAP_ROUTER02, token: USDC, amount: gem, patch: NONE, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [[swap, unwrap]] }) },
  ]
}

/**
 * Plan, simulate and sign one direct arb run that follows `preceding` in the
 * same bundle. The builder is offered `tipShare` of the profit, but never so
 * much that less than `minNetUsds` would be left.
 */
export async function planDirect(opts: {
  client: PublicClient
  arb: Hex
  quoter?: Hex // exact-quote helper; without it sizing is a little conservative
  availableWad: bigint // USDS left for the arb after everything in `preceding`
  preceding: Hex[]
  sign: (to: Hex, data: Hex, gas: bigint) => Promise<{ raw: Hex; hash: Hex }>
  simulate: BundleSim
  tipShare: number
  minNetUsds: number
  minBuyUsds?: number
}) {
  const t0 = Date.now()
  const size = await sizeDirect(opts.client, opts.availableWad, opts.quoter, opts.minBuyUsds)
  const sizedMs = Date.now() - t0
  if (!size) return { skipped: 'no profitable size at the pool' }
  const floor = parseUnits(String(opts.minNetUsds), 18)
  if (size.profit <= floor) return { skipped: 'profit below minimum', quoted_profit: formatUnits(size.profit, 18), buy_usds: formatUnits(size.amountIn, 18) }
  let tipUsds = (size.profit * BigInt(Math.round(Math.min(Math.max(opts.tipShare, 0), 0.999) * 10_000))) / 10_000n
  if (size.profit - tipUsds < floor) tipUsds = size.profit - floor
  tipUsds = (tipUsds / 10n ** 12n) * 10n ** 12n
  if (tipUsds < WAD) tipUsds = 0n
  // The outcome is exact for the pool as quoted. If someone moves the pool first, any run that still nets a dollar may land.
  const keep = size.profit - tipUsds
  const minNet = keep / 2n > WAD ? WAD : keep / 2n
  const plan = { flash: size.amountIn, buy: buySteps(size.amountIn, size.lp), tipUsds, tip: tipUsds > 0n ? tipSteps(opts.arb, tipUsds) : [], minNet }
  const data = encodeFunctionData({ abi: arb2Abi, functionName: 'arb', args: [plan] })
  const signed = await opts.sign(opts.arb, data, ARB2_GAS_LIMIT)
  const sim = await opts.simulate([...opts.preceding, signed.raw])
  const r = sim.results[opts.preceding.length]
  if (!r || r.error || !r.value) return { skipped: `simulation failed: ${r?.error ?? JSON.stringify(sim.raw ?? 'no result').slice(0, 160)}`, buy_usds: formatUnits(size.amountIn, 18) }
  if (BigInt(r.gasUsed ?? 0) * 100n > ARB2_GAS_LIMIT * 95n) return { skipped: 'run too close to its gas limit' }
  return {
    raw: signed.raw,
    hash: signed.hash,
    venue: 'Curve pool, direct',
    buy_usds: formatUnits(size.amountIn, 18),
    shares: formatUnits(size.shares, 18),
    quoted_profit: formatUnits(size.profit, 18),
    tip_usds: formatUnits(tipUsds, 18),
    net: formatUnits(BigInt(r.value), 18),
    gas_used: r.gasUsed,
    plan_ms: Date.now() - t0,
    sizing_ms: sizedMs,
    exact_quote: !!opts.quoter,
  }
}
