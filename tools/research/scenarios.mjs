// Repayment scenarios on a mainnet fork at the current block, driving the real bot code.
// Usage: node scenarios.mjs [scenario ids...]
import { spawn } from 'node:child_process'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import {
  createPublicClient, http as vhttp, parseAbi, encodeFunctionData, formatUnits, formatEther, parseUnits, parseEther,
  keccak256, encodeAbiParameters, pad, toHex, concat, getAddress, stringToHex, encodePacked,
} from '../probe/node_modules/viem/_esm/index.js'
import { privateKeyToAccount, sign } from '../probe/node_modules/viem/_esm/accounts/index.js'
import { mainnet } from '../probe/node_modules/viem/_esm/chains/index.js'
import { parseTransaction as parseTx, formatEther as fmtEth } from '../probe/node_modules/viem/_esm/index.js'

const SP = '/tmp/claude-0/-home-user-cryptoalerts/f3bc1415-094c-5ea0-a057-91e8b18caa13/scratchpad'
const ANVIL = `${SP}/foundry/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil`
const DENO = `${SP}/probe/node_modules/@deno/linux-x64-glibc/deno`
const R = 'http://127.0.0.1:8545'
const ST = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'
const ENGINE = '0xCe01C90dE7FD1bcFa39e237FE6D8D9F569e8A6a3', VAT = '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B'
const MAIN = '0xCD532243888D26791881064E24D4A25FD0041d98'
const RUNE_SAFE = '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d', SAFE2 = '0xca5183FB9997046fbd9bA8113139bf5a5Af122A0'
const MULTISEND = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'
const USDS_JOIN = '0x3C0f895007CA717Aa01c8693e59DF1e8C3777FEB'
const HOLDER = '0x653107ab73641b7b15469d33a56a8c5abd9a8006' // a real holder with ~2M who races manually
const ZERO = '0x0000000000000000000000000000000000000000'
const ILK = stringToHex('LSEV2-SKY-A', { size: 32 })
const X = privateKeyToAccount('0x' + '11'.repeat(31) + '12') // stand-in Safe owner on the fork
const D = privateKeyToAccount('0x' + '22'.repeat(31) + '23') // a depositor / public repayer on the fork
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (wad, d = 2) => Number(formatUnits(wad, 18)).toLocaleString('en-US', { maximumFractionDigits: d })

// ---- mock of the Postgres RPC functions ----
const mock = { config: {}, keys: {}, safeBodies: {}, logs: [], notes: [], ladder: null }
http.createServer((req, res) => {
  let b = ''
  req.on('data', (d) => (b += d))
  req.on('end', () => {
    const a = b ? JSON.parse(b) : {}
    const fn = req.url.split('/').pop()
    let out = null
    if (fn === 'stusds_exit_begin') out = a.p_secret === 'local-secret' ? { authorized: true, config: mock.config, email_to: '', email_from: '', keeper_key: mock.keys.stusds_exit_keeper_key ?? null, test_owner_key: mock.keys.stusds_exit_test_owner_key ?? null, dex_ladder: mock.ladder ? { ...mock.ladder, at: new Date().toISOString() } : null } : { authorized: false }
    else if (fn === 'stusds_exit_race_result') { console.log('   race result reported:', a.p_won ? 'won' : 'lost', JSON.stringify(a.p_detail)); out = { authorized: true, tip_share: a.p_won ? 0.985 : 0.995 } }
    else if (fn === 'stusds_exit_store_key') { const created = !mock.keys[a.p_name]; if (created) mock.keys[a.p_name] = a.p_key; out = { ok: true, created } }
    else if (fn === 'stusds_exit_log') mock.logs.push({ action: a.p_action, detail: a.p_detail })
    else if (fn === 'stusds_exit_notify') mock.notes.push(`${a.p_title} | ${a.p_body}`)
    else if (fn === 'stusds_exit_safe_upsert') out = { authorized: true, events: [] }
    else if (fn === 'stusds_exit_safe_fetch') out = { authorized: true, status: 200, body: mock.safeBodies[getAddress(a.p_safe)] ?? { results: [] } }
    else if (fn === 'stusds_exit_claim') out = true
    else if (fn === 'stusds_exit_seen_hash') out = false
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(out))
  })
}).listen(54321)

const anvil = spawn(ANVIL, ['--fork-url', 'https://mainnet.gateway.tenderly.co', '--port', '8545', '--silent'], { stdio: 'ignore' })
const fn = spawn(DENO, ['run', '--node-modules-dir=none', '--allow-net', '--allow-env', '/home/user/cryptoalerts/supabase/functions/stusds-exit/index.ts'], {
  cwd: `${SP}/itest/denorun`, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DENO_NO_PACKAGE_JSON: '1', DENO_CERT: '/root/.ccr/ca-bundle.crt', DENO_DIR: `${SP}/denocache`, SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'x', EXIT_RPC_URLS: R, EXIT_LOCAL_SUBMIT: '1' },
})
let fnLog = ''
fn.stdout.on('data', (d) => (fnLog += d))
fn.stderr.on('data', (d) => (fnLog += d))
const stop = () => { try { anvil.kill() } catch {} try { fn.kill() } catch {} }
process.on('exit', stop)

const c = createPublicClient({ chain: mainnet, transport: vhttp(R, { timeout: 120_000 }) })
const rpc = async (method, params = []) => {
  const r = await fetch(R, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const act = async (body) => {
  const r = await fetch('http://127.0.0.1:8000', { method: 'POST', headers: { 'x-cron-secret': 'local-secret', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
  return r.json()
}
for (let i = 0; i < 180; i++) {
  try { await rpc('eth_blockNumber'); await fetch('http://127.0.0.1:8000'); break } catch { await sleep(1000) }
}

const tok = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)', 'function deposit(uint256,address) returns (uint256)', 'function withdraw(uint256,address,address) returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)', 'function maxWithdraw(address) view returns (uint256)'])
const eng = parseAbi(['function ownerUrns(address,uint256) view returns (address)', 'function wipe(address,uint256,uint256)', 'function wipeAll(address,uint256)'])
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)', 'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)'])
const bal = (t, a) => c.readContract({ address: t, abi: tok, functionName: 'balanceOf', args: [a] })
const setEth = (a, eth) => rpc('anvil_setBalance', [a, toHex(parseEther(String(eth)))])
async function as(from, to, data, gas = 1_500_000n, value = 0n) {
  await rpc('anvil_impersonateAccount', [from])
  const h = await rpc('eth_sendTransaction', [{ from, to, data, gas: toHex(gas), value: toHex(value) }])
  const rc = await c.waitForTransactionReceipt({ hash: h, timeout: 120_000, pollingInterval: 200 })
  if (rc.status !== 'success') throw new Error(`setup tx to ${to} reverted`)
  return rc
}
const mintUsds = async (to, wad) => { await setEth(USDS_JOIN, 1); await as(USDS_JOIN, USDS, encodeFunctionData({ abi: tok, functionName: 'mint', args: [to, wad] })) }
const available = async () => {
  const [ta, ilk, due] = await Promise.all([
    c.readContract({ address: ST, abi: parseAbi(['function totalAssets() view returns (uint256)']), functionName: 'totalAssets' }),
    c.readContract({ address: VAT, abi: parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), functionName: 'ilks', args: [ILK] }),
    c.readContract({ address: '0x836F56750517b1528B5078Cba4Ac4B94fBE4A399', abi: parseAbi(['function Due() view returns (uint256)']), functionName: 'Due' }),
  ])
  const debt = ilk[0] * ilk[1] + due
  return ta * 10n ** 27n > debt ? (ta * 10n ** 27n - debt) / 10n ** 27n : 0n
}

// ---- one-time setup ----
const head0 = await c.getBlock()
const ethPx = Number((await c.readContract({ address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', abi: parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']), functionName: 'latestRoundData' }))[1]) / 1e8
const nav = Number(formatUnits(await c.readContract({ address: ST, abi: tok, functionName: 'convertToAssets', args: [10n ** 18n] }), 18))
console.log(`fork at block ${head0.number}, base fee ${(Number(head0.baseFeePerGas) / 1e9).toFixed(3)} gwei, ETH $${ethPx.toFixed(0)}, stUSDS worth ${nav.toFixed(4)} USDS, withdrawable now ${fmt(await available())} USDS`)
const s0 = await act({ action: 'setup' })
const K = s0.keeper, T = s0.test_owner
await setEth(K, 2)
const mainExit = (await act({ action: 'deploy', target: 'main', floor_usds: '100', tip_wei_per_usds: '900000000000', max_tip_eth: '1' })).address
const testExit = (await act({ action: 'deploy', target: 'test', floor_usds: '5', tip_wei_per_usds: '20000000000000', max_tip_eth: '0.002' })).address
const arb = (await act({ action: 'deploy_arb' })).address
const arb2r = await act({ action: 'deploy_arb2' })
const arb2 = arb2r.address
const arb3 = (await act({ action: 'deploy_arb3' })).address
console.log('self-sizing arb contract on the fork:', arb3)
const arb4 = (await act({ action: 'deploy_arb4' })).address
const LEAN = process.env.LEAN !== '0'
console.log('lean arb contract on the fork:', arb4, LEAN ? '(in use, 0.04 ETH of tip money)' : '(not used in this run)')
console.log('direct arb contract on the fork:', arb2, 'deploy gas', arb2r.gas_used)
await setEth(MAIN, 1)
await as(MAIN, ST, encodeFunctionData({ abi: tok, functionName: 'transfer', args: [T, 100n * 10n ** 18n] }), 300_000n)
const mainShares = await bal(ST, MAIN)
await as(MAIN, ST, encodeFunctionData({ abi: tok, functionName: 'approve', args: [mainExit, mainShares] }), 300_000n)
mock.config = { helper_address: testExit, target_name: 'test', enabled: true }
await act({ action: 'approve_test' })
// Stand-in owner on rune.eth's Safe so the fork can produce "fully signed" repayments of any size.
const slot = (key, n) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, BigInt(n)]))
const SENT = '0x0000000000000000000000000000000000000001'
for (const SAFE of [RUNE_SAFE, SAFE2]) {
  const firstOwner = await rpc('eth_getStorageAt', [SAFE, slot(SENT, 2), 'latest'])
  await rpc('anvil_setStorageAt', [SAFE, slot(X.address, 2), firstOwner])
  await rpc('anvil_setStorageAt', [SAFE, slot(SENT, 2), pad(X.address)])
  await rpc('anvil_setStorageAt', [SAFE, toHex(3, { size: 32 }), toHex(BigInt(await rpc('eth_getStorageAt', [SAFE, toHex(3, { size: 32 }), 'latest'])) + 1n, { size: 32 })])
  await rpc('anvil_setStorageAt', [SAFE, toHex(4, { size: 32 }), toHex(1, { size: 32 })])
  if ((await c.readContract({ address: SAFE, abi: safeAbi, functionName: 'getThreshold' })) !== 1n) throw new Error('Safe override failed')
}
await setEth(X.address, 1); await setEth(D.address, 1); await setEth(HOLDER, 1)
// rune's loans
const loans = []
for (let i = 0; i < 8; i++) {
  const urn = await c.readContract({ address: ENGINE, abi: eng, functionName: 'ownerUrns', args: [RUNE_SAFE, BigInt(i)] }).catch(() => null)
  if (!urn || urn === ZERO) break
  const [, art] = await c.readContract({ address: VAT, abi: parseAbi(['function urns(bytes32,address) view returns (uint256,uint256)']), functionName: 'urns', args: [ILK, urn] })
  const [, rate] = await c.readContract({ address: VAT, abi: parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), functionName: 'ilks', args: [ILK] })
  loans.push({ index: i, debt: (art * rate) / 10n ** 27n })
}
console.log('rune.eth Safe loans:', loans.map((l) => `#${l.index} ${fmt(l.debt, 0)}`).join(', '))
const sffLoans = []
for (let i = 0; i < 8; i++) {
  const urn = await c.readContract({ address: ENGINE, abi: eng, functionName: 'ownerUrns', args: [SAFE2, BigInt(i)] }).catch(() => null)
  if (!urn || urn === ZERO) break
  const [, art] = await c.readContract({ address: VAT, abi: parseAbi(['function urns(bytes32,address) view returns (uint256,uint256)']), functionName: 'urns', args: [ILK, urn] })
  const [, rate] = await c.readContract({ address: VAT, abi: parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), functionName: 'ilks', args: [ILK] })
  sffLoans.push({ index: i, debt: (art * rate) / 10n ** 27n, urn })
}
console.log('foundation Safe loans:', sffLoans.map((l) => `#${l.index} ${fmt(l.debt, 0)} (${l.urn.slice(0, 8)})`).join(', '))
const sffLoan = sffLoans.reduce((a, b) => (b.debt > a.debt ? b : a))
const bigLoan = loans.reduce((a, b) => (b.debt > a.debt ? b : a))
const smallLoan = loans.filter((l) => l.debt > 10n ** 21n).reduce((a, b) => (b.debt < a.debt ? b : a))
const baseCfg = { enabled: true, function_url: '', trigger_min_usds: 20, min_assets_usds: 5, priority_gwei: 1, fee_bps: 10, fee_floor_usd: 1, safe_route: true, public_broadcast: false, watch_safe: `${RUNE_SAFE},${SAFE2}`, arb_address: arb, arb2_address: arb2, arb3_address: arb3, arb4_address: LEAN ? arb4 : null, arb_min_usds: 150, arb_quoter_address: arb2r.quoter, arb_enabled: true, arb_tip_share_buildernet: 0.999, arb_tip_share_safe: 0.3, arb_tip_share_race: 0.99, arb_min_net_usd: 2, mempool_enabled: true }
const cfgMain = { ...baseCfg, helper_address: mainExit, target_name: 'main' }
const cfgTest = { ...baseCfg, helper_address: testExit, target_name: 'test', fee_floor_usd: 3 }

// The price ladder the collector would have stored (one request at a time, as it does).
{
  const navWad = await c.readContract({ address: ST, abi: tok, functionName: 'convertToAssets', args: [10n ** 18n] })
  const quotes = []
  for (const k of [5_000n, 20_000n, 60_000n, 150_000n, 350_000n, 750_000n]) {
    const r = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${USDS}&tokenOut=${ST}&amountIn=${k * 10n ** 18n}`, { headers: { 'x-client-id': 'stusds-dash' } })
    const j = await r.json()
    if (j?.data?.routeSummary) quotes.push({ in: String(k * 10n ** 18n), shares: j.data.routeSummary.amountOut })
    await sleep(400)
  }
  mock.ladder = { nav: String(navWad), quotes }
  console.log('price ladder:', quotes.map((q) => `${Number(BigInt(q.in) / 10n ** 18n).toLocaleString()} -> ${(Number(q.in) / Number(q.shares)).toFixed(4)}`).join(', '))
}

// ---- building blocks ----
async function safeRepayTx({ wad, all, loan, safe = RUNE_SAFE, direct = false }) {
  const RUNE_SAFE = safe // everything below acts for the chosen Safe
  const amount = all ? loan.debt + loan.debt / 100n : wad // approve a little extra for interest when repaying everything
  await mintUsds(RUNE_SAFE, amount)
  const calls = [
    { to: USDS, data: encodeFunctionData({ abi: tok, functionName: 'approve', args: [ENGINE, amount] }), decoded: { method: 'approve', parameters: [] } },
    all
      ? { to: ENGINE, data: encodeFunctionData({ abi: eng, functionName: 'wipeAll', args: [RUNE_SAFE, BigInt(loan.index)] }), decoded: { method: 'wipeAll', parameters: [{ name: 'owner', value: RUNE_SAFE }, { name: 'index', value: String(loan.index) }] } }
      : { to: ENGINE, data: encodeFunctionData({ abi: eng, functionName: 'wipe', args: [RUNE_SAFE, BigInt(loan.index), wad] }), decoded: { method: 'wipe', parameters: [{ name: 'owner', value: RUNE_SAFE }, { name: 'index', value: String(loan.index) }, { name: 'wad', value: String(wad) }] } },
  ]
  if (direct) {
    // The approval was given in an earlier transaction; the queued one is a single plain call to the lending engine.
    await as(RUNE_SAFE, USDS, calls[0].data, 300_000n).catch(async () => { await setEth(RUNE_SAFE, 1); await as(RUNE_SAFE, USDS, calls[0].data, 300_000n) })
    const data = calls[1].data
    const nonce = await c.readContract({ address: RUNE_SAFE, abi: safeAbi, functionName: 'nonce' })
    const safeTxHash = await c.readContract({ address: RUNE_SAFE, abi: safeAbi, functionName: 'getTransactionHash', args: [ENGINE, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce] })
    const sig = await sign({ hash: safeTxHash, privateKey: '0x' + '11'.repeat(31) + '12' })
    const signature = concat([sig.r, sig.s, toHex(Number(sig.v ?? (sig.yParity ? 28n : 27n)), { size: 1 })])
    const api = {
      safe: RUNE_SAFE, to: ENGINE, value: '0', data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: Number(nonce), safeTxHash,
      submissionDate: new Date().toISOString(), isExecuted: false, confirmationsRequired: 1, confirmations: [{ owner: X.address, signature }],
      dataDecoded: calls[1].decoded,
    }
    const ownerSig = concat([pad(X.address), pad('0x00'), '0x01'])
    const execData = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [ENGINE, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, ownerSig] })
    const head = await c.getBlock()
    const publicRaw = await X.signTransaction({ chainId: 1, type: 'eip1559', to: RUNE_SAFE, data: execData, gas: 900_000n, nonce: await c.getTransactionCount({ address: X.address }), maxFeePerGas: head.baseFeePerGas * 2n + 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n })
    return { api, publicRaw }
  }
  const packed = concat(calls.map((x) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, x.to, 0n, BigInt((x.data.length - 2) / 2), x.data])))
  const data = encodeFunctionData({ abi: parseAbi(['function multiSend(bytes)']), functionName: 'multiSend', args: [packed] })
  const nonce = await c.readContract({ address: RUNE_SAFE, abi: safeAbi, functionName: 'nonce' })
  const safeTxHash = await c.readContract({ address: RUNE_SAFE, abi: safeAbi, functionName: 'getTransactionHash', args: [MULTISEND, 0n, data, 1, 0n, 0n, 0n, ZERO, ZERO, nonce] })
  const sig = await sign({ hash: safeTxHash, privateKey: '0x' + '11'.repeat(31) + '12' })
  const signature = concat([sig.r, sig.s, toHex(Number(sig.v ?? (sig.yParity ? 28n : 27n)), { size: 1 })])
  const api = {
    safe: RUNE_SAFE, to: MULTISEND, value: '0', data, operation: 1, safeTxGas: 0, baseGas: 0, gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: Number(nonce), safeTxHash,
    submissionDate: new Date().toISOString(), isExecuted: false, confirmationsRequired: 1, confirmations: [{ owner: X.address, signature }],
    dataDecoded: { method: 'multiSend', parameters: [{ name: 'transactions', valueDecoded: calls.map((x) => ({ to: x.to, dataDecoded: x.decoded })) }] },
  }
  // The same repayment as a public transaction sent by an owner (approved-hash signature of the sender).
  const ownerSig = concat([pad(X.address), pad('0x00'), '0x01'])
  const execData = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [MULTISEND, 0n, data, 1, 0n, 0n, 0n, ZERO, ZERO, ownerSig] })
  const head = await c.getBlock()
  const publicRaw = await X.signTransaction({ chainId: 1, type: 'eip1559', to: RUNE_SAFE, data: execData, gas: 900_000n, nonce: await c.getTransactionCount({ address: X.address }), maxFeePerGas: head.baseFeePerGas * 2n + 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n })
  return { api, publicRaw }
}
async function signedDeposit(wad) {
  await mintUsds(D.address, wad)
  const head = await c.getBlock()
  let nonce = await c.getTransactionCount({ address: D.address })
  const fees = { chainId: 1, type: 'eip1559', maxFeePerGas: head.baseFeePerGas * 2n + 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }
  const approve = await D.signTransaction({ ...fees, to: USDS, data: encodeFunctionData({ abi: tok, functionName: 'approve', args: [ST, wad] }), gas: 100_000n, nonce: nonce++ })
  const h = await rpc('eth_sendRawTransaction', [approve])
  await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 })
  return await D.signTransaction({ ...fees, to: ST, data: encodeFunctionData({ abi: tok, functionName: 'deposit', args: [wad, D.address] }), gas: 1_500_000n, nonce })
}

async function run(id, title, { cfg, botEth, prepare }) {
  const snap = await rpc('evm_snapshot')
  mock.config = { ...cfg }
  mock.safeBodies = {}
  mock.logs = []
  mock.notes = []
  await setEth(K, botEth)
  if (LEAN) await setEth(arb4, 0.04)
  const owner = cfg.target_name === 'main' ? MAIN : T
  const t0 = Date.now()
  let note = ''
  try {
    const before = { ownerUsds: await bal(USDS, owner), ownerShares: await bal(ST, owner), mainUsds: await bal(USDS, MAIN), keeper: await c.getBalance({ address: K }) }
    const steps = await prepare()
    for (const step of steps) await step()
    const after = { ownerUsds: await bal(USDS, owner), ownerShares: await bal(ST, owner), mainUsds: await bal(USDS, MAIN), keeper: await c.getBalance({ address: K }), left: await available() }
    const fired = mock.logs.filter((l) => l.action === 'fired')
    const nothing = mock.logs.filter((l) => l.action === 'nothing')
    const exitOut = after.ownerUsds - before.ownerUsds - (owner === MAIN ? fired.reduce((s, f) => s + (f.detail.arb?.net ? parseUnits(String(f.detail.arb.net), 18) : 0n), 0n) : 0n)
    const arbNet = fired.reduce((s, f) => s + (f.detail.arb?.net ? Number(f.detail.arb.net) : 0), 0)
    const arbTip = fired.reduce((s, f) => s + (f.detail.arb?.tip_usds ? Number(f.detail.arb.tip_usds) : 0), 0)
    const arbBuy = fired.map((f) => f.detail.arb?.buy_usds).filter(Boolean).map(Number)
    const exitTip = fired.reduce((s, f) => s + (f.detail.exit?.tip_eth ? Number(f.detail.exit.tip_eth) : 0), 0)
    const spent = Number(formatEther(before.keeper - after.keeper))
    const res = {
      id, title, target: cfg.target_name, bot_key_eth: botEth,
      exit_usds: Number(formatUnits(exitOut > 0n ? exitOut : 0n, 18)), shares_left: Number(formatUnits(after.ownerShares, 18)), position_left_usds: Number(formatUnits(after.ownerShares, 18)) * nav,
      exit_tip_eth: exitTip, exit_tip_usd: exitTip * ethPx,
      arb_buy_usds: arbBuy, arb_profit_to_main_usds: arbNet, arb_tip_to_builder_usds: arbTip,
      bot_key_eth_spent: spent, left_withdrawable_usds: Number(formatUnits(after.left, 18)),
      fired: fired.map((f) => ({ route: f.detail.route, ms: f.detail.ms, exit: f.detail.exit, arb: f.detail.arb })),
      nothing: nothing.map((f) => ({ route: f.detail.route, reason: f.detail.reason, exit: f.detail.exit, arb: f.detail.arb })),
      other_logs: mock.logs.filter((l) => !['fired', 'nothing', 'included', 'deployed', 'deployed_arb'].includes(l.action)).map((l) => `${l.action}: ${JSON.stringify(l.detail).slice(0, 200)}`),
      notes: mock.notes, seconds: Math.round((Date.now() - t0) / 1000),
    }
    results.push(res)
    console.log(`\n[${id}] ${title}`)
    console.log(`   exit: ${fmt(exitOut > 0n ? exitOut : 0n)} USDS to the ${cfg.target_name} wallet (position left ${res.position_left_usds.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDS), tip ${exitTip.toFixed(4)} ETH ($${(exitTip * ethPx).toFixed(0)})`)
    console.log(`   arb: bought ${arbBuy.map((x) => x.toLocaleString('en-US', { maximumFractionDigits: 0 })).join(' + ') || 'nothing'}; ${arbNet.toFixed(0)} USDS profit to main wallet, ${arbTip.toFixed(0)} USDS tip to builder`)
    console.log(`   bot key spent ${spent.toFixed(4)} ETH; still withdrawable afterwards ${fmt(after.left, 0)} USDS; ${res.seconds}s`)
    for (const f of res.fired) console.log(`   fired via ${f.route}: timings ${JSON.stringify(f.ms)}${f.exit?.skipped ? ` | exit skipped: ${f.exit.skipped}` : ''}${f.arb?.skipped ? ` | arb skipped: ${String(f.arb.skipped).slice(0, 140)}` : ''}${f.arb?.retried ? ` | arb retried after: ${String(f.arb.retried).slice(0, 100)}` : ''}${f.arb_direct ? ` | direct: ${f.arb_direct.skipped ? 'skipped: ' + String(f.arb_direct.skipped).slice(0, 120) : `buy ${Math.round(f.arb_direct.buy_usds)} profit ${Math.round(f.arb_direct.quoted_profit)} tip ${Math.round(f.arb_direct.tip_usds)} net ${Number(f.arb_direct.net).toFixed(2)} sizing ${f.arb_direct.sizing_ms}ms plan ${f.arb_direct.plan_ms}ms exact ${f.arb_direct.exact_quote} gas ${f.arb_direct.gas_used}`}` : ''}${f.arb_kyber ? ` | kyber: ${f.arb_kyber.skipped ? 'skipped: ' + String(f.arb_kyber.skipped).slice(0, 80) : `buy ${Math.round(f.arb_kyber.buy_usds)} tip ${Math.round(f.arb_kyber.tip_usds)} net ${Number(f.arb_kyber.net).toFixed(0)}`}` : ''}`)
    for (const f of res.nothing) console.log(`   nothing via ${f.route}: ${f.reason ?? ''} exit=${JSON.stringify(f.exit ?? '').slice(0, 160)} arb=${JSON.stringify(f.arb ?? '').slice(0, 160)}`)
    for (const l of res.other_logs) console.log('   log', l)
  } catch (e) {
    note = String(e).slice(0, 300)
    console.log(`\n[${id}] ${title}\n   HARNESS ERROR: ${note}`)
    results.push({ id, title, error: note })
  }
  await rpc('evm_revert', [snap])
  await sleep(9000)
}

const results = []
const tickOnce = () => act({ action: 'tick_once' })
const fire = async () => act({ action: 'fire', block: Number(await c.getBlockNumber()) })
const backrun = (raw) => act({ action: 'backrun_test', raw })
const e18 = (n) => BigInt(n) * 10n ** 18n

// Standing withdrawal: the bundles are handed to builders before anyone knows liquidity will appear. Then a stranger's
// deposit lands, and a builder includes the best-paying bundle that is valid behind it.
async function standingCase(id, usdsFreed, cfg = cfgMain) {
  await run(id, `${cfg === cfgMain ? 'Main wallet armed' : 'Today (nothing to withdraw)'}, standing bundles: ${usdsFreed.toLocaleString('en-US')} USDS appears from a transaction the bot never saw`, { cfg, botEth: 0.8, prepare: async () => [async () => {
    const t = await act({ action: 'standing_once' })
    console.log(`   ${t.tiers.length} standing bundles for a position of ${Math.round(Number(t.position_usds)).toLocaleString('en-US')} USDS; size classes from ${t.tiers.map((x) => Math.round(Number(x.min_usds)).toLocaleString('en-US')).join(' / ')} USDS up`)
    const dep = await signedDeposit(e18(usdsFreed))
    const h = await rpc('eth_sendRawTransaction', [dep]); await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 })
    const before = await bal(USDS, MAIN)
    let used = null
    for (const tier of t.tiers) { const tx = parseTx(tier.raw); try { await c.call({ account: K, to: tx.to, data: tx.data, value: tx.value }); used = tier; break } catch { } }
    const arbAfter = async (label) => {
      if (!t.arb) { console.log('   no standing arb configured'); return }
      const tx = parseTx(t.arb.normal.raw)
      const mb = await bal(USDS, MAIN)
      try { await c.call({ account: K, to: tx.to, data: tx.data, nonce: tx.nonce }) } catch (e) { console.log(`   standing arb ${label}: not valid (${String(e.shortMessage || e).slice(0, 90)}), so it is not included`); return }
      const ah = await rpc('eth_sendRawTransaction', [t.arb.normal.raw]); const arc = await c.waitForTransactionReceipt({ hash: ah, pollingInterval: 200 })
      console.log(`   standing arb ${label}: ${(Number((await bal(USDS, MAIN)) - mb) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDS profit to the main wallet at a ${(t.arb.normal.tip_share * 100).toFixed(1)}% builder share, gas ${arc.gasUsed}, status ${arc.status}, tip money left ${Number(formatEther(await c.getBalance({ address: tx.to }))).toFixed(5)} ETH; left withdrawable ${(Number(await available()) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDS`)
    }
    if (!used) { console.log('   no standing withdrawal is valid'); await arbAfter('alone'); return }
    const kb = await c.getBalance({ address: K })
    const hh = await rpc('eth_sendRawTransaction', [used.raw]); const rc = await c.waitForTransactionReceipt({ hash: hh, pollingInterval: 200 })
    const got = Number((await bal(USDS, MAIN)) - before) / 1e18
    const spent = Number(fmtEth(kb - (await c.getBalance({ address: K }))))
    console.log(`   landed class "at least ${Math.round(Number(used.min_usds)).toLocaleString('en-US')} USDS": ${got.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDS to the main wallet; bot key paid ${spent.toFixed(5)} ETH in tip and gas = $${(spent * ethPx).toFixed(2)} = ${(spent * ethPx / got * 100).toFixed(4)}% of the amount (status ${rc.status})`)
    await arbAfter('behind the withdrawal')
  }] })
}

// The always-in-the-block withdrawal: the builder includes it whatever happens; here the fork plays that builder.
async function alwaysCase(id, usdsFreed, cfg = cfgMain) {
  const owner = cfg.target_name === 'main' ? MAIN : T
  const what = usdsFreed ? usdsFreed.toLocaleString('en-US') + ' USDS appears from a transaction the bot never saw' : 'nothing new is withdrawable'
  const who = cfg === cfgMain ? 'main wallet armed' : 'test wallet'
  await run(id, 'Always-in-the-block withdrawal (' + who + '): ' + what, { cfg: { ...cfg, always_builders: 'quasar,eureka', always_arb: true }, botEth: 0.8, prepare: async () => [async () => {
    const t = await act({ action: 'standing_once' })
    const al = t.always
    console.log('   always bundle:', JSON.stringify({ to: al?.to, txs: al?.txs?.length ?? 0, skipped: al?.skipped ?? null }), '| withdrawable before:', fmt(await available(), 0))
    if (!al?.txs) return
    if (usdsFreed) { const dep = await signedDeposit(e18(usdsFreed)); const h = await rpc('eth_sendRawTransaction', [dep]); await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 }) }
    for (const [i, tx] of al.txs.entries()) {
      const kb = await c.getBalance({ address: K }), ob = await bal(USDS, owner), mb = await bal(USDS, MAIN)
      const h = await rpc('eth_sendRawTransaction', [tx.raw]); const rc = await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 })
      const spent = Number(fmtEth(kb - (await c.getBalance({ address: K }))))
      const gasCost = Number(fmtEth(rc.gasUsed * rc.effectiveGasPrice))
      const got = (Number((await bal(USDS, owner)) - ob) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })
      const gotMain = (Number((await bal(USDS, MAIN)) - mb) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })
      console.log('   ' + (i === 0 ? 'withdrawal' : 'arb') + ': status ' + rc.status + ', gas used ' + rc.gasUsed + ', gas cost ' + gasCost.toFixed(7) + ' ETH = $' + (gasCost * ethPx).toFixed(4) + ', bot key spent in all ' + spent.toFixed(6) + ' ETH = $' + (spent * ethPx).toFixed(2) + '; owner received ' + got + ' USDS, main wallet ' + gotMain + ' USDS')
    }
  }] })
}
const sffQueue = (t) => async () => { mock.safeBodies[getAddress(SAFE2)] = { results: [t.api] } }
const S = {
  S1: () => run('S1', "The 25M, bot key at today's 0.76 ETH: the foundation's Safe repays 25,000,000 on its largest loan, fully signed in its queue", { cfg: cfgMain, botEth: 0.7596, prepare: async () => { const t = await safeRepayTx({ wad: e18(25_000_000), loan: sffLoan, safe: SAFE2 }); return [sffQueue(t), tickOnce] } }),
  S2: () => run('S2', 'The 25M, bot key topped up to 1.06 ETH: same queued repayment', { cfg: cfgMain, botEth: 1.06, prepare: async () => { const t = await safeRepayTx({ wad: e18(25_000_001), loan: sffLoan, safe: SAFE2 }); return [sffQueue(t), tickOnce] } }),
  S3: () => run('S3', 'The 25M, bot key 1.06 ETH: the repayment is queued as one plain call to the lending engine (approval given earlier)', { cfg: cfgMain, botEth: 1.06, prepare: async () => { const t = await safeRepayTx({ wad: e18(25_000_000), loan: sffLoan, safe: SAFE2, direct: true }); return [sffQueue(t), tickOnce] } }),
  S4: () => run('S4', 'The 25M, bot key 1.06 ETH: the repayment is never queued and shows up in the public mempool', { cfg: cfgMain, botEth: 1.06, prepare: async () => { const t = await safeRepayTx({ wad: e18(25_000_000), loan: sffLoan, safe: SAFE2 }); return [() => backrun(t.publicRaw)] } }),
  S5: () => standingCase('S5', 25_000_000),
  X0: () => alwaysCase('X0', 0, cfgTest),
  X1: () => alwaysCase('X1', 0),
  X2: () => alwaysCase('X2', 33_380),
  X3: () => alwaysCase('X3', 25_000_000),
  X4: () => alwaysCase('X4', 300, cfgTest),
  S6: () => run('S6', 'The 25M, bot key 1.06 ETH: a rival gets the repayment into the block first and takes 1,900,000 right behind it; we only act on the next block', { cfg: cfgMain, botEth: 1.06, prepare: async () => { const t = await safeRepayTx({ wad: e18(25_000_002), loan: sffLoan, safe: SAFE2 }); return [async () => { const h = await rpc('eth_sendRawTransaction', [t.publicRaw]); const rc = await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 }); console.log('   repayment tx status', rc.status, 'gas', rc.gasUsed, '| withdrawable', fmt(await available(), 0), '| rival can withdraw', fmt(await c.readContract({ address: ST, abi: parseAbi(['function maxWithdraw(address) view returns (uint256)']), functionName: 'maxWithdraw', args: [HOLDER] }), 0)) }, async () => { const mw = await c.readContract({ address: ST, abi: parseAbi(['function maxWithdraw(address) view returns (uint256)']), functionName: 'maxWithdraw', args: [HOLDER] }); const take = mw < e18(1_900_000) ? mw * 99n / 100n : e18(1_900_000); console.log('   rival takes', fmt(take, 0)); await as(HOLDER, ST, encodeFunctionData({ abi: tok, functionName: 'withdraw', args: [take, HOLDER, HOLDER] })) }, fire] } }),
  A: () => run('A', "Today's setup (test wallet only): rune.eth's Safe repays 1,000,000, fully signed in its queue", { cfg: cfgTest, botEth: 0.032, prepare: async () => { const t = await safeRepayTx({ wad: e18(1_000_003), loan: bigLoan }); return [async () => { mock.safeBodies[getAddress(RUNE_SAFE)] = { results: [t.api] } }, tickOnce] } }),
  B: () => run('B', 'Main wallet armed: Safe repays 500,000 (less than the position)', { cfg: cfgMain, botEth: 0.75, prepare: async () => { const t = await safeRepayTx({ wad: e18(500_000), loan: bigLoan }); return [async () => { mock.safeBodies[getAddress(RUNE_SAFE)] = { results: [t.api] } }, tickOnce] } }),
  C: () => run('C', 'Main wallet armed: Safe repays 2,000,000', { cfg: cfgMain, botEth: 0.75, prepare: async () => { const t = await safeRepayTx({ wad: e18(2_000_000), loan: bigLoan }); return [async () => { mock.safeBodies[getAddress(RUNE_SAFE)] = { results: [t.api] } }, tickOnce] } }),
  D: () => run('D', `Main wallet armed: rune.eth repays one whole loan (${fmt(smallLoan.debt, 0)} USDS, "repay all")`, { cfg: cfgMain, botEth: 0.75, prepare: async () => { const t = await safeRepayTx({ all: true, loan: smallLoan }); return [async () => { mock.safeBodies[getAddress(RUNE_SAFE)] = { results: [t.api] } }, tickOnce] } }),
  E: () => run('E', 'Main wallet armed: a 40,000 repayment appears in the public mempool (like this morning)', { cfg: cfgMain, botEth: 0.75, prepare: async () => { const t = await safeRepayTx({ wad: e18(40_000), loan: bigLoan }); return [() => backrun(t.publicRaw)] } }),
  T1: () => run('T1', 'Live-test rehearsal, alone: the bot key deposits 300 USDS inside its own bundle, exit and arb follow', { cfg: { ...cfgTest, arb_min_usds: 150 }, botEth: 0.8, prepare: async () => { await mintUsds(K, e18(300)); return [async () => { console.log('   drill result', JSON.stringify(await act({ action: 'drill', usds: 300, mode: 'alone' })).slice(0, 300)) }] } }),
  T2: () => run('T2', 'Live-test rehearsal, public race: the same 300 USDS deposit, bid at the race share', { cfg: { ...cfgTest, arb_min_usds: 150, arb_tip_share_race: 0.995 }, botEth: 0.8, prepare: async () => { await mintUsds(K, e18(300)); return [async () => { console.log('   drill result', JSON.stringify(await act({ action: 'drill', usds: 300, mode: 'race' })).slice(0, 300)) }] } }),
  V1: () => standingCase('V1', 300, cfgTest),
  V2: () => standingCase('V2', 40_000, cfgTest),
  W1: () => standingCase('W1', 500_000),
  W2: () => standingCase('W2', 3_000_000),
  W3: () => standingCase('W3', 3_000),
  W4: () => standingCase('W4', 60),
  F: () => run('F', "Today's setup (test wallet only): the same public 40,000 repayment", { cfg: cfgTest, botEth: 0.032, prepare: async () => { const t = await safeRepayTx({ wad: e18(40_000), loan: bigLoan }); return [() => backrun(t.publicRaw)] } }),
  G: () => run('G', 'Main wallet armed: repayments drip in, three public deposits of 20,000 one after another', { cfg: cfgMain, botEth: 0.75, prepare: async () => [async () => backrun(await signedDeposit(e18(20_000))), async () => backrun(await signedDeposit(e18(20_000))), async () => backrun(await signedDeposit(e18(20_000)))] }),
  H: () => run('H', 'Main wallet armed: 300,000 is freed privately, a faster holder takes 250,000 in the same block, we see the rest at the end of the block', { cfg: cfgMain, botEth: 0.75, prepare: async () => { const raw = await signedDeposit(e18(300_000)); return [async () => { const h = await rpc('eth_sendRawTransaction', [raw]); await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 }) }, () => as(HOLDER, ST, encodeFunctionData({ abi: tok, functionName: 'withdraw', args: [e18(250_000), HOLDER, HOLDER] })), fire] } }),
  I: () => run('I', 'Main wallet armed: a tiny 300 USDS public deposit (fee policy check)', { cfg: cfgMain, botEth: 0.75, prepare: async () => [async () => backrun(await signedDeposit(e18(300)))] }),
  J: () => run('J', 'Main wallet armed, gas spikes to 40 gwei: 100,000 freed at the end of a block', { cfg: cfgMain, botEth: 0.75, prepare: async () => { const raw = await signedDeposit(e18(100_000)); return [async () => { const h = await rpc('eth_sendRawTransaction', [raw]); await c.waitForTransactionReceipt({ hash: h, pollingInterval: 200 }) }, async () => { await rpc('anvil_setNextBlockBaseFeePerGas', [toHex(40n * 10n ** 9n)]); await rpc('evm_mine') }, fire] } }),
  K: () => run('K', 'Main wallet armed but bot key left at 0.032 ETH: Safe repays 2,000,000', { cfg: cfgMain, botEth: 0.032, prepare: async () => { const t = await safeRepayTx({ wad: e18(2_000_001), loan: bigLoan }); return [async () => { mock.safeBodies[getAddress(RUNE_SAFE)] = { results: [t.api] } }, tickOnce] } }),
}
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(S)
for (const id of want) await S[id]()
writeFileSync(`${SP}/sim/results-${want.join('')}.json`, JSON.stringify({ block: Number(head0.number), ethPx, nav, results }, null, 1))
writeFileSync(`${SP}/sim/fn.log`, fnLog)
console.log('\ndone')
stop()
process.exit(0)
