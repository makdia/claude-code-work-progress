import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'work-progress',
  component: 'Pane',
  requestId: 'work-progress',
  props: { title: 'Work progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Stands in for the engine: a clock the test moves, and tool results.
const engine = (on: Parameters<TestBody>[1], clock: { now: number }, toasts: string[]) => {
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
