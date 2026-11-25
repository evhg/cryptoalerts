// stUSDS dashboard collector - Supabase edge function, run once a minute by pg_cron.
//
// Reads the state of stUSDS and of everything around it (rates, borrowers,
// prices, our wallets, the DEX discount), stores one snapshot and one history
// row, records new repayments / deposits / withdrawals and who took the freed
// liquidity, and decides which changes deserve a push notification.
//
// It also keeps the DEX price ladder the exit bot sizes its arb with.
// Read-only towards the chain: it holds no keys and sends no transactions.

import { createPublicClient, decodeEventLog, fallback, formatEther, formatUnits, getAddress, type Hex, http, parseAbi, parseAbiItem } from 'npm:viem@2.58.4'
import { mainnet } from 'npm:viem@2.58.4/chains'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const env = (k: string) => Deno.env.get(k) ?? ''
const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co']
const client = createPublicClient({ chain: mainnet, transport: fallback(RPCS.map((u) => http(u, { timeout: 6000 }))) })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const ST = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'
const ENGINE = '0xCe01C90dE7FD1bcFa39e237FE6D8D9F569e8A6a3', VAT = '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B', JUG = '0x19c0976f590D67707E62397C87829d896Dc0f1F1'
const RATE_SETTER = '0x30784615252B13E1DbE2bDf598627eaC297Bf4C5'
const ILK = '0x4c534556322d534b592d41000000000000000000000000000000000000000000'
const MAIN = '0xCD532243888D26791881064E24D4A25FD0041d98', MAIN_EXIT = '0xbF54F2AA78b4c240e34224073aff9E89Cd915897'
const TEST = '0x3A60B6AA75978CB265481A49fcfE0BD44eBDD04C', TEST_EXIT = '0x01662b082432859c366ab16362eab10fb72c73e6'
const KEEPER = '0x3C865A8F373544A6Abce380d68A4dEd7f8179BC9'
const ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const SKY_USDS_PAIR = '0x2621CC0B3F3c079c1Db0E80794AA24976F0b9e3c' // Uniswap V2 SKY/USDS
const SKY = '0x56072C95FAA701256059aa122697B133aDEd9279'
const CURVE_POOL = '0x2C7C98A3b1582D83c43987202aEFf638312478aE'
const SAFES: [string, Hex][] = [['rune.eth Safe (3-of-5)', '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d'], ['Safe 0xca51 (3-of-6)', '0xca5183FB9997046fbd9bA8113139bf5a5Af122A0']]
// The ten largest SKY-backed loans (97% of all debt on Nov 24) and who owns them.
const LOANS: [Hex, string][] = [
  ['0x3D25235b7c414cB67BF09561a33fd6CE62c11DCf', 'Safe 0xca51'],
  ['0x6A010b5eAE917D9e1D3B21e8129F8846F39C8c41', 'rune.eth Safe'],
  ['0x60AC29917Be15ca276ee8e6B168858d688A41b24', 'rune.eth Safe'],
  ['0xe1040ada443930CF3390f8484385079c3F4c8e05', 'rune.eth Safe'],
  ['0xf1ee47ea61007089D750417d193d00928526bf5b', '0x37EF…11ef'],
  ['0xC8F29e20270612815Cf596b5f138cb7A39108859', '0xC189…B1ca'],
  ['0x7Ef9c6bD6E749106b131F981cF041f5a61E0EA69', 'rune.eth Safe'],
  ['0x7Af90794F98eDe057c4fFB6b8480C016393F4907', '0x0A05…A464'],
  ['0x3A9D3a1f9b57b79ddde00B1597d3a67507c2de94', '0x5AB2…E131'],
  ['0xDFdb5d44F1C0B935c00e4fff6CbFd76C0dB7E97C', '0xb095…4E42'],
]
const KYBER = 'https://aggregator-api.kyberswap.com/ethereum/api/v1'
const LADDER = [5_000n, 20_000n, 60_000n, 150_000n, 350_000n, 750_000n]

const abi = parseAbi([
  'function totalAssets() view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)',
  'function str() view returns (uint256)', 'function cap() view returns (uint256)', 'function line() view returns (uint256)', 'function clip() view returns (address)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function Due() view returns (uint256)', 'function stopped() view returns (uint256)',
  'function toc() view returns (uint128)', 'function tau() view returns (uint64)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)',
  'function balances(uint256) view returns (uint256)', 'function nonce() view returns (uint256)',
])
const vatAbi = parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)', 'function urns(bytes32,address) view returns (uint256,uint256)'])
const jugAbi = parseAbi(['function ilks(bytes32) view returns (uint256,uint256)'])
const EV = {
  Wipe: parseAbiItem('event Wipe(address indexed owner, uint256 indexed index, uint256 wad)'),
  Draw: parseAbiItem('event Draw(address indexed owner, uint256 indexed index, address to, uint256 wad)'),
  Deposit: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
}
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

async function db(fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`db ${fn} ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const n18 = (x: bigint) => Number(formatUnits(x, 18))
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const RAY = 10n ** 27n
// Jug._rpow: x^n in ray, rounding half up at each step.
function rpow(x: bigint, n: bigint): bigint {
  let z = n % 2n === 0n ? RAY : x
  for (n = n / 2n; n > 0n; n = n / 2n) {
    x = (x * x + RAY / 2n) / RAY
    if (n % 2n === 1n) z = (z * x + RAY / 2n) / RAY
  }
  return z
}
// A per-second ray rate as a yearly percentage.
const apy = (ray: bigint) => round((Math.exp(Math.log(Number(ray) / 1e27) * 31_536_000) - 1) * 100, 2)
const money = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 })

// ETH a transaction handed straight to the block builder (how bundles pay), from a call trace.
type Frame = { to?: string; value?: string; calls?: Frame[] }
const paidTo = (f: Frame, builder: string): bigint =>
  (f.to?.toLowerCase() === builder && f.value ? BigInt(f.value) : 0n) + (f.calls ?? []).reduce((s, c) => s + paidTo(c, builder), 0n)
async function builderPayment(hash: string, builder: string): Promise<bigint | null> {
  try {
    const r = await fetch('https://eth.drpc.org', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] }),
    })
    const j = await r.json()
    return j?.result ? paidTo(j.result, builder.toLowerCase()) : null
  } catch {
    return null
  }
}

async function kyberShares(amountIn: bigint): Promise<bigint | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${KYBER}/routes?tokenIn=${USDS}&tokenOut=${ST}&amountIn=${amountIn}`, { headers: { 'x-client-id': 'stusds-dash' }, signal: AbortSignal.timeout(4000) })
      if (r.ok) {
        const j = await r.json()
        if (j?.data?.routeSummary?.amountOut) return BigInt(j.data.routeSummary.amountOut)
        return null
      }
    } catch { /* retry */ }
    await sleep(600)
  }
  return null
}

// Repayments, borrows, deposits and withdrawals in a block range, and who took the liquidity
// (one row per withdrawing transaction of 100 USDS or more, from block `takersFrom` on).
async function scan(fromBlock: bigint, toBlock: bigint, takersFrom: bigint) {
  const events: any[] = []
  const takers: any[] = []
  const [engineLogs, stLogs] = await Promise.all([
    client.getLogs({ address: ENGINE, events: [EV.Wipe, EV.Draw], fromBlock, toBlock }),
    client.getLogs({ address: ST, events: [EV.Deposit, EV.Withdraw], fromBlock, toBlock }),
  ])
  const blocks = new Map<bigint, Awaited<ReturnType<typeof client.getBlock>>>()
  const block = async (bn: bigint) => {
    if (!blocks.has(bn)) blocks.set(bn, await client.getBlock({ blockNumber: bn }))
    return blocks.get(bn)!
  }
  for (const l of [...engineLogs, ...stLogs] as any[]) {
    const amount = n18(l.args.wad ?? l.args.assets)
    if (amount < 1) continue
    const ts = new Date(Number((await block(l.blockNumber)).timestamp) * 1000).toISOString()
    events.push({ tx: l.transactionHash, log_index: l.logIndex, block: Number(l.blockNumber), block_ts: ts, kind: l.eventName, who: String(l.args.owner ?? l.args.sender).toLowerCase(), amount: round(amount, 2), txi: l.transactionIndex })
  }
  const sources = events.filter((e) => (e.kind === 'Wipe' || e.kind === 'Deposit') && e.amount >= 50)
  const byTx = new Map<string, any[]>()
  for (const e of events) if (e.kind === 'Withdraw' && e.amount >= 100 && BigInt(e.block) >= takersFrom) byTx.set(e.tx, [...(byTx.get(e.tx) ?? []), e])
  for (const [hash, ws] of byTx) {
    try {
      const [tx, rc, blk] = await Promise.all([client.getTransaction({ hash: hash as Hex }), client.getTransactionReceipt({ hash: hash as Hex }), block(BigInt(ws[0].block))])
      let boughtInTx = false
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== ST.toLowerCase()) continue
        try {
          const d = decodeEventLog({ abi: transferAbi, data: l.data, topics: l.topics })
          if (d.args.from !== '0x0000000000000000000000000000000000000000' && ws.some((w) => w.who === d.args.to.toLowerCase())) boughtInTx = true
        } catch { /* another event */ }
      }
      const sameTxSource = sources.some((e) => e.tx === hash)
      // The freed liquidity it took: the latest repayment or deposit before it, if that was at most 100 blocks earlier.
      const before = sources.filter((e) => e.tx !== hash && (e.block < ws[0].block || (e.block === ws[0].block && e.txi < ws[0].txi))).sort((a, b) => b.block - a.block)[0]
      const lag = sameTxSource ? 0 : before && ws[0].block - before.block <= 100 ? ws[0].block - before.block : null
      const kind = sameTxSource ? 'self' : boughtInTx ? 'arb' : 'holder'
      const prio = (rc.effectiveGasPrice - (blk.baseFeePerGas ?? 0n)) * rc.gasUsed
      const direct = kind === 'self' ? 0n : await builderPayment(hash, blk.miner)
      const to = (tx.to ?? '').toLowerCase()
      takers.push({
        tx: hash, block: ws[0].block, block_ts: ws[0].block_ts, tx_index: rc.transactionIndex, amount: round(ws.reduce((s, w) => s + w.amount, 0), 2), kind,
        entity: to === ST.toLowerCase() ? tx.from.toLowerCase() : to, tx_from: tx.from.toLowerCase(), tx_to: to,
        lag_blocks: lag, pay_eth: round(Number(formatEther(prio + (direct ?? 0n))), 6), traced: direct !== null,
      })
    } catch (e) {
      console.error('taker classify failed', hash, String(e).slice(0, 120))
    }
  }
  return { events, takers }
}

// Fills the tables for an older block range (used once, to load history from before the collector existed).
async function backfill(secret: string, from: bigint, to: bigint) {
  let events = 0, takers = 0
  for (let a = from; a <= to; a += 2000n) {
    const b = a + 1999n > to ? to : a + 1999n
    const r = await scan(a > 30n ? a - 30n : a, b, a)
    await db('stusds_dash_ingest', { p_secret: secret, p_now: null, p_events: r.events.map(({ txi: _txi, ...e }) => e), p_takers: r.takers, p_notices: [] })
    events += r.events.length
    takers += r.takers.length
  }
  console.log(`dash backfill ${from}-${to}: events ${events} takers ${takers}`)
  return { from: Number(from), to: Number(to), events, takers }
}

async function collect(secret: string, begin: any) {
  const started = Date.now()
  const head = await client.getBlock()
  const prev = begin.prev ?? null
  const cfg = begin.config ?? {}
  const clip = (prev?.clip as Hex | undefined) ?? (await client.readContract({ address: ST, abi, functionName: 'clip' }))

  const c = (address: Hex, functionName: string, args: unknown[] = []) => ({ address, abi, functionName, args } as any)
  const calls = [
    c(ST, 'totalAssets'), c(ST, 'convertToAssets', [10n ** 18n]), c(ST, 'str'), c(ST, 'cap'), c(ST, 'line'), // 0-4
    { address: VAT, abi: vatAbi, functionName: 'ilks', args: [ILK] }, { address: JUG, abi: jugAbi, functionName: 'ilks', args: [ILK] }, // 5-6
    c(clip, 'Due'), c(clip, 'stopped'), c(RATE_SETTER, 'toc'), c(RATE_SETTER, 'tau'), // 7-10
    c(ST, 'balanceOf', [MAIN]), c(USDS, 'balanceOf', [MAIN]), c(ST, 'allowance', [MAIN, MAIN_EXIT]), // 11-13
    c(ST, 'balanceOf', [TEST]), c(ST, 'allowance', [TEST, TEST_EXIT]), c(ST, 'balanceOf', [KEEPER]), // 14-16
    c(ETH_USD, 'latestRoundData'), c(SKY_USDS_PAIR, 'getReserves'), c(SKY_USDS_PAIR, 'token0'), // 17-19
    c(CURVE_POOL, 'balances', [0n]), c(CURVE_POOL, 'balances', [1n]), // 20-21
    c(SAFES[0][1], 'nonce'), c(SAFES[1][1], 'nonce'), // 22-23
    ...LOANS.map(([urn]) => ({ address: VAT, abi: vatAbi, functionName: 'urns', args: [ILK, urn] })), // 24..
  ]
  const [res, mainEth, keeperEth] = await Promise.all([
    client.multicall({ contracts: calls as any, allowFailure: true, blockNumber: head.number }),
    client.getBalance({ address: MAIN, blockNumber: head.number }),
    client.getBalance({ address: KEEPER, blockNumber: head.number }),
  ])
  const v = (i: number) => {
    if (res[i].status !== 'success') throw new Error(`read ${i} failed`)
    return res[i].result as any
  }
  const totalAssets: bigint = v(0), navWad: bigint = v(1), str: bigint = v(2), cap: bigint = v(3), line: bigint = v(4)
  const [art, rate, spot] = v(5) as bigint[]
  const [duty, rho] = v(6) as bigint[]
  const due: bigint = v(7)
  const rateNow = head.timestamp > rho ? (rpow(duty, head.timestamp - rho) * rate) / RAY : rate
  const debtRad = art * rateNow + due
  const availableWad = totalAssets * RAY > debtRad ? (totalAssets * RAY - debtRad) / RAY : 0n
  const util = Number((debtRad * 10n ** 8n) / (totalAssets * RAY)) / 1e6
  const ethUsd = Number((v(17) as any[])[1]) / 1e8
  const [r0, r1] = v(18) as bigint[]
  const skyIs0 = getAddress(v(19)) === getAddress(SKY)
  const skyUsd = skyIs0 ? Number(r1) / Number(r0) : Number(r0) / Number(r1)
  const skyOracle = (Number(spot) / 1e27) * 1.2 // the price loans are valued at (capped)
  const nav = n18(navWad)
  const mainShares: bigint = v(11)
  const mainValue = (n18(mainShares) * Number(navWad)) / 1e18
  const strPct = apy(str), dutyPct = apy(duty)

  const loans = LOANS.map(([urn, owner], i) => {
    const [ink, uart] = v(24 + i) as bigint[]
    const debt = n18((uart * rateNow) / RAY), sky = n18(ink)
    return {
      urn, owner, debt: round(debt, 0), sky: round(sky, 0),
      cover_pct: debt > 0 ? round((sky * skyUsd) / debt * 100, 0) : null, // collateral value / debt at the market price
      liq_price: debt > 0 ? round((debt * 1.2) / sky, 4) : null, // SKY price below which the loan is under the 120% line
      under_line: debt > 0 ? sky * Math.min(skyUsd, skyOracle) < debt * 1.2 : false,
    }
  }).filter((l) => l.debt > 0)

  // DEX price ladder for the bot's arb sizing, and the discount it implies. One request at a time.
  const quotes: { in: string; shares: string }[] = []
  for (const k of LADDER) {
    const shares = await kyberShares(k * 10n ** 18n)
    if (shares) quotes.push({ in: String(k * 10n ** 18n), shares: String(shares) })
    await sleep(150)
  }
  const prevLadder = prev?.dex_ladder
  const ladder = quotes.length >= 4 ? { at: new Date().toISOString(), nav: String(navWad), quotes } : prevLadder ?? null
  const px = (k: bigint) => {
    const q = (ladder?.quotes ?? []).find((x: any) => x.in === String(k * 10n ** 18n))
    return q ? Number(q.in) / Number(q.shares) : null
  }
  const profit = (k: bigint) => {
    const q = (ladder?.quotes ?? []).find((x: any) => x.in === String(k * 10n ** 18n))
    return q ? (Number(q.shares) / 1e18) * nav - Number(k) : null
  }
  const pxSmall = px(5_000n)

  // New events since the last run (with a short look-back so a taker can be matched to the repayment before it).
  const lastBlock = prev?.events_to ? BigInt(prev.events_to) : begin.last_event_block ? BigInt(begin.last_event_block) : head.number - 300n
  const fromBlock = lastBlock + 1n
  const toBlock = head.number - fromBlock > 3000n ? fromBlock + 3000n : head.number
  const notices: { key: string; title: string; body: string }[] = []
  const { events, takers } = toBlock >= fromBlock ? await scan(fromBlock - 30n, toBlock, fromBlock) : { events: [], takers: [] }
  for (const e of events) {
    if (BigInt(e.block) < fromBlock) continue
    const who = `${e.who.slice(0, 6)}\u2026${e.who.slice(-4)}`
    if (e.kind === 'Wipe' && e.amount >= 100_000) notices.push({ key: `wipe:${e.tx}:${e.log_index}`, title: `stUSDS: ${money(e.amount)} USDS repaid`, body: `Borrower ${who} repaid ${money(e.amount)} USDS in block ${e.block}. Withdrawable right now: ${money(n18(availableWad))} USDS.` })
    if (e.kind === 'Draw' && e.amount >= 100_000) notices.push({ key: `draw:${e.tx}:${e.log_index}`, title: `stUSDS: ${money(e.amount)} USDS newly borrowed`, body: `${who} borrowed ${money(e.amount)} USDS against SKY in block ${e.block}.` })
    if (e.kind === 'Deposit' && e.amount >= 250_000) notices.push({ key: `dep:${e.tx}:${e.log_index}`, title: `stUSDS: ${money(e.amount)} USDS deposited`, body: `${who} deposited ${money(e.amount)} USDS into stUSDS in block ${e.block}.` })
  }

  // Changes worth a push, compared with the previous snapshot.
  const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  if (prev) {
    if (Math.abs((prev.str_pct ?? strPct) - strPct) >= 0.02 || Math.abs((prev.duty_pct ?? dutyPct) - dutyPct) >= 0.02) {
      notices.push({ key: `rates:${head.number}`, title: 'stUSDS rates changed', body: `stUSDS rate ${prev.str_pct}% -> ${strPct}%, SKY borrow rate ${prev.duty_pct}% -> ${dutyPct}% a year.` })
    }
    if (prev.liquidations_stopped !== undefined && prev.liquidations_stopped !== Number(v(8))) {
      notices.push({ key: `clip:${head.number}`, title: 'SKY loan liquidations setting changed', body: `Liquidation switch went from ${prev.liquidations_stopped} to ${Number(v(8))} (0 = liquidations on, 3 = fully off).` })
    }
    const lineNow = Number(formatUnits(line, 45)), capNow = n18(cap)
    if (prev.debt_ceiling && (lineNow === 0 || Math.abs(lineNow - prev.debt_ceiling) / prev.debt_ceiling > 0.05)) {
      notices.push({ key: `line:${head.number}`, title: 'stUSDS borrowing limit changed', body: `Maximum SKY-backed borrowing went from ${money(prev.debt_ceiling)} to ${money(lineNow)} USDS.` })
    }
    if (prev.deposit_cap && (capNow === 0 || Math.abs(capNow - prev.deposit_cap) / prev.deposit_cap > 0.05)) {
      notices.push({ key: `cap:${head.number}`, title: 'stUSDS deposit cap changed', body: `Deposit cap went from ${money(prev.deposit_cap)} to ${money(capNow)} USDS.` })
    }
    for (const level of [0.035, 0.03, 0.025, 0.02]) {
      if (prev.sky_usd >= level && skyUsd < level) notices.push({ key: `sky:${level}:${day}`, title: `SKY fell below $${level}`, body: `SKY trades at $${skyUsd.toFixed(4)}. Loans are valued at no more than $${skyOracle.toFixed(4)}; lower prices thin the collateral behind stUSDS.` })
    }
    if (prev.main_shares !== undefined && Math.abs(prev.main_shares - n18(mainShares)) > 1) {
      notices.push({ key: `main:${head.number}`, title: 'Main wallet stUSDS balance changed', body: `From ${money(prev.main_shares)} to ${money(n18(mainShares))} stUSDS shares. Main wallet now holds ${money(n18(v(12)))} USDS.` })
    }
  }
  if (n18(keeperEth) < 0.01) notices.push({ key: `keeper_low:${day}`, title: 'stUSDS bot key is low on ETH', body: `Bot key holds ${n18(keeperEth).toFixed(4)} ETH. It needs ETH for gas and for the tip on a withdrawal.` })

  const now = {
    block: Number(head.number), block_ts: new Date(Number(head.timestamp) * 1000).toISOString(), clip,
    util_pct: round(util, 4), available: round(n18(availableWad), 2), total_assets: round(n18(totalAssets), 0), debt: round(Number(debtRad / RAY) / 1e18, 0),
    nav: round(nav, 6), str_pct: strPct, duty_pct: dutyPct, deposit_cap: round(n18(cap), 0), debt_ceiling: round(Number(formatUnits(line, 45)), 0),
    rates_last_set: new Date(Number(v(9)) * 1000).toISOString(), rates_next_change: new Date((Number(v(9)) + Number(v(10))) * 1000).toISOString(),
    liquidations_stopped: Number(v(8)),
    sky_usd: round(skyUsd, 5), sky_loan_price: round(skyOracle, 5), eth_usd: round(ethUsd, 2),
    dex_price: pxSmall ? round(pxSmall, 4) : null, dex_discount_pct: pxSmall ? round((1 - pxSmall / nav) * 100, 2) : null,
    arb_profit_150k: profit(150_000n) !== null ? round(profit(150_000n)!, 0) : null, arb_profit_750k: profit(750_000n) !== null ? round(profit(750_000n)!, 0) : null,
    curve_usds: round(n18(v(20)), 0), curve_stusds: round(n18(v(21)), 0),
    main_shares: round(n18(mainShares), 2), main_value: round(mainValue, 2), main_usds: round(n18(v(12)), 2), main_eth: round(n18(mainEth), 4),
    main_allowance: round(n18(v(13)), 2), main_armed: (v(13) as bigint) > 0n && cfg.target_name === 'main' && !!cfg.enabled,
    main_daily_yield: round(mainValue * (Math.pow(1 + strPct / 100, 1 / 365) - 1), 0),
    test_value: round((n18(v(14)) * Number(navWad)) / 1e18, 2), test_allowance_ok: (v(15) as bigint) > 0n,
    keeper_eth: round(n18(keeperEth), 4), keeper_stusds_value: round((n18(v(16)) * Number(navWad)) / 1e18, 2),
    bot_enabled: !!cfg.enabled, bot_target: cfg.target_name ?? null, arb_enabled: !!cfg.arb_enabled, mempool_enabled: !!cfg.mempool_enabled, safe_route: !!cfg.safe_route,
    fee_bps: Number(cfg.fee_bps ?? 10), arb_tip_share_safe: Number(cfg.arb_tip_share_safe ?? 0.3), arb_tip_share_race: Number(cfg.arb_tip_share_race ?? 0.85),
    safes: SAFES.map(([name, address], i) => ({ name, address, nonce: Number(v(22 + i)) })),
    loans, dex_ladder: ladder, events_to: Number(toBlock >= fromBlock ? toBlock : lastBlock), collect_ms: Date.now() - started,
  }
  const out = await db('stusds_dash_ingest', {
    p_secret: secret, p_now: now,
    p_events: events.map(({ txi: _txi, ...e }) => e), p_takers: takers, p_notices: notices,
  })
  console.log(`dash: block ${now.block} util ${now.util_pct}% events ${events.length} takers ${takers.length} notices ${notices.length} pushed ${out?.pushed ?? 0} in ${Date.now() - started} ms`)
  return { block: now.block, events: events.length, takers: takers.length, notices: notices.length, ms: Date.now() - started }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('not found', { status: 404 })
  const secret = req.headers.get('x-cron-secret') ?? ''
  if (!secret) return new Response('unauthorized', { status: 401 })
  const begin = await db('stusds_dash_begin', { p_secret: secret }).catch(() => null)
  if (!begin?.authorized) return new Response('unauthorized', { status: 401 })
  const body = await req.json().catch(() => ({}))
  if (body?.backfill) {
    const p = backfill(secret, BigInt(body.backfill.from), BigInt(body.backfill.to)).catch((e) => console.error('dash backfill failed', String(e)))
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p)
    return Response.json({ started: true })
  }
  if (body?.wait) {
    try {
      return Response.json(await collect(secret, begin))
    } catch (e) {
      return Response.json({ error: String(e).slice(0, 400) }, { status: 500 })
    }
  }
  const p = collect(secret, begin).catch((e) => console.error('dash collect failed', String(e)))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p)
  return Response.json({ started: true })
})
