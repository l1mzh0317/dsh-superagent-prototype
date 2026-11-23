import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { Runtime } from '../src/app/runtime.ts'
import type { Ticket } from '../src/core/index.ts'
import { HulyClient, type HulyDeployment } from '../src/sources/huly-client.ts'
import { registerTeamPeppy } from '../src/team-peppy/http.ts'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) } })
async function fixture() {
  const deployment: HulyDeployment = { workspace: 'a', workspaceUrl: 'pt', origin: 'https://huly.example', endpoint: '', tokenFile: '', botPerson: '', botSocial: '', botAccount: '', channels: ['c'], operators: ['owner'] }
  const ticket = { id: 'task', title: 'Investigate', decisionId: 'decision', mandate: { actor: { source: 'huly', id: 'author-social' } },
    channels: [{ source: 'huly', thread: 'a:c:root', address: { workspace: 'a', channelId: 'c', rootId: 'root' } }],
    assignments: [{ id: 'assignment', createdAt: '2026-11-23', startedAt: '2026-11-23', state: 'running' }], inputs: [], undelivered: [], createdAt: '2026-11-23', updatedAt: '2026-11-23', origin: { triggerId: 'root', triggerIds: ['root'] } } as unknown as Ticket
  const huly = new HulyClient(deployment)
  const account = vi.spyOn(huly, 'account').mockResolvedValue({ uuid: 'owner', role: 'USER', socialIds: ['author-social'] })
  vi.spyOn(huly, 'find').mockResolvedValue([])
  const channel = vi.spyOn(huly, 'one').mockResolvedValue({ _id: 'c' } as never)
  const prompt = vi.fn().mockResolvedValue({ accepted: true }), cancel = vi.fn().mockReturnValue({ accepted: true })
  const triggers = new Map<string, unknown>()
  const discussionRoots = vi.fn(() => [] as import('../src/core/index.ts').Trigger[])
  const receive = vi.fn(t => { triggers.set(t.id, t); return 'stored' })
  const attach = vi.fn()
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const ctx = { webServer: { register: (r: { handler: typeof handler }) => { handler = r.handler; return () => {} } },
    agents: { get: () => ({ status: 'running' }) }, sessionController: { prompt, cancel, follow: async function* () {
      yield { type: 'snapshot', cursor: 0, records: [], projections: {} }
    } } } as unknown as Context
  const disposition = vi.fn(() => ({ fanout: [] as string[], acked: [] as string[] }))
  const messageTriggers = vi.fn(() => [{ id: 'input', human: true, addressed: 'mention', actor: { source: 'huly', id: 'author-social' }, meta: { workspace: 'a', messageId: 'message' }, channel: ticket.channels[0] }] as unknown as import('../src/core/index.ts').Trigger[])
  const threadMessages = vi.fn(() => [] as import('../src/core/index.ts').Trigger[])
  const runtime = { ready: Promise.resolve(), configured: () => true, sources: { instance: () => ({ config: { channels: ['c'] } }) },
    store: { get: () => undefined, set: vi.fn(), read: { messageTriggers, hulyThreadMessages: threadMessages, hulyDiscussionRoots: discussionRoots, hulyDiscussionMessages: () => [] }, settings: () => ({ policy: { sources: { huly: { allowed: [{ id: 'author-social' }] } } } }), decisions: { get: () => undefined }, atomic: (f: () => unknown) => f(), triggers: { get: (id: string) => triggers.get(id), disposition },
      tickets: { list: () => [ticket], get: (id: string) => id === 'task' ? ticket : undefined } }, engine: { receive, attach }, passes: { request: vi.fn() } } as unknown as Runtime
  registerTeamPeppy(ctx, runtime, huly)
  const server = createServer((req, res) => { void handler(req, res) }); servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const token = 'header.' + Buffer.from('{"workspace":"a"}').toString('base64url') + '.sig'
  const headers = { authorization: `Bearer ${token}`, origin: deployment.origin, 'x-team-peppy-request': '1', 'content-type': 'application/json' }
  const call = (path: string, data?: unknown, overrides = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/team-peppy/api/${path}`, {
    headers: { ...headers, ...overrides }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
  })
  return { call, account, channel, prompt, cancel, ticket, receive, attach, messageTriggers, disposition, threadMessages, discussionRoots, triggers }
}
describe('Huly-authenticated worker bridge', () => {
  it('returns only message-header status and a real session binding after channel authorization', async () => {
    const f = await fixture()
    f.disposition.mockReturnValue({ fanout: ['task'], acked: ['task'] })
    const res = await f.call('message-status?message=message')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace: 'a', items: [expect.objectContaining({ messageId: 'message', taskId: 'task', state: 'running', sessionName: 'Investigate', sessionId: 'worker-task' })] })
    f.channel.mockResolvedValue(undefined)
    expect(await (await f.call('message-status?message=message')).json()).toEqual({ workspace: 'a', items: [] })
  })
  it('refuses unbounded message polling and never exposes a linked private channel', async () => {
    const f = await fixture()
    expect((await f.call('message-status?'+Array(101).fill('message=x').join('&'))).status).toBe(400)
    f.disposition.mockReturnValue({ fanout: ['task'], acked: ['task'] })
    f.ticket.channels.push({ source: 'github', thread: 'private', address: {} } as never)
    expect((await (await f.call('message-status?message=message')).json()).items).toEqual([])
  })
  it('projects original thread context and refuses mixed-source task context', async () => {
    const f = await fixture()
    const base = { source: 'huly', human: true, actor: { source: 'huly', id: 'alice' }, at: '2026-11-23T00:00:00Z', meta: { workspace: 'a', channelId: 'c', rootId: 'root' } }
    f.threadMessages.mockReturnValue([
      { ...base, id: 'root', text: '先讨论需求', meta: { ...base.meta, messageId: 'root' } },
      { ...base, at: '2026-11-23T00:01:00Z', id: 'next', text: '仅供参考', meta: { ...base.meta, messageId: 'next' } },
    ] as never)
    const res = await f.call('tasks/task/context'); expect(res.status).toBe(200)
    const value = await res.json(); expect(value.nodes.map((n: { inclusion: string }) => n.inclusion)).toEqual(['adopted', 'context'])
    expect(value.nodes[1].sourceUrl).toMatch(/message=next$/)
    f.ticket.channels.push({ source: 'github', thread: 'private', address: {} } as never)
    expect((await f.call('tasks/task/context')).status).toBe(404)
  })
  it('offers authenticated optional routing without leaking credentials into the grant', async () => {
    const f = await fixture(); const res = await f.call('route', { task: 'task' })
    expect(res.status).toBe(200); expect(Object.keys(await res.json()).sort()).toEqual(['expires', 'route'])
    expect((await f.call('route', { task: 'missing' })).status).toBe(403)
    expect((await f.call('route', { task: 'new' }, { origin: '', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
  it('submits to the existing worker Session and scopes idempotency by authenticated operator', async () => {
    const f = await fixture(), requestId = '25240cbb-a470-4623-818e-20cfbe564928'
    const res = await f.call('tasks/task/messages', { sessionId: 'worker-task', requestId, text: 'Check the original issue', mode: 'steer' })
    expect(res.status).toBe(200)
    expect(f.receive.mock.calls[0]![0]).toMatchObject({ text: 'Check the original issue', meta: { operator: 'owner', workspace: 'a' } })
    expect(f.attach.mock.calls[0]![0]).toBe('task')
    expect(f.prompt).not.toHaveBeenCalled()
    await f.call('tasks/task/messages', { sessionId: 'worker-task', requestId, text: 'Check the original issue', mode: 'steer' })
    expect(f.receive).toHaveBeenCalledOnce(); expect(f.attach).toHaveBeenCalledOnce()
  })
  it('refuses stale Session bindings and never redirects a command to another Session', async () => {
    const f = await fixture()
    const res = await f.call('tasks/task/messages', { sessionId: 'another-worker', requestId: '25240cbb-a470-4623-818e-20cfbe564928', text: 'Continue' })
    expect(res.status).toBe(409); expect(f.prompt).not.toHaveBeenCalled()
  })
  it('lists a Router discussion with zero workers and keeps selectable sessions consistent with route permissions', async () => {
    const f = await fixture()
    const root = { ...f.messageTriggers()[0]!, source: 'huly', id: 'discussion', text: 'Team Peppy 调查登录', channel: f.ticket.channels[0]! }
    const empty = { ...root, id: 'empty', text: 'Team Peppy 讨论设计', channel: { ...root.channel, thread: 'a:c:other' } }
    f.triggers.set(root.id, root); f.triggers.set(empty.id, empty)
    f.discussionRoots.mockReturnValue([root, empty])
    const { discussions } = await (await f.call('route-options')).json()
    expect(discussions).toEqual([
      expect.objectContaining({ id: 'discussion', sessions: [expect.objectContaining({ id: 'task' })] }),
      expect.objectContaining({ id: 'empty', sessions: [] })
    ])
    expect((await f.call('route', { discussion: 'empty' })).status).toBe(200)
    expect((await f.call('route', { discussion: 'empty', task: 'task' })).status).toBe(409)
    expect((await f.call('route', { discussion: 'discussion', task: 'task' })).status).toBe(200)
    f.account.mockResolvedValue({ uuid: 'owner', role: 'OWNER', socialIds: ['not-on-source-list'] })
    expect(await (await f.call('route-options')).json()).toMatchObject({ canChoose: false, discussions: [] })
    expect((await f.call('route', { discussion: 'discussion', task: 'task' })).status).toBe(403)
  })
  it('keeps read permission separate from write permission', async () => {
    const f = await fixture(); f.account.mockResolvedValue({ uuid: 'reader', role: 'USER', socialIds: ['reader'] })
    const list = await f.call('tasks'); expect((await list.json()).items[0].canWrite).toBe(false)
    const res = await f.call('tasks/task/cancel', { sessionId: 'worker-task' })
    expect(res.status).toBe(403); expect(f.cancel).not.toHaveBeenCalled()
  })
  it('accepts embedded same-origin selection without Origin and rejects cross-site or ambient-only writes', async () => {
    const f = await fixture()
    const cookie = 'presentation-metadata-Token=header.' + Buffer.from('{"workspace":"a"}').toString('base64url') + '.sig'
    const embedded = { authorization: '', origin: '', cookie }
    expect((await f.call('route', { task: 'task' }, { ...embedded, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await f.call('route', { task: 'task' }, { ...embedded, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await f.call('route', { task: 'task' }, embedded)).status).toBe(403)
    expect((await f.call('route', { task: 'task' }, { origin: '' })).status).toBe(200)
    // Electron's session.fetch bypass of the app protocol is seen as a browser-initiated request.
    expect((await f.call('route', { task: 'task' }, { origin: '', 'sec-fetch-site': 'none' })).status).toBe(200)
    expect((await f.call('route', { task: 'task' }, { ...embedded, 'sec-fetch-site': 'none' })).status).toBe(403)
    expect((await f.call('route', { task: 'task' }, { origin: '', 'sec-fetch-site': 'same-site' })).status).toBe(403)
  })
  it('enforces current channel access and CSRF protection for write requests', async () => {
    const f = await fixture()
    let res = await f.call('tasks/task/cancel', { sessionId: 'worker-task' }, { origin: 'https://attacker.example' })
    expect(res.status).toBe(403); expect(f.cancel).not.toHaveBeenCalled()
    f.channel.mockResolvedValue(undefined)
    res = await f.call('tasks'); expect((await res.json()).items).toEqual([])
    res = await f.call('tasks/task/session'); expect(res.status).toBe(404)
  })
})
