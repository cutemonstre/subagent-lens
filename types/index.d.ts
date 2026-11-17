export type LensAgent = {
  id: string
  type: string
  task: string
  model: string
  effort: string | null
  startedAt: number
  isStopping: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-lens': { agents: Record<string, LensAgent>; tick: number }
  }
}
