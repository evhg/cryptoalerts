// stUSDS utilization watcher - Supabase edge function.
//
// pg_cron invokes this once a minute. Each invocation watches Ethereum for
// ~110 seconds (so consecutive invocations overlap and one missed minute is
// harmless): it subscribes to new block headers over WebSocket on several
// public endpoints and also polls the block number every 2s as a floor.
// Every new block is evaluated once and reported to Postgres, which decides
// atomically whether this is a new drop that deserves an alert.

import {
  DEFAULT_ENDPOINTS,
  DEFAULT_SETUP,
  type Endpoint,
  fmtPct,
  fmtUsds,
  hedged,
  isAtOrBelow,
  latestBlockNumber,
  readSetup,
  readSnapshot,
  readSnapshotAt,
  type Setup,
  sleep,
  type Snapshot,
} from './chain.ts'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const RUN_MS = 110_000
const POLL_MS = 2_000

const env = (k: string) => Deno.env.get(k) ?? ''
const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')

// Returned by stusds_alert_begin(): settings live in Postgres. The Resend key
// comes from the RESEND_API_KEY function secret if set, otherwise from Vault
// (handed over by stusds_alert_begin).
type Config = {
  resend_api_key?: string | null
  authorized: boolean
  enabled: boolean
  threshold_ppm: number
  email_to: string
  email_from: string
  notify_stale: boolean
  last_eval_at: string | null
  last_block: number
}

function endpoints(): Endpoint[] {
  const raw = env('RPC_ENDPOINTS')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length && parsed.every((e) => e?.name && e?.http)) return parsed
    } catch { /* fall through to defaults */ }
    console.error('RPC_ENDPOINTS is not a valid JSON array of {name, http, ws?}; using defaults')
  }
  return DEFAULT_ENDPOINTS
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function db(fn: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`db ${fn} ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

// ---------- email ----------

type SendResult = { ok: boolean; id?: string; error?: string }

type Mail = { subject: string; text: string; html: string }

async function sendEmail(cfg: Config, mail: Mail, idempotencyKey?: string): Promise<SendResult> {
  const key = RESEND_API_KEY || cfg.resend_api_key || ''
  if (!key) return { ok: false, error: 'no Resend API key: set the RESEND_API_KEY secret or store one through the setup route' }
  let error = 'not attempted'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      }
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: cfg.email_from, to: [cfg.email_to], ...mail }),
        signal: AbortSignal.timeout(6000),
      })
      const body = await res.text()
      if (res.ok) return { ok: true, id: JSON.parse(body).id }
      error = `resend ${res.status}: ${body.slice(0, 200)}`
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break // will not succeed on retry
    } catch (e) {
      error = String(e)
    }
    await sleep(400 * (attempt + 1))
  }
  console.error('email failed:', error)
  return { ok: false, error }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function alertEmail(s: Snapshot, thresholdPpm: number, opts: { test?: boolean; note?: string } = {}): Mail {
  const pct = fmtPct(s.utilPpm)
  const avail = fmtUsds(s.availableWad)
  // Bangkok time, per the user's standing preference (never UTC).
  const blockTime = new Date(s.timestamp * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) + ' Bangkok time'
  const delay = ((Date.now() - s.timestamp * 1000) / 1000).toFixed(1)
  const prefix = opts.test ? '[TEST] ' : ''
  const subject = `${prefix}stUSDS utilization ${pct} - ${avail} USDS withdrawable`
  const rows: [string, string][] = [
    ['Utilization', pct],
    ['Withdrawable now', `${avail} USDS`],
    ['Total stUSDS assets', `${fmtUsds(s.totalAssets)} USDS`],
    ['Alert threshold', `${fmtPct(thresholdPpm, 1)} or lower`],
    ['Block', `${s.block} (${blockTime})`],
    ['Sent', `${delay}s after the block timestamp`],
  ]
  const intro = opts.test
    ? 'This is a test of the stUSDS alert pipeline. Figures below are live, but the threshold has not necessarily been crossed.'
    : `stUSDS utilization dropped to ${pct}, at or below your ${fmtPct(thresholdPpm, 1)} threshold. Liquidity can be taken by other withdrawers or borrowers at any moment.`
  const links = [
    ['Withdraw in the Sky app', 'https://app.sky.money/?network=ethereum&widget=expert'],
    ['stUSDS contract', 'https://etherscan.io/address/0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'],
    ['Block', `https://etherscan.io/block/${s.block}`],
  ]
  const text = [
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(opts.note ? ['', `Note: ${opts.note}`] : []),
    '',
    ...links.map(([k, v]) => `${k}: ${v}`),
  ].join('\n')
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p>${esc(intro)}</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`).join('\n')}
</table>
${opts.note ? `<p style="color:#555">Note: ${esc(opts.note)}</p>` : ''}
<p>${links.map(([k, v]) => `<a href="${v}">${esc(k)}</a>`).join(' &middot; ')}</p>
</div>`
  return { subject, text, html }
}

// ---------- watch loop ----------

async function runLoop(cfg: Config) {
  const startedAt = Date.now()
  const deadline = startedAt + RUN_MS
  const eps = endpoints()
  const httpUrls = eps.map((e) => e.http)
  const thresholdPpm = BigInt(cfg.threshold_ppm)

  if (cfg.notify_stale) {
    const since = cfg.last_eval_at
      ? new Date(cfg.last_eval_at).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) + ' Bangkok time'
      : 'unknown'
    const body =
      `The stUSDS utilization watcher had not evaluated a block since ${since} (last block ${cfg.last_block}).\n` +
      'It is running again now. If this message repeats, the watcher cannot reach its Ethereum RPC endpoints.'
    sendEmail(cfg, {
      subject: 'stUSDS alert watcher was stalled',
      text: body,
      html: `<p>${esc(body).replace(/\n/g, '<br>')}</p>`,
    }).catch(() => {})
  }

  let setup: Setup = DEFAULT_SETUP
  try {
    setup = await hedged(httpUrls, (u) => readSetup(u), 500)
  } catch (e) {
    console.error('readSetup failed, using defaults:', String(e))
  }

  let lastDone = 0
  let inflight = 0
  let alertedWithoutDb = false
  let evaluated = 0
  let failures = 0

  const handle = async (snap: Snapshot, source: string) => {
    const lagMs = Date.now() - snap.timestamp * 1000
    let res: any
    try {
      res = await db('stusds_alert_observe', {
        p_block: snap.block,
        p_block_ts: new Date(snap.timestamp * 1000).toISOString(),
        p_total_assets: snap.totalAssets.toString(),
        p_debt_rad: snap.debtRad.toString(),
        p_lag_ms: lagMs,
        p_source: source,
      })
    } catch (e) {
      // State store unreachable: fail open. Resend's idempotency key limits
      // this to one email per 10 minutes across overlapping invocations.
      console.error('observe failed:', String(e))
      if (isAtOrBelow(snap, thresholdPpm) && !alertedWithoutDb) {
        alertedWithoutDb = true
        const m = alertEmail(snap, Number(thresholdPpm), {
          note: 'the alert state store was unreachable, so repeat-suppression may not apply to this message.',
        })
        await sendEmail(cfg, m, `stusds-nodb-${Math.floor(Date.now() / 600_000)}`)
      }
      return
    }
    if (res?.action === 'alert') {
      const m = alertEmail(snap, Number(thresholdPpm))
      const sent = await sendEmail(cfg, m, `stusds-alert-${res.alert_id}`)
      console.log(`ALERT block ${snap.block} util ${snap.utilPpm} email ${sent.ok ? sent.id : sent.error}`)
      try {
        await db('stusds_alert_email_result', {
          p_alert_id: res.alert_id,
          p_ok: sent.ok,
          p_email_id: sent.id ?? null,
          p_error: sent.error ?? null,
          p_latency_ms: Date.now() - snap.timestamp * 1000,
        })
      } catch (e) {
        console.error('email_result failed:', String(e))
      }
    }
  }

  const evaluate = async (block: number, source: string, preferUrl: string) => {
    if (!Number.isFinite(block) || block <= lastDone || block <= inflight) return
    inflight = block
    try {
      const urls = [preferUrl, ...httpUrls.filter((u) => u !== preferUrl)]
      const snap = await readSnapshotAt(urls, setup, block)
      if (block > lastDone) lastDone = block
      evaluated++
      await handle(snap, source)
    } catch (e) {
      failures++
      console.error(`evaluate ${block} failed:`, String(e))
    } finally {
      if (inflight === block) inflight = 0
    }
  }

  // Push path: new block headers over WebSocket.
  let closed = false
  const sockets = new Set<WebSocket>()
  const connect = (ep: Endpoint) => {
    if (closed || !ep.ws || Date.now() > deadline - 3000) return
    let ws: WebSocket
    try {
      ws = new WebSocket(ep.ws)
    } catch {
      setTimeout(() => connect(ep), 2000)
      return
    }
    sockets.add(ws)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }))
    ws.onmessage = (m) => {
      try {
        const head = JSON.parse(String(m.data))?.params?.result
        if (head?.number) evaluate(parseInt(head.number, 16), `${ep.name}/ws`, ep.http)
      } catch { /* ignore malformed frames */ }
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* already closed */ }
    }
    ws.onclose = () => {
      sockets.delete(ws)
      if (!closed) setTimeout(() => connect(ep), 1500)
    }
  }
  eps.forEach(connect)

  // Floor: poll the block number, rotating through endpoints.
  let i = 0
  while (Date.now() < deadline) {
    const ep = eps[i++ % eps.length]
    latestBlockNumber(ep.http)
      .then((n) => evaluate(n, `${ep.name}/poll`, ep.http))
      .catch(() => {})
    await sleep(POLL_MS)
  }
  closed = true
  for (const ws of sockets) {
    try { ws.close() } catch { /* already closed */ }
  }
  console.log(`run done: ${evaluated} blocks, ${failures} failures, last ${lastDone}, ${Math.round((Date.now() - startedAt) / 1000)}s`)
}

// ---------- HTTP entry ----------

let healthCache: { at: number; body: unknown } | null = null

Deno.serve(async (req) => {
  // Public, read-only health view (on-chain figures and watcher freshness only).
  if (req.method === 'GET') {
    if (!healthCache || Date.now() - healthCache.at > 10_000) {
      try {
        healthCache = { at: Date.now(), body: await db('stusds_alert_health') }
      } catch (e) {
        return json({ ok: false, error: String(e) }, 503)
      }
    }
    return json(healthCache.body)
  }

  // The caller's secret is checked against the one stored in Postgres, which
  // is also where pg_cron reads it from.
  const body = await req.json().catch(() => ({}))

  // One-time setup: store the Resend key in Vault. Guarded by a single-use
  // token whose hash was placed in stusds_alert.config beforehand.
  const setupToken = req.headers.get('x-setup-token')
  if (setupToken) {
    try {
      const res = await db('stusds_alert_set_resend_key', {
        p_token: setupToken,
        p_key: String(body?.resend_api_key ?? ''),
      })
      return json(res, res?.ok ? 200 : 400)
    } catch {
      return json({ ok: false, error: 'state store unavailable' }, 503)
    }
  }

  const secret = req.headers.get('x-cron-secret') ?? ''
  if (!secret) return json({ error: 'unauthorized' }, 401)
  let cfg: Config
  try {
    cfg = await db('stusds_alert_begin', { p_secret: secret, p_run: !body?.test })
  } catch (e) {
    console.error('begin failed:', String(e))
    return json({ error: 'state store unavailable' }, 503)
  }
  if (!cfg?.authorized) return json({ error: 'unauthorized' }, 401)

  if (body?.test) {
    try {
      const eps = endpoints()
      const urls = eps.map((e) => e.http)
      const setup = await hedged(urls, (u) => readSetup(u), 500)
      const snap = await hedged(urls, (u) => readSnapshot(u, setup), 500)
      const m = alertEmail(snap, cfg.threshold_ppm, { test: true })
      const sent = await sendEmail(cfg, m)
      return json({ sent, subject: m.subject, utilPpm: snap.utilPpm, block: snap.block })
    } catch (e) {
      return json({ error: String(e) }, 500)
    }
  }

  if (!cfg.enabled) return json({ started: false, reason: 'disabled' })
  const run = runLoop(cfg).catch((e) => console.error('run crashed:', String(e)))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(run)
  return json({ started: true })
})
