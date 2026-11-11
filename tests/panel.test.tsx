import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'work-progress',
  component: 'Pane',
  requestId: 'work-progress',
  props: { title: 'Work progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Stands in for the engine: a clock the test moves, and tool results.
const engine = (on: Parameters<TestBody>[1], clock: { now: number }, toasts: string[], prompts: string[] = []) => {
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.register', () => ({ value: { tool: 'mcp__work-progress__decide' } }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: clock.now }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', () => ({ turnId: 't' }))
  on('classic.PermissionRequest', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    clock.now += 2000
    return e.tool === 'Write'
      ? { result: { type: 'create', content: 'a\nb\nc', structuredPatch: [] } }
      : e.tool === 'Edit'
        ? { result: { structuredPatch: [{ lines: ['+x', '+y', '-z', ' k'] }] } }
        : { result: {} }
  })
}

test('the panel lists files added, edited and removed, and timed steps', async ($, on) => {
  const clock = { now: 1000 }
  engine(on, clock, [])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/new.php', content: 'a\nb\nc' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/style.scss', old_string: 'z', new_string: 'x\ny' })
  await $.tool.call({ tool: 'Bash', command: 'rm -f old.js && git rm legacy.php', description: 'Remove old files' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Files changed \(4\)/ }))?.text).toContain('+5 -1')
    expect((await ui.find({ type: 'Text', text: /src\/new\.php/ }))?.text).toBe('A src/new.php +3 -0')
    expect((await ui.find({ type: 'Text', text: /style\.scss/ }))?.text).toBe('M style.scss +2 -1')
    expect((await ui.find({ type: 'Text', text: /old\.js/ }))?.text).toContain('D old.js')
    expect((await ui.find({ type: 'Text', text: /Remove old files/ }))?.text).toBe('✓ Remove old files · 2s')
    await ui.unmount()
  }
})

test('a finished task shows a summary toast', async ($, on) => {
  const clock = { now: 1000 }
  const toasts: string[] = []
  engine(on, clock, toasts)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a file', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/new.php', content: 'a\nb\nc' })
  await $.tool.call({ tool: 'Bash', command: 'false', description: 'Run tests' })
  clock.now += 40000
  await $.turn.complete({ answer: 'done', durationMs: 44000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(toasts).toEqual(['Done in 44s · 1 file +3 -0'])
})

test('a short answer with no file changed shows no toast', async ($, on) => {
  const clock = { now: 1000 }
  const toasts: string[] = []
  engine(on, clock, toasts)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what is this?', turnId: 't2' })
  clock.now += 3000
  await $.turn.complete({ answer: 'a thing', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer' })

  expect(toasts).toEqual([])
})

test('a permission prompt shows "Needs you" until the call settles', async ($, on) => {
  const clock = { now: 1000 }
  engine(on, clock, [])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'push it', turnId: 't3' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push the branch' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Needs you/ }))?.text).toBe('⚠ Needs you · Approve: Push the branch')
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push the branch' })
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  expect((await after.find({ type: 'Text', text: /Working/ }))?.text).toContain('● Working')
  await after.unmount()
})

// The mod's own tool is not in the built-in typings.
type ToolCallInput = Parameters<Parameters<TestBody>[0]['tool']['call']>[0]
const decide = ($: Parameters<TestBody>[0], input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__work-progress__decide', ...input } as unknown as ToolCallInput)
const start = async ($: Parameters<TestBody>[0], text: string) => {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 'd' })
}

test('a small decision is taken by Claude, and a change reaches the next step', async ($, on) => {
  const clock = { now: 1000 }
  engine(on, clock, [])
  await start($, 'style the swatch')
  const ran = await decide($, { question: 'Hover border width?', options: ['1px', '2px'], recommended: '2px', why: 'Easier to see', cost: 'small' })
  expect(String(ran.result)).toContain('D1 recorded: using "2px"')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /D1 Hover/ }))?.text).toBe('✓ D1 Hover border width? · 2px (decided by Claude)')
  await ui.press({ key: 'D1-1px' })
  await ui.unmount()

  // Claude is still working: the change rides on its next tool result.
  const next = await $.tool.call({ tool: 'Read', file_path: '/proj/a.scss' })
  expect(next.context?.join(' ')).toContain('Decision D1 changed by the person: "Hover border width?" → 1px (you had used 2px)')
  const after = await $.tool.call({ tool: 'Read', file_path: '/proj/b.scss' })
  expect(after.context).toBeUndefined()
})

test('a costly decision is parked, and an answer while idle starts a new turn', async ($, on) => {
  const clock = { now: 1000 }
  const prompts: string[] = []
  engine(on, clock, [], prompts)
  await start($, 'add a setting')
  const ran = await decide($, { question: 'Store it in DB or theme.json?', options: ['theme.json', 'DB'], recommended: 'theme.json', why: 'No migration', cost: 'costly' })
  expect(String(ran.result)).toContain('D1 parked')
  await $.turn.complete({ answer: 'waiting on D1', durationMs: 5000, isAborted: false, turnId: 'd', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Needs you/ }))?.text).toBe('⚠ Needs you · 1 decision waiting')
  expect((await ui.find({ type: 'Text', text: /D1 Store/ }))?.text).toBe('⏸ D1 Store it in DB or theme.json? · waiting for you')
  await ui.input({ key: 'D1-other', text: 'wp_options' })
  await ui.unmount()

  expect(prompts).toEqual(['Decision D1 answered by the person: "Store it in DB or theme.json?" → wp_options. Do the work you parked for it now.'])
})

test('confirming Claude\'s own choice sends nothing', async ($, on) => {
  const clock = { now: 1000 }
  const prompts: string[] = []
  engine(on, clock, [], prompts)
  await start($, 'name it')
  await decide($, { question: 'Class name?', options: ['fct-hover', 'fct-swatch-hover'], recommended: 'fct-swatch-hover', why: 'Clearer', cost: 'small' })
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 'd', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'D1-fct-swatch-hover' })
  expect((await ui.find({ type: 'Text', text: /D1 Class/ }))?.text).toBe('✓ D1 Class name? · fct-swatch-hover (yours)')
  await ui.unmount()
  expect(prompts).toEqual([])
})

test('a change Claude did not read before its turn ended starts a new turn', async ($, on) => {
  const clock = { now: 1000 }
  const prompts: string[] = []
  engine(on, clock, [], prompts)
  await start($, 'style it')
  await decide($, { question: 'Radius?', options: ['4px', '8px'], recommended: '8px', why: 'Matches cards', cost: 'small' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'D1-4px' })
  await ui.unmount()
  expect(prompts).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 'd', reason: 'answer' })
  expect(prompts).toEqual(['Decision D1 changed by the person: "Radius?" → 4px (you had used 8px). Revise the work that used 8px.'])
})

test('a decide call with a recommendation outside its options is refused', async ($, on) => {
  engine(on, { now: 1000 }, [])
  await start($, 'x')
  const ran = await decide($, { question: 'Q?', options: ['a', 'b'], recommended: 'c', why: '', cost: 'small' })
  expect(ran.deny).toContain('recommended value that is one of the options')
})
