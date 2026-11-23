import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../src/app/runtime.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { HulyFeedback, hulyMessageStatus } from '../src/sources/huly-feedback.ts'
import { HulyClient, type HulyDeployment } from '../src/sources/huly-client.ts'

const d: HulyDeployment = { workspace: 'ws', workspaceUrl: 'pt', endpoint: '', origin: 'https://huly.example', tokenFile: '', botPerson: 'bot-person', botSocial: 'bot', botAccount: 'bot-account', channels: ['c'], operators: [] }
function fixture() {
  const trigger = { id: 'input', human: true, addressed: 'mention', actor: { source: 'huly', id: 'alice' }, threads: [{ source: 'huly', id: 'ws:c:root' }], meta: { messageId: 'm' }, channel: { source: 'huly', thread: 'ws:c:root', address: { channelId: 'c', rootId: 'root' } } } as unknown as Trigger
  const values = new Map<string, unknown>(), tickets: Ticket[] = []
  const host = { state: { get: (k: string) => structuredClone(values.get(k)), set: (k: string, v: unknown) => values.set(k, structuredClone(v)), keys: (f: { prefix: string }) => [...values.keys()].filter(k => k.startsWith(f.prefix)) }, triggers: { get: () => trigger } } as unknown as SourceContext
  const disposition = vi.fn((): Record<string, unknown> => ({ fanout: tickets.map(t => t.id) })), relay = vi.fn()
  const runtime = { sessions: { relay }, store: { get: (k: string) => values.get(k), atomic: (f: () => unknown) => f(), receipts: { waiting: () => [] }, settings: () => ({ policy: { sources: { huly: { allowed: [{ id: 'alice' }] } } } }), triggers: { disposition }, decisions: { get: vi.fn() }, tickets: { get: (id: string) => tickets.find(t => t.id === id), list: () => tickets } } } as unknown as Pick<Runtime, 'store' | 'sessions'>
  const client = new HulyClient(d), api = vi.spyOn(client, 'api').mockResolvedValue({})
  return { trigger, tickets, values, client, api, host, runtime, disposition, relay, make: () => new HulyFeedback(host, client, runtime), status: () => hulyMessageStatus(runtime, 'ws', trigger) }
}
describe('Message-header delivery state', () => {
  it('projects intake, queue, worker and terminal state without sending channel noise', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger); await receipt.sync()
    expect(f.status()).toMatchObject({ messageId: 'm', state: 'processing', sessionName: null, sessionId: null })
    f.tickets.push({ id: 'task', title: '修复登录问题', origin: { triggerIds: ['input'] }, assignments: [{ id: 'assignment', state: 'pending' }] } as unknown as Ticket)
    expect(f.status()).toMatchObject({ state: 'queued', taskId: 'task', sessionName: '修复登录问题', sessionId: null })
    Object.assign(f.tickets[0]!.assignments[0]!, { state: 'running', startedAt: 'now' })
    expect(f.status()).toMatchObject({ state: 'running', sessionId: 'worker-task' })
    f.tickets[0]!.ended = { by: 'human', at: 'now' } as never
    expect(f.status()).toMatchObject({ state: 'stopped' })
    f.tickets[0]!.ended = { by: 'pull', at: 'now', outcome: 'closed' } as never
    expect(f.status()).toMatchObject({ state: 'ended', label: '已结束' })
    await receipt.sync(); expect(f.api).not.toHaveBeenCalled()
  })
  it('keeps unmentioned context silent until actually adopted', () => {
    const f = fixture(); delete f.trigger.addressed
    f.tickets.push({ id: 'task', title: '检查部署', origin: { triggerIds: ['earlier'] }, assignments: [{ state: 'running' }] } as unknown as Ticket)
    expect(f.status()).toBeUndefined()
    f.disposition.mockReturnValue({ fanout: ['task'], acked: ['task'] })
    expect(f.status()).toMatchObject({ state: 'running', sessionName: '检查部署' })
  })
  it('requests one substantive answer for an unanswered mention without sending a receipt', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger)
    f.disposition.mockReturnValue({ fanout: [], decisionId: 'ignore' })
    vi.mocked(f.runtime.store.decisions.get).mockReturnValue({ kind: 'ignore' } as never)
    await receipt.sync(); await f.make().sync()
    expect(f.relay).toHaveBeenCalledOnce(); expect(f.api).not.toHaveBeenCalled()
  })
  it('does not duplicate an answer already pending in the native Outbox', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger)
    f.disposition.mockReturnValue({ fanout: [], decisionId: 'ignore' })
    vi.mocked(f.runtime.store.decisions.get).mockReturnValue({ kind: 'ignore' } as never)
    const { key } = await import('../src/core/index.ts')
    f.runtime.store.receipts.waiting = () => [{ id: key('reply', 'input', '回答'), kind: 'reply', text: '回答' }] as never
    await receipt.sync(); expect(f.relay).not.toHaveBeenCalled()
  })
  it('sends the actual reply without a worker ID or session-link footer', async () => {
    const client = new HulyClient(d)
    vi.spyOn(client, 'one').mockResolvedValueOnce(undefined).mockResolvedValueOnce({ _id: 'root', _class: 'chunter:class:ChatMessage', space: 'c' } as never).mockResolvedValueOnce({ _id: 'c' } as never)
    const api = vi.spyOn(client, 'api').mockResolvedValue({})
    await client.reply('root', 'c', 'reply', '已修复登录问题')
    const tx = api.mock.calls[0]![2] as { attributes: { message: string } }
    expect(JSON.parse(tx.attributes.message).content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: '已修复登录问题' }] }])
  })
})
