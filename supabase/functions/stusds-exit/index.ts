// stUSDS exit bot - Supabase edge function.
//
// Three ways to the liquidity, each building the same bundle: the owner's
// exit first (StUsdsExit, 1:1 at Sky, fee capped at 0.1%), then an arb on
// whatever is left (StUsdsArb, profit to the main wallet only):
//  - end of block: the block observer reports withdrawable USDS (`fire`);
//  - Safe route: a fully signed repayment in a big borrower's Safe queue,
//    executed by us with our transactions right behind it (`tick`);
//  - backrun: a public repayment or deposit seen while pending (`mempool`).
// What each one frees is measured by simulating it, never decoded from calldata.
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
  decodeFunctionResult,
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
import { ARB_GAS_LIMIT, arbDeployData, availableUsds, type Ladder, ladderQuotes, planArb, verifyArb } from './arb.ts'
import { arb2DeployData, planDirect, quoterDeployData, verifyArb2, verifyQuoter } from './arb2.ts'
import { amountHint, isCandidate, rebuildRaw } from './pending.ts'

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
  ladder?: Ladder // DEX price ladder kept fresh by the collector
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
    ladder: parseLadder(b.dex_ladder),
  }
}

/** The stored price ladder, if it is recent enough to size a trade with. */
function parseLadder(d: any): Ladder | undefined {
  try {
    if (!d?.nav || !Array.isArray(d.quotes) || !d.quotes.length) return undefined
    if (Date.now() - new Date(d.at).getTime() > 5 * 60_000) return undefined
    return { nav: BigInt(d.nav), quotes: d.quotes.map((q: any) => ({ amountIn: BigInt(q.in), shares: BigInt(q.shares) })) }
  } catch {
    return undefined
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

// The latest block, shared for a moment between the many steps of one run.
type Head = { number: bigint; timestamp: bigint; baseFeePerGas: bigint | null }
let headCache: { at: number; head: Head } | null = null
async function getHead(): Promise<Head> {
  if (!headCache || Date.now() - headCache.at > 1500) {
    const b = await client.getBlock()
    headCache = { at: Date.now(), head: { number: b.number!, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null } }
  }
  return headCache.head
}

async function signTx(account: PrivateKeyAccount, req: TxReq, priorityGwei: number, nonce?: number) {
  const [head, n] = await Promise.all([
    getHead(),
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

let ethUsdCache: { at: number; price: number } | null = null
async function ethUsd(chainNow: bigint): Promise<number> {
  if (ethUsdCache && Date.now() - ethUsdCache.at < 60_000) return ethUsdCache.price
  const r = await client.readContract({
    address: ETH_USD_FEED,
    abi: parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']),
    functionName: 'latestRoundData',
  })
  if (Number(chainNow) - Number(r[3]) > 6 * 3600) throw new Error('ETH price feed is stale')
  ethUsdCache = { at: Date.now(), price: Number(r[1]) / 1e8 }
  return ethUsdCache.price
}

/**
 * Fee policy: everything one exit costs (network gas for the gas we use, at
 * base fee plus our priority fee, plus the builder tip) stays within fee_bps
 * of the USDS it withdraws (default 10 = 0.1%). fee_floor_usd lets very small
 * exits go through when gas is cheap. Returns the tip that fits in what is left.
 */
async function feePlan(cfg: any, expectedWad: bigint, gasUnits: bigint, keeperBalance: bigint, gasLimit: bigint) {
  const head = await getHead()
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
  if (LOCAL_SUBMIT) return await localSimulate(raws)
  const head = await getHead()
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

const forkCall = async (method: string, params: unknown[]) => {
  const r = await fetch(RPC_URLS[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

/**
 * Fork rehearsals only: emulate eth_callBundle on an anvil fork. Runs the
 * transactions in order (a reverting one does not stop the rest, as in a real
 * bundle), reports each one's return data, then rolls the fork back.
 */
async function localSimulate(raws: Hex[]): Promise<Sim> {
  await forkCall('anvil_dropAllTransactions', []).catch(() => null)
  const snap = await forkCall('evm_snapshot', [])
  const results: Sim['results'] = []
  try {
    for (const raw of raws) {
      let hash: Hex
      try {
        hash = await forkCall('eth_sendRawTransaction', [raw])
      } catch (e) {
        results.push({ error: String(e).slice(0, 200) })
        continue
      }
      const rc = await client.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 200 })
      const tr = await forkCall('debug_traceTransaction', [hash, { tracer: 'callTracer' }]).catch(() => null)
      if (rc.status === 'success') results.push({ value: tr?.output && tr.output !== '0x' ? tr.output : undefined, gasUsed: Number(rc.gasUsed) })
      else results.push({ error: `reverted: ${tr?.error ?? ''} ${String(tr?.output ?? '').slice(0, 74)}`, gasUsed: Number(rc.gasUsed) })
    }
  } finally {
    await forkCall('evm_revert', [snap])
    await forkCall('anvil_dropAllTransactions', []).catch(() => null)
  }
  return { ok: results.length === raws.length && results.every((r) => !r.error), results }
}

/** Fork rehearsals only: play the role of the builder and include one bundle. */
async function localCommit(bundle: Hex[]) {
  const out: any[] = []
  for (const raw of bundle) out.push({ builder: 'local-fork', status: 200, body: await client.sendRawTransaction({ serializedTransaction: raw }).catch((e) => `"error": ${String(e).slice(0, 120)}`) })
  return out
}

/** Send each bundle to every builder for each target block. */
async function sendBundles(signer: PrivateKeyAccount, bundles: Hex[][], targets: bigint[], publicRaw?: Hex, mayRevert?: Hex[]) {
  return await Promise.all([
    ...BUILDERS.flatMap((b) => targets.flatMap((t) => bundles.map((txs) => builderCall(b, signer, 'eth_sendBundle', [{ txs, blockNumber: toHex(t), ...(mayRevert?.length ? { revertingTxHashes: mayRevert } : {}) }])))),
    ...(publicRaw ? PUBLIC_MEMPOOL.map((u) => publicSend(u, publicRaw)) : []),
  ])
}

const sendOk = (s: any) => s.status === 200 && !String(s.body ?? '').includes('"error"')
const summarizeSends = (sent: any[]) => ({
  accepted_by: [...new Set(sent.filter(sendOk).map((s) => s.builder))],
  requests: sent.length,
  failures: sent.filter((s) => !sendOk(s)).slice(0, 4),
})

// ---------- liquidity lens ----------
//
// "How much USDS can be withdrawn from stUSDS right after these transactions?"
// asked as a transaction of our own at the end of a simulated bundle: one
// Multicall3 call whose return data carries the four numbers the stUSDS
// contract itself uses. Nothing is decoded from other people's calldata.

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const VAT = '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B'
const JUG = '0x19c0976f590D67707E62397C87829d896Dc0f1F1'
const ILK = '0x4c534556322d534b592d41000000000000000000000000000000000000000000' // LSEV2-SKY-A
const lensAbi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function drip(bytes32) returns (uint256)',
  'function ilks(bytes32) view returns (uint256, uint256, uint256, uint256, uint256)',
  'function Due() view returns (uint256)',
  'function clip() view returns (address)',
])
const mc3Abi = [{
  type: 'function',
  name: 'aggregate3',
  stateMutability: 'payable',
  inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
  outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
}] as const

let clipAddress: Hex | null = null
async function lensData(): Promise<Hex> {
  clipAddress ??= await client.readContract({ address: ST_USDS, abi: lensAbi, functionName: 'clip' })
  const c = (target: Hex, callData: Hex) => ({ target, allowFailure: false, callData })
  return encodeFunctionData({
    abi: mc3Abi,
    functionName: 'aggregate3',
    args: [[
      c(ST_USDS, encodeFunctionData({ abi: lensAbi, functionName: 'totalAssets' })),
      c(JUG, encodeFunctionData({ abi: lensAbi, functionName: 'drip', args: [ILK] })), // accrues interest to this block and returns the rate
      c(VAT, encodeFunctionData({ abi: lensAbi, functionName: 'ilks', args: [ILK] })),
      c(clipAddress!, encodeFunctionData({ abi: lensAbi, functionName: 'Due' })),
    ]],
  })
}

function decodeLens(value: string): bigint {
  const res = decodeFunctionResult({ abi: mc3Abi, functionName: 'aggregate3', data: value as Hex })
  const totalAssets = BigInt(res[0].returnData)
  const rate = BigInt(res[1].returnData)
  const art = BigInt('0x' + res[2].returnData.slice(2, 66))
  const due = BigInt(res[3].returnData)
  const RAY = 10n ** 27n
  const debt = art * rate + due
  return totalAssets * RAY > debt ? (totalAssets * RAY - debt) / RAY : 0n
}

type ExitBuild = Awaited<ReturnType<typeof buildExit>>
type Probe =
  | { ok: true; x: ExitBuild | null; exitExpected: bigint | null; exitSkip?: string; availableAfter: bigint }
  | { ok: false; reason: string }

/**
 * What would the owner's exit get right after `preceding`, and how much USDS is
 * left withdrawable after that? One simulation: [...preceding, exit, lens].
 */
async function probeLiquidity(ctx: Ctx, preceding: Hex[], n: number): Promise<Probe> {
  const cfg = ctx.config
  const keeper = ctx.keeper!
  const prio = Number(cfg.priority_gwei ?? 1)
  let x: ExitBuild | null = null
  let exitSkip: string | undefined
  if (cfg.helper_address) {
    try {
      x = await buildExit(ctx)
    } catch (e) {
      exitSkip = String(e).slice(0, 160)
    }
  } else exitSkip = 'no exit contract'

  if (!preceding.length) {
    const available = await availableUsds(client as any)
    let exitExpected: bigint | null = null
    if (x) {
      if (x.shares === 0n) exitSkip = 'nothing redeemable'
      else {
        try {
          exitExpected = (await client.simulateContract({ address: x.helper, abi: exitAbi, functionName: 'exit', args: [maxUint256, x.minAssets], account: x.keeper.address, value: 0n })).result
        } catch (e) {
          exitSkip = `exit simulation reverted: ${String(e).slice(0, 120)}`
        }
      }
    }
    return { ok: true, x, exitExpected, exitSkip, availableAfter: available - (exitExpected ?? 0n) }
  }

  const txs = [...preceding]
  let exitIdx = -1
  if (x) {
    const p = await signTx(keeper, { to: x.helper, data: x.data, value: 0n, gas: x.gas }, prio, n)
    exitIdx = txs.length
    txs.push(p.raw)
  }
  const lens = await signTx(keeper, { to: MULTICALL3, data: await lensData(), gas: 400_000n }, prio, x ? n + 1 : n)
  txs.push(lens.raw)
  const sim = await simulateBundle(ctx, txs)
  for (let i = 0; i < preceding.length; i++) {
    const r = sim.results[i]
    if (!r || r.error) return { ok: false, reason: `transaction ${i + 1} of ${preceding.length} ahead of us would fail: ${r?.error ?? JSON.stringify(sim.raw ?? 'no result').slice(0, 200)}` }
  }
  const rl = sim.results[txs.length - 1]
  if (!rl || rl.error || !rl.value) return { ok: false, reason: `liquidity lens failed: ${rl?.error ?? 'no return data'}` }
  const availableAfter = decodeLens(rl.value)
  const re = exitIdx >= 0 ? sim.results[exitIdx] : null
  const exitExpected = re && !re.error && re.value ? BigInt(re.value) : null
  if (x && exitExpected === null) exitSkip = `exit gets nothing here${re?.error ? ` (${re.error.slice(0, 80)})` : ''}`
  return { ok: true, x, exitExpected, exitSkip, availableAfter }
}

type Leg = { raw: Hex; hash: Hex; expected: bigint; detail: Record<string, unknown> }
type Skip = { skipped: string; [k: string]: unknown }
const isLeg = (x: Leg | Skip): x is Leg => 'raw' in x

/** The owner's exit, tipped within the fee policy (gas of `extraGas` the bot also pays for counts against it). */
async function exitLeg(ctx: Ctx, p: Extract<Probe, { ok: true }>, n: number, extraGas: bigint, arbGasReserve: bigint): Promise<Leg | Skip> {
  const cfg = ctx.config
  if (!p.x || p.exitExpected === null) return { skipped: p.exitSkip ?? 'no exit' }
  // The bot key must still afford every transaction that follows in the same bundle.
  const plan = await feePlan(cfg, p.exitExpected, EXIT_GAS_USED + extraGas, p.x.balance, p.x.gas + extraGas + arbGasReserve)
  if (!plan.ok) return { skipped: plan.reason, expected_usds: formatUnits(p.exitExpected, 18) }
  const signed = await signTx(p.x.keeper, { to: p.x.helper, data: p.x.data, value: plan.tipWei, gas: p.x.gas }, Number(cfg.priority_gwei ?? 1), n)
  return {
    raw: signed.raw,
    hash: signed.hash,
    expected: p.exitExpected,
    detail: { hash: signed.hash, nonce: n, expected_usds: formatUnits(p.exitExpected, 18), tip_eth: formatEther(plan.tipWei), fee_budget_usd: plan.budgetUsd, gas_usd: plan.gasUsd },
  }
}

/** The arb on whatever liquidity is left after `preceding`. Profit only ever goes to the main wallet. */
async function arbLeg(ctx: Ctx, preceding: Hex[], availableWad: bigint, nonce: number, tipShare: number, ladder: Ladder | null): Promise<Leg | Skip> {
  const cfg = ctx.config
  if (!cfg.arb_enabled || !cfg.arb_address || !ctx.keeper) return { skipped: 'arb off' }
  if (!ladder || !ladder.quotes.length) return { skipped: 'no DEX quotes' }
  if (availableWad < parseUnits(String(Math.max(Number(cfg.arb_min_usds ?? 1000), 1000)), 18)) return { skipped: 'too little liquidity for an arb', available_usds: formatUnits(availableWad > 0n ? availableWad : 0n, 18) }
  try {
    const arb = await verifyArb(client as any, getAddress(cfg.arb_address), getAddress(MAIN_WALLET), ctx.keeper.address)
    const prio = Number(cfg.arb_priority_gwei ?? 0.05)
    const r: any = await planArb({
      arb,
      availableWad,
      ladder,
      preceding,
      sign: (to, data, gas) => signTx(ctx.keeper!, { to, data, gas }, prio, nonce),
      simulate: (raws) => simulateBundle(ctx, raws),
      tipShare,
      minNetUsds: Number(cfg.arb_min_net_usd ?? 25),
    })
    if (!r.raw) return { skipped: r.skipped ?? 'no plan', ...r }
    const { raw, hash, ...rest } = r
    return { raw, hash, expected: 0n, detail: { hash, nonce, tip_share: tipShare, ...rest } }
  } catch (e) {
    return { skipped: String(e).slice(0, 200) }
  }
}

/**
 * The same arb through the direct-routing contract: priced from the Curve pool
 * itself, so it is ready about a second after the liquidity is measured.
 */
async function directArbLeg(ctx: Ctx, preceding: Hex[], availableWad: bigint, nonce: number, tipShare: number): Promise<Leg | Skip> {
  const cfg = ctx.config
  if (!cfg.arb_enabled || !cfg.arb2_address || !ctx.keeper) return { skipped: 'direct arb off' }
  const minOpening = Number(cfg.arb_min_usds ?? 1000)
  if (availableWad < parseUnits(String(minOpening), 18)) return { skipped: 'too little liquidity for an arb', available_usds: formatUnits(availableWad > 0n ? availableWad : 0n, 18) }
  try {
    const arb = await verifyArb2(client as any, getAddress(cfg.arb2_address), getAddress(MAIN_WALLET), ctx.keeper.address)
    // The builder is paid out of the arb's profit, not out of the bot key's ETH, so the priority fee stays minimal.
    const prio = Number(cfg.arb_priority_gwei ?? 0.05)
    const quoter = cfg.arb_quoter_address ? await verifyQuoter(client as any, getAddress(cfg.arb_quoter_address)).catch(() => undefined) : undefined
    const r: any = await planDirect({
      client: client as any,
      arb,
      quoter,
      availableWad,
      preceding,
      sign: (to, data, gas) => signTx(ctx.keeper!, { to, data, gas }, prio, nonce),
      simulate: (raws) => simulateBundle(ctx, raws),
      tipShare,
      minNetUsds: Number(cfg.arb_min_net_usd ?? 25),
      minBuyUsds: minOpening / 2,
    })
    if (!r.raw) return { skipped: r.skipped ?? 'no plan', ...r }
    const { raw, hash, ...rest } = r
    return { raw, hash, expected: 0n, detail: { hash, nonce, tip_share: tipShare, ...rest } }
  } catch (e) {
    return { skipped: String(e).slice(0, 200) }
  }
}

/** Wait for whichever of our transactions lands, log it and tell the user. */
async function watchLanding(ctx: Ctx, seenBlock: number, route: string, exit: Leg | null, arbs: Leg[]) {
  const cfg = ctx.config
  const landed = { exit: false, arb: false }
  const pending = new Map<Hex, 'exit' | 'arb'>()
  if (exit) pending.set(exit.hash, 'exit')
  for (const a of arbs) pending.set(a.hash, 'arb')
  for (let i = 0; i < 20 && pending.size; i++) {
    await sleep(2500)
    for (const [hash, kind] of [...pending]) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) continue
      pending.delete(hash)
      const detail = { route, kind, hash, block: Number(receipt.blockNumber), index: receipt.transactionIndex, status: receipt.status, gas_used: Number(receipt.gasUsed), blocks_after_seen: Number(receipt.blockNumber) - seenBlock }
      await log(ctx, receipt.blockNumber, 'included', detail)
      if (receipt.status === 'success') landed[kind] = true
      if (kind === 'exit') {
        await notify(
          ctx,
          'stusds:exit',
          receipt.status === 'success' ? `stUSDS withdrawal landed (${route})` : `stUSDS withdrawal reverted on-chain (${route})`,
          `${usd(exit!.expected)} USDS expected, block ${receipt.blockNumber} position ${receipt.transactionIndex} (${cfg.target_name}). https://etherscan.io/tx/${hash}`,
        )
      } else if (receipt.status === 'success') {
        const won = arbs.find((a) => a.hash === hash)
        await notify(ctx, 'stusds:arb', `stUSDS arb landed (${route})`, `About ${Number(won?.detail.net ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDS profit sent to the main wallet, block ${receipt.blockNumber}. https://etherscan.io/tx/${hash}`)
      }
    }
  }
  if (pending.size) await log(ctx, seenBlock, 'not_included', { route, hashes: [...pending.keys()] })
  return landed
}

/**
 * One shape for every route: after `preceding` (nothing, a Safe repayment we
 * execute, or someone's pending repayment), the owner's exit goes first and the
 * arb takes what is left. The exit bundle is sent as soon as it is ready; the
 * bundle that also carries the arb follows, and builders take whichever is best.
 */
async function runRoute(ctx: Ctx, o: { route: 'end of block' | 'Safe route' | 'backrun' | 'test, alone' | 'test, public race'; seenBlock: number; preceding: Hex[]; n: number; extraGas?: bigint; tipShare: number; nTargets: number; publicCopy?: boolean; meta?: Record<string, unknown> }) {
  const t0 = Date.now()
  const cfg = ctx.config
  const keeper = ctx.keeper!
  const arbOn = !!(cfg.arb_enabled && (cfg.arb_address || cfg.arb2_address))
  const kyberOn = !!(cfg.arb_enabled && cfg.arb_address)
  const [head, p, ladder] = await Promise.all([
    getHead(),
    probeLiquidity(ctx, o.preceding, o.n),
    kyberOn ? (ctx.ladder ? Promise.resolve(ctx.ladder) : cfg.arb2_address ? Promise.resolve(null) : ladderQuotes(client as any).catch(() => null)) : Promise.resolve(null),
  ])
  const probeMs = Date.now() - t0
  if (!p.ok) {
    await log(ctx, o.seenBlock, 'nothing', { route: o.route, reason: p.reason, ms: probeMs, ...o.meta })
    return { skipped: p.reason }
  }
  const targets = Array.from({ length: o.nTargets }, (_, i) => head.number + 1n + BigInt(i))
  const exit = await exitLeg(ctx, p, o.n, o.extraGas ?? 0n, arbOn ? ARB_GAS_LIMIT : 0n)
  const sent: any[] = []
  // Where the opening only exists inside our own bundle (a Safe repayment we execute, a private test deposit), a
  // withdrawal sent on its own lets the builder pair it with somebody else's arb: bots whose transaction simply takes
  // whatever is withdrawable when it runs did exactly that on 25 Nov. So there the arb is planned first (for at most
  // 2.5 s) and travels in the same bundle, marked as allowed to fail so that it can never hold the withdrawal back.
  const exclusive = o.route === 'Safe route' || o.route === 'test, alone'
  const holdExit = exclusive && isLeg(exit) && !!(cfg.arb_enabled && cfg.arb2_address) && p.availableAfter >= parseUnits(String(cfg.arb_min_usds ?? 1000), 18)
  const sendExitAlone = async () => {
    if (isLeg(exit) && !LOCAL_SUBMIT) sent.push(...await sendBundles(keeper, [[...o.preceding, exit.raw]], targets, o.publicCopy && cfg.public_broadcast ? exit.raw : undefined))
  }
  if (!holdExit) await sendExitAlone()
  const exitMs = Date.now() - t0

  // An exit that was priced out by the fee policy leaves its liquidity for the arb.
  const available = p.availableAfter + (!isLeg(exit) && p.exitExpected !== null ? p.exitExpected : 0n)
  const before = isLeg(exit) ? [...o.preceding, exit.raw] : o.preceding
  const arbNonce = isLeg(exit) ? o.n + 1 : o.n
  // Direct route first: it needs no outside quote and is out within about a second.
  const direct: Leg | Skip = holdExit
    ? await Promise.race([directArbLeg(ctx, before, available, arbNonce, o.tipShare), sleep(LOCAL_SUBMIT ? 30_000 : 2500).then((): Skip => ({ skipped: 'arb plan took too long' }))])
    : await directArbLeg(ctx, before, available, arbNonce, o.tipShare)
  if (isLeg(direct) && !LOCAL_SUBMIT) sent.push(...await sendBundles(keeper, [[...before, direct.raw]], targets, undefined, holdExit ? [direct.hash] : undefined))
  if (holdExit && !isLeg(direct)) await sendExitAlone()
  const directMs = Date.now() - t0
  // The KyberSwap route also reaches resting limit orders, which matters for large openings. It is slower, so it
  // goes out as a second bundle (same nonce: at most one of the two can land) or stands in when the direct one has no plan.
  const wantKyber = kyberOn && (!isLeg(direct) || available >= parseUnits(String(cfg.arb_kyber_min_usds ?? 150000), 18))
  const kyber: Leg | Skip = wantKyber ? await arbLeg(ctx, before, available, arbNonce, o.tipShare, ladder) : { skipped: 'not needed at this size' }
  if (isLeg(kyber) && !LOCAL_SUBMIT) sent.push(...await sendBundles(keeper, [[...before, kyber.raw]], targets, undefined, holdExit ? [kyber.hash] : undefined))
  // The better-paying of the two is the one a builder would take.
  const tipOf = (l: Leg | Skip) => (isLeg(l) ? Number(l.detail.tip_usds ?? 0) : -1)
  const arb: Leg | Skip = tipOf(kyber) > tipOf(direct) ? kyber : isLeg(direct) ? direct : kyber
  if (LOCAL_SUBMIT && (isLeg(exit) || isLeg(arb))) sent.push(...await localCommit(isLeg(arb) ? [...before, arb.raw] : before))

  const detail = {
    route: o.route,
    head: Number(head.number),
    head_age_ms: Date.now() - Number(head.timestamp) * 1000,
    targets: targets.map(Number),
    available_after_exit_usds: formatUnits(p.availableAfter > 0n ? p.availableAfter : 0n, 18),
    exit: isLeg(exit) ? exit.detail : exit,
    arb: isLeg(arb) ? arb.detail : arb,
    arb_direct: isLeg(direct) ? direct.detail : direct,
    arb_kyber: isLeg(kyber) ? kyber.detail : kyber,
    one_bundle: holdExit && isLeg(direct),
    ms: { probe: probeMs, exit_sent: exitMs, direct_arb_sent: directMs, total: Date.now() - t0 },
    builders: summarizeSends(sent),
    ...o.meta,
  }
  if (!isLeg(exit) && !isLeg(arb)) {
    await log(ctx, o.seenBlock, 'nothing', detail)
    return { skipped: 'nothing for us' }
  }
  await log(ctx, o.seenBlock, 'fired', detail)
  const landed = await watchLanding(ctx, o.seenBlock, o.route, isLeg(exit) ? exit : null, LOCAL_SUBMIT ? (isLeg(arb) ? [arb] : []) : [direct, kyber].filter(isLeg))
  // Open races teach the bid: after a win offer builders a little less next time, after a loss a little more.
  const contested = o.route === 'backrun' || o.route === 'end of block' || o.route === 'test, public race'
  if (contested && (isLeg(direct) || isLeg(kyber))) {
    let outcome: 'won' | 'lost' | null = landed.arb ? 'won' : null
    if (!outcome) {
      // Only a loss if somebody else took the liquidity we bid for.
      const left = await availableUsds(client as any).catch(() => null)
      if (left !== null && left < available / 5n) outcome = 'lost'
    }
    if (outcome) {
      const r = await db('stusds_exit_race_result', { p_secret: ctx.secret, p_won: outcome === 'won', p_detail: { route: o.route, tip_share: o.tipShare, opening_usds: formatUnits(available, 18) } }).catch(() => null)
      console.log('race', outcome, 'tip share now', r?.tip_share)
    }
  }
  return { fired: true, landed }
}

/** At most one isolate acts on a given event (cron runs overlap on purpose). Fails open. */
const claim = (ctx: Ctx, key: string): Promise<boolean> =>
  db('stusds_exit_claim', { p_secret: ctx.secret, p_key: key }).then((r) => r !== false).catch(() => true)

/** Liquidity is there at the end of a block. */
async function fire(ctx: Ctx, seenBlock: number) {
  const cfg = ctx.config
  if (!cfg.enabled || !ctx.keeper) return { skipped: 'not armed' }
  // Always the confirmed nonce: a still-pending public copy of an earlier attempt
  // must be replaced, not queued behind (builders drop bundles with a nonce gap).
  const n = await client.getTransactionCount({ address: ctx.keeper.address, blockTag: 'latest' })
  // Some validators build their own blocks from the public mempool, which no bundle
  // reaches. A public copy of the exit covers those (beaten, it just reverts cheaply).
  return await runRoute(ctx, { route: 'end of block', seenBlock, preceding: [], n, tipShare: Number(cfg.arb_tip_share_race ?? 0.85), nTargets: 3, publicCopy: true })
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
    if (toEngine && m === 'wipeAll') repay += 1 // the whole loan; the simulation measures the real amount
    parts.push(toEngine && (m === 'wipe' || m === 'draw') && p.wad ? `${m} ${Number(formatUnits(BigInt(p.wad), 18)).toLocaleString('en-US')}` : m)
  }
  return { repay, summary: parts.join(' + ').slice(0, 200) }
}

/**
 * Safe route. A repayment that sits fully signed in a Safe's queue can be
 * submitted by anyone: the owners' signatures are the authorisation and the
 * submitter only pays gas. We submit it ourselves with our transactions right
 * behind it, as one bundle, so the freed USDS reaches the exit before anyone
 * else. We execute exactly what the owners signed (checked against the Safe's
 * own transaction hash) and nothing else.
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

  const head = await getHead()
  if ((safeRouteSent.get(t.safeTxHash) ?? 0) > Number(head.number)) return { skipped: 'already covering the next blocks' }
  if (!(await claim(ctx, `safe:${t.safeTxHash}:${head.number}`))) return { skipped: 'another run is handling it' }
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
  const exec = await signTx(keeper, { to: safe, data: execData, gas: execGas }, Number(cfg.priority_gwei ?? 1), n)
  safeRouteSent.set(t.safeTxHash, Number(head.number) + 2)
  // Never public: their signed transaction goes only to builders, inside our bundle.
  return await runRoute(ctx, {
    route: 'Safe route', seenBlock: Number(head.number), preceding: [exec.raw], n: n + 1, extraGas: execGas,
    tipShare: Number(cfg.arb_tip_share_safe ?? 0.3), nTargets: 3,
    meta: { safeTxHash: t.safeTxHash, safe, safe_nonce: Number(onchainNonce), exec_hash: exec.hash, summary: describeSafeTx(t).summary },
  })
}

/**
 * The Safe's recent transactions from Safe's transaction service. Without an
 * API key the service allows about 5,000 requests a month per address, so the
 * database function paces itself and serves its last answer in between. With
 * SAFE_API_KEY set, the function asks Safe directly at `safe_poll_seconds`.
 */
const SAFE_API = 'https://api.safe.global/tx-service/eth/api/v1'
async function safeTxList(ctx: Ctx, safe: Hex) {
  const key = env('SAFE_API_KEY')
  if (key) {
    const r = await fetch(`${SAFE_API}/safes/${safe}/multisig-transactions/?limit=12`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`Safe API (with key) answered ${r.status}`)
    return await r.json()
  }
  const viaDb = await db('stusds_exit_safe_fetch', { p_secret: ctx.secret, p_safe: safe, p_limit: 12 })
  if (viaDb?.status === 200 && viaDb.body) return viaDb.body
  throw new Error(`Safe API without a key: ${viaDb?.status ?? '?'} ${viaDb?.error ?? ''}`.trim())
}

const watchedSafes = (cfg: any): Hex[] =>
  String(cfg.watch_safe ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => getAddress(s))

async function pollSafe(ctx: Ctx, safe: Hex) {
  const [txs, onchainNonce, threshold] = await Promise.all([
    safeTxList(ctx, safe),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
  ])
  // The chain decides what is still pending, not the API's executed flag.
  for (const t of txs.results ?? []) {
    if (BigInt(t.nonce) !== onchainNonce || describeSafeTx(t).repay <= 0) continue
    const r = await safeRoute(ctx, safe, t, onchainNonce, threshold).catch((e) => ({ error: String(e).slice(0, 300) }))
    console.log('safe route', t.safeTxHash.slice(0, 10), JSON.stringify(r).slice(0, 300))
  }
  const rows = (txs.results ?? [])
    // A pending transaction below the Safe's current nonce has been replaced and can never run.
    .filter((t: any) => t.isExecuted || BigInt(t.nonce) >= onchainNonce)
    .map((t: any) => {
      const d = describeSafeTx(t)
      return {
        safe_tx_hash: t.safeTxHash,
        safe,
        nonce: t.nonce,
        proposed_at: t.submissionDate,
        executed_at: t.isExecuted ? t.executionDate : null,
        confirmations: t.confirmations?.length ?? 0,
        required: t.confirmationsRequired ?? Number(threshold),
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
  // pg_cron starts this once a minute. With an API key, poll every few seconds so a
  // repayment that becomes fully signed is seen at once; without one, twice a minute
  // (the database function serves its paced, cached answer).
  const everyMs = env('SAFE_API_KEY') ? Math.max(3, Number(ctx.config.safe_poll_seconds ?? 10)) * 1000 : 30_000
  const until = Date.now() + 55_000
  while (Date.now() < until) {
    const roundStart = Date.now()
    for (const safe of safes) {
      try {
        await pollSafe(ctx, safe)
        delete failures[safe]
      } catch (e) {
        failures[safe] = String(e).slice(0, 200)
      }
    }
    const wait = everyMs - (Date.now() - roundStart)
    if (Date.now() + wait >= until) break
    await sleep(Math.max(wait, 500))
  }
  // A blind Safe watch must be visible, but once an hour is enough.
  if (Object.keys(failures).length && (await claim(ctx, `safe_blind:${Math.floor(Date.now() / 3_600_000)}`))) {
    console.error('safe poll failing', JSON.stringify(failures))
    await log(ctx, null, 'safe_poll_failed', { failures, has_api_key: !!env('SAFE_API_KEY') })
  }
}

// ---------- pending-transaction watch (backruns) ----------
//
// Public repayments and deposits are seen before they are mined. We put our
// exit and the arb directly behind them, as one bundle that only lands if the
// repayment does, in the same block.

// Two independent feeds: each node only sees part of the public queue (on 25 Nov one showed well under half of what the other did).
const PENDING_WS = ['wss://ethereum-rpc.publicnode.com', 'wss://0xrpc.io/eth']
// Optional third feed: an Alchemy key in the function's secrets (any name containing "alchemy"; a bare key or a full
// endpoint URL both work). Alchemy filters on its side, so it only sends transactions addressed to the contracts below.
function alchemyKey(): string {
  const hit = Object.entries(Deno.env.toObject()).find(([k, v]) => /alchemy/i.test(k) && v)
  if (!hit) return ''
  const v = hit[1].trim()
  const m = v.match(/\/v2\/([A-Za-z0-9_-]{16,})/)
  return m ? m[1] : /^[A-Za-z0-9_-]{16,}$/.test(v) ? v : ''
}
const ENTRY_POINTS = ['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', '0x0000000071727De22E5E9d8BAf0edAc6f37da032'] // ERC-4337 bundlers
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

async function backrun(ctx: Ctx, victim: any, victimRaw?: Hex) {
  const raw = victimRaw ?? rebuildRaw(victim) ?? (await rawTransaction(victim.hash))
  if (!raw) return { skipped: 'raw transaction not available' }
  const [n, head] = await Promise.all([client.getTransactionCount({ address: ctx.keeper!.address, blockTag: 'latest' }), getHead()])
  return await runRoute(ctx, {
    route: 'backrun', seenBlock: Number(head.number), preceding: [raw], n, tipShare: Number(ctx.config.arb_tip_share_race ?? 0.85), nTargets: 3,
    meta: { victim: victim.hash, from: victim.from, to: victim.to },
  })
}

/** Watch pending transactions for ~110 s (pg_cron starts one run a minute; runs overlap). */
async function mempoolWatch(ctx: Ctx) {
  const cfg = ctx.config
  if (!cfg.mempool_enabled || !cfg.enabled || !ctx.keeper) return
  const minWad = parseUnits(String(cfg.trigger_min_usds ?? 20), 18)
  const seen = new Set<string>()
  const deadline = Date.now() + 110_000
  let closed = false
  let candidates = 0
  let busy = Promise.resolve()
  const firstFrom: Record<string, number> = {}
  const handle = (tx: any, feed: string) => {
    if (!tx?.hash || seen.has(tx.hash)) return
    seen.add(tx.hash)
    firstFrom[feed] = (firstFrom[feed] ?? 0) + 1
    if (String(tx.from ?? '').toLowerCase() === ctx.keeper!.address.toLowerCase()) return
    if (!isCandidate(tx)) return
    const hint = amountHint(tx)
    if (hint !== null && hint < minWad) return // readable and too small to matter
    candidates++
    // One at a time per run: they share the bot key's nonce.
    busy = busy.then(async () => {
      if (!(await claim(ctx, `bk:${tx.hash}`))) return
      const r = await backrun(ctx, tx).catch((e) => ({ error: String(e).slice(0, 200) }))
      console.log('backrun', tx.hash, JSON.stringify(r).slice(0, 200))
    })
  }
  const sockets = new Set<WebSocket>()
  const connect = (url: string, params: unknown[] = ['newPendingTransactions', true]) => {
    if (closed || Date.now() > deadline - 3000) return
    const ws = new WebSocket(url)
    sockets.add(ws)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params }))
    ws.onmessage = (m) => {
      try {
        const r = JSON.parse(String(m.data))?.params?.result
        if (r && typeof r === 'object') handle(r, new URL(url).host)
      } catch { /* ignore malformed frames */ }
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* closed */ }
    }
    ws.onclose = () => {
      sockets.delete(ws)
      if (!closed) setTimeout(() => connect(url, params), 1500)
    }
  }
  PENDING_WS.forEach((u) => connect(u))
  const alchemy = alchemyKey()
  if (alchemy) {
    const toAddress = [LOCKSTAKE_ENGINE, ST_USDS, ...String(cfg.watch_safe ?? '').split(',').map((x) => x.trim()).filter(Boolean), ...ENTRY_POINTS]
    connect(`wss://eth-mainnet.g.alchemy.com/v2/${alchemy}`, ['alchemy_pendingTransactions', { toAddress, hashesOnly: false }])
  }
  while (Date.now() < deadline) await sleep(1000)
  closed = true
  for (const ws of sockets) {
    try { ws.close() } catch { /* closed */ }
  }
  await busy
  // Heartbeat for the dashboard: the pending feed is alive and this many transactions went past.
  await db('stusds_exit_heartbeat', { p_secret: ctx.secret, p_kind: 'mempool', p_detail: { seen: seen.size, candidates, first_seen_by: firstFrom } }).catch(() => null)
  console.log(`mempool run done: ${seen.size} pending transactions seen, ${candidates} candidates`)
}

/**
 * Live check of the simulation plumbing, sending nothing: asks Flashbots to
 * simulate (1) the liquidity lens alone and (2) a tiny deposit by the bot key
 * followed by the lens, and compares both with a plain read of the chain.
 */
async function simcheck(ctx: Ctx) {
  const keeper = ctx.keeper!
  const prio = Number(ctx.config.priority_gwei ?? 1)
  const n = await client.getTransactionCount({ address: keeper.address, blockTag: 'latest' })
  const direct = await availableUsds(client as any)
  const lens = await lensData()
  const lens0 = await signTx(keeper, { to: MULTICALL3, data: lens, gas: 400_000n }, prio, n)
  const s1 = await simulateBundle(ctx, [lens0.raw])
  const out: any = { available_by_direct_read: formatUnits(direct, 18), lens_alone: s1.results[0]?.value ? formatUnits(decodeLens(s1.results[0].value), 18) : s1 }
  const [bal, allowance] = await Promise.all([
    client.readContract({ address: USDS, abi: tokenAbi, functionName: 'balanceOf', args: [keeper.address] }),
    client.readContract({ address: USDS, abi: tokenAbi, functionName: 'allowance', args: [keeper.address, ST_USDS] }),
  ])
  const amount = parseUnits('0.3', 18)
  if (bal >= amount && allowance >= amount) {
    const dep = await signTx(keeper, { to: ST_USDS, data: encodeFunctionData({ abi: tokenAbi, functionName: 'deposit', args: [amount, keeper.address] }), gas: 450_000n }, prio, n)
    const lens1 = await signTx(keeper, { to: MULTICALL3, data: lens, gas: 400_000n }, prio, n + 1)
    const s2 = await simulateBundle(ctx, [dep.raw, lens1.raw])
    out.after_simulated_deposit_of_0_3 = s2.results[1]?.value ? formatUnits(decodeLens(s2.results[1].value), 18) : s2
    out.deposit_return_shares = s2.results[0]?.value ? formatUnits(BigInt(s2.results[0].value), 18) : s2.results[0]
  } else out.after_simulated_deposit_of_0_3 = 'skipped: bot key has no approved USDS to simulate with'
  return out
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
  if (ctx.config.arb2_address) {
    out.arb_direct = {
      address: ctx.config.arb2_address,
      code: await verifyArb2(client as any, getAddress(ctx.config.arb2_address), getAddress(MAIN_WALLET), ctx.keeper!.address)
        .then(() => 'verified: tested build, profit to main wallet, bot key as keeper, fixed venue list').catch((e) => `REJECTED: ${String(e)}`),
      quoter: ctx.config.arb_quoter_address ?? null,
      quoter_code: ctx.config.arb_quoter_address
        ? await verifyQuoter(client as any, getAddress(ctx.config.arb_quoter_address)).then(() => 'verified: tested build').catch((e) => `REJECTED: ${String(e)}`)
        : 'none',
    }
  }
  out.mempool_watch = !!ctx.config.mempool_enabled
  out.alchemy_feed = !!alchemyKey()
  out.safe_api_key = !!env('SAFE_API_KEY')
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

/** Deploy the direct-routing arb contract (profit fixed to the main wallet, bot key as keeper, fixed venue list). */
async function deployArb2(ctx: Ctx) {
  const receipt = await sendPublic(ctx.keeper!, { data: arb2DeployData(getAddress(MAIN_WALLET), ctx.keeper!.address), gas: 2_500_000n })
  const address = receipt.contractAddress!
  await verifyArb2(client as any, address, getAddress(MAIN_WALLET), ctx.keeper!.address)
  const q = await sendPublic(ctx.keeper!, { data: quoterDeployData(), gas: 900_000n })
  const quoter = q.contractAddress!
  await verifyQuoter(client as any, quoter)
  await log(ctx, receipt.blockNumber, 'deployed_arb2', { address, tx: receipt.transactionHash, quoter, quoter_tx: q.transactionHash })
  return { address, tx: receipt.transactionHash, gas_used: receipt.gasUsed, quoter, quoter_tx: q.transactionHash, quoter_gas_used: q.gasUsed }
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
  // Live tests of the whole chain. 'alone': the deposit travels only inside our own bundle, in front of the exit and
  // the arb, so nobody can compete. 'race': the deposit is also broadcast publicly, and every bot may follow it.
  if (body.mode === 'alone' || body.mode === 'race') {
    const cfg = ctx.config
    const [n, head] = await Promise.all([client.getTransactionCount({ address: k.address, blockTag: 'latest' }), getHead()])
    const dep = await signTx(k, req, Number(cfg.priority_gwei ?? 1), n)
    await log(ctx, Number(head.number), 'drill_deposit', { usds: body.usds, mode: body.mode, tx: dep.hash })
    if (body.mode === 'race' && !LOCAL_SUBMIT) await Promise.all(PUBLIC_MEMPOOL.map((u) => publicSend(u, dep.raw)))
    const out = await runRoute(ctx, {
      route: body.mode === 'race' ? 'test, public race' : 'test, alone', seenBlock: Number(head.number), preceding: [dep.raw], n: n + 1,
      tipShare: Number(body.mode === 'race' ? cfg.arb_tip_share_race ?? 0.99 : cfg.arb_tip_share_safe ?? 0.3), nTargets: 3,
      meta: { test_deposit: dep.hash, test_usds: body.usds },
    })
    return { mode: body.mode, deposit_tx: dep.hash, ...out }
  }
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
        if (LOCAL_SUBMIT) return json(await fire(ctx, Number(body.block)))
        background(fire(ctx, Number(body.block)).then((r) => console.log('fire', JSON.stringify(r))))
        return json({ started: true })
      case 'tick_once': {
        // Fork rehearsals only: one pass over the Safe queues, awaited.
        if (!LOCAL_SUBMIT) return json({ error: 'unknown action' }, 400)
        const out: Record<string, unknown> = {}
        for (const safe of watchedSafes(ctx.config)) out[safe] = await pollSafe(ctx, safe).catch((e) => ({ error: String(e).slice(0, 300) }))
        return json(out)
      }
      case 'tick':
        background(tick(ctx))
        return json({ started: true })
      case 'mempool':
        background(mempoolWatch(ctx))
        return json({ started: true })
      case 'deploy_arb':
        return json(await deployArb(ctx))
      case 'deploy_arb2':
        return json(await deployArb2(ctx))
      case 'simcheck':
        return json(await simcheck(ctx))
      case 'backrun_test': {
        // Fork rehearsals only: treat a signed transaction we are handed as a pending one.
        if (!LOCAL_SUBMIT) return json({ error: 'unknown action' }, 400)
        const raw = body.raw as Hex
        return json(await backrun(ctx, { hash: keccak256(raw), from: body.from ?? null, to: body.to ?? null }, raw))
      }
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
