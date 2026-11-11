import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, ChangeKind, Decision, DecisionCost, Estimate, FileChange, ModelTier, Step, TaskSize, Todo } from '../types'

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

const estimate = atom({ plugin: 'work-progress', key: 'estimate' } as const, null as Estimate | null, { shape: 'estimate-1' })

// API prices in dollars per million tokens (Claude API reference, 2026-11-03).
// Cache write is 1.25x input; Haiku's cache read is assumed at 0.1x input.
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const PRICES: Record<ModelTier, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  fable: { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
}
const TIERS: ModelTier[] = ['haiku', 'sonnet', 'opus', 'fable']
// Starting guesses of one task's tokens per size; real tasks replace them over time.
const PRIOR: Record<TaskSize, Usage> = {
  tiny: { input_tokens: 2000, output_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 40000 },
  small: { input_tokens: 5000, output_tokens: 4000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 250000 },
  medium: { input_tokens: 15000, output_tokens: 15000, cache_creation_input_tokens: 80000, cache_read_input_tokens: 1500000 },
  large: { input_tokens: 40000, output_tokens: 50000, cache_creation_input_tokens: 250000, cache_read_input_tokens: 6000000 },
}
const SIZES = Object.keys(PRIOR) as TaskSize[]
const CALIBRATION_KEY = 'calibration-v1'
type Calibration = Partial<Record<TaskSize, Usage & { count: number }>>

const tierOf = (model: string): ModelTier | '' => TIERS.find(t => model.toLowerCase().includes(t)) ?? ''
const costOf = (u: Usage, tier: ModelTier) => {
  const p = PRICES[tier]
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead) / 1e6
}
const dollars = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

const ESTIMATE_SYSTEM = [
  'You size tasks for a coding agent. Reply with JSON only, no prose:',
  '{"size":"tiny|small|medium|large","kind":"question|small fix|feature|refactor|debugging|research|other","model":"haiku|sonnet|opus|fable","why":"under 12 words"}',
  'size: tiny = a question or one-line change; small = one file or one clear fix; medium = a few files or a feature; large = many files, unclear bugs, or long research.',
  'model: the cheapest that will do it well. haiku: questions, lookups, trivial edits. sonnet: routine coding and clear fixes. opus: multi-file features, unclear bugs, design choices. fable: only very hard, long work.',
].join('\n')

const parseEstimate = (text: string) => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const size = SIZES.find(one => one === raw.size)
    const model = TIERS.find(one => one === raw.model)
    if (!size || !model) return undefined
    return { size, suggested: model, kind: typeof raw.kind === 'string' ? clip(raw.kind, 30) : 'other', why: typeof raw.why === 'string' ? clip(raw.why, 90) : '' }
  } catch {
    return undefined
  }
}

// Claude Code's own color for asking the person; red stays for failures.
const NEEDS_YOU = 'permission'

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
    // From a later dispatch: a command.run hook may not wait on a new turn.
    $.clock.after(0, () => void $.prompt.submit({ text: note }).catch(() => $.ui.toast('Could not send the answer to Claude')))
  }
}

const readCalibration = async ($: Dollar): Promise<Calibration> => {
  const raw = await $.store.get(CALIBRATION_KEY).catch(() => undefined)
  return raw && typeof raw === 'object' ? (raw as Calibration) : {}
}

// Expected tokens for a size: the prior counts as one task, real tasks add to the mean.
const expected = (calibration: Calibration, size: TaskSize): Usage => {
  const seen = calibration[size]
  const prior = PRIOR[size]
  if (!seen || seen.count < 1) return prior
  const mix = (key: keyof Usage) => (prior[key] + seen[key] * seen.count) / (seen.count + 1)
  return { input_tokens: mix('input_tokens'), output_tokens: mix('output_tokens'), cache_creation_input_tokens: mix('cache_creation_input_tokens'), cache_read_input_tokens: mix('cache_read_input_tokens') }
}

const runEstimate = async ($: Dollar, task: string) => {
  const reply = await $.model.complete({ model: 'haiku', system: ESTIMATE_SYSTEM, prompt: clip(task, 2000), maxTokens: 200, timeoutMs: 20000 })
  const parsed = reply.isAnswered ? parseEstimate(reply.text) : undefined
  const current = tierOf(await $.session.model().catch(() => ''))
  if (!parsed) {
    await update($, estimate, e => (e && e.task === task ? { ...e, state: 'failed' as const, current } : e))
    return
  }
  const usage = expected(await readCalibration($), parsed.size)
  const costs = { haiku: costOf(usage, 'haiku'), sonnet: costOf(usage, 'sonnet'), opus: costOf(usage, 'opus'), fable: costOf(usage, 'fable') }
  await update($, estimate, e => (e && e.task === task ? { ...e, ...parsed, state: 'ready' as const, current, costs } : e))
}

const learn = async ($: Dollar, size: TaskSize, used: Usage) => {
  const calibration = await readCalibration($)
  const seen = calibration[size] ?? { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, count: 0 }
  const n = seen.count + 1
  const avg = (key: keyof Usage) => seen[key] + (used[key] - seen[key]) / n
  calibration[size] = { input_tokens: avg('input_tokens'), output_tokens: avg('output_tokens'), cache_creation_input_tokens: avg('cache_creation_input_tokens'), cache_read_input_tokens: avg('cache_read_input_tokens'), count: n }
  await $.store.set(CALIBRATION_KEY, calibration)
}

const switchModel = async ($: Dollar, tier: ModelTier) => {
  const ran = await $.command.run({ command: 'model', args: tier }).catch(() => undefined)
  if (!ran) $.ui.toast(`Could not switch. Type /model ${tier}`)
  else await update($, estimate, e => (e ? { ...e, current: tier } : e))
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
  // A typed task gets a quick size and cost estimate from the smallest model.
  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    const isTyped = e.command === undefined && e.origin?.kind !== 'plugin' && !e.isMeta
    if (isTyped && e.text.trim().length > 0) {
      const empty = { haiku: 0, sonnet: 0, opus: 0, fable: 0 }
      await update($, estimate, () => ({ task: e.text, state: 'thinking' as const, size: 'small' as const, kind: '', suggested: 'sonnet' as const, why: '', current: '' as const, costs: empty, actual: 0 }))
      // Off the prompt's path: the task starts while the estimate runs.
      $.clock.after(0, () => {
        void runEstimate($, e.text).catch(() =>
          update($, estimate, x => (x && x.task === e.text ? { ...x, state: 'failed' as const } : x)),
        )
      })
    }
    return ran
  })

  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({ name: 'progress', description: 'Open the work progress side panel' })
    await $.command.register({ name: 'decide', description: 'Answer a decision from the Work progress panel: /decide D2 theme.json', argumentHint: '<id> <option or your own answer>' })
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

  // Answers a decision from the prompt, where the panel's buttons need focus first.
  on('command.run', { command: 'decide' }, async ($, e) => {
    const list = await read($, decisions)
    const match = (e.args ?? '').trim().match(/^(D\d+)\s+(.+)$/i)
    if (!match) {
      const open = list.filter(d => d.by !== 'you').slice(-6)
      const lines = open.map(d => `${d.id} ${d.question} [${d.options.join(' | ')}] now: ${d.by === 'waiting' ? 'waiting' : d.chosen}`)
      return { text: open.length ? `Answer with /decide <id> <option>:\n${lines.join('\n')}` : 'No open decisions.' }
    }
    const id = (match[1] as string).toUpperCase()
    const answer = (match[2] as string).trim()
    const d = list.find(one => one.id === id)
    if (!d) return { text: `No decision ${id}.` }
    // A typed option matches its button regardless of case.
    const option = d.options.find(o => o.toLowerCase() === answer.toLowerCase()) ?? answer
    await choose($, id, option)
    return { text: `${id} → ${option}.` }
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
    const used = e.usage
    const tier = used ? tierOf(used.model) : ''
    if (used && tier) {
      const spent = costOf(used, tier)
      const est = await update($, estimate, x => (x ? { ...x, actual: x.actual + spent } : x))
      if (est && est.state === 'ready' && !e.isAborted) await learn($, est.size, used)
    }
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
    const [act, stepList, fileList, todoList, decisionList, est, now] = await Promise.all([
      read($, activity), read($, steps), read($, changes), read($, todos), read($, decisions), read($, estimate), $.clock.now(),
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
          <Text color={NEEDS_YOU} bold>⚠ Needs you · {act.waitingFor}</Text>
        ) : act.isWorking ? (
          <Text color="yellow" bold>● Working · {seconds(now - act.startedAt)}</Text>
        ) : waiting.length > 0 ? (
          <Text color={NEEDS_YOU} bold>⚠ Needs you · {waiting.length} decision{waiting.length === 1 ? '' : 's'} waiting</Text>
        ) : (
          <Text color="green" bold>✓ Idle{act.lastMs ? ` · last task took ${seconds(act.lastMs)}` : ''}</Text>
        )}
        {act.task !== '' && <Text dimColor wrap="truncate-end">Task: {clip(act.task, width - 6)}</Text>}
        <Text wrap="truncate-end">
          Now: {act.isWorking ? (running ? running.label : 'Thinking…') : 'Waiting for you'}
        </Text>

        {est && (
          <Box flexDirection="column" marginTop={1}>
            {est.state === 'thinking' && <Text dimColor>Estimate: sizing the task…</Text>}
            {est.state === 'failed' && <Text dimColor>Estimate: not available for this task.</Text>}
            {est.state === 'ready' && (
              <Box flexDirection="column">
                <Text bold>Estimate · {est.size} {est.kind}</Text>
                <Text wrap="truncate-end">
                  {TIERS.map(t => `${t} ~${dollars(est.costs[t])}`).join(' · ')}
                </Text>
                <Text wrap="truncate-end" color={est.current !== '' && est.current !== est.suggested ? 'cyan' : 'green'}>
                  {est.current === est.suggested ? `✓ ${est.current} fits this task` : `Suggested: ${est.suggested}`}
                  {est.why ? ` · ${est.why}` : ''}
                </Text>
                {est.current !== '' && est.current !== est.suggested && (
                  <Box flexDirection="row">
                    <Button key="switch-model" variant="primary" onPress={() => void switchModel($, est.suggested)}>
                      Switch to {est.suggested}
                    </Button>
                    <Text dimColor> now: {est.current} · a switch restarts the prompt cache</Text>
                  </Box>
                )}
              </Box>
            )}
            {est.actual > 0 && (
              <Text wrap="truncate-end">
                Spent so far: {dollars(est.actual)}
                {est.state === 'ready' && est.current !== '' ? ` (estimate ~${dollars(est.costs[est.current])} on ${est.current})` : ''}
              </Text>
            )}
            <Text dimColor>At API prices; on a plan this is usage, not a bill.</Text>
          </Box>
        )}

        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Decisions{waiting.length > 0 ? ` · ${waiting.length} parked` : ''}</Text>
            <Text dimColor wrap="truncate-end">Answer: /decide {shown[0]?.id ?? 'D1'} &lt;option&gt; · or ctrl+x tab, then Tab and Enter</Text>
            {shown.map(d => (
              <Box
                flexDirection="column"
                key={d.id}
                {...(d.by === 'waiting' ? { borderStyle: 'round', borderColor: NEEDS_YOU, paddingX: 1 } : {})}
              >
                <Text wrap="truncate-end" color={d.by === 'waiting' ? NEEDS_YOU : undefined} bold={d.by === 'waiting'} dimColor={d.by === 'you'}>
                  {d.by === 'waiting' ? '⏸' : '✓'} {d.id} {d.question}
                  {d.by === 'waiting' ? ' · waiting for you' : ` · ${d.chosen} (${d.by === 'claude' ? 'decided by Claude' : 'yours'})`}
                </Text>
                {d.by !== 'you' && (
                  <Box flexDirection="column">
                    {d.why !== '' && <Text dimColor wrap="truncate-end">  Recommended: {d.recommended} · {d.why}</Text>}
                    {d.by === 'waiting' && <Text color={NEEDS_YOU} wrap="truncate-end">  Your input: /decide {d.id} &lt;option&gt;</Text>}
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
