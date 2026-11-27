// Telegram bridge for the Claude session.
//
// Telegram -> here (webhook): decide who is speaking from the Telegram user id, store the message, wake the session.
// Session -> here (x-cron-secret): send a message, set the webhook up, report status.
//
// Nothing a message says can change who its sender is: the role comes from the database, keyed by the numeric
// Telegram user id that Telegram itself puts on the update. The wake-up call carries no instructions, only a note
// that messages are waiting; the session reads them from the database.

const env = (k: string) => Deno.env.get(k) ?? ''
const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const TOKEN = env('TELEGRAM_BOT_TOKEN')
const FIRE_URL = env('ROUTINE_FIRE_URL')
const FIRE_TOKEN = env('ROUTINE_FIRE_TOKEN')

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function db(fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not set' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    })
    return await res.json()
  } catch (e) {
    return { ok: false, description: String(e).slice(0, 200) }
  }
}

/** Telegram accepts 4096 characters per message; split longer text on line breaks. */
function chunks(text: string, size = 3900): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length) out.push(rest)
  return out
}

async function send(chatId: number, text: string, replyTo?: number | null) {
  const results: any[] = []
  for (const [i, part] of chunks(text).entries()) {
    const payload: Record<string, unknown> = { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } }
    if (i === 0 && replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }
    results.push(await tg('sendMessage', payload))
  }
  return results
}

/** Wake the session. The text is a note, not an instruction: the session reads the messages from the database. */
async function wake(note: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  if (!FIRE_URL || !FIRE_TOKEN) return { ok: false, detail: 'ROUTINE_FIRE_URL or ROUTINE_FIRE_TOKEN is not set' }
  try {
    const res = await fetch(FIRE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FIRE_TOKEN}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: JSON.stringify(note) }),
      signal: AbortSignal.timeout(10000),
    })
    const body = (await res.text()).slice(0, 300)
    return { ok: res.ok, detail: `${res.status} ${body}` }
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) }
  }
}

const displayName = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(' ')

async function onUpdate(update: any, botUsername: string) {
  const member = update.my_chat_member
  if (member) {
    const r = await db('tg_chat_member', {
      p: { chat: { id: member.chat.id, title: member.chat.title ?? null, type: member.chat.type }, from: { id: member.from.id }, status: member.new_chat_member?.status ?? '' },
    })
    if (r?.action === 'leave') await tg('leaveChat', { chat_id: member.chat.id })
    else if (r?.action === 'greet') await send(member.chat.id, r.text)
    return { handled: 'chat_member', action: r?.action }
  }

  const m = update.message
  if (!m || m.from?.is_bot) return { handled: 'ignored' }
  const text: string = m.text ?? m.caption ?? ''
  if (!text) return { handled: 'ignored' }
  const isPrivate = m.chat.type === 'private'
  const bot = botUsername.toLowerCase()
  const mentioned = bot !== '' && text.toLowerCase().includes('@' + bot)
  const repliedToBot = bot !== '' && String(m.reply_to_message?.from?.username ?? '').toLowerCase() === bot
  // In a group a bare command reaches every bot; count it only when it is addressed to this one or is ours.
  const command = /^\/(ask|status|help)(@\w+)?(\s|$)/i.test(text) && (!/^\/\w+@/.test(text) || mentioned)
  const addressed = isPrivate || mentioned || repliedToBot || command
  const r = await db('tg_ingest', {
    p: {
      chat: { id: m.chat.id, title: m.chat.title ?? null, type: m.chat.type },
      from: { id: m.from.id, username: m.from.username ?? null, name: displayName(m.from) },
      message_id: m.message_id,
      text,
      reply_to: m.reply_to_message?.text ?? m.reply_to_message?.caption ?? null,
      addressed,
    },
  })
  if (r?.action === 'reply' || r?.action === 'queued') await send(m.chat.id, r.text, m.message_id)
  // 'wait': the session's watcher is listening and will pick the message up within seconds.
  if (r?.action === 'wait') await tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' })
  if (r?.action === 'fire') {
    await tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' })
    const w = await wake({ source: 'telegram bridge', pending_messages: r.pending, newest_message_id: r.id, sender_role: r.role })
    if (!w.ok) {
      await db('tg_fire_failed', { p_id: r.id, p_note: w.detail })
      await send(m.chat.id, 'Received. I could not be woken right away, so the answer comes with my next hourly check.', m.message_id)
    }
    return { handled: 'message', action: 'fire', woke: w.ok }
  }
  return { handled: 'message', action: r?.action ?? null }
}

async function onSession(body: any, begin: any) {
  switch (body.action) {
    case 'send': {
      const results = await send(Number(body.chat_id), String(body.text ?? ''), body.reply_to_message_id ? Number(body.reply_to_message_id) : null)
      return { ok: results.every((x) => x?.ok), results: results.map((x) => ({ ok: x?.ok, message_id: x?.result?.message_id ?? null, error: x?.ok ? null : x?.description })) }
    }
    case 'setup': {
      // Read the bot's own name, point Telegram's webhook at this function, and remember both.
      const me = await tg('getMe', {})
      if (!me?.ok) return { ok: false, step: 'getMe', error: me?.description }
      const url = `${SUPABASE_URL}/functions/v1/tg-bot`
      const hook = await tg('setWebhook', { url, secret_token: begin.webhook_secret, allowed_updates: ['message', 'my_chat_member'], drop_pending_updates: true })
      if (!hook?.ok) return { ok: false, step: 'setWebhook', error: hook?.description }
      await db('tg_set_bot', { p_username: me.result.username, p_function_url: url })
      await tg('setMyCommands', { commands: [{ command: 'ask', description: 'Ask a question' }, { command: 'status', description: 'Current stUSDS status' }] })
      return { ok: true, bot: me.result.username, name: me.result.first_name, can_join_groups: me.result.can_join_groups, reads_all_group_messages: me.result.can_read_all_group_messages, webhook: url, wake_configured: !!FIRE_URL && !!FIRE_TOKEN }
    }
    case 'status': {
      const info = await tg('getWebhookInfo', {})
      return {
        ok: true, has_bot_token: !!TOKEN, wake_configured: !!FIRE_URL && !!FIRE_TOKEN, bot: begin.bot_username,
        webhook: info?.ok ? { url_set: !!info.result.url, pending: info.result.pending_update_count, last_error: info.result.last_error_message ?? null } : info?.description,
      }
    }
    case 'wake_test':
      return await wake({ source: 'telegram bridge', test: true })
    default:
      return { error: 'unknown action' }
  }
}

/**
 * Long poll for the session's own watcher (watcher/tg-wait.mjs): answers as soon as a message is waiting, or after
 * about 45 seconds with zero. The watcher exits when something is waiting, and that exit is what starts a turn in
 * the session. Each poll also records that a watcher is listening, so the bot knows an answer will come soon.
 */
async function longPoll(key: string) {
  const until = Date.now() + 45_000
  for (;;) {
    const n = await db('tg_poll', { p_key: key })
    if (n === -1) return json({ error: 'not authorized' }, 401)
    if (n > 0 || Date.now() >= until) return json({ pending: n })
    await new Promise((r) => setTimeout(r, 2000))
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    const key = new URL(req.url).searchParams.get('poll')
    if (key) return await longPoll(key).catch(() => json({ error: 'internal error' }, 500))
    return json({ ok: true })
  }
  try {
    const begin = await db('tg_begin', {
      p_webhook_secret: req.headers.get('x-telegram-bot-api-secret-token') ?? '',
      p_cron_secret: req.headers.get('x-cron-secret') ?? '',
    })
    const body = await req.json().catch(() => ({}))
    if (begin?.caller === 'telegram') {
      // Always answer 200: Telegram repeats an update that gets anything else.
      const result = await onUpdate(body, String(begin.bot_username ?? '')).catch((e) => ({ error: String(e).slice(0, 200) }))
      if ((result as any).error) console.error('telegram update', (result as any).error)
      return json({ ok: true })
    }
    if (begin?.caller === 'session') return json(await onSession(body, begin))
    return json({ error: 'not authorized' }, 401)
  } catch (e) {
    console.error('tg-bot', String(e).slice(0, 300))
    return json({ error: 'internal error' }, 500)
  }
})
