import { describe, expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'subagent-lens',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
} as const

describe('subagent-lens', () => {
  test('a spawned subagent shows its type, model and effort, then clears', async ($, on) => {
    // Hooks registered here sit beneath the mod and stand in for the engine.
    const clock = mock.clock(on, { now: 1_000_000 })
    on('ui.render', ($, e) => $.ui.resolve(e).Box({})) // the engine's empty band
    on('session.start', ($, e) => ({ cwd: e.cwd }) as any)
    on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'a1' }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    })
    on('turn.complete', () => ({ text: '' }))
    on('agent.list', () => [{ id: 'a1', description: 'find auth code', type: 'Explore', status: 'running' }] as any)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeUndefined()

    await $.agent.spawn({ prompt: 'find auth', description: 'find auth code', subagentType: 'Explore' } as any)
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'fable-5.1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /find auth code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()

    // The subagent's first request names the effort it actually runs at.
    for await (const _ of $.turn.step({
      turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'low', messageCount: 1, agentId: 'a1',
    } as any)) {
    }
    expect(await ui.find({ type: 'Text', text: 'low' })).toBeDefined()

    // The heartbeat redraws the elapsed time.
    await clock.advance(3_000)
    expect(await ui.find({ type: 'Text', text: /0:03/ })).toBeDefined()

    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeUndefined()
    await ui.unmount()
  })

  test('Stop refuses the stopped subagent its next tool call', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('ui.render', ($, e) => $.ui.resolve(e).Box({})) // the engine's empty band
    on('session.start', ($, e) => ({ cwd: e.cwd }) as any)
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a2' }))
    on('tool.call', () => ({ result: 'ran' }) as any)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'big refactor', subagentType: 'general-purpose' } as any)
    expect(await ui.find({ type: 'Text', text: 'opus-5.5' })).toBeDefined()

    await ui.press({ key: 'stop-a2' })
    expect(await ui.find({ type: 'Button', label: 'Stopping…' } as any)).toBeDefined()

    const r: any = await $.tool.call({ tool: 'Read', file_path: '/work/a.md', agentId: 'a2' } as any).catch(
      (err: unknown) => ({ deny: String(err) }),
    )
    expect(JSON.stringify(r)).toMatch(/Subagent Lens/)
    await ui.unmount()
  })
})
