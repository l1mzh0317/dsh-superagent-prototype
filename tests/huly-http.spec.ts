import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, createConnection } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { Runtime } from '../src/app/runtime.ts'
import type { Ticket } from '../src/core/index.ts'
import { HulyClient, type HulyDeployment } from '../src/sources/huly-client.ts'
import { registerTeamPeppy } from '../src/team-peppy/http.ts'

vi.mock('node:net', async importOriginal => {
  const net = await importOriginal<typeof import('node:net')>()
  return { ...net, createConnection: vi.fn(net.createConnection) }
})

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) } })
async function fixture() {
  const deployment: HulyDeployment = { workspace: 'a', workspaceUrl: 'pt', origin: 'https://huly.example', endpoint: '', tokenFile: '', botPerson: '', botSocial: '', botAccount: '', channels: ['c'], operators: ['owner'] }
  const ticket = { id: 'task', title: 'Investigate', decisionId: 'decision', mandate: { actor: { source: 'huly', id: 'author-social' } },
    channels: [{ source: 'huly', thread: 'a:c:root', address: { workspace: 'a', channelId: 'c', rootId: 'root' } }],
    assignments: [{ id: 'assignment', createdAt: '2026-11-23', startedAt: '2026-11-23', state: 'running' }], inputs: [], undelivered: [], createdAt: '2026-11-23', updatedAt: '2026-11-23', origin: { triggerId: 'root', triggerIds: ['root'] } } as unknown as Ticket
  const huly = new HulyClient(deployment)
  const account = vi.spyOn(huly, 'account').mockResolvedValue({ uuid: 'owner', role: 'USER', socialIds: ['author-social'] })
  const directory = vi.spyOn(huly, 'find').mockResolvedValue([])
  const workspaceMembers = vi.spyOn(huly, 'workspaceMembers').mockResolvedValue([])
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
  const values = new Map<string, unknown>()
  const runtime = { ready: Promise.resolve(), configured: () => true, sources: { instance: () => ({ config: { channels: ['c'] } }) },
    store: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), read: { messageTriggers, hulyThreadMessages: threadMessages, hulyDiscussionRoots: discussionRoots, hulyDiscussionMessages: () => [] }, settings: () => ({ policy: { sources: { huly: { allowed: [{ id: 'author-social' }] } } } }), decisions: { get: () => undefined }, atomic: (f: () => unknown) => f(), triggers: { get: (id: string) => triggers.get(id), disposition },
      tickets: { list: () => [ticket], get: (id: string) => id === 'task' ? ticket : undefined } }, engine: { receive, attach }, passes: { request: vi.fn() } } as unknown as Runtime
  registerTeamPeppy(ctx, runtime, huly)
  const server = createServer((req, res) => { void handler(req, res) }); servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const token = 'header.' + Buffer.from('{"workspace":"a"}').toString('base64url') + '.sig'
  const headers = { authorization: `Bearer ${token}`, origin: deployment.origin, 'x-team-peppy-request': '1', 'content-type': 'application/json' }
  const call = (path: string, data?: unknown, overrides = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/team-peppy/api/${path}`, {
    headers: { ...headers, ...overrides }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
  })
  return { call, account, directory, workspaceMembers, channel, prompt, cancel, ticket, receive, attach, messageTriggers, disposition, threadMessages, discussionRoots, triggers }
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

describe('workspace Instances', () => {
  it('stages the exact services for live Huly members and hides them before application and during revocation', async () => {
    const f = await fixture()
    const identity = (uuid: string, role: string) => f.account.mockResolvedValue({ uuid, role, socialIds: [uuid + '-social'] })
    const host = { name: 'Build server', address: '100.70.0.9', service: { name: 'Build logs', protocol: 'https', port: 8443 } }
    const alice = { account: 'alice', login: 'alice@example.test' }
    const bob = { account: 'bob', login: 'bob@example.test' }
    expect((await f.call('instances/machines', host)).status).toBe(403)
    expect((await f.call('instances/members')).status).toBe(403)

    identity('owner', 'OWNER')
    const first = await f.call('instances/machines', host)
    expect(first.status).toBe(200)
    const machine = await first.json()
    expect(await (await f.call('instances/machines', host)).json()).toEqual(machine)
    const listed = await (await f.call('instances')).json()
    const serviceId = listed.machines[0].services[0].id
    const query = 'instances/connection?service=' + serviceId
    const draft = { serviceId, group: 'group:developers', members: [alice] }
    expect((await f.call('instances/preview', draft)).status).toBe(400)

    f.directory.mockResolvedValue([
      { personUuid: 'alice', name: 'Alice' }, { personUuid: 'bob', name: 'Bob' },
    ] as never)
    expect(await (await f.call('instances/members')).json()).toEqual({ members: [
      { account: 'alice', name: 'Alice' }, { account: 'bob', name: 'Bob' },
    ] })
    expect(await (await f.call('instances/preview', draft)).json()).toEqual({
      grant: { src: ['group:developers'], dst: [host.address], ip: ['tcp:8443'] },
      tests: [{ src: alice.login, proto: 'tcp', accept: [host.address + ':8443'] }],
    })
    const grant = await (await f.call('instances/grants', draft)).json()
    expect(await (await f.call('instances/grants', draft)).json()).toEqual(grant)
    expect((await f.call('instances/grants', { serviceId, members: [bob] })).status).toBe(200)
    expect((await f.call('instances/grants', { serviceId, members: [alice] })).status).toBe(409)
    const grantId = grant.id

    identity('alice', 'USER')
    expect(await (await f.call('instances')).json()).toEqual({ admin: false, machines: [], grants: [] })
    expect((await f.call(query)).status).toBe(404)
    expect((await f.call('instances/grant-state', { grantId, action: 'confirm' })).status).toBe(403)

    identity('owner', 'OWNER')
    expect((await f.call('instances/grant-state', { grantId, action: 'confirm-revoked' })).status).toBe(409)
    expect(await (await f.call('instances/grant-state', { grantId, action: 'confirm' })).json()).toEqual({ state: 'applied' })
    identity('bob', 'USER')
    expect((await f.call(query)).status).toBe(404)
    identity('alice', 'USER')
    expect(await (await f.call(query)).json()).toEqual({
      workspaceUrl: 'pt', address: host.address, port: 8443, protocol: 'https', logins: [alice.login],
    })
    expect((await (await f.call('instances')).json()).grants).toEqual([])
    expect((await f.call('instances/probe', { serviceId })).status).toBe(403)

    identity('owner', 'OWNER')
    expect(await (await f.call('instances/grant-state', { grantId, action: 'revoke' })).json()).toEqual({ state: 'revoking' })
    const removal = await (await f.call('instances/grant-policy', { grantId })).json()
    expect(removal.tests).toEqual([{ src: alice.login, proto: 'tcp', deny: [host.address + ':8443'] }])
    identity('alice', 'USER')
    expect((await f.call(query)).status).toBe(404)
    identity('owner', 'OWNER')
    expect(await (await f.call('instances/grant-state', { grantId, action: 'confirm-revoked' })).json()).toEqual({ state: 'revoked' })
  })

  it('stages account-based access to exact ports atomically and enables the whole batch after application', async () => {
    const f = await fixture()
    const identity = (uuid: string, role: string) => f.account.mockResolvedValue({ uuid, role, socialIds: [uuid + '-social'] })
    identity('owner', 'OWNER')
    const alice = { account: 'alice', login: 'alice@example.test' }, bob = { account: 'bob', login: 'bob@example.test' }
    const people = [{ personUuid: 'alice', name: 'Alice' }, { personUuid: 'bob', name: 'Bob' }]
    f.directory.mockResolvedValue(people as never)
    const hosts = [
      { name: 'A', address: '100.70.0.9', service: { protocol: 'ssh', port: 22 } },
      { name: 'B', address: '100.70.0.10', service: { protocol: 'ssh', port: 15030 } },
      { name: 'C', address: '100.70.0.11', service: { protocol: 'ssh', port: 2222 } },
    ]
    for (const host of hosts) expect((await f.call('instances/machines', host)).status).toBe(200)
    const catalog = async () => (await (await f.call('instances')).json())
    const [one, two, three] = (await catalog()).machines.map((m: { services: Array<{ id: string }> }) => m.services[0]!.id)
    const selection = { serviceIds: [one, two], members: [alice, bob] }
    const receipt = await f.call('instances/preview-batch', selection)
    expect(receipt.status).toBe(200)
    const rules = await receipt.json()
    expect(rules).toEqual({
      grants: [{ src: [alice.login, bob.login], dst: [hosts[0]!.address], ip: ['tcp:22'] },
        { src: [alice.login, bob.login], dst: [hosts[1]!.address], ip: ['tcp:15030'] }],
      tests: [alice, bob].map(member => ({ src: member.login, proto: 'tcp', accept: ['100.70.0.9:22', '100.70.0.10:15030'] })),
    })
    expect((await catalog()).grants).toEqual([])
    const staged = await f.call('instances/grant-batch', selection)
    expect(staged.status).toBe(200)
    const { id: batchId } = await staged.json()
    expect(await (await f.call('instances/grant-batch', { ...selection, serviceIds: [two, one] })).json()).toEqual({ id: batchId })
    expect(await (await f.call('instances/batch-policy', { batchId })).json()).toEqual(rules)
    expect((await f.call('instances/grant-batch', { ...selection, serviceIds: [one, three] })).status).toBe(409)
    expect((await catalog()).grants).toHaveLength(2)

    identity('alice', 'USER')
    expect((await catalog()).machines).toEqual([])
    expect((await f.call('instances/batch-state', { batchId, action: 'confirm' })).status).toBe(403)
    identity('owner', 'OWNER')
    f.directory.mockResolvedValue(people.slice(0, 1) as never)
    expect((await f.call('instances/batch-state', { batchId, action: 'confirm' })).status).toBe(400)
    expect((await catalog()).grants.every((g: { state: string }) => g.state === 'pending')).toBe(true)
    f.directory.mockResolvedValue(people as never)
    expect(await (await f.call('instances/batch-state', { batchId, action: 'confirm' })).json()).toEqual({ state: 'applied' })
    expect(await (await f.call('instances/batch-state', { batchId, action: 'confirm' })).json()).toEqual({ state: 'applied' })
    expect((await f.call('instances/batch-state', { batchId, action: 'discard' })).status).toBe(409)

    for (const member of [alice, bob]) {
      identity(member.account, 'USER')
      expect((await catalog()).machines.map((m: { name: string }) => m.name)).toEqual(['A', 'B'])
      expect(await (await f.call('instances/connection?service=' + two)).json()).toMatchObject({ logins: [member.login], port: 15030 })
      expect((await f.call('instances/connection?service=' + three)).status).toBe(404)
    }
    identity('outside', 'USER')
    expect((await catalog()).machines).toEqual([])

    identity('owner', 'OWNER')
    const grantId = (await catalog()).grants.find((g: { serviceId: string }) => g.serviceId === one).id
    expect(await (await f.call('instances/grant-state', { grantId, action: 'revoke' })).json()).toEqual({ state: 'revoking' })
    identity('alice', 'USER')
    expect((await catalog()).machines.map((m: { name: string }) => m.name)).toEqual(['B'])
  })

  it('accepts services with no note and preserves service names from older Pepper releases as notes', async () => {
    const { call, account } = await fixture()
    account.mockResolvedValue({ uuid: 'owner', role: 'OWNER', socialIds: ['owner'] })
    const service = { protocol: 'https', port: 443 }
    const machine = { name: 'Build server', address: '100.70.0.9', service }
    const created = await call('instances/machines', machine)
    expect(created.status).toBe(200)
    const { id: machineId } = await created.json()
    expect((await (await call('instances/machines', { ...machine, service: { ...service, note: '' } })).json()).id).toBe(machineId)
    const legacy = { name: 'Build logs', protocol: 'http', port: 8443 }
    expect((await call('instances/services', { machineId, service: legacy })).status).toBe(200)
    expect((await call('instances/services', { machineId, service: { protocol: 'http', port: 8443, note: 'Build logs' } })).status).toBe(200)
    const { machines } = await (await call('instances')).json()
    expect(machines[0].services).toEqual([
      expect.objectContaining({ protocol: 'https', port: 443, name: 'HTTPS :443', note: '' }),
      expect.objectContaining({ protocol: 'http', port: 8443, name: 'Build logs', note: 'Build logs' }),
    ])
  })

  it('delegates Instances to current members without granting control of the delegation list', async () => {
    const f = await fixture()
    const delegate = 'b285cc14-058b-4b6b-9546-cde778c55cf8'
    const absent = '52693805-676a-438f-b689-dce92ae4aa96'
    const identity = (uuid: string, role: string) => f.account.mockResolvedValue({ uuid, role, socialIds: [uuid + '-social'] })
    const machine = { name: 'Build server', address: '100.70.0.9', service: { name: 'Build logs', protocol: 'https', port: 8443 } }
    const change = { account: delegate, enabled: true }

    f.workspaceMembers.mockResolvedValue([{ person: delegate, role: 'USER' }])
    // An active Employee row alone is insufficient if someone has left the workspace.
    f.directory.mockResolvedValue([
      { personUuid: delegate, name: 'Member' }, { personUuid: absent, name: 'Former member' },
    ] as never)
    identity(delegate, 'USER')
    expect((await f.call('instances/managers')).status).toBe(403)
    expect((await f.call('instances/managers', change)).status).toBe(403)
    expect((await f.call('instances/machines', machine)).status).toBe(403)
    identity(delegate, 'MAINTAINER')
    expect((await f.call('instances/managers', change)).status).toBe(403)

    identity('owner', 'OWNER')
    expect(await (await f.call('instances/managers')).json()).toMatchObject({ managers: [] })
    expect((await f.call('instances/managers', { account: absent, enabled: true })).status).toBe(400)
    expect((await f.call('instances/managers', change, { origin: 'https://foreign.test' })).status).toBe(403)
    expect(await (await f.call('instances/managers', change)).json()).toMatchObject({ managers: [delegate] })
    expect(await (await f.call('instances/managers', change)).json()).toMatchObject({ managers: [delegate] })

    identity(delegate, 'USER')
    expect((await (await f.call('instances')).json()).admin).toBe(true)
    expect((await f.call('instances/machines', machine)).status).toBe(200)
    expect((await f.call('instances/managers')).status).toBe(403)
    expect((await f.call('instances/managers', { account: absent, enabled: true })).status).toBe(403)

    f.workspaceMembers.mockResolvedValue([])
    expect((await (await f.call('instances')).json()).admin).toBe(false)
    expect((await f.call('instances/machines', machine)).status).toBe(403)
    f.workspaceMembers.mockResolvedValue([{ person: delegate, role: 'USER' }])
    identity('owner', 'OWNER')
    expect(await (await f.call('instances/managers', { ...change, enabled: false })).json()).toMatchObject({ managers: [] })
    identity(delegate, 'USER')
    expect(await (await f.call('instances')).json()).toEqual({ admin: false, machines: [], grants: [] })
    expect((await f.call('instances/machines', machine)).status).toBe(403)
  })

  it('rejects a delegated write if the owner revokes permission during member validation', async () => {
    const f = await fixture()
    const delegate = 'f7079ad5-9e15-4a5b-acf7-80d7fc316083'
    const recipient = 'ffb31a7f-bd99-4079-bde0-33bffd369c79'
    const auth = (uuid: string, role: string) => f.account.mockResolvedValue({ uuid, role, socialIds: [uuid + '-social'] })
    auth('owner', 'OWNER')
    f.workspaceMembers.mockResolvedValue([{ person: delegate, role: 'USER' }])
    let validationEntered: () => void
    let completeValidation: () => void
    const validating = new Promise<void>(resolve => { validationEntered = resolve })
    const completion = new Promise<void>(resolve => { completeValidation = resolve })
    f.directory.mockImplementation(async (_class, condition) => {
      const selected = (condition.personUuid as { $in: string[] }).$in
      if (selected.includes(recipient)) {
        validationEntered()
        await completion
      }
      return selected.map(personUuid => ({ personUuid, name: 'Member' })) as never
    })
    expect((await f.call('instances/managers', { account: delegate, enabled: true })).status).toBe(200)
    await f.call('instances/machines', { name: 'Build server', address: '100.72.0.9', service: { name: 'Logs', protocol: 'https', port: 443 } })
    const serviceId = (await (await f.call('instances')).json()).machines[0].services[0].id
    auth(delegate, 'USER')
    const pending = f.call('instances/grants', { serviceId, members: [{ account: recipient, login: 'test@example.test' }] })
    try {
      await validating
      auth('owner', 'OWNER')
      expect((await f.call('instances/managers', { account: delegate, enabled: false })).status).toBe(200)
    } finally { completeValidation!() }
    expect((await pending).status).toBe(403)
    expect((await (await f.call('instances')).json()).grants).toEqual([])
  })

  it('checks only the registered endpoint through the Team Peppy process network', async () => {
    const f = await fixture()
    f.account.mockResolvedValue({ uuid: 'owner', role: 'OWNER', socialIds: ['owner-social'] })
    const host = { name: 'Logs', address: '100.71.0.9', service: { name: 'HTTPS', protocol: 'https', port: 8443 } }
    await f.call('instances/machines', host)
    const serviceId = (await (await f.call('instances')).json()).machines[0].services[0].id
    const listener = createServer()
    servers.push(listener)
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const localPort = (listener.address() as AddressInfo).port
    const dial = vi.mocked(createConnection)
    dial.mockClear()
    // Redirect the real TCP attempt into the test runner's network without requiring a Tailnet.
    dial.mockImplementationOnce(() => connect({ host: '127.0.0.1', port: localPort }))
    expect((await f.call('instances/probe', { serviceId, address: '127.0.0.1' })).status).toBe(400)
    expect(dial).not.toHaveBeenCalled()
    const checked = await f.call('instances/probe', { serviceId })
    expect(checked.status).toBe(200)
    expect(await checked.json()).toMatchObject({ reachable: true, checkedAt: expect.any(String) })
    expect(dial).toHaveBeenCalledExactlyOnceWith({ host: host.address, port: 8443, timeout: 3000 })
  })

  it('rejects arbitrary addresses, workspace switches, guest access and cross-origin changes', async () => {
    const f = await fixture()
    f.account.mockResolvedValue({ uuid: 'owner', role: 'ADMIN', socialIds: ['owner'] })
    const host = { name: 'Storage', service: { name: 'SSH', protocol: 'ssh', port: 22 } }
    for (const address of ['localhost', '127.0.0.1', '169.254.169.254', '100.128.0.1', 'https://example.test', '::ffff:100.64.1.1', 'fd00::1']) {
      expect((await f.call('instances/machines', { ...host, address })).status).toBe(400)
    }
    const request = { ...host, address: 'fd7a:115c:a1e0::9' }
    expect((await f.call('instances/machines', request, { origin: 'https://foreign.test' })).status).toBe(403)
    const token = 'header.' + Buffer.from('{"workspace":"foreign"}').toString('base64url') + '.sig'
    expect((await f.call('instances/machines', request, { authorization: 'Bearer ' + token })).status).toBe(403)
    expect((await f.call('instances/machines', request)).status).toBe(200)
    f.account.mockResolvedValue({ uuid: 'guest', role: 'GUEST', socialIds: ['guest'] })
    expect((await f.call('instances')).status).toBe(403)
  })
})
