import { randomUUID } from 'node:crypto'
import { createConnection, isIP } from 'node:net'
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
const grantMembers = z.array(z.object({ account: z.string().min(1).max(80), login }).strict()).min(1).max(50)
const grantInput = z.object({
  serviceId: id,
  members: grantMembers,
  group: z.string().trim().max(80).regex(/^group:[a-zA-Z0-9_-]+$/).optional(),
}).strict()
const batchInput = z.object({
  serviceIds: z.array(id).min(2).max(30).refine(ids => new Set(ids).size === ids.length),
  members: grantMembers,
}).strict()
type GrantInput = z.infer<typeof grantInput>
type Service = z.infer<typeof serviceInput> & { id: string }
interface Machine { id: string; name: string; address: string; services: Service[] }
type GrantState = 'pending' | 'applied' | 'revoking' | 'revoked'
type Grant = GrantInput & {
  id: string; batchId?: string; state: GrantState; updatedAt: string; updatedBy: string
}
interface Registry { machines: Machine[]; grants: Grant[]; managers?: string[] }
const registryKey = family<Registry>('huly-instances:')
const workspaceAdmins = new Set(['OWNER', 'ADMIN'])
const delegatedRoles = new Set(['MAINTAINER', 'USER'])
const members = new Set(['OWNER', 'ADMIN', 'MAINTAINER', 'USER'])
const employeeClass = 'contact:mixin:Employee'

function policy(grant: GrantInput, ip: string, port: number, revoking = false) {
  const src = grant.group ? [grant.group] : grant.members.map(member => member.login)
  const destination = `${ip.includes(':') ? `[${ip}]` : ip}:${port}`
  // Each identity is tested independently, including members of a named Tailscale group.
  return {
    grant: { src, dst: [ip], ip: [`tcp:${port}`] },
    tests: grant.members.map(member => ({ src: member.login, proto: 'tcp', [revoking ? 'deny' : 'accept']: [destination] })),
  }
}

/** Use the same network namespace and routes as the Team Peppy runtime. */
async function runtimeProbe(address: string, port: number): Promise<boolean> {
  if (!isTailnetIP(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HulyError(400, '服务的 Tailscale 地址或端口无效')
  }
  return await new Promise(resolve => {
    const socket = createConnection({ host: address, port, timeout: 3000 })
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

/** Workspace service catalog, access grants, and Team Peppy connectivity checks. */
export class Instances {
  private readonly key
  private readonly probes = new Map<string, Promise<boolean>>()

  constructor(private readonly store: Store, private readonly huly: HulyClient, private readonly probe = runtimeProbe) {
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

  private async currentRecipients(token: string, accounts?: string[]) {
    const [employees, workspace] = await Promise.all([this.directory(token, accounts), this.huly.workspaceMembers(token)])
    const current = new Set(workspace.filter(member => members.has(member.role)).map(member => member.person))
    return employees.filter(employee => current.has(employee.account))
  }

  private async validateRecipients(recipients: GrantInput['members'], token: string): Promise<void> {
    const accounts = [...new Set(recipients.map(member => member.account))]
    const logins = new Set(recipients.map(member => member.login))
    if (accounts.length !== recipients.length || logins.size !== recipients.length) {
      throw new HulyError(400, '每位成员需要不同的 Tailscale 登录名')
    }
    const people = await this.currentRecipients(token, accounts)
    if (!accounts.every(account => people.some(person => person.account === account))) {
      throw new HulyError(400, '请选择当前工作区的有效成员')
    }
  }

  private pendingGrant(registry: Registry, input: GrantInput): Grant | undefined {
    for (const grant of registry.grants) {
      if (grant.serviceId !== input.serviceId || grant.state === 'revoked') continue
      const overlap = grant.members.some(entry => input.members.some(member => entry.account === member.account || entry.login === member.login))
      const sameGroup = grant.group !== undefined && grant.group === input.group
      if (!overlap && !sameGroup) continue
      if (grant.state === 'pending' && grant.group === input.group && grant.members.length === input.members.length &&
        grant.members.every(entry => input.members.some(member => member.account === entry.account && member.login === entry.login))) return grant
      const { machine, service } = this.service(registry, input.serviceId)
      throw new HulyError(409, `${machine.name} 的端口 ${service.port} 已有这些账号或组的授权记录`)
    }
  }

  private batchPolicy(registry: Registry, inputs: GrantInput[]) {
    const policies = inputs.map(input => {
      const { machine, service } = this.service(registry, input.serviceId)
      return policy(input, machine.address, service.port)
    })
    const destinations = new Map<string, string[]>()
    for (const { tests } of policies) {
      for (const test of tests) {
        const ports = destinations.get(test.src) ?? []
        ports.push(...(test.accept ?? []))
        destinations.set(test.src, ports)
      }
    }
    return {
      grants: policies.map(entry => entry.grant),
      tests: [...destinations].map(([src, accept]) => ({ src, proto: 'tcp', accept })),
    }
  }

  private batchGrants(registry: Registry, batchId: string): Grant[] {
    const grants = registry.grants.filter(grant => grant.batchId === batchId)
    if (!grants.length) throw new HulyError(404, '这批授权已不可用')
    return grants
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
    if (method === 'GET' && operation === 'members') return { members: await this.currentRecipients(token) }
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
        const { machine, service } = this.service(registry, value.serviceId)
        await this.validateRecipients(value.members, token)
        if (operation === 'preview') return policy(value, machine.address, service.port)
        return updateManaged(current => {
          const pending = this.pendingGrant(current, value)
          if (pending) return { id: pending.id }
          const grant: Grant = { ...value, id: randomUUID(), state: 'pending', updatedAt: new Date().toISOString(), updatedBy: account.uuid }
          current.grants.push(grant)
          return { id: grant.id }
        })
      }
      case 'preview-batch':
      case 'grant-batch': {
        const { serviceIds, members } = batchInput.parse(data)
        await this.validateRecipients(members, token)
        const inputs = serviceIds.map(serviceId => ({ serviceId, members }))
        if (operation === 'preview-batch') {
          const preview = this.batchPolicy(registry, inputs)
          for (const input of inputs) this.pendingGrant(registry, input)
          return preview
        }
        return updateManaged(current => {
          for (const input of inputs) this.service(current, input.serviceId)
          const pending = inputs.flatMap(input => {
            const grant = this.pendingGrant(current, input)
            return grant ? [grant] : []
          })
          if (pending.length) {
            const batchId = pending[0]!.batchId
            if (batchId && pending.length === inputs.length && pending.every(grant => grant.batchId === batchId) &&
              this.batchGrants(current, batchId).length === inputs.length) return { id: batchId }
            throw new HulyError(409, '部分服务已有待应用授权，请先在服务授权中处理')
          }
          const id = randomUUID(), updatedAt = new Date().toISOString()
          current.grants.push(...inputs.map(input => ({
            ...input, id: randomUUID(), batchId: id, state: 'pending' as const, updatedAt, updatedBy: account.uuid,
          })))
          return { id }
        })
      }
      case 'batch-policy': {
        const { batchId } = z.object({ batchId: id }).strict().parse(data)
        const pending = this.batchGrants(registry, batchId).filter(grant => grant.state === 'pending')
        if (!pending.length) throw new HulyError(409, '这批授权没有等待应用的服务')
        return this.batchPolicy(registry, pending)
      }
      case 'batch-state': {
        const { batchId, action } = z.object({ batchId: id, action: z.enum(['confirm', 'discard']) }).strict().parse(data)
        const pending = this.batchGrants(registry, batchId).find(grant => grant.state === 'pending')
        if (action === 'confirm' && pending) await this.validateRecipients(pending.members, token)
        return updateManaged(current => {
          const grants = this.batchGrants(current, batchId)
          const next = action === 'confirm' ? 'applied' : 'revoked'
          if (grants.some(grant => grant.state !== 'pending' && grant.state !== next)) {
            throw new HulyError(409, '这批授权的状态已变化，请刷新后分别处理')
          }
          const now = new Date().toISOString()
          for (const grant of grants) {
            if (grant.state === next) continue
            grant.state = next
            grant.updatedAt = now
            grant.updatedBy = account.uuid
          }
          return { state: next }
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
