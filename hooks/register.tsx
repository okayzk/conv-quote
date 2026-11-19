import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Quote } from '../types'

// =============================================================================
// State and transcript index
// =============================================================================

const quotes = atom({ plugin: 'conv-quote', key: 'quotes' } as const, [], { shape: 'quotes-2' })
const rev = atom({ plugin: 'conv-quote', key: 'rev' } as const, 0)

const PANE = 'conv-timeline'
const TOOL = 'mcp__conv-quote__locate'
const CHUNK = 4 * 1024 * 1024 // $.fs.read returns at most 4 MiB per call.
const WIN = 150 // locate: chars of raw text on each side of a quote, and per neighbouring message
const CAP = 500 // locate: total chars of one answer

// One drawn transcript message, read from the session JSONL.
// `id` is the JSONL line's `uuid`, which is also the row's ui.render requestId.
type Entry = { id: string; role: 'user' | 'assistant'; time: number; seq: number; text: string }

// Module-level index: rebuilt from the JSONL after every reload (the file is the source of truth).
let path = ''
let offset = 0 // bytes of the JSONL already parsed
let rest = '' // trailing partial line of the last chunk
const byId = new Map<string, Entry>()
const order: Entry[] = []
const toolOwner = new Map<string, string>() // tool_use_id -> uuid of the assistant message holding it
let running: Promise<boolean> | null = null

const short = (id: string) => id.slice(0, 8)
const pad = (n: number) => String(n).padStart(2, '0')
// Display time in Claude Code's `timeZone` setting (IANA name, e.g. "Asia/Shanghai"); undefined = the machine's zone.
let zone: string | undefined
const fmt = (t: number) => {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(t)) p[x.type] = x.value
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}
// For the model: ISO UTC, comparable with the JSONL `timestamp` field.
const fmtFull = (t: number) => new Date(t).toISOString()
const firstLine = (s: string, n: number) => { const l = s.trim().split('\n')[0] ?? ''; return l.length > n ? l.slice(0, n - 1) + '…' : l }

function parseLine(line: string) {
  if (!line.trim()) return
  let j: any
  try { j = JSON.parse(line) } catch { return }
  if ((j.type !== 'user' && j.type !== 'assistant') || !j.uuid || j.isSidechain || j.isMeta) return
  const c = j.message?.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b?.type === 'text') text += (text ? '\n' : '') + b.text
      if (b?.type === 'tool_use' && b.id) toolOwner.set(b.id, j.uuid)
    }
  }
  // Rows without text (tool_result-only user lines, tool_use-only assistant lines) are not message rows.
  if (!text.trim() || byId.has(j.uuid)) return
  const entry: Entry = { id: j.uuid, role: j.type, time: Date.parse(j.timestamp) || 0, seq: order.length + 1, text }
  byId.set(entry.id, entry)
  order.push(entry)
}

// Parse JSONL bytes appended since the last call; true when new entries were added.
async function refresh($: any): Promise<boolean> {
  if (running) return running
  running = (async () => {
    if (!path) path = (await $.session.info()).transcriptPath
    let size = 0
    try { size = (await $.fs.stat(path)).size } catch { return false } // no transcript yet
    if (size < offset) { offset = 0; rest = ''; byId.clear(); order.length = 0; toolOwner.clear() }
    const before = order.length
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset)
      const chunk: string = await $.fs.read(path, { offset, length })
      offset += length
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const l of lines) parseLine(l)
    }
    return order.length > before
  })()
  try { return await running } finally { running = null }
}

// Map a selection's row id (a message uuid, or a tool row's tool_use_id) to an entry;
// a selection spanning rows has no id, so fall back to the newest message containing its first line.
function locate(sel: { text: string; requestId?: string }): Entry | undefined {
  if (sel.requestId) return byId.get(sel.requestId) ?? byId.get(toolOwner.get(sel.requestId) ?? '')
  const probe = sel.text.trim().split('\n')[0]?.trim() ?? ''
  if (probe.length < 6) return undefined
  for (let i = order.length - 1; i >= 0; i--) if (order[i]!.text.includes(probe)) return order[i]
  return undefined
}

// Find the selection inside the raw message text. The selection is the *rendered* text (markdown
// marks gone, lines rewrapped), so both sides are compared with whitespace and markdown marks
// removed, keeping a map back to raw offsets. Returns [start, end) in raw chars, or undefined.
const SKIP = /[\s*`#>|\-•_~]/
function span(raw: string, sel: string): [number, number] | undefined {
  let flat = ''
  const at: number[] = [] // at[k] = raw index of flat[k]
  for (let i = 0; i < raw.length; i++) if (!SKIP.test(raw[i]!)) { flat += raw[i]; at.push(i) }
  let probe = ''
  for (const c of sel) if (!SKIP.test(c)) probe += c
  if (!probe) return undefined
  const k = flat.indexOf(probe)
  if (k < 0) return undefined
  return [at[k]!, at[k + probe.length - 1]! + 1]
}

const CTX = 25 // chars of raw text kept on each side of a quote in the <quotes> block
const QMAX = 300 // chars of the quoted text itself carried in the <quotes> block
async function addQuote($: any, text: string, entry: Entry | undefined, comment: string): Promise<number> {
  const s = entry ? span(entry.text, text) : undefined
  const before = entry && s ? entry.text.slice(Math.max(0, s[0] - CTX), s[0]) : undefined
  const after = entry && s ? entry.text.slice(s[1], s[1] + CTX) : undefined
  await update($, quotes, list => [...list, { n: (list.at(-1)?.n ?? 0) + 1, id: entry?.id, role: entry?.role, time: entry?.time, seq: entry?.seq, text, comment, start: s?.[0], end: s?.[1], before, after }])
  return (await read($, quotes)).at(-1)?.n ?? 0
}

// Returns the quote number (0 when nothing is selected) and the message to show.
async function quoteSelection($: any, comment: string): Promise<{ n: number; msg: string }> {
  const sel = await $.ui.selection()
  if (!sel || !sel.text.trim()) return { n: 0, msg: L().noSelection }
  await refresh($)
  const entry = locate(sel)
  const n = await addQuote($, sel.text, entry, comment)
  return { n, msg: entry ? L().added(n, short(entry.id), entry.seq, entry.role) : L().addedUnlocated(n) }
}

// =============================================================================
// UI strings: Chinese when Claude Code's `language` setting names Chinese, English otherwise
// =============================================================================
const STR = {
  en: {
    noSelection: 'Nothing selected: in fullscreen mode, select transcript text with the mouse first.',
    added: (n: number, id: string, seq: number, role: string) => `Added [Q${n}] ← #${id} (message ${seq}, ${role})`,
    addedUnlocated: (n: number) => `Added [Q${n}] (spans several messages; no single source message found)`,
    addedTimeline: (n: number) => `Added [Q${n}]; click the prompt to comment`,
    quoteDesc: 'Quote the transcript text selected with the mouse; optional argument is your comment',
    quoteHint: '[comment]',
    timelineDesc: 'Open/close the conversation timeline pane',
    notRegistered: (cmd: string, err: unknown) => `conv-quote: /${cmd} not registered: ${err}`,
    timelineTitle: 'Conversation timeline',
    timelineOpened: 'Timeline opened.',
    timelineClosed: 'Timeline closed.',
    attached: 'Quoted',
    bandAdd: 'Quote selection',
    bandTimeline: 'Timeline',
    bandClear: 'Clear quotes',
    jumpFailed: (id: string, why: string) => `Cannot jump to #${id}: ${why}`,
    paneHint: 'Esc closes · "Q" quotes the whole message (click the prompt to comment) · click a row to jump',
    paneEmpty: 'No messages yet.',
    paneQuote: 'Q',
  },
  zh: {
    noSelection: '没有选中内容：请在 fullscreen 模式下先用鼠标选中对话文字。',
    added: (n: number, id: string, seq: number, role: string) => `已添加 [Q${n}] ← #${id}（第 ${seq} 条，${role}）`,
    addedUnlocated: (n: number) => `已添加 [Q${n}]（跨多条消息，未定位到单条原消息）`,
    addedTimeline: (n: number) => `已添加 [Q${n}]，点输入框写评论`,
    quoteDesc: '引用当前鼠标选中的对话内容，参数为评论（可选）',
    quoteHint: '[评论]',
    timelineDesc: '打开/关闭对话时间线面板',
    notRegistered: (cmd: string, err: unknown) => `conv-quote: /${cmd} 未注册：${err}`,
    timelineTitle: '对话时间线',
    timelineOpened: '时间线已打开。',
    timelineClosed: '时间线已关闭。',
    attached: '引用',
    bandAdd: '引用选区',
    bandTimeline: '时间线',
    bandClear: '清空引用',
    jumpFailed: (id: string, why: string) => `无法跳转到 #${id}：${why}`,
    paneHint: 'Esc 关闭 · 「引」引用整条（点输入框写评论）· 点消息行跳转',
    paneEmpty: '还没有消息。',
    paneQuote: '引',
  },
}
let lang: keyof typeof STR = 'en'
const L = () => STR[lang]

const QUOTES_RE = /\n*<quotes session="[^"]*">[\s\S]*?<\/quotes>\s*$/

export const register: Register = on => {
  // ===========================================================================
  // Session setup: commands, model tool, transcript polling
  // ===========================================================================
  on('session.start', async ($, e, next) => {
    // A name another plugin holds is refused; keep the rest of the setup running.
    // `language` is free text passed to Claude (e.g. "chinese", "中文"); anything not naming Chinese falls back to English.
    let setting: unknown
    try { setting = await $.settings.read({ key: 'language' }) } catch { setting = undefined }
    lang = typeof setting === 'string' && /chinese|mandarin|cantonese|中文|汉语|漢語|简体|繁体|繁體|^zh/i.test(setting.trim()) ? 'zh' : 'en'
    let tz: unknown
    try { tz = await $.settings.read({ key: 'timeZone' }) } catch { tz = undefined }
    zone = undefined
    // An unknown zone name throws in Intl; keep the machine's zone then.
    if (typeof tz === 'string' && tz.trim()) { try { new Intl.DateTimeFormat('en', { timeZone: tz.trim() }); zone = tz.trim() } catch { $.ui.toast(`conv-quote: timeZone "${tz}" ?`) } }
    try { await $.command.register({ name: 'quote', description: L().quoteDesc, argumentHint: L().quoteHint }) } catch (err) { $.ui.toast(L().notRegistered('quote', err)) }
    try { await $.command.register({ name: 'timeline', description: L().timelineDesc }) } catch (err) { $.ui.toast(L().notRegistered('timeline', err)) }
    await $.tool.register({
      name: 'locate',
      isDeferred: false,
      description: 'Local positioning for a <quotes> entry, not long-range recall. Usually unnecessary: the quote, chars and context in the <quotes> block are enough. Call only when the quoted message is no longer in your context (e.g. after compaction) or you need a little more text right around the quote. Takes id (uuid or 8+ hex prefix) and the quote\'s start/end; returns at most 500 chars: ~150 chars each side of the span marked ⟦…⟧, plus optional context (0-2, default 0) neighbouring messages\' nearest 150 chars.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, context: { type: 'integer', minimum: 0, maximum: 2, description: 'Neighbouring messages on each side (default 0).' } }, required: ['id'] },
    })
    await refresh($)
    $.clock.every(3000, async () => { if (await refresh($)) await update($, rev, n => n + 1) })
    return next(e)
  })

  on('command.run', { command: 'quote' }, async ($, e) => ({ text: (await quoteSelection($, e.args.trim())).msg }))

  on('command.run', { command: 'timeline' }, async $ => {
    const open = (await $.ui.panes()).some((p: any) => p.id === PANE)
    if (open) { await $.ui.close({ id: PANE }); return { text: L().timelineClosed } }
    await refresh($)
    await $.ui.open({ id: PANE, title: L().timelineTitle, focus: true, closeOnEscape: true })
    return { text: L().timelineOpened }
  })

  // ===========================================================================
  // Model tool: locate a message by id
  // ===========================================================================
  on('tool.run', { tool: TOOL }, async ($, e: any) => {
    // Local positioning only, never long-range recall: a window of WIN chars each side of the span,
    // at most 2 neighbouring messages (their WIN chars nearest the target), the whole answer capped at CAP.
    try { await refresh($) } catch (err) { return { deny: `Transcript could not be read: ${err}` } }
    const want = String(e.id ?? '').replace(/^#/, '').trim()
    const k = Math.max(0, Math.min(2, Number(e.context ?? 0) || 0))
    const hit = want.length >= 6 ? order.find(m => m.id === want || m.id.startsWith(want)) : undefined
    if (!hit) return { result: `No message with id "${want}" in this session.` }
    const head = (m: Entry) => `#${short(m.id)} seq=${m.seq} ${m.role} ${fmtFull(m.time).slice(0, 19)}Z`
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    const t = hit.text, a = Number(e.start), b = Number(e.end)
    const hasSpan = Number.isInteger(a) && Number.isInteger(b) && 0 <= a && a < b && b <= t.length
    const win = hasSpan ? `${a > WIN ? '…' : ''}${t.slice(Math.max(0, a - WIN), a)}⟦${t.slice(a, b)}⟧${t.slice(b, b + WIN)}${b + WIN < t.length ? '…' : ''}` : `${t.slice(0, 2 * WIN)}${t.length > 2 * WIN ? '…' : ''}`
    const i = hit.seq - 1
    const prev = order.slice(Math.max(0, i - k), i).map(m => `[before ${head(m)}] …${flat(m.text.slice(-WIN))}`)
    const nextOnes = order.slice(i + 1, i + 1 + k).map(m => `[after ${head(m)}] ${flat(m.text.slice(0, WIN))}…`)
    const out = [`[${head(hit)}] ${flat(win)}`, ...prev, ...nextOnes].join('\n')
    return { result: out.length > CAP ? out.slice(0, CAP - 12) + '…[truncated]' : out }
  })

  // ===========================================================================
  // Prompt submit: attach pending quotes, then clear them
  // ===========================================================================
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.origin.kind === 'plugin') return next(e)
    const list = await read($, quotes)
    if (list.length === 0) return next(e)
    // A failure while building must never swallow the prompt: send it unchanged; next runs exactly once.
    let block = ''
    try {
      const sid = await $.session.id()
      const body = list.map(q => {
        const where = q.id ? `id=${q.id} role=${q.role} seq=${q.seq} time=${q.time ? fmtFull(q.time) : '?'}` : 'id=? (selection spanned several messages)'
        const pos = q.start !== undefined ? ` chars=${q.start}-${q.end}` : q.id ? ' chars=? (not found verbatim in the raw text)' : ''
        const qt = q.text.trimEnd(), cut = qt.length > QMAX ? `…[+${qt.length - QMAX} chars cut; locate can show more]` : ''
        const quoted = (qt.slice(0, QMAX) + cut).split('\n').map(l => `> ${l}`).join('\n')
        // '…' only where the message goes on past the context; no line at all when the quote is the whole message.
        const len = byId.get(q.id ?? '')?.text.length ?? Infinity
        const bf = q.before ?? '', af = q.after ?? ''
        const ctx = q.start !== undefined && (bf || af) ? `\ncontext: ${q.start > bf.length ? '…' : ''}${bf.replace(/\s+/g, ' ')}⟦…⟧${af.replace(/\s+/g, ' ')}${(q.end ?? 0) + af.length < len ? '…' : ''}` : ''
        return `[Q${q.n}] ${where}${pos}\n${quoted}${ctx}${q.comment ? `\ncomment: ${q.comment}` : ''}`
      })
      block = `<quotes session="${sid}">\nThe user quoted these passages from this conversation; [Qn] in the prompt refers to them. chars=start-end is the quote's span in the raw message text; context shows the raw text around it (⟦…⟧ = the quote). This is usually enough; call ${TOOL} (id, start, end) only if the message is no longer in your context or you need slightly more around the quote.\n\n${body.join('\n\n')}\n</quotes>`
      await update($, quotes, () => [])
    } catch { block = '' }
    return next(block ? { ...e, text: `${e.text}\n\n${block}` } : e)
  })

  // ===========================================================================
  // Transcript rows: time and id header; collapse the attached <quotes> block
  // ===========================================================================
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer' && e.props.origin.kind !== 'unclassified') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const m = byId.get(e.requestId)
    if (!m) await read($, rev) // redraw once the JSONL line is indexed
    let ev = e
    const qs = e.props.text.match(QUOTES_RE)
    if (qs && !e.props.isExpanded) {
      const tags = [...qs[0].matchAll(/^\[Q(\d+)\] id=([0-9a-f?]+)/gm)].map(x => `Q${x[1]}${x[2] === '?' ? '' : ' #' + short(x[2] ?? '')}`)
      ev = { ...e, props: { ...e.props, text: `${e.props.text.replace(QUOTES_RE, '')}\n📎 ${L().attached} ${tags.join(', ')}` } }
    }
    const row = await next(ev)
    // Header under the row: above it, it would sit before the row's top margin and read as the previous message's.
    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={2}><Text dimColor>{m ? `${fmt(m.time)} · #${short(m.id)} · ${m.seq}` : `#${short(e.requestId)}`}</Text></Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.isFirstOfReply) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const m = byId.get(e.requestId)
    if (!m) await read($, rev)
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={2}><Text dimColor>{m ? `${fmt(m.time)} · #${short(m.id)} · ${m.seq}` : `#${short(e.requestId)}`}</Text></Box>
      </Box>
    )
  })

  // ===========================================================================
  // Band above the prompt: pending quotes and controls
  // ===========================================================================
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, quotes)
    const add = async () => {
      const { n, msg } = await quoteSelection($, '')
      if (n) await $.prompt.fill({ text: `[Q${n}] `, mode: 'insert' })
      else $.ui.toast(msg)
    }
    const toggle = async () => {
      const open = (await $.ui.panes()).some((p: any) => p.id === PANE)
      if (open) await $.ui.close({ id: PANE })
      else { await refresh($); await $.ui.open({ id: PANE, title: L().timelineTitle, focus: true, closeOnEscape: true }) }
    }
    return (
      <Box flexDirection="column">
        {list.map(q => (
          <Box>
            <Text dimColor>[Q{q.n}]{q.id ? ` #${short(q.id)}` : ''} “{firstLine(q.text, 50)}”{q.comment ? ` — ${firstLine(q.comment, 30)}` : ''} </Text>
            <Button key={`rm:${q.n}`} label="✕" onPress={() => update($, quotes, l => l.filter(x => x.n !== q.n))} />
          </Box>
        ))}
        <Box>
          <Button key="add" hotkey="q" label={L().bandAdd} onPress={add} />
          <Text> </Text>
          <Button key="timeline" hotkey="t" label={L().bandTimeline} onPress={toggle} />
          {list.length > 0 && <Text> </Text>}
          {list.length > 0 && <Button key="clear" label={L().bandClear} onPress={() => update($, quotes, () => [])} />}
        </Box>
      </Box>
    )
  })

  // ===========================================================================
  // Timeline pane: one node per message; jump or quote the whole message
  // ===========================================================================
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, rev)
    const width = e.viewport?.columns ?? 80
    const shown = order.slice(-300)
    const jump = async (m: Entry) => {
      const r: any = await $.ui.scroll({ to: { requestId: m.id }, block: 'start' })
      if (r?.deny) $.ui.toast(L().jumpFailed(short(m.id), r.deny))
    }
    // Quoting leaves the pane open (Esc always closes it); the person clicks the prompt to comment.
    const quote = async (m: Entry) => {
      const n = await addQuote($, m.text, m, '')
      await $.prompt.fill({ text: `[Q${n}] `, mode: 'insert' })
      $.ui.toast(L().addedTimeline(n))
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{L().paneHint}</Text>
        {shown.length === 0 && <Text dimColor>{L().paneEmpty}</Text>}
        {shown.map(m => (
          <Box>
            <Button key={`q:${m.id}`} label={L().paneQuote} onPress={() => quote(m)} />
            <Text> </Text>
            <Button key={`go:${m.id}`} label={`${fmt(m.time).slice(6)} ${m.role === 'user' ? '›' : '●'} ${m.seq} ${firstLine(m.text, Math.max(10, width - 30))}`} onPress={() => jump(m)} />
          </Box>
        ))}
      </Box>
    )
  })
}
