// Forwards TikTok verification codes that arrive at alerts@kicksma.sh (Resend
// inbound) to the household inboxes.
//
// pg_cron calls this once a minute; each run polls Resend's received-email list
// every ~5 s for ~55 s. Only mail that genuinely comes from TikTok is relayed
// (sender domain account.tiktok.com and a DMARC pass), so a spoofed "TikTok"
// email cannot be pushed through to the inboxes. Each email is claimed in
// Postgres before sending, so it is forwarded at most once.

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const env = (k: string) => Deno.env.get(k) ?? ''
const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND = 'https://api.resend.com'
const RUN_MS = 55_000
const POLL_MS = 5_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function db(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(6000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`db ${fn} ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function resend(path: string, init: RequestInit = {}) {
  const res = await fetch(`${RESEND}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`resend ${path} ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const bangkok = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) + ' Bangkok time'
const isTikTok = (from: string) => /@account\.tiktok\.com>?$/i.test(from.trim())

async function forwardOne(secret: string, cfg: any, item: any) {
  const claimed = await db('mailfwd_claim', { p_secret: secret, p_id: item.id, p_received_at: item.created_at, p_sender: item.from, p_subject: item.subject })
  if (!claimed) return 'already handled'
  try {
    const full = await resend(`/emails/receiving/${item.id}`)
    // Resend reports the receiving server's SPF/DKIM/DMARC verdicts at the top level.
    if ((full?.authentication ?? full?.headers?.authentication)?.dmarc !== 'pass') {
      await db('mailfwd_done', { p_secret: secret, p_id: item.id, p_ok: false, p_email_id: null, p_error: 'not forwarded: DMARC did not pass' })
      return 'skipped: DMARC did not pass'
    }
    const code = String(item.subject ?? '').match(/\b(\d{4,8})\b/)?.[1] ?? '(see below)'
    const text = [
      `TikTok code: ${code}`,
      '',
      `Sent by TikTok to ${cfg.watch_to} at ${bangkok(item.created_at)}.`,
      'If nobody here asked for it, ignore it and do not share it.',
      '',
      '--- original message ---',
      `From: ${item.from}`,
      `Subject: ${item.subject}`,
      '',
      String(full.text ?? '').slice(0, 4000),
    ].join('\n')
    const sent = await resend('/emails', {
      method: 'POST',
      headers: { 'idempotency-key': `mailfwd-${item.id}` },
      body: JSON.stringify({ from: cfg.email_from, to: cfg.forward_to, subject: `TikTok code ${code} (sent to ${cfg.watch_to})`, text }),
    })
    await db('mailfwd_done', { p_secret: secret, p_id: item.id, p_ok: true, p_email_id: sent.id ?? null, p_error: null })
    return `forwarded ${code}`
  } catch (e) {
    await db('mailfwd_done', { p_secret: secret, p_id: item.id, p_ok: false, p_email_id: null, p_error: String(e).slice(0, 300) }).catch(() => {})
    throw e
  }
}

async function run(secret: string, cfg: any) {
  const until = Date.now() + RUN_MS
  while (Date.now() < until) {
    const started = Date.now()
    try {
      const list = await resend('/emails/receiving?limit=20')
      for (const item of list.data ?? []) {
        const toUs = (item.to ?? []).some((t: string) => t.toLowerCase().includes(cfg.watch_to.toLowerCase()))
        if (!toUs || !isTikTok(String(item.from ?? ''))) continue
        const r = await forwardOne(secret, cfg, item).catch((e) => `failed: ${String(e).slice(0, 200)}`)
        if (r !== 'already handled') console.log('mail-forward', item.id, r)
      }
    } catch (e) {
      console.error('mail-forward poll failed', String(e))
    }
    const wait = POLL_MS - (Date.now() - started)
    if (Date.now() + wait >= until) break
    await sleep(Math.max(wait, 500))
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('not found', { status: 404 })
  const secret = req.headers.get('x-cron-secret') ?? ''
  if (!secret) return new Response('unauthorized', { status: 401 })
  const cfg = await db('mailfwd_begin', { p_secret: secret }).catch(() => null)
  if (!cfg?.authorized) return new Response('unauthorized', { status: 401 })
  if (!cfg.enabled) return Response.json({ started: false })
  const p = run(secret, cfg).catch((e) => console.error('mail-forward run failed', String(e)))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p)
  return Response.json({ started: true })
})
