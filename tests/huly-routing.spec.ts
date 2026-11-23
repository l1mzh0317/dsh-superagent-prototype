import { describe, it, expect, vi } from 'vitest'
import type { Runtime } from '../src/app/runtime.ts'
import type { Trigger, Ticket } from '../src/core/index.ts'
import { HulyClient, HulyError } from '../src/sources/huly-client.ts'
import { HulyRouting } from '../src/sources/huly-routing.ts'
function fixture() {
  const client = new HulyClient({ workspace: 'ws', workspaceUrl: 'pt', origin: '', endpoint: '', tokenFile: '', botPerson: '', botSocial: '', botAccount: '', channels: ['c'], operators: [] })
  const account = { uuid: 'alice', role: 'USER', socialIds: ['social-alice'] }
  vi.spyOn(client, 'account').mockResolvedValue(account)
  vi.spyOn(client, 'one').mockResolvedValue({ _id: 'c' } as never)
  const ticket = { id: 'ticket', mandate: { actor: { source: 'huly', id: 'social-alice' } }, channels: [{ source: 'huly', address: { workspace: 'ws', channelId: 'c' } }] } as unknown as Ticket
  const receive = vi.fn((_t: Trigger) => 'stored'), attach = vi.fn(), wake = vi.fn()
  const runtime = { receive, store: { atomic: (f: () => unknown) => f(), settings: () => ({ policy: { sources: { huly: { allowed: [{ id: 'social-alice' }] } } } }), triggers: { get: vi.fn(), disposition: () => ({ fanout: [] }) }, tickets: { get: (id: string) => id === 'ticket' ? ticket : undefined } }, sources: { instance: () => ({ config: { channels: ['c'] } }) }, engine: { receive, attach }, passes: { request: wake } } as unknown as Runtime
  const input = { id: 'input', at: '2026-11-23T00:00:00Z', text: '继续', source: 'huly', addressed: 'mention', human: true, actor: { source: 'huly', id: 'social-alice' }, threads: [{ source: 'huly', id: 'ws:c:root' }], meta: { workspace: 'ws', channelId: 'c', rootId: 'root' } } as Trigger
  return { client, account, runtime, input, ticket, receive, attach, routing: new HulyRouting(runtime, client) }
}
describe('Optional Huly mention routing', () => {
  it('leaves unselected messages with the normal Router and uses a private native lane for an explicit existing choice', async () => {
    const f = fixture(); await f.routing.receive(f.input); expect(f.receive).toHaveBeenCalledWith(f.input)
    f.input.meta.peppyRoute = (await f.routing.issue('ticket', 'user-token', f.account)).route
    await f.routing.receive(f.input)
    expect(f.receive.mock.calls.at(-1)?.[0]).toMatchObject({ threads: [{ id: 'selected:input' }, { id: 'ws:c:root' }], meta: { rootId: 'root', sessionChoice: 'ticket' } })
    expect(f.attach).toHaveBeenCalledWith('ticket', 'input', expect.any(String))
  })
  it('revalidates live access and never changes an expired/forged choice into automatic work', async () => {
    const f = fixture(); f.input.meta.peppyRoute = (await f.routing.issue('ticket', 'user-token', f.account)).route
    vi.mocked(f.client.one).mockResolvedValue(undefined)
    await f.routing.receive(f.input)
    expect(f.attach).not.toHaveBeenCalled(); expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ routingError: true }) }))
    f.input.meta.peppyRoute = 'forged'; await f.routing.receive(f.input); expect(f.attach).not.toHaveBeenCalled()
  })
  it('retains intake for retry during a temporary Huly outage', async () => {
    const f = fixture(); f.input.meta.peppyRoute = (await f.routing.issue('ticket', 'user-token', f.account)).route
    vi.mocked(f.client.account).mockRejectedValue(new HulyError(502, 'temporarily unavailable'))
    await expect(f.routing.receive(f.input)).rejects.toMatchObject({ status: 502 })
    expect(f.receive).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled()
  })
  it('binds choices to their author and marks verified new-work intent without creating a second executor', async () => {
    const f = fixture(); const grant = await f.routing.issue('new', 'user-token', f.account)
    f.input.meta.peppyRoute = grant.route; await f.routing.receive(f.input)
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ newTicket: true, threads: [{ source: 'huly', id: 'selected:input' }, { source: 'huly', id: 'ws:c:root' }] }))
    expect(f.attach).not.toHaveBeenCalled()
    f.input.actor.id = 'another-member'; await f.routing.receive(f.input)
    expect(f.receive.mock.calls.at(-1)?.[0]).toMatchObject({ meta: { routingError: true } })
  })
  it('rejects issuance to a read-only reader, stopped work or mixed-source evidence', async () => {
    const f = fixture(); f.ticket.channels.push({ source: 'github', address: {} } as never)
    await expect(f.routing.issue('ticket', 'user-token', f.account)).rejects.toMatchObject({ status: 403 })
  })
})
