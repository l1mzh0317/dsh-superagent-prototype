import { randomUUID } from 'node:crypto'
import { get } from 'node:http'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import { family } from '../kv.ts'
import { HulyError, type HulyAccount, type HulyClient } from '../sources/huly-client.ts'

const id = z.string().uuid()
const label = z.string().trim().min(1).max(80)
const login = z.string().trim().toLowerCase().max(254).regex(/^[\w.+-]+@(?:[\w-]+(?:\.[\w-]+)+|github|passkey)$/)
const isTailnetIP = (value: string): boolean => {
  if (isIP(value) === 4) {
    const [first, second] = value.split('.').map(Number)
    return first === 100 && second! >= 64 && second! < 128
  }
  return isIP(value) === 6 && /^fd7a:115c:a1e0:/i.test(value)
}
const address = z.string().trim().toLowerCase().refine(isTailnetIP, '请输入 Tailscale IP 地址')
  // Canonicalize IPv6 so equivalent spellings also deduplicate.
  .transform(ip => isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip)
const serviceInput = z.object({
  name: label.optional(),
  note: z.string().trim().max(160).optional(),
  protocol: z.enum(['https', 'http', 'ssh']),
  port: z.number().int().min(1).max(65535),
}).strict()
const serviceNote = (service: z.infer<typeof serviceInput>): string => service.note ?? service.name ?? ''
const sameService = (first: z.infer<typeof serviceInput>, second: z.infer<typeof serviceInput>): boolean =>
  first.port === second.port && first.protocol === second.protocol && serviceNote(first) === serviceNote(second)
const machineInput = z.object({ name: label, address, service: serviceInput }).strict()
const grantInput = z.object({
  serviceId: id,
  members: z.array(z.object({ account: z.string().min(1).max(80), login }).strict()).min(1).max(50),
  group: z.string().trim().max(80).regex(/^group:[a-zA-Z0-9_-]+$/).optional(),
}).strict()
type Service = z.infer<typeof serviceInput> & { id: string }
interface Machine { id: string; name: string; address: string; services: Service[] }
type GrantState = 'pending' | 'applied' | 'revoking' | 'revoked'
type Grant = z.infer<typeof grantInput> & {
  id: string; state: GrantState; updatedAt: string; updatedBy: string
}
interface Registry { machines: Machine[]; grants: Grant[]; managers?: string[] }
const registryKey = family<Registry>('huly-instances:')
const workspaceAdmins = new Set(['OWNER', 'ADMIN'])
const delegatedRoles = new Set(['MAINTAINER', 'USER'])
const members = new Set(['OWNER', 'ADMIN', 'MAINTAINER', 'USER'])
const employeeClass = 'contact:mixin:Employee'

function policy(grant: z.infer<typeof grantInput>, ip: string, port: number, revoking = false) {
  const src = grant.group ? [grant.group] : grant.members.map(member => member.login)
  const destination = `${ip.includes(':') ? `[${ip}]` : ip}:${port}`
  // Each identity is tested independently, including members of a named Tailscale group.
  return {
    grant: { src, dst: [ip], ip: [`tcp:${port}`] },
    tests: grant.members.map(member => ({ src: member.login, proto: 'tcp', [revoking ? 'deny' : 'accept']: [destination] })),
  }
}

async function hostProbe(address: string, port: number): Promise<boolean> {
  const socketPath = process.env.TEAM_PEPPY_INSTANCES_PROBE_SOCKET
  if (!socketPath) throw new HulyError(503, '团队服务器尚未启用连通性检查')
  const path = '/probe?' + new URLSearchParams({ address, port: String(port) })
  return await new Promise((resolve, reject) => {
    const unavailable = () => reject(new HulyError(503, '暂时无法运行团队服务器检查，请重试'))
    const request = get({ socketPath, path, signal: AbortSignal.timeout(5000) }, res => {
      if (res.statusCode !== 200) { res.resume(); unavailable(); return }
      res.setEncoding('utf8')
      let value = ''
      res.on('data', chunk => { value += chunk; if (value.length > 256) { res.destroy(); unavailable() } })
      res.on('error', unavailable)
      res.on('end', () => {
        try {
          const result = JSON.parse(value) as { reachable: unknown }
          if (typeof result.reachable !== 'boolean') { unavailable(); return }
          resolve(result.reachable)
        } catch { unavailable() }
      })
    })
    request.on('error', unavailable)
  })
}

export class Instances {
  private readonly key
  private readonly probes = new Map<string, Promise<boolean>>()

  constructor(private readonly store: Store, private readonly huly: HulyClient, private readonly probe = hostProbe) {
    this.key = registryKey(huly.deployment.workspace)
  }

  private read(): Registry { return this.store.get(this.key) ?? { machines: [], grants: [] } }

  private update<T>(apply: (registry: Registry) => T): T {
    return this.store.atomic(() => {
      const registry = this.read()
      const value = apply(registry)
      this.store.set(this.key, registry)
      return value
    })
  }

  private service(registry: Registry, serviceId: string) {
    for (const machine of registry.machines) {
      const service = machine.services.find(s => s.id === serviceId)
      if (service) return { machine, service }
    }
    throw new HulyError(404, '服务不存在或未获授权')
  }

  private addService(machine: Machine, input: z.infer<typeof serviceInput>): void {
    const existing = machine.services.find(s => s.port === input.port)
    if (existing) {
      if (sameService(existing, input)) return
      throw new HulyError(409, '这个端口上已登记服务')
    }
    if (machine.services.length >= 30) throw new HulyError(409, '这台机器的服务数量已达上限')
    machine.services.push({ ...input, id: randomUUID() })
  }

  private logins(registry: Registry, account: HulyAccount, serviceId: string): string[] {
    return [...new Set(registry.grants
      .filter(grant => grant.serviceId === serviceId && grant.state === 'applied')
      .flatMap(grant => grant.members.filter(member => member.account === account.uuid).map(member => member.login)))]
  }

  private async directory(token: string, accounts?: string[]) {
    const rows = await this.huly.find(employeeClass, { active: true, ...(accounts ? { personUuid: { $in: accounts } } : {}) },
      { limit: accounts?.length ?? 1000, sort: { name: 1 } }, token)
    return rows.flatMap(row => typeof row.personUuid === 'string' && typeof row.name === 'string' && row.role !== 'GUEST' &&
      row.personUuid !== this.huly.deployment.botAccount ? [{ account: row.personUuid, name: row.name }] : [])
  }

  private async eligibleManager(account: string, token: string): Promise<boolean> {
    if (account === this.huly.deployment.botAccount) return false
    const [members, employees] = await Promise.all([this.huly.workspaceMembers(token), this.directory(token, [account])])
    return members.some(member => member.person === account && delegatedRoles.has(member.role)) &&
      employees.some(employee => employee.account === account)
  }

  private async manageDelegation(method: string | undefined, readBody: () => Promise<unknown>, token: string) {
    const botAccount = this.huly.deployment.botAccount
    if (method === 'GET') return { managers: this.read().managers ?? [], botAccount }
    if (method !== 'POST') throw new HulyError(404, 'Unknown Instances operation')
    const { account, enabled } = z.object({ account: id, enabled: z.boolean() }).strict().parse(await readBody())
    if (enabled && !await this.eligibleManager(account, token)) throw new HulyError(400, '请选择当前工作区的成员或维护者')
    return this.update(current => {
      const managers = new Set(current.managers)
      if (enabled) managers.add(account)
      else managers.delete(account)
      current.managers = [...managers]
      return { managers: current.managers, botAccount }
    })
  }

  async handle(operation: string, method: string | undefined, query: URLSearchParams, readBody: () => Promise<unknown>, token: string, account: HulyAccount): Promise<unknown> {
    if (!members.has(account.role)) throw new HulyError(403, 'Instances 仅对工作区成员开放')
    const workspaceAdmin = workspaceAdmins.has(account.role)
    if (operation === 'managers') {
      if (!workspaceAdmin) throw new HulyError(403, '只有工作区所有者或管理员可以分配 Instances 管理权限')
      return this.manageDelegation(method, readBody, token)
    }
    const delegated = !workspaceAdmin && this.read().managers?.includes(account.uuid) === true &&
      await this.eligibleManager(account.uuid, token)
    const registry = this.read()
    const admin = workspaceAdmin || (delegated && registry.managers?.includes(account.uuid) === true)

    if (method === 'GET' && operation === '') {
      const machines = registry.machines.flatMap(machine => {
        const services = machine.services.flatMap(service => {
          const logins = this.logins(registry, account, service.id)
          const note = serviceNote(service)
          const name = note || `${service.protocol.toUpperCase()} :${service.port}`
          return admin || logins.length ? [{ ...service, name, note, logins }] : []
        })
        return admin || services.length ? [{ ...machine, services }] : []
      })
      return { admin, machines, grants: admin ? registry.grants : [] }
    }
    if (method === 'GET' && operation === 'connection') {
      const serviceId = id.parse(query.get('service'))
      const logins = this.logins(registry, account, serviceId)
      if (!admin && !logins.length) throw new HulyError(404, '服务不存在或未获授权')
      const { machine, service } = this.service(registry, serviceId)
      return { workspaceUrl: this.huly.deployment.workspaceUrl, address: machine.address, port: service.port, protocol: service.protocol, logins }
    }
    if (!admin) throw new HulyError(403, '需要 Instances 管理权限')
    if (method === 'GET' && operation === 'members') return { members: await this.directory(token) }
    if (method !== 'POST') throw new HulyError(404, 'Unknown Instances operation')

    const updateManaged = <T>(apply: (current: Registry) => T): T => this.update(current => {
      // A grant could be withdrawn while an already authorized request reads its body or validates members.
      if (!workspaceAdmin && !current.managers?.includes(account.uuid)) throw new HulyError(403, 'Instances 管理权限已撤销')
      return apply(current)
    })
    const data = await readBody()
    switch (operation) {
      case 'machines': {
        const value = machineInput.parse(data)
        return updateManaged(current => {
          const existing = current.machines.find(m => m.address === value.address)
          if (existing) {
            if (existing.name === value.name && existing.services.some(service => sameService(service, value.service))) return { id: existing.id }
            throw new HulyError(409, '这个 Tailscale IP 已登记')
          }
          if (current.machines.length >= 100) throw new HulyError(409, '工作区机器数量已达上限')
          const machine: Machine = { id: randomUUID(), name: value.name, address: value.address, services: [] }
          this.addService(machine, value.service)
          current.machines.push(machine)
          return { id: machine.id }
        })
      }
      case 'services': {
        const value = z.object({ machineId: id, service: serviceInput }).strict().parse(data)
        return updateManaged(current => {
          const machine = current.machines.find(m => m.id === value.machineId)
          if (!machine) throw new HulyError(404, '机器不存在')
          this.addService(machine, value.service)
          return { saved: true }
        })
      }
      case 'probe': {
        const value = z.object({ serviceId: id }).strict().parse(data)
        const { machine, service } = this.service(registry, value.serviceId)
        let check = this.probes.get(service.id)
        if (!check) {
          if (this.probes.size >= 8) throw new HulyError(429, '连接检查繁忙，请重试')
          check = this.probe(machine.address, service.port).finally(() => this.probes.delete(service.id))
          this.probes.set(service.id, check)
        }
        return { reachable: await check, checkedAt: new Date().toISOString() }
      }
      case 'preview':
      case 'grants': {
        const value = grantInput.parse(data)
        const accounts = [...new Set(value.members.map(member => member.account))]
        const logins = new Set(value.members.map(member => member.login))
        if (accounts.length !== value.members.length || logins.size !== value.members.length) throw new HulyError(400, '每位成员需要不同的 Tailscale 登录名')
        const { machine, service } = this.service(registry, value.serviceId)
        const people = await this.directory(token, accounts)
        if (!accounts.every(accountId => people.some(person => person.account === accountId))) throw new HulyError(400, '请选择当前工作区的有效成员')
        const preview = policy(value, machine.address, service.port)
        if (operation === 'preview') return preview
        return updateManaged(current => {
          const existing = current.grants.filter(grant => grant.serviceId === value.serviceId && grant.state !== 'revoked')
          for (const grant of existing) {
            const overlap = grant.members.some(entry => value.members.some(member => entry.account === member.account || entry.login === member.login))
            const sameGroup = grant.group !== undefined && grant.group === value.group
            if (!overlap && !sameGroup) continue
            if (grant.state === 'pending' && grant.group === value.group && grant.members.length === value.members.length &&
              grant.members.every(entry => value.members.some(member => member.account === entry.account && member.login === entry.login))) {
              return { id: grant.id }
            }
            throw new HulyError(409, '选中的成员或组已有此服务的授权记录')
          }
          const grant: Grant = { ...value, id: randomUUID(), state: 'pending', updatedAt: new Date().toISOString(), updatedBy: account.uuid }
          current.grants.push(grant)
          return { id: grant.id }
        })
      }
      case 'grant-policy': {
        const value = z.object({ grantId: id }).strict().parse(data)
        const grant = registry.grants.find(g => g.id === value.grantId)
        if (!grant) throw new HulyError(404, '授权不存在')
        const { machine, service } = this.service(registry, grant.serviceId)
        return policy(grant, machine.address, service.port, grant.state === 'revoking' || grant.state === 'revoked')
      }
      case 'grant-state': {
        const value = z.object({ grantId: id, action: z.enum(['confirm', 'revoke', 'confirm-revoked', 'discard']) }).strict().parse(data)
        return updateManaged(current => {
          const grant = current.grants.find(g => g.id === value.grantId)
          if (!grant) throw new HulyError(404, '授权不存在')
          const transitions = { confirm: ['pending', 'applied'], revoke: ['applied', 'revoking'], 'confirm-revoked': ['revoking', 'revoked'], discard: ['pending', 'revoked'] } as const
          const [previous, next] = transitions[value.action]
          if (grant.state !== next) {
            if (grant.state !== previous) throw new HulyError(409, '授权状态已变化，请刷新')
            grant.state = next
            grant.updatedAt = new Date().toISOString()
            grant.updatedBy = account.uuid
          }
          return { state: grant.state }
        })
      }
      default: throw new HulyError(404, 'Unknown Instances operation')
    }
  }
}
