// Census of everyone who took stUSDS liquidity since Nov 10: who, how, how fast, what they paid.
import { createPublicClient, http, parseAbiItem, formatUnits, decodeEventLog, parseAbi } from '../probe/node_modules/viem/_esm/index.js'
import { mainnet } from '../probe/node_modules/viem/_esm/chains/index.js'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'

const arch = createPublicClient({ chain: mainnet, transport: http('https://mainnet.gateway.tenderly.co', { timeout: 30000, retryCount: 3 }) })
const DRPC = 'https://eth.drpc.org'
const ENG = '0xCe01C90dE7FD1bcFa39e237FE6D8D9F569e8A6a3'.toLowerCase(), ST = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'.toLowerCase()
const FROM = BigInt(process.argv[2] || 26380000)
const head = await arch.getBlockNumber()
const E = {
  Wipe: parseAbiItem('event Wipe(address indexed owner, uint256 indexed index, uint256 wad)'),
  Draw: parseAbiItem('event Draw(address indexed owner, uint256 indexed index, address to, uint256 wad)'),
  Deposit: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
}
const cacheFile = new URL('./cache.json', import.meta.url)
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile)) : { logs: null, tx: {}, blk: {}, trace: {} }
const save = () => writeFileSync(cacheFile, JSON.stringify(cache))

if (!cache.logs || cache.logsTo < Number(head) - 50) {
  const rows = []
  for (const [name, ev] of Object.entries(E)) {
    const address = name === 'Wipe' || name === 'Draw' ? ENG : ST
    for (let f = FROM; f <= head; f += 5000n) {
      const t = f + 4999n > head ? head : f + 4999n
      const logs = await arch.getLogs({ address, event: ev, fromBlock: f, toBlock: t })
      for (const l of logs) rows.push({ name, block: Number(l.blockNumber), idx: l.logIndex, txi: l.transactionIndex, tx: l.transactionHash, who: (l.args.owner ?? l.args.sender).toLowerCase(), amt: Number(formatUnits(l.args.wad ?? l.args.assets, 18)) })
    }
  }
  rows.sort((a, b) => a.block - b.block || a.idx - b.idx)
  cache.logs = rows; cache.logsTo = Number(head); save()
}
const logs = cache.logs
const sources = logs.filter((l) => (l.name === 'Wipe' || l.name === 'Deposit') && l.amt >= 50)
const withdraws = logs.filter((l) => l.name === 'Withdraw' && l.amt >= 100)
console.error('logs', logs.length, 'withdraws>=100', withdraws.length, 'sources>=50', sources.length)

const tabi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const walk = (f, cb) => { let v = 0n; if (f.to && f.to.toLowerCase() === cb && f.value) v += BigInt(f.value); for (const s of f.calls || []) v += walk(s, cb); return v }
const byTx = new Map()
for (const w of withdraws) { if (!byTx.has(w.tx)) byTx.set(w.tx, []); byTx.get(w.tx).push(w) }
let n = 0
for (const [hash, ws] of byTx) {
  n++
  if (!cache.tx[hash]) {
    const [tx, rc] = await Promise.all([arch.getTransaction({ hash }), arch.getTransactionReceipt({ hash })])
    let sharesIn = 0
    for (const l of rc.logs) {
      if (l.address.toLowerCase() === ST) {
        try { const d = decodeEventLog({ abi: tabi, data: l.data, topics: l.topics }); if (d.args.from !== '0x0000000000000000000000000000000000000000' && ws.some((w) => w.who === d.args.to.toLowerCase())) sharesIn += Number(formatUnits(d.args.value, 18)) } catch { }
      }
    }
    cache.tx[hash] = { from: tx.from.toLowerCase(), to: (tx.to || '').toLowerCase(), sel: tx.input.slice(0, 10), gasUsed: Number(rc.gasUsed), egp: rc.effectiveGasPrice.toString(), sharesIn, nlogs: rc.logs.length, status: rc.status }
  }
  const b = ws[0].block
  if (!cache.blk[b]) { const blk = await arch.getBlock({ blockNumber: BigInt(b) }); cache.blk[b] = { ts: Number(blk.timestamp), miner: blk.miner.toLowerCase(), base: (blk.baseFeePerGas ?? 0n).toString(), ntx: blk.transactions.length } }
  if (cache.trace[hash] === undefined && b >= 26412000) { // scarcity era only
    try {
      const r = await fetch(DRPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] }), signal: AbortSignal.timeout(25000) })
      const j = await r.json()
      cache.trace[hash] = j.result ? walk(j.result, cache.blk[b].miner).toString() : null
    } catch { cache.trace[hash] = null }
  }
  if (n % 25 === 0) { save(); console.error('tx', n, '/', byTx.size) }
}
save()

// classify
const out = []
for (const [hash, ws] of byTx) {
  const t = cache.tx[hash], b = ws[0].block, blk = cache.blk[b]
  const amt = ws.reduce((s, w) => s + w.amt, 0)
  const sameTxSrc = sources.filter((s) => s.tx === hash).reduce((x, s) => x + s.amt, 0)
  const sameBlkSrc = sources.filter((s) => s.block === b && s.tx !== hash && s.txi < ws[0].txi)
  let lag = null, srcKind = null
  if (sameTxSrc > 0) { lag = 0; srcKind = 'same tx' }
  else if (sameBlkSrc.length) { lag = 0; srcKind = 'same block' }
  else { const prev = sources.filter((s) => s.block < b && s.block >= b - 50).pop(); if (prev) { lag = b - prev.block; srcKind = 'earlier block' } }
  const kind = sameTxSrc > 0 ? 'self (repay/deposit + withdraw in one tx)' : t.sharesIn > 0 ? 'arb (bought stUSDS in the same tx)' : 'holder (redeemed own shares)'
  const prio = (BigInt(t.egp) - BigInt(blk.base)) * BigInt(t.gasUsed)
  const direct = cache.trace[hash] ? BigInt(cache.trace[hash]) : 0n
  const entity = [ST, '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', '0x111111125421ca6dc452d289314280a0f8842a65', '0x9008d19f58aabd9ed0d60971565aa8510560ab41'].includes(t.to) ? t.from : t.to
  out.push({ hash, block: b, ts: blk.ts, day: new Date((blk.ts + 7 * 3600) * 1000).toISOString().slice(0, 10), txi: ws[0].txi, amt, kind, lag, srcKind, entity, from: t.from, to: t.to, sel: t.sel, payEth: Number(formatUnits(prio + direct, 18)), directEth: Number(formatUnits(direct, 18)), traced: cache.trace[hash] != null, miner: blk.miner })
}
out.sort((a, b) => a.block - b.block || a.txi - b.txi)
writeFileSync(new URL('./census.json', import.meta.url), JSON.stringify({ head: Number(head), from: Number(FROM), withdrawals: out, sources: sources.map((s) => ({ ...s, ts: cache.blk[s.block]?.ts })), logs }, null, 0))
console.log('done', out.length, 'withdraw txs')
