// Chain-reading logic shared by the Supabase edge function (Deno) and the
// in-session watcher (Node). No dependencies: fetch + BigInt only, and only
// erasable TypeScript syntax so Node can run it with type stripping.
//
// Utilization mirrors the stUSDS contract's own withdrawal check
// (StUsds._burn / maxWithdraw):
//
//   withdrawable = totalSupply * chi  -  (Art * rate + clip.Due())
//
// where `rate` is the Vat rate with Jug interest accrued up to the block
// timestamp. So:  utilization = (Art * rate' + Due) / (totalAssets * RAY).

export const RAY = 10n ** 27n
export const WAD = 10n ** 18n

export const ADDR = {
  stUsds: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9',
  vat: '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B',
  jug: '0x19c0976f590D67707E62397C87829d896Dc0f1F1',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
}

// Fallbacks, used only if reading them from stUSDS fails at startup.
export const DEFAULT_SETUP: Setup = {
  clip: '0x836F56750517b1528B5078Cba4Ac4B94fBE4A399',
  // bytes32("LSEV2-SKY-A")
  ilk: '0x4c534556322d534b592d41000000000000000000000000000000000000000000',
}

const SEL = {
  aggregate3: '0x82ad56cb',
  getCurrentBlockTimestamp: '0x0f28c97d',
  getBlockNumber: '0x42cbb15c',
  totalAssets: '0x01e1d114',
  ilks: '0xd9638d36', // same signature on Vat and Jug
  due: '0x08bf162f',
  clip: '0x39b00e41',
  ilk: '0xc5ce281e',
}

export type Endpoint = { name: string; http: string; ws?: string }

// Public endpoints. Override with RPC_ENDPOINTS (JSON array of Endpoint).
export const DEFAULT_ENDPOINTS: Endpoint[] = [
  { name: 'publicnode', http: 'https://ethereum-rpc.publicnode.com', ws: 'wss://ethereum-rpc.publicnode.com' },
  { name: 'drpc', http: 'https://eth.drpc.org', ws: 'wss://eth.drpc.org' },
  { name: 'tenderly', http: 'https://mainnet.gateway.tenderly.co', ws: 'wss://mainnet.gateway.tenderly.co' },
  { name: 'mevblocker', http: 'https://rpc.mevblocker.io' },
]

export type Setup = { clip: string; ilk: string }

export type Snapshot = {
  block: number
  timestamp: number // block timestamp, unix seconds
  totalAssets: bigint // wad
  debtRad: bigint // rad, interest accrued to the block timestamp, plus Due
  availableWad: bigint // withdrawable USDS, wad
  utilPpm: number // parts per million, 4 decimals (999852.6813 = 99.98526813%)
}

// ---------- ABI helpers ----------

const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h)
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')
const padRight = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')

export type Call = { target: string; data: string }

/** Encode Multicall3.aggregate3((address,bool,bytes)[]) with allowFailure = true. */
export function encodeAggregate3(calls: Call[]): string {
  const tuples = calls.map((c) => {
    const d = strip(c.data)
    return strip(c.target).toLowerCase().padStart(64, '0') + word(1) + word(0x60) + word(d.length / 2) + padRight(d)
  })
  let offset = calls.length * 32
  const offsets: string[] = []
  for (const t of tuples) {
    offsets.push(word(offset))
    offset += t.length / 2
  }
  return SEL.aggregate3 + word(0x20) + word(calls.length) + offsets.join('') + tuples.join('')
}

/** Decode the (bool success, bytes returnData)[] result of aggregate3. */
export function decodeAggregate3(hex: string): { success: boolean; data: string }[] {
  const h = strip(hex)
  if (h.length < 128) throw new Error('empty multicall result')
  const w = (byteOff: number) => {
    const s = h.slice(byteOff * 2, byteOff * 2 + 64)
    if (s.length !== 64) throw new Error('truncated multicall result')
    return BigInt('0x' + s)
  }
  const arr = Number(w(0))
  const n = Number(w(arr))
  const base = arr + 32
  const out: { success: boolean; data: string }[] = []
  for (let i = 0; i < n; i++) {
    const t = base + Number(w(base + i * 32))
    const success = w(t) !== 0n
    const b = t + Number(w(t + 32))
    const len = Number(w(b))
    out.push({ success, data: h.slice((b + 32) * 2, (b + 32 + len) * 2) })
  }
  return out
}

const wordAt = (data: string, i: number) => {
  const s = data.slice(i * 64, i * 64 + 64)
  if (s.length !== 64) throw new Error('short return data')
  return BigInt('0x' + s)
}

/** DSS Jug._rpow: x^n in fixed point `base`, rounding half up at each step. */
export function rpow(x: bigint, n: bigint, base: bigint = RAY): bigint {
  if (x === 0n) return n === 0n ? base : 0n
  let z = n % 2n === 0n ? base : x
  const half = base / 2n
  for (n = n / 2n; n > 0n; n = n / 2n) {
    x = (x * x + half) / base
    if (n % 2n === 1n) z = (z * x + half) / base
  }
  return z
}

// ---------- pure evaluation ----------

export type Raw = {
  block: bigint
  timestamp: bigint
  totalAssets: bigint
  art: bigint
  rate: bigint
  duty: bigint
  rho: bigint
  due: bigint
}

export function toSnapshot(r: Raw): Snapshot {
  if (r.totalAssets <= 0n) throw new Error('totalAssets is zero')
  const rate = r.timestamp > r.rho ? (rpow(r.duty, r.timestamp - r.rho) * r.rate) / RAY : r.rate
  const debtRad = r.art * rate + r.due
  const totalRad = r.totalAssets * RAY
  const availableWad = totalRad > debtRad ? (totalRad - debtRad) / RAY : 0n
  const utilPpm = Number((debtRad * 10n ** 10n) / totalRad) / 1e4
  return {
    block: Number(r.block),
    timestamp: Number(r.timestamp),
    totalAssets: r.totalAssets,
    debtRad,
    availableWad,
    utilPpm,
  }
}

/** Exact check: utilization <= thresholdPpm / 1e6. */
export function isAtOrBelow(s: Snapshot, thresholdPpm: bigint): boolean {
  return s.debtRad * 1_000_000n <= s.totalAssets * RAY * thresholdPpm
}

// ---------- RPC ----------

export async function rpc(url: string, method: string, params: unknown[], timeoutMs = 2500): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 80)}`)
  }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
  if (body.result === undefined || body.result === null) throw new Error(`${method}: no result`)
  return body.result
}

export async function latestBlockNumber(url: string, timeoutMs = 2000): Promise<number> {
  const n = parseInt(await rpc(url, 'eth_blockNumber', [], timeoutMs), 16)
  if (!Number.isFinite(n) || n <= 0) throw new Error('bad block number')
  return n
}

async function multicall(url: string, calls: Call[], blockTag: string, timeoutMs: number) {
  const result = await rpc(url, 'eth_call', [{ to: ADDR.multicall3, data: encodeAggregate3(calls) }, blockTag], timeoutMs)
  const out = decodeAggregate3(result)
  if (out.length !== calls.length) throw new Error('multicall length mismatch')
  out.forEach((o, i) => {
    if (!o.success) throw new Error(`multicall sub-call ${i} reverted`)
  })
  return out.map((o) => o.data)
}

/** Read the clipper and ilk stUSDS currently points at (they can be replaced by governance). */
export async function readSetup(url: string, timeoutMs = 4000): Promise<Setup> {
  const [clip, ilk] = await multicall(
    url,
    [
      { target: ADDR.stUsds, data: SEL.clip },
      { target: ADDR.stUsds, data: SEL.ilk },
    ],
    'latest',
    timeoutMs,
  )
  const clipAddr = '0x' + clip.slice(24, 64)
  if (clip.length !== 64 || ilk.length !== 64 || /^0x0+$/.test(clipAddr)) throw new Error('bad setup data')
  return { clip: clipAddr, ilk: '0x' + ilk }
}

/**
 * Read everything needed for one utilization figure in a single eth_call, so
 * all values come from the same block. `block` pins the read to that block
 * number; omit it for "latest".
 */
export async function readSnapshot(url: string, setup: Setup, block?: number, timeoutMs = 2500): Promise<Snapshot> {
  const tag = block === undefined ? 'latest' : '0x' + block.toString(16)
  const ilk = strip(setup.ilk)
  const d = await multicall(
    url,
    [
      { target: ADDR.multicall3, data: SEL.getBlockNumber },
      { target: ADDR.multicall3, data: SEL.getCurrentBlockTimestamp },
      { target: ADDR.stUsds, data: SEL.totalAssets },
      { target: ADDR.vat, data: SEL.ilks + ilk },
      { target: ADDR.jug, data: SEL.ilks + ilk },
      { target: setup.clip, data: SEL.due },
    ],
    tag,
    timeoutMs,
  )
  const snap = toSnapshot({
    block: wordAt(d[0], 0),
    timestamp: wordAt(d[1], 0),
    totalAssets: wordAt(d[2], 0),
    art: wordAt(d[3], 0),
    rate: wordAt(d[3], 1),
    duty: wordAt(d[4], 0),
    rho: wordAt(d[4], 1),
    due: wordAt(d[5], 0),
  })
  if (block !== undefined && snap.block !== block) throw new Error(`asked for block ${block}, got ${snap.block}`)
  return snap
}

/**
 * Run `fn` against the endpoints in order, starting the next one if the
 * previous has not answered within `hedgeMs`. Resolves with the first success.
 */
export function hedged<T>(urls: string[], fn: (url: string) => Promise<T>, hedgeMs = 350): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = 0
    let started = 0
    let done = false
    let lastErr: unknown = new Error('no endpoints')
    const timers: ReturnType<typeof setTimeout>[] = []
    const startNext = () => {
      if (done || started >= urls.length) return
      const url = urls[started++]
      pending++
      fn(url).then(
        (v) => {
          if (done) return
          done = true
          timers.forEach(clearTimeout)
          resolve(v)
        },
        (e) => {
          lastErr = e
          pending--
          if (done) return
          if (started < urls.length) startNext()
          else if (pending === 0) {
            done = true
            reject(lastErr)
          }
        },
      )
      if (started < urls.length) timers.push(setTimeout(startNext, hedgeMs))
    }
    startNext()
  })
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Read the state at exactly `block`. A load-balanced endpoint can announce a
 * block before every backend has it, so retry briefly across endpoints.
 */
export async function readSnapshotAt(urls: string[], setup: Setup, block: number, attempts = 5): Promise<Snapshot> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await hedged(urls, (u) => readSnapshot(u, setup, block))
    } catch (e) {
      lastErr = e
      await sleep(150 * (i + 1))
    }
  }
  throw lastErr
}

// ---------- formatting ----------

export function fmtUsds(wad: bigint): string {
  const whole = (wad / WAD).toString()
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtPct(ppm: number, digits = 3): string {
  // Truncate rather than round, so a figure just above a threshold never prints as below it.
  const f = 10 ** digits
  return (Math.floor((ppm / 1e4) * f) / f).toFixed(digits) + '%'
}
