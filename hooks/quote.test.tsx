import { expect, test } from 'claude-code/testing'

// A two-message transcript; the assistant line also holds a tool_use block.
const JSONL = [
  JSON.stringify({ type: 'user', uuid: 'aaaaaaaa-1111', timestamp: '2026-11-19T02:00:00.000Z', message: { role: 'user', content: 'hello there' } }),
  JSON.stringify({ type: 'assistant', uuid: 'bbbbbbbb-2222', timestamp: '2026-11-19T02:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'line one\nline two' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }),
  '',
].join('\n')

test('a selection is quoted with its message id, attached on submit, then cleared', async ($, on) => {
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.stat', () => ({ value: { size: JSONL.length } as any }))
  on('fs.read', () => ({ value: JSONL }))
  on('ui.selection', () => ({ value: { text: 'line two', requestId: 'bbbbbbbb-2222' } }))
  const filled: string[] = []
  on('prompt.fill', (_, e: any) => { filled.push(e.text); return { isFilled: true } as any })
  let sent = ''
  on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })

  // /quote runs the same flow as the band button: [Qn] goes into the prompt.
  const ran: any = await $.command.run({ command: 'quote', args: '' } as any)
  expect(ran.text).toContain('#bbbbbbbb')
  expect(filled).toEqual(['[Q1] '])

  await $.prompt.submit({ text: '看 [Q1]', origin: { kind: 'composer' } } as any)
  expect(sent).toContain('[Q1] id=bbbbbbbb-2222 role=assistant seq=2')
  expect(sent).toContain('> line two')

  sent = ''
  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
  expect(sent).toBe('next')
})

test('a tool row selection maps to the assistant message holding the call', async ($, on) => {
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('fs.stat', () => ({ value: { size: JSONL.length } as any }))
  on('fs.read', () => ({ value: JSONL }))
  on('ui.selection', () => ({ value: { text: 'ls -la', requestId: 'toolu_1' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  const ran: any = await $.command.run({ command: 'quote', args: '' } as any)
  expect(ran.text).toContain('#bbbbbbbb')
})

// Engine stubs shared by the render tests: the transcript above, and an engine row drawing "engine".
function engine(on: any) {
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } }))
  on('fs.stat', () => ({ value: { size: JSONL.length } }))
  on('fs.read', () => ({ value: JSONL }))
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: { tool: 'mcp__conv-quote__locate' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.render', { plugin: '*' }, ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
}

test('message rows get a time/id header and a collapsed quotes block', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)

  const user = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'UserMessage', requestId: 'aaaaaaaa-1111', props: { text: 'hi\n\n<quotes session="s">\nx\n[Q1] id=bbbbbbbb-2222 role=assistant\n> a\n</quotes>', origin: { kind: 'composer' }, isExpanded: false } } as any)
  expect((await user.find({ type: 'Text', text: /#aaaaaaaa · 1/ }))?.text).toBeTruthy()
  expect((await user.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await user.unmount()

  const bot = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'AssistantMessage', requestId: 'bbbbbbbb-2222', props: { text: 'line one', isFirstOfReply: true } } as any)
  expect((await bot.find({ type: 'Text', text: /#bbbbbbbb · 2/ }))?.text).toBeTruthy()
  await bot.unmount()
})

test('band adds a quote from the selection; pane lists messages', async ($, on) => {
  engine(on)
  on('ui.selection', () => ({ value: { text: 'hello there', requestId: 'aaaaaaaa-1111' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)

  const band = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as any)
  await band.press({ key: 'add' } as any)
  expect((await band.find({ type: 'Text', text: /\[Q1\] #aaaaaaaa/ }))?.text).toBeTruthy()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'Pane', requestId: 'conv-timeline', props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as any)
  expect(await pane.find({ type: 'Button', key: 'go:bbbbbbbb-2222' } as any)).toBeTruthy()
  await pane.unmount()
})

test('a rendered selection maps back to its span in the raw markdown, and locate marks it', async ($, on) => {
  const raw = '前文一句。\n- **可能还会冲突**：`reply-quote` 很可能还在。\n后文。'
  const md = JSON.stringify({ type: 'assistant', uuid: 'cccccccc-3333', timestamp: '2026-11-19T02:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: raw }] } }) + '\n'
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', () => ({ value: { size: md.length } as any }))
  on('fs.read', () => ({ value: md }))
  // Rendered text: bold and code marks gone.
  on('ui.selection', () => ({ value: { text: '可能还会冲突：reply-quote', requestId: 'cccccccc-3333' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  let sent = ''
  on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })

  await $.command.run({ command: 'quote', args: '' } as any)
  await $.prompt.submit({ text: '[Q1]', origin: { kind: 'composer' } } as any)
  const s = raw.indexOf('可能'), t = raw.indexOf('`', raw.indexOf('`') + 1)
  expect(sent).toContain(`chars=${s}-${t}`)
  expect(sent).toContain('context: 前文一句。 - **⟦…⟧` 很可能还在。 后文。\n')

  const r: any = await $.tool.call({ tool: 'mcp__conv-quote__locate', id: 'cccccccc', start: s, end: t } as any)
  expect(String(r.result)).toContain('⟦可能还会冲突**：`reply-quote⟧`')
})

test('locate stays local: 150-char window, context at most 2, answer at most 500 chars', async ($, on) => {
  const big = (c: string) => c.repeat(2000)
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c, i) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', uuid: `${c.repeat(8)}-0000`, timestamp: '2026-11-19T02:00:00.000Z', message: { role: 'x', content: big(c) } })).join('\n') + '\n'
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('fs.stat', () => ({ value: { size: lines.length } as any }))
  on('fs.read', () => ({ value: lines }))

  const one: any = await $.tool.call({ tool: 'mcp__conv-quote__locate', id: 'dddddddd', start: 1000, end: 1010 } as any)
  const s = String(one.result)
  expect(s).toContain('…' + 'd'.repeat(150) + '⟦' + 'd'.repeat(10) + '⟧' + 'd'.repeat(150) + '…')
  expect(s.length).toBeLessThanOrEqual(500)

  const wide: any = await $.tool.call({ tool: 'mcp__conv-quote__locate', id: 'dddddddd', start: 1000, end: 1010, context: 5 } as any)
  const w = String(wide.result)
  expect(w.length).toBeLessThanOrEqual(500)
  expect(w).not.toContain('#aaaaaaaa')
})

test('the <quotes> block carries at most 300 quoted chars and 25 context chars per side', async ($, on) => {
  const raw = 'x'.repeat(100) + 'y'.repeat(1000) + 'z'.repeat(100)
  const md = JSON.stringify({ type: 'assistant', uuid: 'eeeeeeee-5555', timestamp: '2026-11-19T02:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: raw }] } }) + '\n'
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', () => ({ value: { size: md.length } as any }))
  on('fs.read', () => ({ value: md }))
  on('ui.selection', () => ({ value: { text: 'y'.repeat(1000), requestId: 'eeeeeeee-5555' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  let sent = ''
  on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })

  await $.command.run({ command: 'quote', args: '' } as any)
  await $.prompt.submit({ text: '[Q1]', origin: { kind: 'composer' } } as any)
  expect(sent).toContain('> ' + 'y'.repeat(300) + '…[+700 chars cut')
  expect(sent).not.toContain('y'.repeat(301))
  expect(sent).toContain('chars=100-1100')
  expect(sent).toContain('context: …' + 'x'.repeat(25) + '⟦…⟧' + 'z'.repeat(25) + '…')
})

test('a whole-message quote has no context line', async ($, on) => {
  const md = JSON.stringify({ type: 'assistant', uuid: 'ffffffff-6666', timestamp: '2026-11-19T02:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'whole message' }] } }) + '\n'
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', () => ({ value: { size: md.length } as any }))
  on('fs.read', () => ({ value: md }))
  on('ui.selection', () => ({ value: { text: 'whole message', requestId: 'ffffffff-6666' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  let sent = ''
  on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })
  await $.command.run({ command: 'quote', args: '' } as any)
  await $.prompt.submit({ text: 't', origin: { kind: 'composer' } } as any)
  expect(sent).toContain('chars=0-13')
  expect(sent).not.toContain('context:')
})

test('timeline: 「引」 fills [Qn] into the prompt and keeps the pane open', async ($, on) => {
  engine(on)
  const filled: string[] = []
  const closed: string[] = []
  on('prompt.fill', (_: any, e: any) => { filled.push(e.text); return { isFilled: true } as any })
  on('ui.close', (_: any, e: any) => { closed.push(e.id); return { value: undefined } as any })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)

  const pane = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'Pane', requestId: 'conv-timeline', props: { title: 't', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as any)
  await pane.press({ key: 'q:bbbbbbbb-2222' } as any)
  expect(filled).toEqual(['[Q1] '])
  expect(closed).toEqual([])
  await pane.unmount()
})

for (const [setting, want] of [['chinese', '已添加 [Q1]'], ['japanese', 'Added [Q1]'], [undefined, 'Added [Q1]']] as const) {
  test(`language ${setting ?? 'unset'} → ${want}`, async ($, on) => {
    engine(on)
    on('settings.read', () => ({ value: setting === undefined ? {} : { language: setting } }) as any)
    on('ui.selection', () => ({ value: { text: 'line two', requestId: 'bbbbbbbb-2222' } }))
    on('prompt.fill', () => ({ isFilled: true }) as any)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
    const ran: any = await $.command.run({ command: 'quote', args: '' } as any)
    expect(ran.text).toContain(want)
  })
}

test('message header uses the timeZone setting', async ($, on) => {
  engine(on)
  on('settings.read', () => ({ value: { timeZone: 'Asia/Shanghai' } }) as any)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const user = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'UserMessage', requestId: 'aaaaaaaa-1111', props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } } as any)
  expect((await user.find({ type: 'Text', text: /#aaaaaaaa/ }))?.text).toBe('11-19 10:00:00 · #aaaaaaaa · 1')
  await user.unmount()
})

test('a sent quote is listed under the message as a jump button', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const text = '看 [Q1]\n\n<quotes session="s">\nheader\n\n[Q1] id=bbbbbbbb-2222 role=assistant seq=2 time=x chars=9-17\n> line two\ncontext: line one ⟦…⟧\n\n[Q2] id=? (selection spanned several messages)\n> a\n> b\n</quotes>'
  const user = await $.ui.mount({ plugin: 'conv-quote', surface: 'terminal', component: 'UserMessage', requestId: 'aaaaaaaa-1111', props: { text, origin: { kind: 'composer' }, isExpanded: false } } as any)
  expect((await user.find({ type: 'Button', key: 'jq:1' } as any))?.text).toBe('↪ Q1 #bbbbbbbb “line two”')
  expect((await user.find({ type: 'Button', key: 'jq:2' } as any))?.text).toBe('↪ Q2 “a”')
  await user.unmount()
})

for (const requestId of [undefined, 'row-not-indexed']) {
  test(`a selection with ${requestId ? 'an unknown row id' : 'no row id'} is found by its text, markdown marks ignored`, async ($, on) => {
    const raw = '两项都改好了。\n\n**2. `/quote` 和「引用选区」按钮现在走同一套流程**\n- 两者用的是同一个函数'
    const md = JSON.stringify({ type: 'assistant', uuid: '3ba84cde-7777', timestamp: '2026-11-19T02:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: raw }] } }) + '\n'
    on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } as any }))
    on('session.id', () => ({ value: 's' }))
    on('fs.stat', () => ({ value: { size: md.length } as any }))
    on('fs.read', () => ({ value: md }))
    on('ui.selection', () => ({ value: { text: '2. /quote 和「引用选区」按钮现在走同一套流程', requestId } }))
    on('prompt.fill', () => ({ isFilled: true }) as any)
    let sent = ''
    on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })
    const ran: any = await $.command.run({ command: 'quote', args: '' } as any)
    expect(ran.text).toContain('#3ba84cde')
    await $.prompt.submit({ text: '[Q1]', origin: { kind: 'composer' } } as any)
    expect(sent).toContain('[Q1] id=3ba84cde-7777')
    expect(sent).toContain(`chars=${raw.indexOf('2.')}-`)
  })
}

test('a selection spanning several messages goes to the first, its part spanned there', async ($, on) => {
  engine(on)
  // From message 2's last line, over its header, into a later message (here message 1's text).
  on('session.id', () => ({ value: 's' }))
  on('ui.selection', () => ({ value: { text: 'line two\n11-19 10:00:05 · #bbbbbbbb · 2\nhello there' } }))
  on('prompt.fill', () => ({ isFilled: true }) as any)
  let sent = ''
  on('prompt.submit', (_, e) => { sent = e.text; return { text: e.text } as any })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const ran: any = await $.command.run({ command: 'quote', args: '' } as any)
  expect(ran.text).toContain('#bbbbbbbb')
  await $.prompt.submit({ text: '[Q1]', origin: { kind: 'composer' } } as any)
  expect(sent).toContain('[Q1] id=bbbbbbbb-2222 role=assistant seq=2')
  expect(sent).toContain('(first of several messages selected)')
  expect(sent).toContain('chars=9-17')
})
