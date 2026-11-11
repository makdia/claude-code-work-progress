export type ChangeKind = 'added' | 'edited' | 'removed'
export type FileChange = { path: string; kind: ChangeKind; added: number; removed: number; edits: number }
export type Step = { id: string; label: string; state: 'running' | 'done' | 'failed' }
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }
export type Activity = { isWorking: boolean; task: string; startedAt: number; lastMs: number }

declare module 'claude-code' {
  interface PluginState {
    'work-progress': {
      activity: Shaped<Activity>
      steps: Shaped<Step[]>
      changes: Shaped<FileChange[]>
      todos: Shaped<Todo[]>
    }
  }
}
