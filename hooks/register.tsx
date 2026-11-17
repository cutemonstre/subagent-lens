// Subagent Lens: one row above the prompt per running subagent, showing
// which model and effort it runs on, its type and task, how long it has run,
// and a Stop button. Fable and Opus rows are coloured so they stand out.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LensAgent } from '../types'

const agentsRef = { plugin: 'subagent-lens', key: 'agents' } as const
const agents = atom({ plugin: 'subagent-lens', key: 'agents' } as const, {})
const tickRef = { plugin: 'subagent-lens', key: 'tick' } as const
const tick = atom({ plugin: 'subagent-lens', key: 'tick' } as const, 0)

const MAX_ROWS = 6
const RECONCILE_EVERY = 5 // seconds between checks against $.agent.list()
const STOP_REASON =
  'Stopped by the user (Subagent Lens). Do not call any more tools: reply now with what you have.'

export const register: Register = on => {
  // Module variables reset on hot reload; the agents themselves live in $.state.
  let ticker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ticker?.cancel()
    let ticks = 0
    // One heartbeat for the session: it redraws the elapsed times and, every
    // few seconds, drops rows whose agent the engine no longer runs (stopped,
    // failed, or a turn.complete we missed). Idle when nothing is running.
    // The timer reaches state through $.state itself: the state helpers
    // (update/read) take $ only inside a hook's own dispatch.
    ticker = $.clock.every(1000, async () => {
      const { value: all = {}, version } = await $.state.get(agentsRef)
      if (Object.keys(all).length === 0) return
      await $.state.set(tickRef, await $.clock.now())
      ticks += 1
      if (ticks % RECONCILE_EVERY !== 0) return
      const listed = await $.agent.list()
      const running = new Set(listed.filter(a => a.status === 'running').map(a => a.id))
      const kept: Record<string, LensAgent> = {}
      for (const [id, a] of Object.entries(all)) if (running.has(id)) kept[id] = a
      if (Object.keys(kept).length === Object.keys(all).length) return
      // A missed write (a spawn landed meanwhile) is retried next round.
      await $.state.set(agentsRef, kept, { ifVersion: version })
    })
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny || !result.agentId) return result
    const now = await $.clock.now()
    const agent: LensAgent = {
      id: result.agentId,
      type: e.fork ? 'fork' : e.subagentType,
      task: e.description,
      model: result.model,
      effort: null,
      startedAt: now,
      isStopping: false,
    }
    await update($, tick, () => now)
    await update($, agents, all => ({ ...all, [agent.id]: agent }))
    return result
  })

  // Every model request a subagent sends names its real model and effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const id = e.agentId
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, agents, all => {
        const a = all[id]
        if (!a || (a.model === e.model && a.effort === effort)) return all
        return { ...all, [id]: { ...a, model: e.model, effort } }
      })
    }
    return yield* next(e)
  })

  // Backstop for Stop: an agent TaskStop could not end is refused every tool
  // call from then on, which makes it wrap up.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const { value: all = {} } = await $.state.get(agentsRef)
      if (all[e.agentId]?.isStopping) return { deny: STOP_REASON }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, all => {
        if (!(id in all)) return all
        const { [id]: _done, ...rest } = all
        return rest
      })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = Object.values(await read($, agents))
    if (e.props.hasSurvey || all.length === 0) return next(e)

    const now = await read($, tick)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isWide = e.props.bodyColumns >= 90
    const room = Math.max(1, Math.min(MAX_ROWS, e.props.maxRows - 1))
    const shown = all.sort((a, b) => a.startedAt - b.startedAt).slice(0, room)
    const hidden = all.length - shown.length

    return (
      <Box flexDirection="column" paddingX={1}>
        {shown.map(a => {
          const model = shortModel(a.model)
          const id = a.id
          return (
            <Box key={id} flexDirection="row">
              <Text color={modelColor(model)}>{a.isStopping ? '■ ' : '⟳ '}</Text>
              <Text bold>{a.type}</Text>
              <Text dimColor> · </Text>
              <Text bold color={modelColor(model)}>{model}</Text>
              <Text dimColor> · </Text>
              <Text color={effortColor(a.effort)} dimColor={a.effort === null}>
                {a.effort ?? '…'}
              </Text>
              <Text dimColor>{`  ${elapsed(now - a.startedAt)}  `}</Text>
              <Button
                key={`stop-${id}`}
                label={a.isStopping ? 'Stopping…' : 'Stop'}
                dimColor
                onPress={async () => {
                  await update($, agents, current =>
                    current[id] ? { ...current, [id]: { ...current[id], isStopping: true } } : current,
                  )
                  try {
                    await $.tool.call({ tool: 'TaskStop', task_id: id })
                  } catch {
                    // Not a stoppable task (a foreground agent): the tool.call
                    // backstop above makes it wrap up instead.
                  }
                }}
              />
              {isWide ? (
                <Text dimColor italic wrap="truncate-end">{`  ${a.task}`}</Text>
              ) : null}
            </Box>
          )
        })}
        {hidden > 0 ? <Text dimColor>{`  +${hidden} more running`}</Text> : null}
      </Box>
    )
  })
}

// "claude-sonnet-5-5" → "sonnet-5.5", "claude-haiku-4-5-20251001" → "haiku-4.5"
export function shortModel(id: string): string {
  return id
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2')
}

function modelColor(model: string): string {
  if (model.startsWith('fable')) return 'red'
  if (model.startsWith('opus')) return 'yellow'
  if (model.startsWith('sonnet')) return 'green'
  return 'cyan'
}

function effortColor(effort: string | null): string | undefined {
  if (effort === 'max' || effort === 'xhigh') return 'red'
  if (effort === 'high') return 'yellow'
  return undefined
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
