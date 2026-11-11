export type ChangeKind = 'added' | 'edited' | 'removed'
export type FileChange = { path: string; kind: ChangeKind; added: number; removed: number; edits: number }
export type Step = { id: string; label: string; state: 'running' | 'done' | 'failed'; startedAt: number; ms: number }
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }
export type DecisionCost = 'small' | 'costly'
export type Decision = {
  id: string
  question: string
  options: string[]
  recommended: string
  why: string
  cost: DecisionCost
  // The option in force: Claude's pick for a small decision, '' while a costly one waits.
  chosen: string
  by: 'claude' | 'you' | 'waiting'
}

export type TaskSize = 'tiny' | 'small' | 'medium' | 'large'
export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Estimate = {
  task: string
  state: 'thinking' | 'ready' | 'failed'
  size: TaskSize
  kind: string
  suggested: ModelTier
  why: string
  // The session's model when the task started, as a tier ('' if unknown).
  current: ModelTier | ''
  // Estimated dollars per tier at API prices.
  costs: Record<ModelTier, number>
  // Dollars actually spent on this task so far (main loop turns).
  actual: number
}

export type Activity = {
  isWorking: boolean
  task: string
  startedAt: number
  lastMs: number
  // What Claude waits on from the person ('' when nothing).
  waitingFor: string
  // This task's own totals, for the end-of-task summary.
  taskFiles: string[]
  taskAdded: number
  taskRemoved: number
}

declare module 'claude-code' {
  interface PluginState {
    'work-progress': {
      activity: Shaped<Activity>
      steps: Shaped<Step[]>
      changes: Shaped<FileChange[]>
      todos: Shaped<Todo[]>
      decisions: Shaped<Decision[]>
      notes: Shaped<string[]>
      estimate: Shaped<Estimate | null>
    }
  }
}
