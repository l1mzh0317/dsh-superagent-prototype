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
  const channel = vi.spyOn(huly, 'one').mockResolvedValue({ _id: 'c' } as never)
  const prompt = vi.fn().mockResolvedValue({ accepted: true }), cancel = vi.fn().mockReturnValue({ accepted: true })
  const triggers = new Map<string, unknown>()
  const receive = vi.fn(t => { triggers.set(t.id, t); return 'stored' })
  const attach = vi.fn()
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const ctx = { webServer: { register: (r: { handler: typeof handler }) => { handler = r.handler; return () => {} } },
    agents: { get: () => ({ status: 'running' }) }, sessionController: { prompt, cancel, follow: async function* () {
      yield { type: 'snapshot', cursor: 0, records: [], projections: {} }
    } } } as unknown as Context
  const runtime = { ready: Promise.resolve(), configured: () => true, sources: { instance: () => ({ config: { channels: ['c'] } }) },
    store: { atomic: (f: () => unknown) => f(), triggers: { get: (id: string) => triggers.get(id), disposition: () => ({ fanout: [] }) },
      tickets: { list: () => [ticket], get: (id: string) => id === 'task' ? ticket : undefined } }, engine: { receive, attach }, passes: { request: vi.fn() } } as unknown as Runtime
  registerTeamPeppy(ctx, runtime, huly)
  const server = createServer((req, res) => { void handler(req, res) }); servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const token = 'header.' + Buffer.from('{"workspace":"a"}').toString('base64url') + '.sig'
  const headers = { authorization: `Bearer ${token}`, origin: deployment.origin, 'x-team-peppy-request': '1', 'content-type': 'application/json' }
  const call = (path: string, data?: unknown, overrides = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/team-peppy/api/${path}`, {
    headers: { ...headers, ...overrides }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
  })
  return { call, account, channel, prompt, cancel, ticket, receive, attach }
}
describe('Huly-authenticated worker bridge', () => {
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
  it('keeps read permission separate from write permission', async () => {
    const f = await fixture(); f.account.mockResolvedValue({ uuid: 'reader', role: 'USER', socialIds: ['reader'] })
    const list = await f.call('tasks'); expect((await list.json()).items[0].canWrite).toBe(false)
    const res = await f.call('tasks/task/cancel', { sessionId: 'worker-task' })
    expect(res.status).toBe(403); expect(f.cancel).not.toHaveBeenCalled()
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
