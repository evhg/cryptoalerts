// stUSDS exit bot - Supabase edge function.
//
// Three ways to the liquidity, each building the same bundle: the owner's
// exit first (StUsdsExit, 1:1 at Sky, fee capped at 0.1%), then an arb on
// whatever is left (StUsdsArb, profit to the main wallet only):
//  - end of block: the block observer reports withdrawable USDS (`fire`);
//  - Safe route: a fully signed repayment in a big borrower's Safe queue,
//    executed by us with our transactions right behind it (`tick`);
//  - backrun: a public repayment or deposit seen while pending (`mempool`).
//
// Every route is a POST authenticated by the secret pg_cron/pg_net send
// (checked in Postgres). Keys are generated here, stored in Vault and never
// returned by any route.
//
// Safety properties this function relies on:
//  - The exit contract can only pay the owner it was deployed for, and the arb
//    contract only the main wallet, so a mistake here cannot send funds anywhere else.
//  - Both contracts are checked byte-for-byte against the tested builds before use.
//  - Everything goes to block builders as bundles, simulated first: a bundle
//    that would revert is not included and costs nothing.
//  - `sweep` can only send to MAIN_WALLET.

import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  fallback,
  formatEther,
  formatUnits,
  getAddress,
  type Hex,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  parseGwei,
  parseUnits,
  stringToBytes,
  toHex,
} from 'npm:viem@2.58.4'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'npm:viem@2.58.4/accounts'
import { mainnet } from 'npm:viem@2.58.4/chains'
import { EXIT_CREATION_BYTECODE } from './bytecode.ts'
import { arbDeployData, availableUsds, planArb, verifyArb } from './arb.ts'
import { freedBy, freedByExact } from './pending.ts'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const ST_USDS = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'
const LOCKSTAKE_ENGINE = '0xCe01C90dE7FD1bcFa39e237FE6D8D9F569e8A6a3'
// The only address `sweep` and a 'main' deployment can ever name.
const MAIN_WALLET = '0xCD532243888D26791881064E24D4A25FD0041d98'
const EXPECTED_CREATION_HASH = '0x8c9fd8b2762ee45ad4eb46fe6e1c3f36809bc4b92a135aaec22360e1dd1ad0ca'
// keccak256 of the deployed code with its two immutables (stUSDS, owner) zeroed,
// and the byte offsets where those immutables sit in the deployed code.
const EXPECTED_RUNTIME_HASH = '0x3606de2aa68df51213e3fadde7191abc95ce209ec7139944a19b533b02852e0b'
const STUSDS_OFFSETS = [265, 675, 1160, 1341]
const OWNER_OFFSETS = [361, 479, 628, 1118, 1290, 1475]

const exitAbi = parseAbi([
  'constructor(address stUsds_, address owner_, address keeper_, uint256 minAssetsFloor_, uint256 tipWeiPerUsds_, uint256 maxTipWei_)',
  'function exit(uint256 maxShares, uint256 minAssets) payable returns (uint256)',
  'function redeemable() view returns (uint256)',
  'function owner() view returns (address)',
  'function keeper() view returns (address)',
  'function minAssetsFloor() view returns (uint256)',
  'function tipWeiPerUsds() view returns (uint256)',
  'function maxTipWei() view returns (uint256)',
])
const safeAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
])
const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' // Chainlink ETH / USD
// Gas an exit actually uses (measured 232k-255k); used for fee budgeting only.
const EXIT_GAS_USED = 260_000n

const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
])

// Builders that take bundles from anyone, by recent share of blocks.
const BUILDERS = [
  { name: 'titan', url: 'https://rpc.titanbuilder.xyz', sign: false },
  { name: 'quasar', url: 'https://rpc.quasar.win', sign: true },
  { name: 'buildernet', url: 'https://rpc.buildernet.org', sign: true },
  { name: 'eureka', url: 'https://rpc.eurekabuilder.xyz', sign: true },
  { name: 'bombora', url: 'https://rpc.bombora.build', sign: false },
  { name: 'flashbots', url: 'https://relay.flashbots.net', sign: true },
  { name: 'beaver', url: 'https://rpc.beaverbuild.org/', sign: false },
]

const env = (k: string) => Deno.env.get(k) ?? ''

// Local fork testing only: EXIT_RPC_URLS points at a fork, and with
// EXIT_LOCAL_SUBMIT=1 the exit is submitted to that fork instead of to builders.
const RPC_URLS = (env('EXIT_RPC_URLS') ||
  'https://ethereum-rpc.publicnode.com,https://eth.drpc.org,https://mainnet.gateway.tenderly.co,https://rpc.mevblocker.io').split(',')
const LOCAL_SUBMIT = env('EXIT_LOCAL_SUBMIT') === '1'

const client = createPublicClient({
  chain: mainnet,
  transport: fallback(RPC_URLS.map((u) => http(u, { timeout: 4000 }))),
})
const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const usd = (wad: bigint) => Number(formatUnits(wad, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })

async function db(fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    signal: AbortSignal.timeout(6000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`db ${fn} ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

type Ctx = {
  secret: string
  config: any
  email_to: string
  email_from: string
  keeper?: PrivateKeyAccount
  testOwner?: PrivateKeyAccount
}

async function begin(secret: string): Promise<Ctx | null> {
  const b = await db('stusds_exit_begin', { p_secret: secret })
  if (!b?.authorized) return null
  return {
    secret,
    config: b.config ?? {},
    email_to: b.email_to,
    email_from: b.email_from,
    keeper: b.keeper_key ? privateKeyToAccount(b.keeper_key) : undefined,
    testOwner: b.test_owner_key ? privateKeyToAccount(b.test_owner_key) : undefined,
  }
}

const log = (ctx: Ctx, block: bigint | number | null, action: string, detail: unknown) =>
  db('stusds_exit_log', { p_secret: ctx.secret, p_block: block === null ? null : Number(block), p_action: action, p_detail: detail })
    .catch((e) => console.error('log failed', String(e)))

async function notify(ctx: Ctx, kind: string, title: string, body: string) {
  await db('stusds_exit_notify', { p_secret: ctx.secret, p_kind: kind, p_title: title, p_body: body }).catch((e) =>
    console.error('push failed', String(e))
  )
  await email(ctx, title, body)
}

async function email(ctx: Ctx, subject: string, text: string) {
  const key = env('RESEND_API_KEY')
  if (!key || !ctx.email_to) return
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: ctx.email_from, to: [ctx.email_to], subject, text }),
      signal: AbortSignal.timeout(6000),
    })
  } catch (e) {
    console.error('email failed', String(e))
  }
}

/**
 * The bot never calls, and never sends ETH to, an address just because the
 * config names it. The contract there must be byte-for-byte the tested build,
 * bound to stUSDS and to an owner this bot is allowed to serve. This closes
 * the "someone edits helper_address" route to the keeper's ETH.
 */
const verified = new Map<string, Hex>()
async function verifyHelper(ctx: Ctx): Promise<{ helper: Hex; owner: Hex }> {
  if (!ctx.config.helper_address) throw new Error('no helper configured')
  const helper = getAddress(ctx.config.helper_address)
  const cached = verified.get(helper)
  if (cached) return { helper, owner: cached }
  const code = await client.getCode({ address: helper })
  if (!code || code === '0x') throw new Error('helper has no code')
  let hex = code.slice(2)
  const word = (off: number) => hex.slice(off * 2, off * 2 + 64)
  const st = word(STUSDS_OFFSETS[0])
  const ow = word(OWNER_OFFSETS[0])
  if (STUSDS_OFFSETS.some((o) => word(o) !== st) || OWNER_OFFSETS.some((o) => word(o) !== ow)) throw new Error('helper code is not the tested build')
  for (const off of [...STUSDS_OFFSETS, ...OWNER_OFFSETS]) hex = hex.slice(0, off * 2) + '0'.repeat(64) + hex.slice(off * 2 + 64)
  if (keccak256(`0x${hex}`) !== EXPECTED_RUNTIME_HASH) throw new Error('helper code is not the tested build')
  if (getAddress(`0x${st.slice(24)}`) !== getAddress(ST_USDS)) throw new Error('helper is not bound to stUSDS')
  const owner = getAddress(`0x${ow.slice(24)}`)
  const allowed = [MAIN_WALLET, ctx.testOwner?.address].filter(Boolean).map((a) => getAddress(a as string))
  if (!allowed.includes(owner)) throw new Error('helper belongs to an owner this bot does not serve')
  verified.set(helper, owner)
  return { helper, owner }
}

// ---------- transactions ----------

type TxReq = { to?: Hex; data?: Hex; value?: bigint; gas: bigint }

async function signTx(account: PrivateKeyAccount, req: TxReq, priorityGwei: number, nonce?: number) {
  const [head, n] = await Promise.all([
    client.getBlock(),
    nonce === undefined ? client.getTransactionCount({ address: account.address, blockTag: 'pending' }) : Promise.resolve(nonce),
  ])
  const prio = parseGwei(String(priorityGwei))
  const maxFeePerGas = (head.baseFeePerGas ?? 0n) * 2n + prio
  const raw = await account.signTransaction({
    chainId: 1,
    type: 'eip1559',
    to: req.to,
    data: req.data,
    value: req.value ?? 0n,
    gas: req.gas,
    nonce: n,
    maxFeePerGas,
    maxPriorityFeePerGas: prio,
  })
  return { raw, hash: keccak256(raw), head, nonce: n, maxFeePerGas }
}

/** ETH an account needs to send a transaction with this gas limit at today's fees (as signTx prices it). */
async function gasBudget(gas: bigint) {
  const head = await client.getBlock()
  return gas * ((head.baseFeePerGas ?? 0n) * 2n + parseGwei('1.5'))
}

/** Make sure `to` can pay for a transaction of `gas`, topping it up from the keeper if not. */
async function ensureGas(ctx: Ctx, to: Hex, gas: bigint) {
  const need = await gasBudget(gas)
  const have = await client.getBalance({ address: to })
  if (have >= need) return
  await sendPublic(ctx.keeper!, { to, value: need - have + need / 10n, gas: 21_000n })
}

/** Ordinary public transaction (setup steps only - never used for the exit itself). */
async function sendPublic(account: PrivateKeyAccount, req: TxReq) {
  const { raw, hash } = await signTx(account, req, 1.5)
  await client.sendRawTransaction({ serializedTransaction: raw })
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 2000 })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return receipt
}

async function builderCall(b: (typeof BUILDERS)[number], signer: PrivateKeyAccount, method: string, params: unknown[], fullBody = false) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (b.sign) {
    // Flashbots-style: EIP-191 signature over the hex string of keccak256(body).
    headers['X-Flashbots-Signature'] = `${signer.address}:${await signer.signMessage({ message: keccak256(stringToBytes(body)) })}`
  }
  const started = Date.now()
  try {
    const res = await fetch(b.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(4000) })
    const text = await res.text()
    // Simulations need the whole reply; submissions only keep a short excerpt for the log.
    return { builder: b.name, status: res.status, ms: Date.now() - started, body: fullBody ? text : text.slice(0, 200) }
  } catch (e) {
    return { builder: b.name, error: String(e).slice(0, 120), ms: Date.now() - started }
  }
}

// Plain public-mempool nodes (MEV Blocker is deliberately not here: it is a private route).
const PUBLIC_MEMPOOL = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']

async function publicSend(url: string, raw: Hex) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
      signal: AbortSignal.timeout(4000),
    })
    return { builder: `mempool:${new URL(url).host}`, status: res.status, ms: Date.now() - started, body: (await res.text()).slice(0, 160) }
  } catch (e) {
    return { builder: `mempool:${new URL(url).host}`, error: String(e).slice(0, 120), ms: Date.now() - started }
  }
}

/** Send a transaction only as a bundle to builders (never the public mempool) and wait for it. */
async function sendPrivate(account: PrivateKeyAccount, req: TxReq, priorityGwei: number) {
  const { raw, hash, head } = await signTx(account, req, priorityGwei)
  const targets = [head.number + 1n, head.number + 2n, head.number + 3n]
  const sent = await Promise.all(
    BUILDERS.flatMap((b) => targets.map((t) => builderCall(b, account, 'eth_sendBundle', [{ txs: [raw], blockNumber: toHex(t) }]))),
  )
  for (let i = 0; i < 24; i++) {
    await sleep(2500)
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
    if (receipt) {
      if (receipt.status !== 'success') throw new Error(`private transaction ${hash} reverted`)
      return { receipt, sent }
    }
  }
  throw new Error(`private transaction ${hash} not included in blocks ${targets.join(', ')}: ${JSON.stringify(sent).slice(0, 300)}`)
}

async function buildExit(ctx: Ctx) {
  const cfg = ctx.config
  const keeper = ctx.keeper!
  const { helper } = await verifyHelper(ctx)
  const minAssets = parseUnits(String(cfg.min_assets_usds ?? 0), 18)
  const gas = 500_000n
  const [shares, balance] = await Promise.all([
    client.readContract({ address: helper, abi: exitAbi, functionName: 'redeemable' }),
    client.getBalance({ address: keeper.address }),
  ])
  const data = encodeFunctionData({ abi: exitAbi, functionName: 'exit', args: [maxUint256, minAssets] })
  return { keeper, helper, minAssets, gas, shares, balance, data }
}

async function ethUsd(chainNow: bigint): Promise<number> {
  const r = await client.readContract({
    address: ETH_USD_FEED,
    abi: parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']),
    functionName: 'latestRoundData',
  })
  if (Number(chainNow) - Number(r[3]) > 6 * 3600) throw new Error('ETH price feed is stale')
  return Number(r[1]) / 1e8
}

/**
 * Fee policy: everything one exit costs (network gas for the gas we use, at
 * base fee plus our priority fee, plus the builder tip) stays within fee_bps
 * of the USDS it withdraws (default 10 = 0.1%). fee_floor_usd lets very small
 * exits go through when gas is cheap. Returns the tip that fits in what is left.
 */
async function feePlan(cfg: any, expectedWad: bigint, gasUnits: bigint, keeperBalance: bigint, gasLimit: bigint) {
  const head = await client.getBlock()
  const price = await ethUsd(head.timestamp)
  const base = head.baseFeePerGas ?? 0n
  const prio = parseGwei(String(cfg.priority_gwei ?? 1))
  const valueUsd = Number(formatUnits(expectedWad, 18))
  const budgetUsd = Math.max((valueUsd * Number(cfg.fee_bps ?? 10)) / 10_000, Number(cfg.fee_floor_usd ?? 0))
  const gasUsd = Number(formatEther(gasUnits * (base + prio))) * price
  const plan = { price, valueUsd, budgetUsd, gasUsd, tipWei: 0n, ok: gasUsd <= budgetUsd, reason: '' }
  if (!plan.ok) {
    plan.reason = `gas $${gasUsd.toFixed(2)} exceeds the fee budget $${budgetUsd.toFixed(2)}`
    return plan
  }
  let tip = parseEther(((budgetUsd - gasUsd) / price).toFixed(18))
  // The keeper must still be able to pay the worst-case gas of the transactions it signs.
  const reserve = gasLimit * (base * 2n + prio)
  if (keeperBalance <= reserve) {
    plan.ok = false
    plan.reason = 'bot key cannot cover gas'
    return plan
  }
  if (tip > keeperBalance - reserve) tip = keeperBalance - reserve
  plan.tipWei = tip
  return plan
}

// ---------- bundles ----------

type Sim = { ok: boolean; results: { error?: string; value?: string; gasUsed?: number }[]; raw?: unknown }

/** Simulate a bundle exactly as builders would run it (Flashbots eth_callBundle). */
async function simulateBundle(ctx: Ctx, raws: Hex[]): Promise<Sim> {
  if (LOCAL_SUBMIT) return await localSimulate(ctx, raws)
  const head = await client.getBlock()
  const fb = BUILDERS.find((b) => b.name === 'flashbots')!
  const sim = await builderCall(fb, ctx.keeper!, 'eth_callBundle', [{ txs: raws, blockNumber: toHex(head.number + 1n), stateBlockNumber: 'latest' }], true)
  let parsed: any = null
  try {
    parsed = JSON.parse(sim.body ?? '')
  } catch { /* below */ }
  const results = parsed?.result?.results
  if (!Array.isArray(results)) return { ok: false, results: [], raw: { status: sim.status, error: sim.error, body: String(sim.body ?? '').slice(0, 300) } }
  const out = results.map((r: any) => ({
    error: r.error ? `${r.error}${r.revert ? `: ${r.revert}` : ''}` : undefined,
    value: r.value && r.value !== '0x' ? String(r.value) : undefined,
    gasUsed: Number(r.gasUsed ?? 0),
  }))
  return { ok: out.length === raws.length && out.every((r: any) => !r.error), results: out }
}

/** Fork rehearsals only: emulate eth_callBundle on an anvil fork (snapshot, run in order, revert). */
async function localSimulate(ctx: Ctx, raws: Hex[]): Promise<Sim> {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(RPC_URLS[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message)
    return j.result
  }
  // The "return value" of each transaction is the USDS it delivered to the wallets the bot serves.
  const watch = [MAIN_WALLET, ctx.testOwner?.address].filter(Boolean) as Hex[]
  const usdsOf = async () =>
    (await Promise.all(watch.map((a) => client.readContract({ address: USDS, abi: tokenAbi, functionName: 'balanceOf', args: [a] })))).reduce((s, x) => s + x, 0n)
  await call('anvil_dropAllTransactions', []).catch(() => null)
  const snap = await call('evm_snapshot', [])
  const results: Sim['results'] = []
  try {
    for (const raw of raws) {
      const before = await usdsOf()
      let hash: Hex
      try {
        hash = await call('eth_sendRawTransaction', [raw])
      } catch (e) {
        results.push({ error: String(e).slice(0, 200) })
        break
      }
      const rc = await client.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 200 })
      const after = await usdsOf()
      let reason = 'reverted'
      if (rc.status !== 'success') {
        const tr = await call('debug_traceTransaction', [hash, { tracer: 'callTracer' }]).catch(() => null)
        reason = `reverted: ${tr?.error ?? ''} ${String(tr?.output ?? '').slice(0, 74)} gas ${rc.gasUsed}/${tr?.gas ?? '?'}`
      }
      results.push(rc.status === 'success' ? { value: toHex(after - before), gasUsed: Number(rc.gasUsed) } : { error: reason, gasUsed: Number(rc.gasUsed) })
      if (rc.status !== 'success') break
    }
  } finally {
    await call('evm_revert', [snap])
    await call('anvil_dropAllTransactions', []).catch(() => null)
  }
  return { ok: results.length === raws.length && results.every((r) => !r.error), results }
}

/** Send each bundle to every builder for each target block (on a fork: run the first bundle). */
async function sendBundles(signer: PrivateKeyAccount, bundles: Hex[][], targets: bigint[], publicRaw?: Hex) {
  if (LOCAL_SUBMIT) {
    const out: any[] = []
    for (const raw of bundles[0]) out.push({ builder: 'local-fork', status: 200, body: await client.sendRawTransaction({ serializedTransaction: raw }).catch((e) => String(e).slice(0, 120)) })
    return out
  }
  return await Promise.all([
    ...BUILDERS.flatMap((b) => targets.flatMap((t) => bundles.map((txs) => builderCall(b, signer, 'eth_sendBundle', [{ txs, blockNumber: toHex(t) }])))),
    ...(publicRaw ? PUBLIC_MEMPOOL.map((u) => publicSend(u, publicRaw)) : []),
  ])
}

const sendOk = (s: any) => s.status === 200 && !String(s.body ?? '').includes('"error"')
const summarizeSends = (sent: any[]) => ({
  accepted_by: [...new Set(sent.filter(sendOk).map((s) => s.builder))],
  requests: sent.length,
  failures: sent.filter((s) => !sendOk(s)).slice(0, 4),
})

type Leg = { raw: Hex; hash: Hex; expected: bigint; detail: Record<string, unknown> }
type Skip = { skipped: string; [k: string]: unknown }
const isLeg = (x: Leg | Skip): x is Leg => 'raw' in x

/**
 * The owner's exit as the next transaction after `preceding`, tipped within the
 * fee policy (gas of `extraGas` the bot also pays for counts against it).
 */
async function exitLeg(ctx: Ctx, preceding: Hex[], nonce: number, extraGas = 0n): Promise<Leg | Skip> {
  const cfg = ctx.config
  if (!cfg.helper_address) return { skipped: 'no exit contract' }
  const x = await buildExit(ctx)
  const prio = Number(cfg.priority_gwei ?? 1)
  let expected: bigint
  if (!preceding.length) {
    if (x.shares === 0n) return { skipped: 'nothing redeemable' }
    try {
      expected = (await client.simulateContract({ address: x.helper, abi: exitAbi, functionName: 'exit', args: [maxUint256, x.minAssets], account: x.keeper.address, value: 0n })).result
    } catch (e) {
      return { skipped: 'exit simulation reverted', error: String(e).slice(0, 200) }
    }
  } else {
    const probe = await signTx(x.keeper, { to: x.helper, data: x.data, value: 0n, gas: x.gas }, prio, nonce)
    const sim = await simulateBundle(ctx, [...preceding, probe.raw])
    const r = sim.results[preceding.length]
    if (!sim.ok || !r?.value) return { skipped: 'exit gets nothing after the preceding transactions', error: r?.error ?? (sim.raw ? JSON.stringify(sim.raw).slice(0, 200) : undefined) }
    expected = BigInt(r.value)
  }
  const plan = await feePlan(cfg, expected, EXIT_GAS_USED + extraGas, x.balance, x.gas + extraGas)
  if (!plan.ok) return { skipped: plan.reason, expected_usds: formatUnits(expected, 18) }
  const signed = await signTx(x.keeper, { to: x.helper, data: x.data, value: plan.tipWei, gas: x.gas }, prio, nonce)
  return {
    raw: signed.raw,
    hash: signed.hash,
    expected,
    detail: { hash: signed.hash, nonce, expected_usds: formatUnits(expected, 18), tip_eth: formatEther(plan.tipWei), fee_budget_usd: plan.budgetUsd, gas_usd: plan.gasUsd },
  }
}

/** The arb on whatever liquidity is left after `preceding`. Profit only ever goes to the main wallet. */
async function arbLeg(ctx: Ctx, preceding: Hex[], availableWad: bigint, nonce: number, tipShare: number): Promise<Leg | Skip> {
  const cfg = ctx.config
  if (!cfg.arb_enabled || !cfg.arb_address || !ctx.keeper) return { skipped: 'arb off' }
  if (availableWad < parseUnits('2000', 18)) return { skipped: 'too little liquidity for an arb', available_usds: formatUnits(availableWad > 0n ? availableWad : 0n, 18) }
  try {
    const arb = await verifyArb(client as any, getAddress(cfg.arb_address), getAddress(MAIN_WALLET), ctx.keeper.address)
    const prio = Number(cfg.priority_gwei ?? 1)
    const r: any = await planArb({
      client: client as any,
      arb,
      availableWad,
      preceding,
      sign: (to, data, gas) => signTx(ctx.keeper!, { to, data, gas }, prio, nonce),
      simulate: (raws) => simulateBundle(ctx, raws),
      tipShare,
      minNetUsds: Number(cfg.arb_min_net_usd ?? 25),
    })
    if (!r.raw) return { skipped: r.skipped ?? 'no plan', ...r }
    const { raw, hash, ...rest } = r
    return { raw, hash, expected: 0n, detail: { hash, nonce, ...rest } }
  } catch (e) {
    return { skipped: String(e).slice(0, 200) }
  }
}

/** Wait for whichever of our transactions lands, log it and tell the user. */
async function watchLanding(ctx: Ctx, seenBlock: number, route: string, exit: Leg | null, arb: Leg | null) {
  const cfg = ctx.config
  const pending = new Map<Hex, 'exit' | 'arb'>()
  if (exit) pending.set(exit.hash, 'exit')
  if (arb) pending.set(arb.hash, 'arb')
  for (let i = 0; i < 20 && pending.size; i++) {
    await sleep(2500)
    for (const [hash, kind] of [...pending]) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) continue
      pending.delete(hash)
      const detail = { route, kind, hash, block: Number(receipt.blockNumber), index: receipt.transactionIndex, status: receipt.status, gas_used: Number(receipt.gasUsed), blocks_after_seen: Number(receipt.blockNumber) - seenBlock }
      await log(ctx, receipt.blockNumber, 'included', detail)
      if (kind === 'exit') {
        await notify(
          ctx,
          'stusds:exit',
          receipt.status === 'success' ? `stUSDS withdrawal landed (${route})` : `stUSDS withdrawal reverted on-chain (${route})`,
          `${usd(exit!.expected)} USDS expected, block ${receipt.blockNumber} position ${receipt.transactionIndex} (${cfg.target_name}). https://etherscan.io/tx/${hash}`,
        )
      } else if (receipt.status === 'success') {
        await notify(ctx, 'stusds:arb', `stUSDS arb landed (${route})`, `About ${Number(arb!.detail.net ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDS profit sent to the main wallet, block ${receipt.blockNumber}. https://etherscan.io/tx/${hash}`)
      }
    }
  }
  if (pending.size) await log(ctx, seenBlock, 'not_included', { route, hashes: [...pending.keys()] })
}

/** Liquidity is there at the end of a block: the exit first, then the arb on whatever is left. */
async function fire(ctx: Ctx, seenBlock: number) {
  const started = Date.now()
  const cfg = ctx.config
  if (!cfg.enabled || !ctx.keeper) return { skipped: 'not armed' }
  const keeper = ctx.keeper
  // Always the confirmed nonce: a still-pending public copy of an earlier attempt
  // must be replaced, not queued behind (builders drop bundles with a nonce gap).
  const [n, head, available] = await Promise.all([
    client.getTransactionCount({ address: keeper.address, blockTag: 'latest' }),
    client.getBlock(),
    availableUsds(client as any),
  ])
  const exit = await exitLeg(ctx, [], n)
  const arb = await arbLeg(ctx, isLeg(exit) ? [exit.raw] : [], available - (isLeg(exit) ? exit.expected : 0n), isLeg(exit) ? n + 1 : n, Number(cfg.arb_tip_share_race ?? 0.7))
  if (!isLeg(exit) && !isLeg(arb)) {
    await log(ctx, seenBlock, 'nothing_to_do', { exit, arb, available_usds: formatUnits(available, 18), ms: Date.now() - started })
    return { skipped: 'nothing to do' }
  }
  const bundles: Hex[][] = []
  if (isLeg(exit) && isLeg(arb)) bundles.push([exit.raw, arb.raw])
  if (isLeg(exit)) bundles.push([exit.raw])
  else if (isLeg(arb)) bundles.push([arb.raw])
  const targets = [head.number + 1n, head.number + 2n, head.number + 3n]
  // Some validators build their own blocks from the public mempool, which no bundle
  // reaches. A public copy of the exit covers those (beaten, it just reverts cheaply).
  const sent = await sendBundles(keeper, bundles, targets, cfg.public_broadcast && isLeg(exit) ? exit.raw : undefined)
  await log(ctx, seenBlock, 'fired', {
    route: 'end_of_block',
    head: Number(head.number),
    head_age_ms: Date.now() - Number(head.timestamp) * 1000,
    targets: targets.map(Number),
    available_usds: formatUnits(available, 18),
    exit: isLeg(exit) ? exit.detail : exit,
    arb: isLeg(arb) ? arb.detail : arb,
    ms: Date.now() - started,
    builders: summarizeSends(sent),
  })
  await watchLanding(ctx, seenBlock, 'end of block', isLeg(exit) ? exit : null, isLeg(arb) ? arb : null)
  return { fired: true }
}

// ---------- Safe queue watch ----------

function describeSafeTx(t: any): { repay: number; summary: string } {
  const calls: any[] = t.dataDecoded?.method === 'multiSend'
    ? (t.dataDecoded.parameters?.[0]?.valueDecoded ?? [])
    : [{ to: t.to, dataDecoded: t.dataDecoded }]
  let repay = 0
  const parts: string[] = []
  for (const c of calls) {
    const m = c.dataDecoded?.method ?? 'call'
    const toEngine = String(c.to ?? '').toLowerCase() === LOCKSTAKE_ENGINE.toLowerCase()
    const p = Object.fromEntries((c.dataDecoded?.parameters ?? []).map((q: any) => [q.name, q.value]))
    if (toEngine && m === 'wipe' && p.wad) repay += Number(formatUnits(BigInt(p.wad), 18))
    if (toEngine && m === 'wipeAll') repay += 1 // amount is the whole debt; flag it
    parts.push(toEngine && (m === 'wipe' || m === 'draw') && p.wad ? `${m} ${Number(formatUnits(BigInt(p.wad), 18)).toLocaleString('en-US')}` : m)
  }
  return { repay, summary: parts.join(' + ').slice(0, 200) }
}

/**
 * Safe route. A repayment that sits fully signed in a Safe's queue can be
 * submitted by anyone: the owners' signatures are the authorisation and the
 * submitter only pays gas. We submit it ourselves with the exit right behind
 * it, as one bundle, so the freed USDS reaches the exit before anyone else.
 * We execute exactly what the owners signed (checked against the Safe's own
 * transaction hash) and nothing else.
 */
const safeRouteSent = new Map<string, number>() // safeTxHash -> last block targeted

async function safeRoute(ctx: Ctx, safe: Hex, t: any, onchainNonce: bigint, threshold: bigint) {
  const cfg = ctx.config
  if (!cfg.enabled || !cfg.safe_route || !ctx.keeper) return { skipped: 'not armed' }
  if (BigInt(t.nonce) !== onchainNonce) return { skipped: 'not next in the Safe queue' }
  const confs = [...(t.confirmations ?? [])].filter((c: any) => typeof c.signature === 'string' && c.signature.length === 132)
  if (BigInt(confs.length) < threshold) return { skipped: 'not fully signed' }
  if (BigInt(t.gasPrice ?? 0) !== 0n) return { skipped: 'Safe transaction pays a gas refund; not touching it' }
  // Safe checks signatures in ascending owner order and uses the first `threshold`.
  confs.sort((a: any, b: any) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1))
  const signatures = ('0x' + confs.slice(0, Number(threshold)).map((c: any) => c.signature.slice(2)).join('')) as Hex
  const args = [
    getAddress(t.to), BigInt(t.value ?? 0), (t.data ?? '0x') as Hex, Number(t.operation ?? 0), BigInt(t.safeTxGas ?? 0),
    BigInt(t.baseGas ?? 0), 0n, getAddress(t.gasToken ?? '0x0000000000000000000000000000000000000000'),
    getAddress(t.refundReceiver ?? '0x0000000000000000000000000000000000000000'),
  ] as const
  const hash = await client.readContract({ address: safe, abi: safeAbi, functionName: 'getTransactionHash', args: [...args, onchainNonce] })
  if (hash.toLowerCase() !== String(t.safeTxHash).toLowerCase()) return { skipped: 'transaction does not match what the owners signed' }

  const head = await client.getBlock()
  if ((safeRouteSent.get(t.safeTxHash) ?? 0) > Number(head.number)) return { skipped: 'already covering the next blocks' }
  const keeper = ctx.keeper
  const execData = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [...args, signatures] })
  let execGas: bigint
  try {
    const ok = await client.simulateContract({ address: safe, abi: safeAbi, functionName: 'execTransaction', args: [...args, signatures], account: keeper.address })
    if (!ok.result) return { skipped: 'Safe transaction would fail' }
    execGas = (await client.estimateGas({ account: keeper.address, to: safe, data: execData })) * 13n / 10n
  } catch (e) {
    await log(ctx, Number(head.number), 'safe_route_sim_failed', { safeTxHash: t.safeTxHash, error: String(e).slice(0, 300) })
    return { skipped: 'Safe transaction simulation failed' }
  }

  const n = await client.getTransactionCount({ address: keeper.address, blockTag: 'latest' })
  const prio = Number(cfg.priority_gwei ?? 1)
  const exec = await signTx(keeper, { to: safe, data: execData, gas: execGas }, prio, n)
  // Our exit right behind the repayment, then the arb on whatever it leaves.
  const exit = await exitLeg(ctx, [exec.raw], n + 1, execGas)
  const repayWad = parseUnits(String(Math.floor(describeSafeTx(t).repay)), 18)
  const available = (await availableUsds(client as any)) + repayWad - (isLeg(exit) ? exit.expected : 0n)
  const arb = await arbLeg(ctx, isLeg(exit) ? [exec.raw, exit.raw] : [exec.raw], available, isLeg(exit) ? n + 2 : n + 1, Number(cfg.arb_tip_share_safe ?? 0.3))
  if (!isLeg(exit) && !isLeg(arb)) {
    await log(ctx, Number(head.number), 'safe_route_nothing', { safeTxHash: t.safeTxHash, exit, arb })
    return { skipped: 'nothing for us after this repayment' }
  }
  const bundles: Hex[][] = []
  if (isLeg(exit) && isLeg(arb)) bundles.push([exec.raw, exit.raw, arb.raw])
  if (isLeg(exit)) bundles.push([exec.raw, exit.raw])
  else if (isLeg(arb)) bundles.push([exec.raw, arb.raw])
  const targets = [head.number + 1n, head.number + 2n, head.number + 3n]
  // Never public: their signed transaction goes only to builders, inside our bundle.
  const sent = await sendBundles(keeper, bundles, targets)
  safeRouteSent.set(t.safeTxHash, Number(head.number) + 2)
  await log(ctx, Number(head.number), 'safe_route_fired', {
    safeTxHash: t.safeTxHash, safe, safe_nonce: Number(onchainNonce), exec_hash: exec.hash, targets: targets.map(Number),
    repay_usds: formatUnits(repayWad, 18), exit: isLeg(exit) ? exit.detail : exit, arb: isLeg(arb) ? arb.detail : arb, builders: summarizeSends(sent),
  })
  await watchLanding(ctx, Number(head.number), 'Safe route', isLeg(exit) ? exit : null, isLeg(arb) ? arb : null)
  return { fired: true }
}

/**
 * The Safe's recent transactions from Safe's transaction service. Edge
 * functions share outbound addresses that Safe rate-limits (HTTP 429), so
 * fetch through Postgres first and only fall back to fetching directly.
 */
async function safeTxList(ctx: Ctx, safe: Hex) {
  const viaDb = await db('stusds_exit_safe_fetch', { p_secret: ctx.secret, p_safe: safe, p_limit: 12 }).catch((e) => ({ error: String(e) }))
  if (viaDb?.status === 200 && viaDb.body) return viaDb.body
  const r = await fetch(`https://api.safe.global/tx-service/eth/api/v1/safes/${safe}/multisig-transactions/?limit=12`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`safe api: via db ${viaDb?.status ?? viaDb?.error ?? '?'}, direct ${r.status}`)
  return r.json()
}

const watchedSafes = (cfg: any): Hex[] =>
  String(cfg.watch_safe ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => getAddress(s))

async function pollSafe(ctx: Ctx, safe: Hex) {
  const [txs, onchainNonce, threshold] = await Promise.all([
    safeTxList(ctx, safe),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
  ])
  const info = { nonce: onchainNonce, threshold }
  // The chain decides what is still pending, not the API's executed flag.
  for (const t of txs.results ?? []) {
    if (BigInt(t.nonce) !== onchainNonce || describeSafeTx(t).repay <= 0) continue
    const r = await safeRoute(ctx, safe, t, onchainNonce, threshold).catch((e) => ({ error: String(e).slice(0, 300) }))
    console.log('safe route', t.safeTxHash.slice(0, 10), JSON.stringify(r).slice(0, 300))
  }
  const rows = (txs.results ?? [])
    // A pending transaction below the Safe's current nonce has been replaced and can never run.
    .filter((t: any) => t.isExecuted || Number(t.nonce) >= Number(info.nonce))
    .map((t: any) => {
      const d = describeSafeTx(t)
      return {
        safe_tx_hash: t.safeTxHash,
        safe,
        nonce: t.nonce,
        proposed_at: t.submissionDate,
        executed_at: t.isExecuted ? t.executionDate : null,
        confirmations: t.confirmations?.length ?? 0,
        required: t.confirmationsRequired ?? info.threshold,
        repay_usds: d.repay,
        summary: d.summary,
      }
    })
  const res = await db('stusds_exit_safe_upsert', { p_secret: ctx.secret, p_rows: rows })
  for (const ev of res?.events ?? []) {
    await email(ctx, `${ev.title}: ${Number(ev.repay_usds).toLocaleString('en-US')} USDS`, `${ev.body}\n\nSafe ${safe}\nhttps://app.safe.global/transactions/queue?safe=eth:${safe}`)
  }
  return { rows: rows.length, events: res?.events?.length ?? 0 }
}

async function tick(ctx: Ctx) {
  const safes = watchedSafes(ctx.config)
  if (!safes.length) return
  const failures: Record<string, string> = {}
  let polls = 0
  // pg_cron starts this once a minute; poll every ~5 s for the next ~55 s, so a
  // repayment that becomes fully signed is seen within seconds.
  const until = Date.now() + 55_000
  while (Date.now() < until) {
    const roundStart = Date.now()
    for (const safe of safes) {
      polls++
      try {
        await pollSafe(ctx, safe)
      } catch (e) {
        failures[safe] = String(e).slice(0, 200)
        console.error('safe poll failed', safe, String(e))
      }
    }
    const wait = 5_000 - (Date.now() - roundStart)
    if (Date.now() + wait < until) await sleep(Math.max(wait, 500))
    else break
  }
  // A blind Safe watch must be visible: record any minute in which polling failed.
  if (Object.keys(failures).length) await log(ctx, null, 'safe_poll_failed', { polls, failures })
}

// ---------- pending-transaction watch (backruns) ----------
//
// Public repayments and deposits are seen before they are mined. We put our
// exit and the arb directly behind them, as one bundle that only lands if the
// repayment does, in the same block.

const PENDING_WS = ['wss://ethereum-rpc.publicnode.com']
async function rawTransaction(hash: Hex): Promise<Hex | null> {
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getRawTransactionByHash', params: [hash] }), signal: AbortSignal.timeout(2500) })
      const j = await r.json()
      if (j.result && j.result !== '0x') return j.result
    } catch { /* next */ }
  }
  return null
}

async function backrun(ctx: Ctx, victim: any, freedWad: bigint) {
  const started = Date.now()
  const cfg = ctx.config
  const keeper = ctx.keeper!
  const victimRaw = await rawTransaction(victim.hash)
  if (!victimRaw) return { skipped: 'raw transaction not available' }
  const [n, head, availableNow] = await Promise.all([
    client.getTransactionCount({ address: keeper.address, blockTag: 'latest' }),
    client.getBlock(),
    availableUsds(client as any),
  ])
  const exit = await exitLeg(ctx, [victimRaw], n)
  const available = availableNow + freedWad - (isLeg(exit) ? exit.expected : 0n)
  const arb = await arbLeg(ctx, isLeg(exit) ? [victimRaw, exit.raw] : [victimRaw], available, isLeg(exit) ? n + 1 : n, Number(cfg.arb_tip_share_race ?? 0.7))
  if (!isLeg(exit) && !isLeg(arb)) {
    await log(ctx, Number(head.number), 'backrun_nothing', { victim: victim.hash, freed_usds: formatUnits(freedWad, 18), exit, arb, ms: Date.now() - started })
    return { skipped: 'nothing for us' }
  }
  const bundles: Hex[][] = []
  if (isLeg(exit) && isLeg(arb)) bundles.push([victimRaw, exit.raw, arb.raw])
  if (isLeg(exit)) bundles.push([victimRaw, exit.raw])
  else if (isLeg(arb)) bundles.push([victimRaw, arb.raw])
  const targets = [head.number + 1n, head.number + 2n]
  const sent = await sendBundles(keeper, bundles, targets)
  await log(ctx, Number(head.number), 'backrun_fired', {
    victim: victim.hash, from: victim.from, to: victim.to, freed_usds: formatUnits(freedWad, 18), targets: targets.map(Number),
    exit: isLeg(exit) ? exit.detail : exit, arb: isLeg(arb) ? arb.detail : arb, ms: Date.now() - started, builders: summarizeSends(sent),
  })
  await watchLanding(ctx, Number(head.number), 'backrun', isLeg(exit) ? exit : null, isLeg(arb) ? arb : null)
  return { fired: true }
}

/** Watch pending transactions for ~110 s (pg_cron starts one run a minute; runs overlap). */
async function mempoolWatch(ctx: Ctx) {
  const cfg = ctx.config
  if (!cfg.mempool_enabled || !cfg.enabled || !ctx.keeper) return
  const safes = watchedSafes(cfg)
  const seen = new Set<string>()
  const deadline = Date.now() + 110_000
  let closed = false
  let busy = Promise.resolve()
  const handle = (tx: any) => {
    if (!tx?.hash || seen.has(tx.hash)) return
    seen.add(tx.hash)
    if (String(tx.from ?? '').toLowerCase() === ctx.keeper!.address.toLowerCase()) return
    let freed = 0n
    try {
      freed = freedBy(tx, safes)
    } catch { /* ignore */ }
    if (freed <= 0n) return
    // One backrun at a time per run: they share the bot key's nonce.
    busy = busy.then(async () => backrun(ctx, tx, await freedByExact(tx, safes, client as any).catch(() => freed)).then((r) => console.log('backrun', tx.hash, JSON.stringify(r).slice(0, 200))).catch((e) => console.error('backrun failed', String(e))))
  }
  const sockets = new Set<WebSocket>()
  const connect = (url: string) => {
    if (closed || Date.now() > deadline - 3000) return
    const ws = new WebSocket(url)
    sockets.add(ws)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions', true] }))
    ws.onmessage = (m) => {
      try {
        const r = JSON.parse(String(m.data))?.params?.result
        if (r && typeof r === 'object') handle(r)
      } catch { /* ignore malformed frames */ }
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* closed */ }
    }
    ws.onclose = () => {
      sockets.delete(ws)
      if (!closed) setTimeout(() => connect(url), 1500)
    }
  }
  PENDING_WS.forEach(connect)
  while (Date.now() < deadline) await sleep(1000)
  closed = true
  for (const ws of sockets) {
    try { ws.close() } catch { /* closed */ }
  }
  await busy
  console.log(`mempool run done: ${seen.size} pending transactions seen`)
}

// ---------- setup routes ----------

async function status(ctx: Ctx) {
  const out: any = { enabled: ctx.config.enabled, target: ctx.config.target_name, helper: ctx.config.helper_address }
  const who: [string, string | undefined][] = [['keeper', ctx.keeper?.address], ['test_owner', ctx.testOwner?.address], ['main_wallet', MAIN_WALLET]]
  for (const [name, addr] of who) {
    if (!addr) continue
    const a = getAddress(addr)
    const [eth, shares, usds] = await Promise.all([
      client.getBalance({ address: a }),
      client.readContract({ address: ST_USDS, abi: tokenAbi, functionName: 'balanceOf', args: [a] }),
      client.readContract({ address: USDS, abi: tokenAbi, functionName: 'balanceOf', args: [a] }),
    ])
    const worth = await client.readContract({ address: ST_USDS, abi: tokenAbi, functionName: 'convertToAssets', args: [shares] })
    out[name] = { address: a, eth: formatEther(eth), usds: formatUnits(usds, 18), stusds_worth_usds: formatUnits(worth, 18) }
  }
  if (ctx.config.helper_address) {
    out.helper_code = await verifyHelper(ctx).then(() => 'verified: tested build').catch((e) => `REJECTED: ${String(e)}`)
  }
  if (ctx.config.helper_address && String(out.helper_code).startsWith('verified')) {
    const h = getAddress(ctx.config.helper_address)
    const read = (fn: any) => client.readContract({ address: h, abi: exitAbi, functionName: fn })
    const [owner, keeper, floor, perUsds, maxTip, redeemable] = await Promise.all([
      read('owner'), read('keeper'), read('minAssetsFloor'), read('tipWeiPerUsds'), read('maxTipWei'), read('redeemable'),
    ])
    const allowance = await client.readContract({ address: ST_USDS, abi: tokenAbi, functionName: 'allowance', args: [owner as Hex, h] })
    out.helper_state = {
      owner, keeper, floor_usds: formatUnits(floor as bigint, 18), tip_wei_per_usds: perUsds, max_tip_eth: formatEther(maxTip as bigint),
      allowance_shares: allowance > 10n ** 40n ? 'unlimited' : formatUnits(allowance, 18), redeemable_shares: formatUnits(redeemable as bigint, 18),
    }
  }
  if (ctx.config.arb_address) {
    out.arb = {
      address: ctx.config.arb_address,
      enabled: !!ctx.config.arb_enabled,
      code: await verifyArb(client as any, getAddress(ctx.config.arb_address), getAddress(MAIN_WALLET), ctx.keeper!.address)
        .then(() => 'verified: tested build, profit to main wallet, bot key as keeper').catch((e) => `REJECTED: ${String(e)}`),
      tip_share_safe: ctx.config.arb_tip_share_safe,
      tip_share_race: ctx.config.arb_tip_share_race,
      min_net_usd: ctx.config.arb_min_net_usd,
    }
  }
  out.mempool_watch = !!ctx.config.mempool_enabled
  out.available_usds = formatUnits(await availableUsds(client as any), 18)
  return out
}

async function setup(ctx: Ctx) {
  const created: string[] = []
  for (const [have, name] of [[ctx.keeper, 'stusds_exit_keeper_key'], [ctx.testOwner, 'stusds_exit_test_owner_key']] as const) {
    if (have) continue
    const r = await db('stusds_exit_store_key', { p_secret: ctx.secret, p_name: name, p_key: generatePrivateKey() })
    if (r?.created) created.push(name)
  }
  const fresh = (await begin(ctx.secret))!
  return { created, keeper: fresh.keeper?.address, test_owner: fresh.testOwner?.address }
}

async function deploy(ctx: Ctx, body: any) {
  if (keccak256(EXIT_CREATION_BYTECODE as Hex) !== EXPECTED_CREATION_HASH) throw new Error('bytecode does not match the audited build')
  const owner = body.target === 'main' ? MAIN_WALLET : body.target === 'test' ? ctx.testOwner!.address : null
  if (!owner) throw new Error("target must be 'test' or 'main'")
  const args = [
    ST_USDS,
    getAddress(owner),
    ctx.keeper!.address,
    parseUnits(String(body.floor_usds), 18),
    BigInt(body.tip_wei_per_usds),
    parseEther(String(body.max_tip_eth)),
  ] as const
  const data = encodeDeployData({ abi: exitAbi, bytecode: EXIT_CREATION_BYTECODE as Hex, args })
  const receipt = await sendPublic(ctx.keeper!, { data, gas: 900_000n })
  await log(ctx, receipt.blockNumber, 'deployed', { target: body.target, owner, address: receipt.contractAddress, tx: receipt.transactionHash })
  return { address: receipt.contractAddress, owner, tx: receipt.transactionHash, gas_used: receipt.gasUsed }
}

/** Deploy the arb contract (profit fixed to the main wallet, bot key as keeper). */
async function deployArb(ctx: Ctx) {
  const receipt = await sendPublic(ctx.keeper!, { data: arbDeployData(getAddress(MAIN_WALLET), ctx.keeper!.address), gas: 2_500_000n })
  const address = receipt.contractAddress!
  await verifyArb(client as any, address, getAddress(MAIN_WALLET), ctx.keeper!.address)
  await log(ctx, receipt.blockNumber, 'deployed_arb', { address, tx: receipt.transactionHash })
  return { address, tx: receipt.transactionHash, gas_used: receipt.gasUsed }
}

/** Test wallet only: give it gas money and approve its exit contract. */
async function approveTest(ctx: Ctx) {
  const t = ctx.testOwner!
  const { helper, owner } = await verifyHelper(ctx)
  if (owner !== t.address) throw new Error('configured helper does not belong to the test wallet')
  await ensureGas(ctx, t.address, 80_000n)
  const data = encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [helper, maxUint256] })
  const r = await sendPublic(t, { to: ST_USDS, data, gas: 80_000n })
  return { approved: helper, tx: r.transactionHash }
}

/** Create liquidity on purpose (a drill): the keeper deposits USDS into stUSDS. */
async function drill(ctx: Ctx, body: any) {
  const k = ctx.keeper!
  const amount = parseUnits(String(body.usds), 18)
  const allowance = await client.readContract({ address: USDS, abi: tokenAbi, functionName: 'allowance', args: [k.address, ST_USDS] })
  if (allowance < amount) {
    await sendPublic(k, { to: USDS, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [ST_USDS, maxUint256] }), gas: 80_000n })
  }
  const req = { to: ST_USDS as Hex, data: encodeFunctionData({ abi: tokenAbi, functionName: 'deposit', args: [amount, k.address] }), gas: 450_000n }
  // A public deposit is backrun in the same block by mempool bots; a private one
  // only becomes visible once its block is out, which is the race the exit bot runs.
  const r = body.private ? (await sendPrivate(k, req, 2)).receipt : await sendPublic(k, req)
  await log(ctx, r.blockNumber, 'drill_deposit', { usds: body.usds, private: !!body.private, tx: r.transactionHash, index: r.transactionIndex })
  return { deposited_usds: body.usds, private: !!body.private, block: r.blockNumber, index: r.transactionIndex, tx: r.transactionHash }
}

/** Return test funds to the main wallet. The destination is fixed. */
async function sweep(ctx: Ctx, body: any) {
  const done: any[] = []
  for (const acct of [ctx.testOwner, ctx.keeper]) {
    if (!acct) continue
    for (const token of [USDS, ST_USDS] as Hex[]) {
      const bal = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [acct.address] })
      if (bal === 0n) continue
      if (acct !== ctx.keeper) await ensureGas(ctx, acct.address, 120_000n)
      const r = await sendPublic(acct, { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [MAIN_WALLET, bal] }), gas: 120_000n })
      done.push({ from: acct.address, token, amount: formatUnits(bal, 18), tx: r.transactionHash })
    }
  }
  if (body.eth && ctx.keeper) {
    const head = await client.getBlock()
    const fee = 21_000n * ((head.baseFeePerGas ?? 0n) * 2n + parseGwei('1.5'))
    const bal = await client.getBalance({ address: ctx.keeper.address })
    if (bal > fee * 2n) {
      const r = await sendPublic(ctx.keeper, { to: MAIN_WALLET, value: bal - fee, gas: 21_000n })
      done.push({ from: ctx.keeper.address, token: 'ETH', amount: formatEther(bal - fee), tx: r.transactionHash })
    }
  }
  await log(ctx, null, 'sweep', done)
  return done
}

/** Plumbing check: sign the real exit transaction and ask Flashbots to simulate it. */
async function simulate(ctx: Ctx) {
  const x = await buildExit(ctx)
  const { raw, hash, head } = await signTx(x.keeper, { to: x.helper, data: x.data, value: 0n, gas: x.gas }, Number(ctx.config.priority_gwei ?? 1))
  const fb = BUILDERS.find((b) => b.name === 'flashbots')!
  const sim = await builderCall(fb, x.keeper, 'eth_callBundle', [{ txs: [raw], blockNumber: toHex(head.number + 1n), stateBlockNumber: 'latest' }])
  const plan = await feePlan(ctx.config, parseUnits('100000', 18), EXIT_GAS_USED, x.balance, x.gas)
  return { hash, redeemable_shares: formatUnits(x.shares, 18), keeper_eth: formatEther(x.balance), fee_plan_for_100k_usds: { ...plan, tipWei: formatEther(plan.tipWei) }, flashbots_simulation: sim }
}

// ---------- HTTP entry ----------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'not found' }, 404)
  const secret = req.headers.get('x-cron-secret') ?? ''
  if (!secret) return json({ error: 'unauthorized' }, 401)
  const body = await req.json().catch(() => ({}))
  let ctx: Ctx | null
  try {
    ctx = await begin(secret)
  } catch (e) {
    console.error('begin failed', String(e))
    return json({ error: 'state store unavailable' }, 503)
  }
  if (!ctx) return json({ error: 'unauthorized' }, 401)

  const background = (p: Promise<unknown>) => {
    const guarded = p.catch((e) => console.error(`${body.action} failed`, String(e)))
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(guarded)
  }

  try {
    switch (body.action) {
      case 'fire':
        background(fire(ctx, Number(body.block)).then((r) => console.log('fire', JSON.stringify(r))))
        return json({ started: true })
      case 'tick':
        background(tick(ctx))
        return json({ started: true })
      case 'mempool':
        background(mempoolWatch(ctx))
        return json({ started: true })
      case 'deploy_arb':
        return json(await deployArb(ctx))
      case 'setup':
        return json(await setup(ctx))
      case 'status':
        return json(await status(ctx))
      case 'simulate':
        return json(await simulate(ctx))
      case 'deploy':
        return json(await deploy(ctx, body))
      case 'approve_test':
        return json(await approveTest(ctx))
      case 'drill':
        return json(await drill(ctx, body))
      case 'sweep':
        return json(await sweep(ctx, body))
      default:
        return json({ error: 'unknown action' }, 400)
    }
  } catch (e) {
    console.error(`${body.action} failed`, String(e))
    return json({ error: String(e).slice(0, 400) }, 500)
  }
})
