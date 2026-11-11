import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Activity, ChangeKind, FileChange, Step, Todo } from '../types'

const PANE = 'work-progress'
const TITLE = 'Work progress'

// Bump a shape tag when that value's fields change: old stored values are then dropped.
const activity = atom({ plugin: 'work-progress', key: 'activity' } as const, { isWorking: false, task: '', startedAt: 0, lastMs: 0 } as Activity, { shape: 'activity-1' })
const steps = atom({ plugin: 'work-progress', key: 'steps' } as const, [] as Step[], { shape: 'steps-1' })
const changes = atom({ plugin: 'work-progress', key: 'changes' } as const, [] as FileChange[], { shape: 'changes-1' })
const todos = atom({ plugin: 'work-progress', key: 'todos' } as const, [] as Todo[], { shape: 'todos-1' })

const MAX_STEPS = 50
const MAX_FILES = 300

let cwd = ''
let ticker: Timer | undefined

const short = (path: string) => (cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path)
const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}
const seconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

type Patch = { lines: string[] }[]
// Edit and Write results share these fields.
type WriteResult = { structuredPatch?: Patch; type?: 'create' | 'update'; content?: string; staged?: boolean }
const countPatch = (patch: Patch | undefined) => {
  let added = 0
  let removed = 0
  for (const hunk of patch ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// Files named by rm / git rm / unlink in a shell command; flags and globs skipped.
const removedPaths = (command: string): string[] => {
  const found: string[] = []
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/)
    const at = words[0] === 'git' && words[1] === 'rm' ? 2 : words[0] === 'rm' || words[0] === 'unlink' ? 1 : -1
    if (at < 0) continue
    for (const word of words.slice(at)) {
      if (!word || word.startsWith('-') || /[*?$`|<>]/.test(word)) continue
      found.push(word.replace(/^['"]|['"]$/g, ''))
    }
  }
  return found
}

const label = (tool: string, input: Record<string, unknown>): string => {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Read': return `Reading ${short(text('file_path'))}`
    case 'Edit': return `Editing ${short(text('file_path'))}`
    case 'Write': return `Writing ${short(text('file_path'))}`
    case 'NotebookEdit': return `Editing ${short(text('notebook_path'))}`
    case 'Bash': return text('description') || `Running ${clip(text('command'), 50)}`
    case 'Grep': return `Searching for "${clip(text('pattern'), 40)}"`
    case 'Glob': return `Finding files ${clip(text('pattern'), 40)}`
    case 'Agent': return `Sub-agent: ${text('description') || 'working'}`
    case 'WebFetch': return `Reading web page ${clip(text('url'), 50)}`
    case 'WebSearch': return `Searching the web: ${clip(text('query'), 40)}`
    case 'TodoWrite': return 'Updating the to-do list'
    case 'Skill': return `Using skill ${text('skill')}`
    default: return tool.startsWith('mcp__') ? `Tool ${tool.split('__').slice(1).join(' › ')}` : tool
  }
}

const record = (list: FileChange[], path: string, kind: ChangeKind, added: number, removed: number) => {
  const old = list.find(one => one.path === path)
  if (!old) return [...list, { path, kind, added, removed, edits: 1 }].slice(-MAX_FILES)
  // A file created this session stays "added" through later edits.
  const next: ChangeKind = kind === 'removed' ? 'removed' : old.kind === 'added' ? 'added' : kind
  return list.map(one =>
    one.path === path ? { ...one, kind: next, added: one.added + added, removed: one.removed + removed, edits: one.edits + 1 } : one,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({ name: 'progress', description: 'Open the work progress side panel' })
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Work progress panel opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    await update($, activity, a => ({ ...a, isWorking: true, task: e.text || a.task, startedAt: now }))
    if (e.text) await update($, steps, () => [])
    ticker?.cancel()
    ticker = $.clock.every(5000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    ticker?.cancel()
    ticker = undefined
    const now = await $.clock.now()
    await update($, activity, a => ({ ...a, isWorking: false, lastMs: now - a.startedAt }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const step: Step = { id: e.tool_use_id, label: label(e.tool, input), state: 'running' }
    if (e.agentId === undefined) await update($, steps, list => [...list, step].slice(-MAX_STEPS))

    const ran = await next(e)
    const isOk = ran.deny === undefined && ran.isError !== true

    if (e.agentId === undefined) {
      await update($, steps, list => list.map(one => (one.id === step.id ? { ...one, state: isOk ? ('done' as const) : ('failed' as const) } : one)))
    }
    if (!isOk) return ran

    if (e.tool === 'TodoWrite') {
      await update($, todos, () => e.todos.map(t => ({ content: t.content, status: t.status })))
    } else if ((e.tool === 'Edit' || e.tool === 'Write') && ran.result && !(ran.result as WriteResult).staged) {
      const out = ran.result as WriteResult
      const { added, removed } = countPatch(out.structuredPatch)
      const isNew = e.tool === 'Write' && out.type === 'create'
      const path = short(e.file_path)
      const lines = isNew ? (out.content ?? '').split('\n').length : added
      await update($, changes, list => record(list, path, isNew ? 'added' : 'edited', lines, removed))
    } else if (e.tool === 'NotebookEdit') {
      const path = short(e.notebook_path)
      await update($, changes, list => record(list, path, 'edited', 0, 0))
    } else if (e.tool === 'Bash') {
      const gone = removedPaths(e.command)
      if (gone.length) await update($, changes, list => gone.reduce((acc, p) => record(acc, short(p), 'removed', 0, 0), list))
    }
    return ran
    // Only observes: a failure here must never block the tool call.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [act, stepList, fileList, todoList, now] = await Promise.all([
      read($, activity), read($, steps), read($, changes), read($, todos), $.clock.now(),
    ])
    const width = Math.max(20, (e.viewport?.columns ?? 60) - 4)
    const rows = Math.max(10, e.viewport?.rows ?? 30)

    const running = [...stepList].reverse().find(one => one.state === 'running')
    const doneTodos = todoList.filter(t => t.status === 'completed').length
    const plus = fileList.reduce((n, f) => n + f.added, 0)
    const minus = fileList.reduce((n, f) => n + f.removed, 0)
    const fileRoom = Math.max(3, Math.floor(rows / 3))
    const stepRoom = Math.max(3, Math.floor(rows / 4))
    const mark = { added: 'A', edited: 'M', removed: 'D' } as const
    const tone = { added: 'green', edited: 'yellow', removed: 'red' } as const

    return (
      <Box flexDirection="column">
        {act.isWorking ? (
          <Text color="yellow" bold>● Working · {seconds(now - act.startedAt)}</Text>
        ) : (
          <Text color="green" bold>✓ Idle{act.lastMs ? ` · last task took ${seconds(act.lastMs)}` : ''}</Text>
        )}
        {act.task !== '' && <Text dimColor wrap="truncate-end">Task: {clip(act.task, width - 6)}</Text>}
        <Text wrap="truncate-end">
          Now: {act.isWorking ? (running ? running.label : 'Thinking…') : 'Waiting for you'}
        </Text>

        {todoList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Progress {doneTodos}/{todoList.length}</Text>
            {todoList.map(t => (
              <Text wrap="truncate-end" dimColor={t.status === 'completed'} color={t.status === 'in_progress' ? 'cyan' : undefined}>
                {t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} {t.content}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Files changed ({fileList.length}) <Text color="green">+{plus}</Text> <Text color="red">-{minus}</Text></Text>
          {fileList.length === 0 && <Text dimColor>No code changes yet.</Text>}
          {fileList.slice(-fileRoom).map(f => (
            <Text wrap="truncate-end">
              <Text color={tone[f.kind]}>{mark[f.kind]}</Text> {f.path}{' '}
              {f.kind !== 'removed' && <Text color="green">+{f.added}</Text>}
              {f.kind !== 'removed' && ' '}
              {f.kind !== 'removed' && <Text color="red">-{f.removed}</Text>}
            </Text>
          ))}
          {fileList.length > fileRoom && <Text dimColor>…and {fileList.length - fileRoom} more</Text>}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recent steps</Text>
          {stepList.length === 0 && <Text dimColor>None yet.</Text>}
          {stepList.slice(-stepRoom).map(s => (
            <Text wrap="truncate-end" dimColor={s.state === 'done'} color={s.state === 'failed' ? 'red' : s.state === 'running' ? 'cyan' : undefined}>
              {s.state === 'running' ? '›' : s.state === 'failed' ? '✗' : '✓'} {s.label}
            </Text>
          ))}
        </Box>
        <Text dimColor>A added · M edited · D removed</Text>
      </Box>
    )
  })
}
