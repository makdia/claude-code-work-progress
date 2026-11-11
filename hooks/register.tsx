import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, ChangeKind, Decision, DecisionCost, FileChange, Step, Todo } from '../types'

const PANE = 'work-progress'
const TITLE = 'Work progress'

// Bump a shape tag when that value's fields change: old stored values are then dropped.
const IDLE: Activity = { isWorking: false, task: '', startedAt: 0, lastMs: 0, waitingFor: '', taskFiles: [], taskAdded: 0, taskRemoved: 0 }
const activity = atom({ plugin: 'work-progress', key: 'activity' } as const, IDLE, { shape: 'activity-2' })
const steps = atom({ plugin: 'work-progress', key: 'steps' } as const, [] as Step[], { shape: 'steps-2' })
const changes = atom({ plugin: 'work-progress', key: 'changes' } as const, [] as FileChange[], { shape: 'changes-1' })
const todos = atom({ plugin: 'work-progress', key: 'todos' } as const, [] as Todo[], { shape: 'todos-1' })
const decisions = atom({ plugin: 'work-progress', key: 'decisions' } as const, [] as Decision[], { shape: 'decisions-1' })
// Answers from the person not yet read by Claude.
const notes = atom({ plugin: 'work-progress', key: 'notes' } as const, [] as string[], { shape: 'notes-1' })

const DECIDE = 'decide'
const DECIDE_TOOL = /^mcp__work-progress__decide$/
const MAX_DECISIONS = 50
const DECIDE_HELP = [
  'Record a decision instead of stopping to ask the person. They answer later in the Work progress panel while you keep working.',
  "cost 'small': cheap to redo if changed (naming, wording, styling details, where a file goes). You decide: use `recommended` and continue at once.",
  "cost 'costly': expensive to redo or hard to undo (architecture, data or storage format, an approach touching many files, push, delete, migration, sending anything). Do not guess: skip the work that depends on it, do all the work that does not, and if only parked work is left while it is unanswered, end your turn saying what waits on the person.",
  "When unsure which cost applies, use 'costly'. Do not use this tool for what the person already decided.",
  'Answers reach you as a note after a later tool result, or as a new message: for a small decision, revise the work that used the old choice; for a costly one, do the parked work.',
].join('\n')

const MAX_STEPS = 50
const MAX_FILES = 300
// A task shorter than this, with no file changed, gets no summary toast.
const SUMMARY_MIN_MS = 30000
// Tools that stop and wait for the person's answer.
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

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

const noteTask = (a: Activity, path: string, added: number, removed: number): Activity => ({
  ...a,
  taskFiles: a.taskFiles.includes(path) ? a.taskFiles : [...a.taskFiles, path].slice(-MAX_FILES),
  taskAdded: a.taskAdded + added,
  taskRemoved: a.taskRemoved + removed,
})

const describeChange = (d: Decision, choice: string) =>
  d.cost === 'costly'
    ? `Decision ${d.id} answered by the person: "${d.question}" → ${choice}. Do the work you parked for it now.`
    : `Decision ${d.id} changed by the person: "${d.question}" → ${choice} (you had used ${d.chosen}). Revise the work that used ${d.chosen}.`

const record = (list: FileChange[], path: string, kind: ChangeKind, added: number, removed: number) => {
  const old = list.find(one => one.path === path)
  if (!old) return [...list, { path, kind, added, removed, edits: 1 }].slice(-MAX_FILES)
  // A file created this session stays "added" through later edits.
  const next: ChangeKind = kind === 'removed' ? 'removed' : old.kind === 'added' ? 'added' : kind
  return list.map(one =>
    one.path === path ? { ...one, kind: next, added: one.added + added, removed: one.removed + removed, edits: one.edits + 1 } : one,
  )
}

type Dollar = EngineInterface

const deliver = async ($: Dollar, note: string) => {
  const act = await read($, activity)
  if (act.isWorking) {
    await update($, notes, list => [...list, note])
  } else {
    void $.prompt.submit({ text: note })
  }
}

// The person picks an option in the panel.
const choose = async ($: Dollar, id: string, choice: string) => {
  const list = await read($, decisions)
  const d = list.find(one => one.id === id)
  const picked = choice.trim()
  if (!d || !picked) return
  const isSame = d.by !== 'waiting' && d.chosen === picked
  await update($, decisions, all => all.map(one => (one.id === id ? { ...one, chosen: picked, by: 'you' as const } : one)))
  if (!isSame) await deliver($, describeChange(d, picked))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({ name: 'progress', description: 'Open the work progress side panel' })
    await $.tool.register({
      name: DECIDE,
      description: DECIDE_HELP,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The decision, as one short question' },
          options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6, description: 'The choices, short labels' },
          recommended: { type: 'string', description: 'Your recommended option, one of options' },
          why: { type: 'string', description: 'Why you recommend it, one short sentence' },
          cost: { type: 'string', enum: ['small', 'costly'], description: 'How costly a wrong guess would be' },
        },
        required: ['question', 'options', 'recommended', 'why', 'cost'],
      },
    })
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
    await update($, activity, a =>
      e.text
        ? { ...a, isWorking: true, task: e.text, startedAt: now, waitingFor: '', taskFiles: [], taskAdded: 0, taskRemoved: 0 }
        : { ...a, isWorking: true, startedAt: now, waitingFor: '' },
    )
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
    const done = await update($, activity, a => ({ ...a, isWorking: false, waitingFor: '', lastMs: now - a.startedAt }))
    // Answers Claude never read this turn start a turn of their own.
    const unread = await read($, notes)
    if (unread.length > 0) {
      await update($, notes, () => [])
      void $.prompt.submit({ text: unread.join('\n') })
    }
    const failed = (await read($, steps)).filter(one => one.state === 'failed').length
    const files = done.taskFiles.length
    if (!e.isAborted && (files > 0 || done.lastMs >= SUMMARY_MIN_MS)) {
      const parts = [`Done in ${seconds(done.lastMs)}`]
      if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'} +${done.taskAdded} -${done.taskRemoved}`)
      if (failed > 0) parts.push(`${failed} failed step${failed === 1 ? '' : 's'}`)
      $.ui.toast(parts.join(' · '), { timeoutMs: 8000 })
    }
    return next(e)
  })

  // Answers the decide tool; the generic tool.call hook below still records the step.
  on('tool.call', { tool: DECIDE_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const options = Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string').slice(0, 6) : []
    const question = typeof input.question === 'string' ? clip(input.question, 200) : ''
    const recommended = typeof input.recommended === 'string' ? input.recommended : ''
    const cost: DecisionCost = input.cost === 'small' ? 'small' : 'costly'
    if (!question || options.length < 2 || !options.includes(recommended)) {
      return { deny: 'decide needs a question, 2 to 6 options and a recommended value that is one of the options.' }
    }
    const list = await update($, decisions, all => {
      const d: Decision = {
        id: `D${all.length + 1}`,
        question,
        options,
        recommended,
        why: typeof input.why === 'string' ? clip(input.why, 200) : '',
        cost,
        chosen: cost === 'small' ? recommended : '',
        by: cost === 'small' ? 'claude' : 'waiting',
      }
      return [...all, d].slice(-MAX_DECISIONS)
    })
    const d = list[list.length - 1] as Decision
    const text =
      cost === 'small'
        ? `${d.id} recorded: using "${recommended}". Continue now; if the person changes it you will get a note.`
        : `${d.id} parked: waiting for the person. Do not do the work that depends on it; continue everything else. If only parked work is left, end your turn and say what waits on them.`
    return { result: text }
  })

  // Raised just before Claude Code shows a permission prompt.
  on('classic.PermissionRequest', async ($, e, next) => {
    const what = label(e.tool_name, (e.tool_input ?? {}) as Record<string, unknown>)
    await update($, activity, a => ({ ...a, waitingFor: `Approve: ${what}` }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    const startedAt = await $.clock.now()
    const step: Step = { id: e.tool_use_id, label: label(e.tool, input), state: 'running', startedAt, ms: 0 }
    if (isMain) await update($, steps, list => [...list, step].slice(-MAX_STEPS))
    if (isMain && ASKS_PERSON.has(e.tool)) await update($, activity, a => ({ ...a, waitingFor: 'Answer the question in the chat' }))

    const ran = await next(e)
    const isOk = ran.deny === undefined && ran.isError !== true
    const ms = (await $.clock.now()) - startedAt

    if (isMain) {
      await update($, steps, list =>
        list.map(one => (one.id === step.id ? { ...one, state: isOk ? ('done' as const) : ('failed' as const), ms } : one)),
      )
      // The call settled, so whatever it waited on was answered.
      await update($, activity, a => (a.waitingFor ? { ...a, waitingFor: '' } : a))
    }
    // The person's answers ride on the next result Claude reads.
    let out = ran
    if (isMain && ran.deny === undefined) {
      const pending = await read($, notes)
      if (pending.length > 0) {
        await update($, notes, () => [])
        out = { ...ran, context: [...(ran.context ?? []), ...pending] }
      }
    }
    if (!isOk) return out

    if (e.tool === 'TodoWrite') {
      await update($, todos, () => e.todos.map(t => ({ content: t.content, status: t.status })))
    } else if ((e.tool === 'Edit' || e.tool === 'Write') && ran.result && !(ran.result as WriteResult).staged) {
      const out = ran.result as WriteResult
      const { added, removed } = countPatch(out.structuredPatch)
      const isNew = e.tool === 'Write' && out.type === 'create'
      const path = short(e.file_path)
      const lines = isNew ? (out.content ?? '').split('\n').length : added
      await update($, changes, list => record(list, path, isNew ? 'added' : 'edited', lines, removed))
      await update($, activity, a => noteTask(a, path, lines, removed))
    } else if (e.tool === 'NotebookEdit') {
      const path = short(e.notebook_path)
      await update($, changes, list => record(list, path, 'edited', 0, 0))
      await update($, activity, a => noteTask(a, path, 0, 0))
    } else if (e.tool === 'Bash') {
      const gone = removedPaths(e.command)
      if (gone.length) {
        await update($, changes, list => gone.reduce((acc, p) => record(acc, short(p), 'removed', 0, 0), list))
        await update($, activity, a => gone.reduce((acc, p) => noteTask(acc, short(p), 0, 0), a))
      }
    }
    return out
    // Only observes: a failure here must never block the tool call.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const [act, stepList, fileList, todoList, decisionList, now] = await Promise.all([
      read($, activity), read($, steps), read($, changes), read($, todos), read($, decisions), $.clock.now(),
    ])
    const waiting = decisionList.filter(d => d.by === 'waiting')
    // Open ones first, then the latest decided ones.
    const shown = [...waiting, ...decisionList.filter(d => d.by !== 'waiting').slice(-4).reverse()]
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
        {act.waitingFor !== '' ? (
          <Text color="red" bold>⚠ Needs you · {act.waitingFor}</Text>
        ) : act.isWorking ? (
          <Text color="yellow" bold>● Working · {seconds(now - act.startedAt)}</Text>
        ) : waiting.length > 0 ? (
          <Text color="red" bold>⚠ Needs you · {waiting.length} decision{waiting.length === 1 ? '' : 's'} waiting</Text>
        ) : (
          <Text color="green" bold>✓ Idle{act.lastMs ? ` · last task took ${seconds(act.lastMs)}` : ''}</Text>
        )}
        {act.task !== '' && <Text dimColor wrap="truncate-end">Task: {clip(act.task, width - 6)}</Text>}
        <Text wrap="truncate-end">
          Now: {act.isWorking ? (running ? running.label : 'Thinking…') : 'Waiting for you'}
        </Text>

        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Decisions{waiting.length > 0 ? ` · ${waiting.length} parked` : ''}</Text>
            {shown.map(d => (
              <Box flexDirection="column" key={d.id}>
                <Text wrap="truncate-end" color={d.by === 'waiting' ? 'red' : undefined} dimColor={d.by === 'you'}>
                  {d.by === 'waiting' ? '⏸' : '✓'} {d.id} {d.question}
                  {d.by === 'waiting' ? ' · waiting for you' : ` · ${d.chosen} (${d.by === 'claude' ? 'decided by Claude' : 'yours'})`}
                </Text>
                {d.by !== 'you' && (
                  <Box flexDirection="column">
                    {d.why !== '' && <Text dimColor wrap="truncate-end">  Recommended: {d.recommended} · {d.why}</Text>}
                    <Box flexDirection="row" flexWrap="wrap">
                      {d.options.map(option => (
                        <Button
                          key={`${d.id}-${option}`}
                          variant={option === d.chosen || (d.by === 'waiting' && option === d.recommended) ? 'primary' : undefined}
                          onPress={() => void choose($, d.id, option)}
                        >
                          {option}
                        </Button>
                      ))}
                    </Box>
                    <Input key={`${d.id}-other`} placeholder="Other… (type and press Enter)" onSubmit={value => void choose($, d.id, value)} />
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

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
              {s.state === 'running' ? ` · ${seconds(now - s.startedAt)}` : s.ms >= 1000 ? ` · ${seconds(s.ms)}` : ''}
            </Text>
          ))}
        </Box>
        <Text dimColor>A added · M edited · D removed</Text>
      </Box>
    )
  })
}
