// stUSDS exit bot - Supabase edge function.
//
// Fires a private, revert-protected redemption through the owner's StUsdsExit
// contract when the block observer reports withdrawable liquidity, and watches
// a Safe's public transaction queue for repayments that are about to land.
//
// Every route is a POST authenticated by the secret pg_cron/pg_net send
// (checked in Postgres). Keys are generated here, stored in Vault and never
// returned by any route.
//
// Safety properties this function relies on:
//  - The exit contract can only pay the owner it was deployed for, so a
//    mistake here cannot send funds anywhere else.
//  - Withdrawals are sent only as single-transaction bundles straight to block
//    builders: a transaction that would revert is not included and costs nothing.
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

/** Ordinary public transaction (setup steps only - never used for the exit itself). */
async function sendPublic(account: PrivateKeyAccount, req: TxReq) {
  const { raw, hash } = await signTx(account, req, 1.5)
  await client.sendRawTransaction({ serializedTransaction: raw })
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 2000 })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return receipt
}

async function builderCall(b: (typeof BUILDERS)[number], signer: PrivateKeyAccount, method: string, params: unknown[]) {
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
    return { builder: b.name, status: res.status, ms: Date.now() - started, body: text.slice(0, 200) }
  } catch (e) {
    return { builder: b.name, error: String(e).slice(0, 120), ms: Date.now() - started }
  }
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
  // Keep enough ETH back to pay for gas at a generous fee.
  const reserve = gas * parseGwei('20')
  let tip = parseGwei(String(cfg.tip_gwei ?? 0))
  if (balance < reserve) tip = 0n
  else if (tip > balance - reserve) tip = balance - reserve
  const data = encodeFunctionData({ abi: exitAbi, functionName: 'exit', args: [maxUint256, minAssets] })
  return { keeper, helper, minAssets, gas, shares, balance, tip, data }
}

/** The main path: liquidity is there, send the exit privately for the next blocks. */
async function fire(ctx: Ctx, seenBlock: number) {
  const started = Date.now()
  const cfg = ctx.config
  if (!cfg.enabled || !cfg.helper_address || !ctx.keeper) return { skipped: 'not armed' }
  const x = await buildExit(ctx)
  if (x.shares === 0n) {
    await log(ctx, seenBlock, 'nothing_redeemable', { ms: Date.now() - started })
    return { skipped: 'nothing redeemable' }
  }
  let expected: bigint
  try {
    const sim = await client.simulateContract({
      address: x.helper,
      abi: exitAbi,
      functionName: 'exit',
      args: [maxUint256, x.minAssets],
      account: x.keeper.address,
      value: x.tip,
    })
    expected = sim.result
  } catch (e) {
    await log(ctx, seenBlock, 'simulation_reverted', { error: String(e).slice(0, 300), ms: Date.now() - started })
    return { skipped: 'simulation reverted' }
  }

  const { raw, hash, head, nonce } = await signTx(x.keeper, { to: x.helper, data: x.data, value: x.tip, gas: x.gas }, Number(cfg.priority_gwei ?? 2))
  const targets = [head.number + 1n, head.number + 2n, head.number + 3n]
  const sent = LOCAL_SUBMIT
    ? [{ builder: 'local-fork', body: await client.sendRawTransaction({ serializedTransaction: raw }) }]
    : await Promise.all(
      BUILDERS.flatMap((b) => targets.map((t) => builderCall(b, x.keeper, 'eth_sendBundle', [{ txs: [raw], blockNumber: toHex(t) }]))),
    )
  const sentMs = Date.now() - started
  await log(ctx, seenBlock, 'fired', {
    hash,
    nonce,
    head: Number(head.number),
    head_age_ms: Date.now() - Number(head.timestamp) * 1000,
    targets: targets.map(Number),
    expected_usds: formatUnits(expected, 18),
    tip_eth: formatEther(x.tip),
    ms: sentMs,
    builders: sent,
  })

  // Did it land?
  for (let i = 0; i < 20; i++) {
    await sleep(2500)
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
    if (receipt) {
      const detail = {
        hash,
        block: Number(receipt.blockNumber),
        index: receipt.transactionIndex,
        status: receipt.status,
        gas_used: Number(receipt.gasUsed),
        expected_usds: formatUnits(expected, 18),
        blocks_after_seen: Number(receipt.blockNumber) - seenBlock,
      }
      await log(ctx, receipt.blockNumber, 'included', detail)
      await notify(
        ctx,
        'stusds:exit',
        receipt.status === 'success' ? 'stUSDS withdrawal landed' : 'stUSDS withdrawal reverted on-chain',
        `${usd(expected)} USDS expected, block ${receipt.blockNumber} position ${receipt.transactionIndex} (${cfg.target_name}). https://etherscan.io/tx/${hash}`,
      )
      return detail
    }
  }
  await log(ctx, seenBlock, 'not_included', { hash, targets: targets.map(Number) })
  return { hash, included: false }
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

async function pollSafe(ctx: Ctx) {
  const safe = getAddress(ctx.config.watch_safe)
  const base = `https://safe-transaction-mainnet.safe.global/api/v1/safes/${safe}`
  const get = async (u: string) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`safe api ${r.status}`)
    return r.json()
  }
  const [info, txs] = await Promise.all([get(`${base}/`), get(`${base}/multisig-transactions/?limit=12`)])
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
  if (!ctx.config.watch_safe) return
  for (let i = 0; i < 3; i++) {
    try {
      await pollSafe(ctx)
    } catch (e) {
      console.error('safe poll failed', String(e))
    }
    if (i < 2) await sleep(20_000)
  }
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

/** Test wallet only: give it gas money and approve its exit contract. */
async function approveTest(ctx: Ctx) {
  const t = ctx.testOwner!
  const { helper, owner } = await verifyHelper(ctx)
  if (owner !== t.address) throw new Error('configured helper does not belong to the test wallet')
  const need = parseEther('0.0003')
  if ((await client.getBalance({ address: t.address })) < need) {
    await sendPublic(ctx.keeper!, { to: t.address, value: need, gas: 21_000n })
  }
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
  const r = await sendPublic(k, { to: ST_USDS, data: encodeFunctionData({ abi: tokenAbi, functionName: 'deposit', args: [amount, k.address] }), gas: 450_000n })
  await log(ctx, r.blockNumber, 'drill_deposit', { usds: body.usds, tx: r.transactionHash, index: r.transactionIndex })
  return { deposited_usds: body.usds, block: r.blockNumber, index: r.transactionIndex, tx: r.transactionHash }
}

/** Return test funds to the main wallet. The destination is fixed. */
async function sweep(ctx: Ctx, body: any) {
  const done: any[] = []
  for (const acct of [ctx.testOwner, ctx.keeper]) {
    if (!acct) continue
    for (const token of [USDS, ST_USDS] as Hex[]) {
      const bal = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [acct.address] })
      if (bal === 0n) continue
      if ((await client.getBalance({ address: acct.address })) < parseEther('0.0002') && acct !== ctx.keeper) {
        await sendPublic(ctx.keeper!, { to: acct.address, value: parseEther('0.0003'), gas: 21_000n })
      }
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
  const { raw, hash, head } = await signTx(x.keeper, { to: x.helper, data: x.data, value: x.tip, gas: x.gas }, Number(ctx.config.priority_gwei ?? 2))
  const fb = BUILDERS.find((b) => b.name === 'flashbots')!
  const sim = await builderCall(fb, x.keeper, 'eth_callBundle', [{ txs: [raw], blockNumber: toHex(head.number + 1n), stateBlockNumber: 'latest' }])
  return { hash, redeemable_shares: formatUnits(x.shares, 18), tip_eth: formatEther(x.tip), keeper_eth: formatEther(x.balance), flashbots_simulation: sim }
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
