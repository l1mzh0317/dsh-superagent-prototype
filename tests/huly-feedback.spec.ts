import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../src/app/runtime.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { HulyFeedback } from '../src/sources/huly-feedback.ts'
import { HulyClient, HULY, type HulyDeployment } from '../src/sources/huly-client.ts'

const d: HulyDeployment = { workspace: 'ws', workspaceUrl: 'pt', endpoint: '', origin: 'https://huly.example', tokenFile: '', botPerson: 'bot-person', botSocial: 'bot', botAccount: 'bot-account', channels: ['c'], operators: [] }
function fixture() {
  const trigger = { id: 'input', human: true, addressed: 'mention', actor: { source: 'huly', id: 'alice' }, threads: [{ source: 'huly', id: 'ws:c:root' }], meta: { messageId: 'm' }, channel: { source: 'huly', thread: 'ws:c:root', address: { channelId: 'c', rootId: 'root' } } } as unknown as Trigger
  const values = new Map<string, unknown>(), tickets: Ticket[] = []
  const host = { state: { get: (k: string) => { const v = values.get(k); return v ? structuredClone(v) : undefined }, set: (k: string, v: unknown) => values.set(k, structuredClone(v)), keys: (f: { prefix: string }) => [...values.keys()].filter(k => k.startsWith(f.prefix)) }, threads: { get: () => ({ evaluating: { delivered: 'now' } }) }, triggers: { get: () => trigger } } as unknown as SourceContext
  const disposition = vi.fn((): Record<string, unknown> => ({ fanout: tickets.map(t => t.id) }))
  const relay = vi.fn()
  const runtime = { sessions: { relay }, store: { atomic: (f: () => unknown) => f(), receipts: { waiting: () => [] }, settings: () => ({ policy: { sources: { huly: { allowed: [{ id: 'alice' }] } } } }), triggers: { disposition }, decisions: { get: vi.fn() }, tickets: { get: (id: string) => tickets.find(t => t.id === id), list: () => tickets } } } as unknown as Pick<Runtime, 'store' | 'sessions'>
  const client = new HulyClient(d), reaction = vi.spyOn(client, 'receivedReaction').mockResolvedValue(), feedback = vi.spyOn(client, 'feedback').mockResolvedValue()
  return { trigger, tickets, client, reaction, feedback, host, runtime, disposition, relay, make: () => new HulyFeedback(host, client, runtime) }
}
describe('Huly visible delivery feedback', () => {
  it('marks receipt before a worker exists, then reconciles the same receipt into its real worker link', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger); await receipt.sync()
    expect(f.reaction).toHaveBeenCalledWith('m')
    expect(f.feedback.mock.calls[0]?.[3]).toContain('Router 正在处理')
    f.tickets.push({ id: 'task', title: '检查部署', origin: { triggerIds: ['input'] }, assignments: [{ id: 'assignment', state: 'pending' }] } as unknown as Ticket)
    await receipt.sync(); expect(f.feedback.mock.calls.at(-1)?.[3]).toContain('排队中')
    f.tickets[0]!.assignments[0]!.state = 'running'
    await receipt.sync()
    expect(f.feedback.mock.calls.at(-1)).toEqual(['root', 'c', 'input', expect.stringContaining('Worker 已接手'), { ticketId: 'task', title: '检查部署', sessionId: 'worker-task' }])
    await f.make().sync(); expect(f.feedback).toHaveBeenCalledTimes(3); expect(f.reaction).toHaveBeenCalledOnce()
  })
  it('retries an external feedback failure after restart without losing the received input', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger)
    f.feedback.mockRejectedValueOnce(new Error('Huly unavailable'))
    await expect(receipt.sync()).rejects.toThrow('Huly unavailable')
    await f.make().sync()
    expect(f.feedback).toHaveBeenCalledTimes(2); expect(f.reaction).toHaveBeenCalledOnce()
  })
  it('does not write reactions for synthetic Dashboard inputs', async () => {
    const f = fixture(), receipt = f.make(); receipt.record({ ...f.trigger, meta: { surface: 'dashboard' } }); await receipt.sync()
    expect(f.reaction).not.toHaveBeenCalled(); expect(f.feedback).not.toHaveBeenCalled()
  })
  it('keeps unmentioned follow-ups silent until a worker actually takes them up', async () => {
    const f = fixture(), receipt = f.make(); delete f.trigger.addressed
    f.tickets.push({ id: 'task', title: '检查部署', origin: { triggerIds: ['earlier-mention'] }, assignments: [{ id: 'assignment', state: 'running' }] } as unknown as Ticket)
    receipt.record(f.trigger); await receipt.sync()
    expect(f.reaction).not.toHaveBeenCalled(); expect(f.feedback).not.toHaveBeenCalled()
    f.disposition.mockReturnValue({ fanout: ['task'], acked: ['task'] })
    await receipt.sync()
    expect(f.reaction).toHaveBeenCalledWith('m'); expect(f.feedback.mock.calls.at(-1)?.[3]).toContain('已纳入处理')
  })
  it('requests one durable answer when a mention was routed as discussion without being answered', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger)
    f.disposition.mockReturnValue({ fanout: [], decisionId: 'ignore' })
    vi.mocked(f.runtime.store.decisions.get).mockReturnValue({ kind: 'ignore' } as never)
    await receipt.sync(); await f.make().sync()
    expect(f.relay).toHaveBeenCalledOnce()
    expect(JSON.parse(f.relay.mock.calls[0]![1])).toMatchObject({ kind: 'huly_answer_required', trigger_id: 'input' })
  })
  it('does not ask for a second answer while the native Outbox is already delivering one', async () => {
    const f = fixture(), receipt = f.make(); receipt.record(f.trigger)
    f.disposition.mockReturnValue({ fanout: [], decisionId: 'ignore' })
    vi.mocked(f.runtime.store.decisions.get).mockReturnValue({ kind: 'ignore' } as never)
    const { key } = await import('../src/core/index.ts')
    f.runtime.store.receipts.waiting = () => [{ id: key('reply', 'input', '正在发送的回答'), kind: 'reply', text: '正在发送的回答' }] as never
    await receipt.sync()
    expect(f.relay).not.toHaveBeenCalled()
    expect(f.feedback.mock.calls.at(-1)?.[3]).toContain('正在发送')
  })
  it('uses a stable Huly reaction and does not toggle it off on replay', async () => {
    const client = new HulyClient(d), one = vi.spyOn(client, 'one').mockResolvedValueOnce(undefined).mockResolvedValueOnce({ _id: 'm', _class: HULY.message, space: 'c' } as never)
    const api = vi.spyOn(client, 'api').mockResolvedValue({})
    await client.receivedReaction('m')
    const tx = api.mock.calls[0]![2] as Record<string, unknown>
    expect(tx).toMatchObject({ objectClass: HULY.reaction, attachedTo: 'm', collection: 'reactions', attributes: { emoji: '✅', createBy: 'bot' } })
    one.mockResolvedValue({ _id: tx.objectId } as never)
    await client.receivedReaction('m'); expect(api).toHaveBeenCalledOnce()
  })
  it('links each reply to the authorized task and updates only the bot-owned status message', async () => {
    const client = new HulyClient(d), session = { ticketId: 'task', title: '检查部署', sessionId: 'worker-task' }
    const one = vi.spyOn(client, 'one').mockResolvedValueOnce(undefined).mockResolvedValueOnce({ _id: 'root', _class: HULY.message, space: 'c' } as never).mockResolvedValueOnce({ _id: 'c' } as never)
    const api = vi.spyOn(client, 'api').mockResolvedValue({})
    await client.reply('root', 'c', 'reply', '已完成', session)
    const tx = api.mock.calls[0]![2] as { attributes: { message: string } }
    const markup = JSON.parse(tx.attributes.message)
    expect(markup.content.at(-1).content[0]).toMatchObject({ text: 'Worker · 检查部署 · worker-task', marks: [{ type: 'link', attrs: { href: 'https://huly.example/files/ws/team-peppy/?task=task&session=1' } }] })
    one.mockResolvedValue({ _id: 'existing', space: 'c', attachedTo: 'root', createdBy: 'someone-else' } as never)
    await expect(client.feedback('root', 'c', 'input', '处理中', session)).rejects.toThrow('ownership')
    expect(api).toHaveBeenCalledOnce()
  })
})
