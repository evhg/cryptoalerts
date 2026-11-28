// Price and indicator alerts for the Telegram bot.
//
// A person sets an alert in a chat ("tell me when BTC closes below 58,500 on the 4h"). It is stored as a rule, a
// scheduled call checks every rule once a minute, and the bot posts in that chat when one comes true. An alert fires
// once and is then switched off.
//
// What a rule can watch:
//   price, no interval    the price trades at a level (checked once a minute, on the last price and on the highs and
//                         lows of the one-minute candles since the alert was set)
//   price, with interval  a candle of that interval closes above or below a level
//   rsi                   RSI of that interval, at a candle close, is above or below a level
//   sma / ema             a candle of that interval closes above or below its moving average
//
// Prices are OKX spot against USDT; Hyperliquid is asked when OKX does not answer.

export type Rule = {
  symbol: string
  metric: 'price' | 'rsi' | 'sma' | 'ema'
  op: 'above' | 'below'
  value: number | null
  interval: string | null
  period: number | null
}
export type AlertCmd =
  | { kind: 'add'; rule: Rule }
  | { kind: 'list' }
  | { kind: 'delete'; id: number }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

const INTERVAL_WORDS: Record<string, string> = {
  '15m': '15m', '15min': '15m', '15mins': '15m',
  '1h': '1h', '60m': '1h', 'hourly': '1h', 'hour': '1h', 'h1': '1h',
  '4h': '4h', '240m': '4h', 'h4': '4h',
  '1d': '1d', 'd': '1d', 'daily': '1d', 'day': '1d', 'd1': '1d',
}
export const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
// Daily candles are UTC days, so they close at 07:00 Bangkok time.
const OKX_BAR: Record<string, string> = { '1m': '1m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' }

const ABOVE = new Set(['above', 'over', '>', '>=', 'exceeds', 'higher', 'up'])
const BELOW = new Set(['below', 'under', '<', '<=', 'lower', 'beneath', 'down'])
const CLOSE = new Set(['close', 'closes', 'closing', 'closed'])
const FILLER = new Set([
  'add', 'set', 'new', 'alert', 'me', 'when', 'if', 'the', 'a', 'an', 'at', 'on', 'to', 'is', 'goes', 'gets', 'drops', 'falls', 'rises', 'breaks',
  'crosses', 'reaches', 'hits', 'trades', 'price', 'than', 'its', 'it', 'candle', 'chart', 'timeframe', 'period', 'of', 'for', 'tell', 'notify', 'ping',
  'please', 'and', 'usd', 'usdt', 'dollars', 'level',
])

/** "58,500", "$58.5k", "1.2m" -> number; anything else -> null. */
function num(token: string): number | null {
  const m = token.replace(/[$,]/g, '').match(/^(\d+(?:\.\d+)?)([km])?$/)
  if (!m) return null
  return Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
}

/**
 * Turn the words after "/alert" (or after "ALERT" from the model) into a command.
 * Returns null when the text does not look like any alert command, so the caller can let the model have a go.
 */
export function parseAlert(input: string): AlertCmd | null {
  const text = input.trim().toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ')
  if (!text) return { kind: 'help' }
  let tokens = text.split(' ').map((t) => t.replace(/^[#"'`]+|[.,;:!?"'`]+$/g, '')).filter(Boolean)
  if (['list', 'show', 'mine', 'all'].includes(tokens[0])) return { kind: 'list' }
  if (tokens[0] === 'help') return { kind: 'help' }
  if (['delete', 'del', 'remove', 'rm', 'cancel', 'stop'].includes(tokens[0])) {
    const id = tokens.slice(1).map((t) => Number(t.replace('#', ''))).find((n) => Number.isInteger(n) && n > 0)
    return id ? { kind: 'delete', id } : { kind: 'error', message: 'Say which one, for example: /alert del 3' }
  }
  // Join "rsi 21" style names that carry their period in the word: rsi21, sma200, ema50, ma200.
  let period: number | null = null
  let metric: Rule['metric'] = 'price'
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const named = t.match(/^(rsi|sma|ema|ma)(\d{1,3})?$/)
    if (named) {
      metric = named[1] === 'rsi' ? 'rsi' : named[1] === 'ema' ? 'ema' : 'sma'
      if (named[2]) period = Number(named[2])
      else if (metric !== 'rsi' && num(tokens[i + 1] ?? '') !== null && !INTERVAL_WORDS[tokens[i + 1]]) period = num(tokens[++i])
      continue
    }
    if (t === 'period' && num(tokens[i + 1] ?? '') !== null) { period = num(tokens[++i]); continue }
    rest.push(t)
  }
  tokens = rest
  let op: Rule['op'] | null = null
  let opAt = -1
  let interval: string | null = null
  let onClose = false
  let symbol: string | null = null
  const numbers: { at: number; n: number }[] = []
  tokens.forEach((t, i) => {
    if (ABOVE.has(t)) { if (!op) { op = 'above'; opAt = i } return }
    if (BELOW.has(t)) { if (!op) { op = 'below'; opAt = i } return }
    if (CLOSE.has(t)) { onClose = true; return }
    if (INTERVAL_WORDS[t]) { interval = interval ?? INTERVAL_WORDS[t]; return }
    const n = num(t)
    if (n !== null) { numbers.push({ at: i, n }); return }
    if (FILLER.has(t)) return
    const s = t.replace(/[-/_]?(usdt|usd|perp)$/, '')
    if (!symbol && /^[a-z0-9]{2,12}$/.test(s) && /[a-z]/.test(s)) symbol = s.toUpperCase()
  })
  if (!symbol || !op) return symbol || op || numbers.length ? { kind: 'error', message: 'I need a coin, "above" or "below", and a level.' } : null
  const after = numbers.find((x) => x.at > opAt) ?? numbers[numbers.length - 1]
  if (metric === 'rsi') {
    // "rsi 14 4h below 30": a number in front of the direction is the period.
    const before = numbers.find((x) => x.at < opAt)
    if (!period && before && after && before !== after) period = before.n
    if (!after) return { kind: 'error', message: 'I need the RSI level, for example: /alert ETH rsi 4h below 30' }
    if (after.n <= 0 || after.n >= 100) return { kind: 'error', message: 'An RSI level is between 0 and 100.' }
    return checked({ symbol, metric, op, value: after.n, interval: interval ?? '4h', period: period ?? 14 })
  }
  if (metric === 'sma' || metric === 'ema') {
    if (!period && numbers.length) period = numbers[0].n
    if (!period) return { kind: 'error', message: 'I need the length of the average, for example: /alert BTC sma 200 1d below' }
    return checked({ symbol, metric, op, value: null, interval: interval ?? '1d', period })
  }
  if (!after) return { kind: 'error', message: 'I need a price level, for example: /alert BTC below 58500' }
  if (onClose && !interval) return { kind: 'error', message: 'Say which candle: 15m, 1h, 4h or 1d. For example: /alert BTC close 4h below 58500' }
  return checked({ symbol, metric: 'price', op, value: after.n, interval, period: null })
}

function checked(rule: Rule): AlertCmd {
  if (rule.value !== null && !(rule.value > 0)) return { kind: 'error', message: 'The level must be above zero.' }
  if (rule.period !== null && (!Number.isInteger(rule.period) || rule.period < 2 || rule.period > 250)) {
    return { kind: 'error', message: 'The length must be a whole number from 2 to 250.' }
  }
  return { kind: 'add', rule }
}

/** A number the way a person writes it: 58,500 / 1,653.2 / 0.9951 / 0.00001234 */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?'
  const v = Number(n)
  const a = Math.abs(v)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8
  return v.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function describeRule(r: Rule): string {
  const p = r.period ?? (r.metric === 'rsi' ? 14 : 0)
  if (r.metric === 'rsi') return `${r.symbol} RSI(${p}) on the ${r.interval} ${r.op} ${fmt(r.value)}`
  if (r.metric === 'sma' || r.metric === 'ema') return `${r.symbol} ${r.interval} close ${r.op} its ${p}-period ${r.metric.toUpperCase()}`
  if (r.interval) return `${r.symbol} ${r.interval} close ${r.op} ${fmt(r.value)}`
  return `${r.symbol} price ${r.op} ${fmt(r.value)}`
}

// ---------- market data ----------

export type Candle = { t: number; h: number; l: number; c: number; closed: boolean }
type Cache = Map<string, unknown>

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`${res.status}`)
  return await res.json()
}
const hyperliquid = (body: unknown) =>
  getJson('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** One fetch per key and round: later callers get the same answer, or the same failure, without asking again. */
function once<T>(cache: Cache, key: string, make: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = make()
    p.catch(() => {})
    cache.set(key, p)
  }
  return cache.get(key) as Promise<T>
}

/** Last traded price, or null when neither source knows the symbol. Throws when no source answered at all. */
export function lastPrice(symbol: string, cache: Cache = new Map()): Promise<number | null> {
  return once(cache, `p:${symbol}`, async () => {
    let answered = false
    try {
      const j = await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`)
      answered = true
      const last = Number(j?.data?.[0]?.last)
      if (j?.code === '0' && last > 0) return last
    } catch { /* try the other source */ }
    try {
      const mids = await once(cache, 'hl:mids', () => hyperliquid({ type: 'allMids' }))
      answered = true
      const mid = Number(mids?.[symbol])
      if (mid > 0) return mid
    } catch { /* nothing more to try */ }
    if (!answered) throw new Error('no price source answered')
    return null
  })
}

/** Candles of one interval, oldest first. The last one is usually still open (`closed` false). Empty: unknown symbol. */
export function candles(symbol: string, interval: string, cache: Cache = new Map()): Promise<Candle[]> {
  return once(cache, `c:${symbol}:${interval}`, async () => {
    const want = interval === '1m' ? 15 : 300
    try {
      const j = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=${OKX_BAR[interval]}&limit=${want}`)
      if (j?.code === '0' && Array.isArray(j.data) && j.data.length) {
        return j.data.map((r: string[]) => ({ t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), closed: r[8] === '1' })).reverse()
      }
    } catch { /* try the other source */ }
    const now = Date.now()
    const j = await hyperliquid({ type: 'candleSnapshot', req: { coin: symbol, interval, startTime: now - want * INTERVAL_MS[interval], endTime: now } }).catch(() => null)
    if (!Array.isArray(j)) return []
    return j.map((r: any) => ({ t: Number(r.t), h: Number(r.h), l: Number(r.l), c: Number(r.c), closed: Number(r.T) < now }))
  })
}

// ---------- indicators ----------

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null
  let s = 0
  for (let i = values.length - period; i < values.length; i++) s += values[i]
  return s / period
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let e = 0
  for (let i = 0; i < period; i++) e += values[i]
  e /= period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

/** RSI with Wilder's smoothing, the way charting packages show it. */
export function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}

// ---------- evaluation ----------

/** A moment in Bangkok time, for people: "29 Nov 03:00". */
export function bkk(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')
}

/** `closedAt`: for a candle rule, when the candle that was looked at closed. */
export type Verdict = { ok: boolean; hit: boolean; value: number | null; detail: string; closedAt?: number }

const unknown = (symbol: string) => `I do not know ${symbol}. I look for ${symbol}-USDT on OKX and ${symbol} on Hyperliquid.`

/**
 * Is the rule true now? `sinceMs` is when the alert was set. A rule that waits for a candle close only counts a candle
 * that closed after that moment; a price rule counts the last price and the one-minute candles that began after it.
 * `ok` false means the rule could not be checked (unknown coin, no data); `detail` then says why.
 */
export async function evaluate(rule: Rule, sinceMs: number, cache: Cache = new Map()): Promise<Verdict> {
  const level = Number(rule.value)
  const cmp = (x: number, y: number) => (rule.op === 'above' ? x >= y : x <= y)
  if (rule.metric === 'price' && !rule.interval) {
    const minutes = await candles(rule.symbol, '1m', cache).catch(() => [] as Candle[])
    if (!minutes.length) {
      const p = await lastPrice(rule.symbol, cache)
      if (p === null) return { ok: false, hit: false, value: null, detail: unknown(rule.symbol) }
      return { ok: true, hit: cmp(p, level), value: p, detail: `Last price ${fmt(p)}.` }
    }
    const last = minutes[minutes.length - 1].c
    if (cmp(last, level)) return { ok: true, hit: true, value: last, detail: `Last price ${fmt(last)}.` }
    const touched = minutes.filter((x) => x.t > sinceMs).map((x) => (rule.op === 'above' ? x.h : x.l)).filter((x) => cmp(x, level))
    if (touched.length) {
      const extreme = rule.op === 'above' ? Math.max(...touched) : Math.min(...touched)
      return { ok: true, hit: true, value: extreme, detail: `It traded at ${fmt(extreme)} within the last minutes; last price ${fmt(last)}.` }
    }
    return { ok: true, hit: false, value: last, detail: `Last price ${fmt(last)}.` }
  }
  const interval = rule.interval ?? '1d'
  const closed = (await candles(rule.symbol, interval, cache)).filter((x) => x.closed)
  if (!closed.length) {
    const p = await lastPrice(rule.symbol, cache).catch(() => 0)
    return { ok: false, hit: false, value: null, detail: p === null ? unknown(rule.symbol) : `I have no ${interval} candles for ${rule.symbol} right now.` }
  }
  const last = closed[closed.length - 1]
  const closedAt = last.t + INTERVAL_MS[interval]
  const fresh = closedAt > sinceMs
  const closes = closed.map((x) => x.c)
  const at = `The ${interval} candle that closed at ${bkk(closedAt)} Bangkok time`
  if (rule.metric === 'price') {
    return { ok: true, hit: fresh && cmp(last.c, level), value: last.c, closedAt, detail: `${at} closed at ${fmt(last.c)}.` }
  }
  const period = rule.period ?? 14
  if (rule.metric === 'rsi') {
    const r = rsi(closes, period)
    if (r === null) return { ok: false, hit: false, value: null, detail: `Not enough ${interval} candles for RSI(${period}) on ${rule.symbol}.` }
    return { ok: true, hit: fresh && cmp(r, level), value: Number(r.toFixed(2)), closedAt, detail: `${at} left RSI(${period}) at ${r.toFixed(1)} (price ${fmt(last.c)}).` }
  }
  const avg = rule.metric === 'ema' ? ema(closes, period) : sma(closes, period)
  if (avg === null) return { ok: false, hit: false, value: null, detail: `Not enough ${interval} candles for a ${period}-period average on ${rule.symbol} (I have ${closes.length}).` }
  return { ok: true, hit: fresh && cmp(last.c, avg), value: last.c, closedAt, detail: `${at} closed at ${fmt(last.c)}; the ${period}-period ${rule.metric.toUpperCase()} is ${fmt(avg)}.` }
}

export const ALERT_HELP = [
  'Alerts, one line each:',
  '/alert BTC below 58500 (as soon as the price trades there)',
  '/alert BTC close 4h below 58500 (a 4h candle closes there)',
  '/alert ETH rsi 4h below 30',
  '/alert BTC sma 200 1d below (a daily close under the 200-day average)',
  '/alerts lists yours, /alert del 3 removes one.',
  'Candles: 15m, 1h, 4h, 1d (the daily one closes at 07:00 Bangkok time). You can also just ask in words. An alert fires once and lasts 90 days.',
].join('\n')

// ---------- what the bot does with a command, and the once-a-minute round ----------

type Db = (fn: string, args: Record<string, unknown>) => Promise<any>
type Send = (chatId: number, text: string, replyTo?: number | null) => Promise<any[]>
const ruleOf = (a: any): Rule => ({
  symbol: String(a.symbol), metric: a.metric, op: a.op, value: a.value === null || a.value === undefined ? null : Number(a.value),
  interval: a.interval ?? null, period: a.period === null || a.period === undefined ? null : Number(a.period),
})

/** Carry out one alert command for the stored message `id` and return the text to answer with. */
export async function alertReply(db: Db, id: number, words: string): Promise<string> {
  const cmd = parseAlert(words)
  if (!cmd || cmd.kind === 'help') return ALERT_HELP
  if (cmd.kind === 'error') return cmd.message
  if (cmd.kind === 'list') {
    const rows: any[] = (await db('tg_alert_list', { p_id: id })) ?? []
    if (!rows.length) return 'You have no alerts in this chat. Example: /alert BTC below 58500'
    return ['Your alerts here:', ...rows.map((a) => `#${a.id} ${describeRule(ruleOf(a))}`), 'Remove one with /alert del <number>.'].join('\n')
  }
  if (cmd.kind === 'delete') {
    return (await db('tg_alert_delete', { p_id: id, p_alert: cmd.id })) ? `Alert #${cmd.id} removed.` : `I found no alert #${cmd.id} of yours here.`
  }
  const rule = cmd.rule
  const cache: Cache = new Map()
  let price: number | null
  try {
    price = await lastPrice(rule.symbol, cache)
  } catch {
    return 'The price sources are not answering right now. Nothing was set; try again in a minute.'
  }
  if (price === null) return unknown(rule.symbol)
  const now = Date.now()
  const v = await evaluate(rule, now, cache).catch(() => null)
  if (!v) return 'The price sources are not answering right now. Nothing was set; try again in a minute.'
  if (!v.ok) return v.detail
  if (v.hit) return `${rule.symbol} is already ${rule.op} ${fmt(rule.value)}: last price ${fmt(v.value)}. Nothing was set.`
  const r = await db('tg_alert_add', { p_id: id, p_rule: rule })
  if (!r?.ok) {
    if (r?.error === 'duplicate') return `You already have that one: alert #${r.id}.`
    if (r?.error === 'not_allowed') return 'Alerts are not switched on in this chat.'
    if (r?.error === 'user_limit') return `You have ${r.limit} alerts running, which is the limit. Remove one first: /alerts shows them.`
    if (r?.error === 'chat_limit') return `This chat has ${r.limit} alerts running, which is the limit.`
    return 'I could not set that alert.'
  }
  const next = rule.interval ? ` Checked at each ${rule.interval} close; the next one is at ${bkk((Math.floor(now / INTERVAL_MS[rule.interval]) + 1) * INTERVAL_MS[rule.interval])} Bangkok time.` : ' Checked once a minute.'
  return `Alert #${r.id} set: ${describeRule(rule)}. ${v.detail}${next}`
}

const ENDED: Record<string, string> = {
  expired: 'ended after 90 days without triggering',
  no_data: 'ended because I could get no price data for it for half a day',
}

/** One round: look at every active alert, post the ones that came true. Called once a minute. */
export async function alertsTick(db: Db, send: Send): Promise<Record<string, unknown>> {
  const due = await db('tg_alerts_due', {})
  const alerts: any[] = due?.alerts ?? []
  for (const e of (due?.ended ?? []) as any[]) {
    if (ENDED[e.reason]) await send(Number(e.chat_id), `Alert #${e.id} (${describeRule(ruleOf(e))}) ${ENDED[e.reason]}.`, e.message_id)
  }
  const now = Date.now()
  const cache: Cache = new Map()
  const slotOf = (a: any) => Math.floor(now / INTERVAL_MS[a.interval])
  // A candle rule is looked at once per candle: skip it until a new candle of its interval has closed.
  const todo = alerts.filter((a) => !a.interval || a.checked_slot === null || slotOf(a) > Number(a.checked_slot))
  // Fetch each coin and interval once, a few at a time, before going through the rules.
  const keys = [...new Set(todo.map((a) => `${a.symbol}|${a.interval ?? '1m'}`))]
  for (let i = 0; i < keys.length; i += 8) {
    await Promise.all(keys.slice(i, i + 8).map((k) => candles(k.split('|')[0], k.split('|')[1], cache).catch(() => [])))
  }
  const checked: Record<string, unknown>[] = []
  let fired = 0
  for (const a of todo) {
    const rule = ruleOf(a)
    const v = await evaluate(rule, Number(a.created_ms), cache).catch((e) => ({ ok: false, hit: false, value: null, detail: String(e).slice(0, 120) } as Verdict))
    if (!v.ok) {
      checked.push({ id: a.id, error: v.detail })
      continue
    }
    if (!v.hit) {
      // Only tick a candle off once the candle that just ended is the one that was looked at.
      const slot = a.interval && v.closedAt !== undefined && v.closedAt >= slotOf(a) * INTERVAL_MS[a.interval] ? slotOf(a) : null
      checked.push({ id: a.id, value: v.value, slot })
      continue
    }
    if (!(await db('tg_alert_fire', { p_alert: a.id, p_value: v.value }))) continue
    const text = `Alert #${a.id}${a.sender ? ` for ${a.sender}` : ''}: ${describeRule(rule)}.\n${v.detail}`
    const res = await send(Number(a.chat_id), text, a.message_id).catch(() => [{ ok: false }])
    await db('tg_alert_sent', { p_alert: a.id, p_text: text, p_ok: res.length > 0 && res.every((x: any) => x?.ok) })
    fired++
  }
  if (checked.length) await db('tg_alerts_checked', { p: checked })
  return { active: alerts.length, looked_at: todo.length, fired, failed: checked.filter((c) => c.error).length }
}
