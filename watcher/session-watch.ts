// In-session watcher: lets a Claude Code session post the alert in chat.
//
// Runs as a background command inside the session's container. It polls
// Ethereum itself (independently of the deployed Supabase watcher) and EXITS
// when something needs to be said, because a background command exiting is
// what wakes the session:
//
//   exit 10  ALERT       utilization dropped to the threshold or lower
//   exit 20  STALE       the deployed Supabase watcher has stopped evaluating blocks
//   exit 30  RPC_FAILURE this watcher itself cannot read the chain
//   exit 0   SUPERSEDED / EXPIRED   a newer instance took over, or max runtime reached
//
// Arming state survives restarts in ~/.stusds-watch/state.json, so restarting
// after an alert does not re-alert until utilization has gone back above the
// threshold (and the cooldown has passed).
//
//   node watcher/session-watch.ts            run
//   node watcher/session-watch.ts --status   print status of the running instance

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_SETUP,
  fmtPct,
  fmtUsds,
  hedged,
  isAtOrBelow,
  latestBlockNumber,
  readSetup,
  readSnapshotAt,
  type Setup,
  sleep,
  type Snapshot,
} from '../supabase/functions/stusds-watch/chain.ts'

const DIR = process.env.STUSDS_WATCH_DIR ?? join(homedir(), '.stusds-watch')
const STATE_FILE = join(DIR, 'state.json')
const PID_FILE = join(DIR, 'pid')
const THRESHOLD_PPM = BigInt(process.env.STUSDS_THRESHOLD_PPM ?? '999000')
const COOLDOWN_MS = Number(process.env.STUSDS_COOLDOWN_SECONDS ?? 600) * 1000
const MAX_RUN_MS = Number(process.env.STUSDS_MAX_MINUTES ?? 115) * 60_000
const HEALTH_URL = process.env.STUSDS_HEALTH_URL ?? 'https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/stusds-watch'
const POLL_MS = 1000
const NOTICE_EVERY_MS = 6 * 3600_000

type State = {
  armed: boolean
  lastAlertAt: number
  lastStaleNoticeAt: number
  lastRpcNoticeAt: number
  lastBlock: number
  lastUtilPpm: number | null
  lastEvalAt: number
}

const loadState = (): State => {
  const base: State = { armed: true, lastAlertAt: 0, lastStaleNoticeAt: 0, lastRpcNoticeAt: 0, lastBlock: 0, lastUtilPpm: null, lastEvalAt: 0 }
  try {
    return { ...base, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
  } catch {
    return base
  }
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s))

const readPid = (): number => {
  try {
    return Number(readFileSync(PID_FILE, 'utf8').trim()) || 0
  } catch {
    return 0
  }
}
const alive = (pid: number) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

mkdirSync(DIR, { recursive: true })

if (process.argv.includes('--status')) {
  // Wait briefly for a (possibly just-started) instance to report a fresh block.
  let out: Record<string, unknown> = {}
  for (let i = 0; i < 30; i++) {
    const s = loadState()
    const pid = readPid()
    const ageS = s.lastEvalAt ? Math.round((Date.now() - s.lastEvalAt) / 1000) : null
    out = {
      running: alive(pid),
      pid,
      armed: s.armed,
      lastBlock: s.lastBlock,
      lastEvalAgeSeconds: ageS,
      utilization: s.lastUtilPpm === null ? null : fmtPct(s.lastUtilPpm, 4),
      lastAlertAt: s.lastAlertAt ? new Date(s.lastAlertAt).toISOString() : null,
    }
    if (out.running && ageS !== null && ageS < 30) break
    await sleep(500)
  }
  console.log(JSON.stringify(out))
  process.exit(out.running ? 0 : 1)
}

const startedAt = Date.now()
const eps = DEFAULT_ENDPOINTS
const urls = eps.map((e) => e.http)
const state = loadState()
let tookOver = false

const finish = (code: number, label: string, detail: Record<string, unknown>) => {
  saveState(state)
  console.log(`${label} ${JSON.stringify(detail)}`)
  process.exit(code)
}

process.on('SIGTERM', () => {
  const pid = readPid()
  if (pid && pid !== process.pid) finish(0, 'SUPERSEDED', { by: pid })
  else finish(0, 'STOPPED', {})
})

let setup: Setup = DEFAULT_SETUP
try {
  setup = await hedged(urls, (u) => readSetup(u), 500)
} catch (e) {
  console.log(`readSetup failed, using defaults: ${e}`)
}

const describe = (s: Snapshot) => ({
  utilization: fmtPct(s.utilPpm, 4),
  withdrawableUsds: fmtUsds(s.availableWad),
  totalAssetsUsds: fmtUsds(s.totalAssets),
  block: s.block,
  blockTime: new Date(s.timestamp * 1000).toISOString(),
  detectedSecondsAfterBlock: Number(((Date.now() - s.timestamp * 1000) / 1000).toFixed(1)),
})

const onSnapshot = (s: Snapshot) => {
  state.lastBlock = s.block
  state.lastUtilPpm = s.utilPpm
  state.lastEvalAt = Date.now()

  if (!tookOver) {
    // Only replace the previous instance once this one is demonstrably working.
    tookOver = true
    const old = readPid()
    writeFileSync(PID_FILE, String(process.pid))
    if (old && old !== process.pid && alive(old)) process.kill(old, 'SIGTERM')
    console.log(`watching from block ${s.block}: ${fmtPct(s.utilPpm, 4)}, armed=${state.armed}`)
  }

  if (isAtOrBelow(s, THRESHOLD_PPM)) {
    if (state.armed && Date.now() >= state.lastAlertAt + COOLDOWN_MS) {
      state.armed = false
      state.lastAlertAt = Date.now()
      finish(10, 'ALERT', describe(s))
    }
  } else if (!state.armed) {
    state.armed = true
    console.log(`re-armed at block ${s.block}: ${fmtPct(s.utilPpm, 4)}`)
  }
  saveState(state)
}

let healthFailures = 0
const checkHealth = async () => {
  if (!HEALTH_URL) return
  let h: any = null
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) })
    h = await res.json()
    healthFailures = res.ok ? 0 : healthFailures + 1
  } catch {
    healthFailures++
  }
  const staleFor = typeof h?.age_seconds === 'number' ? h.age_seconds : null
  const stale = (h && h.enabled !== false && staleFor !== null && staleFor > 300) || healthFailures >= 5
  if (stale && Date.now() > state.lastStaleNoticeAt + NOTICE_EVERY_MS) {
    state.lastStaleNoticeAt = Date.now()
    finish(20, 'STALE', { deployedWatcherAgeSeconds: staleFor, healthFailures, health: h })
  }
}

let i = 0
let busy = false
let lastHealthAt = 0
let lastLogAt = Date.now()
let lastOkAt = Date.now()

while (true) {
  const now = Date.now()
  if (now - startedAt > MAX_RUN_MS) finish(0, 'EXPIRED', { ranMinutes: Math.round((now - startedAt) / 60_000) })

  if (!busy) {
    busy = true
    const ep = eps[i++ % eps.length]
    latestBlockNumber(ep.http)
      .then(async (n) => {
        if (n > state.lastBlock || !tookOver) {
          const s = await readSnapshotAt([ep.http, ...urls.filter((u) => u !== ep.http)], setup, n, 3)
          lastOkAt = Date.now()
          onSnapshot(s)
        } else {
          lastOkAt = Date.now()
        }
      })
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }

  if (now - lastOkAt > 300_000 && now > state.lastRpcNoticeAt + NOTICE_EVERY_MS) {
    state.lastRpcNoticeAt = now
    finish(30, 'RPC_FAILURE', { secondsWithoutChainRead: Math.round((now - lastOkAt) / 1000) })
  }
  if (now - lastHealthAt > 60_000) {
    lastHealthAt = now
    checkHealth().catch(() => {})
  }
  if (now - lastLogAt > 1_800_000) {
    lastLogAt = now
    console.log(`ok block ${state.lastBlock}: ${state.lastUtilPpm === null ? '?' : fmtPct(state.lastUtilPpm, 4)}, armed=${state.armed}`)
  }
  await sleep(POLL_MS)
}
