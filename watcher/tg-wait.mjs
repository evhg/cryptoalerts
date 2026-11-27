// Waits until a Telegram message is waiting for the session, then exits.
//
// Run as a background command inside the Claude session. Nothing can start a turn in the session from outside,
// but a background command that ends does: the session is told, reads `stusds_alert.v_tg_pending`, answers, and
// starts this watcher again. The function holds each request open (a long poll), so this makes about two
// requests a minute while idle and reacts within a couple of seconds.
//
//   TG_POLL_KEY=...  node watcher/tg-wait.mjs
//
// Exit lines: TELEGRAM pending=N (messages are waiting), EXPIRED (ran its time, start it again),
// UNAUTHORIZED (wrong key), UNREACHABLE (the function did not answer for several minutes).

const URL_BASE = process.env.TG_POLL_URL ?? 'https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/tg-bot'
const KEY = process.env.TG_POLL_KEY ?? ''
const MAX_MS = Number(process.env.TG_WAIT_MAX_MS ?? 110 * 60 * 1000)
const started = Date.now()
const stamp = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' Bangkok time'

if (!KEY) {
  console.log('UNAUTHORIZED no TG_POLL_KEY given')
  process.exit(2)
}

let failures = 0
while (Date.now() - started < MAX_MS) {
  try {
    const res = await fetch(`${URL_BASE}?poll=${encodeURIComponent(KEY)}`, { signal: AbortSignal.timeout(70_000) })
    if (res.status === 401) {
      console.log('UNAUTHORIZED the poll key was refused')
      process.exit(2)
    }
    const body = await res.json()
    failures = 0
    if (Number(body.pending) > 0) {
      console.log(`TELEGRAM pending=${body.pending} at ${stamp()}`)
      process.exit(0)
    }
  } catch (e) {
    failures++
    if (failures >= 12) {
      console.log(`UNREACHABLE ${String(e).slice(0, 120)} at ${stamp()}`)
      process.exit(3)
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
}
console.log(`EXPIRED at ${stamp()}`)
