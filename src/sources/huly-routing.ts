/** Optional, authenticated mention routing. Grants live briefly in memory; credentials never enter message markup. */
import { randomUUID } from 'node:crypto'
import type { Runtime } from '../app/runtime.ts'
import { type Ticket, type Trigger, type ReceiveResult, UserError } from '../core/index.ts'
import { allowedSender } from '../policy.ts'
import { HULY, HulyClient, HulyError, type HulyAccount } from './huly-client.ts'

export async function mayReadHulyTask(runtime: Runtime, client: HulyClient, ticket: Ticket, token: string): Promise<boolean> {
  const enabled = runtime.sources.instance<{ channels: string[] }>('huly')?.config.channels ?? []
  if (!ticket.channels.length || !ticket.channels.every(c => c.source === 'huly' && c.address.workspace === client.deployment.workspace && enabled.includes(c.address.channelId!))) return false
  for (const channel of new Set(ticket.channels.map(c => c.address.channelId!))) if (!await client.one(HULY.channel, channel, token)) return false
  return true
}
export function mayWriteHulyTask(client: HulyClient, ticket: Ticket, a: HulyAccount): boolean {
  return ticket.ended?.by !== 'human' && (client.deployment.operators.includes(a.uuid) || ['OWNER', 'ADMIN'].includes(a.role)
    || ticket.mandate.actor.source === 'huly' && a.socialIds.includes(ticket.mandate.actor.id))
}
interface Grant { token: string; account: string; actors: string[]; task: string; expires: number }
/** Validates a member’s optional choice at issuance and again at source intake, then uses the native Engine. */
export class HulyRouting {
  private grants = new Map<string, Grant>()
  constructor(private runtime: Runtime, private client: HulyClient) {}
  async issue(task: string, token: string, account: HulyAccount): Promise<{ route: string; expires: number }> {
    this.prune()
    if (this.grants.size >= 1000) throw new HulyError(429, '请稍后重试')
    if (!account.socialIds.some(id => allowedSender(this.runtime.store.settings(), { source: 'huly', id }))) throw new HulyError(403, '当前成员无权发起任务')
    if (task !== 'new') {
      const ticket = this.runtime.store.tickets.get(task)
      if (!ticket || !await mayReadHulyTask(this.runtime, this.client, ticket, token) || !mayWriteHulyTask(this.client, ticket, account)) throw new HulyError(403, '无法选择此会话')
    }
    const route = randomUUID(), expires = Date.now() + 30 * 60_000
    this.grants.set(route, { token, account: account.uuid, actors: account.socialIds, task, expires })
    return { route, expires }
  }
  private prune(): void { for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(id) }
  async receive(trigger: Trigger): Promise<ReceiveResult> {
    const stored = this.runtime.store.triggers.get(trigger.id)
    if (stored) return 'duplicate'
    const route = trigger.addressed && trigger.human ? trigger.meta.peppyRoute : undefined
    if (!route) return this.runtime.receive(trigger)
    this.prune()
    const grant = typeof route === 'string' ? this.grants.get(route) : undefined
    try {
      if (!grant || !grant.actors.includes(trigger.actor.id) || !allowedSender(this.runtime.store.settings(), trigger.actor)) throw new HulyError(409, 'Expired selection')
      const account = await this.client.account(grant.token)
      if (account.uuid !== grant.account || !account.socialIds.includes(trigger.actor.id) || !await this.client.one(HULY.channel, String(trigger.meta.channelId), grant.token)) throw new HulyError(403, 'Membership changed')
      const ticket = grant.task === 'new' ? undefined : this.runtime.store.tickets.get(grant.task)
      if (grant.task !== 'new' && (!ticket || !await mayReadHulyTask(this.runtime, this.client, ticket, grant.token) || !mayWriteHulyTask(this.client, ticket, account))) throw new HulyError(403, 'Task access changed')
      // A private primary evaluation lane isolates a new request; verified core routing limits fan-out.
      // Keep original native Threads too, so later unmentioned discussion reaches the selected worker.
      const routed: Trigger = { ...trigger, threads: [{ source: 'huly', id: `selected:${trigger.id}` }, ...trigger.threads],
        ...(ticket ? { targetTicket: ticket.id } : { newTicket: true }), meta: { ...trigger.meta, peppyRoute: undefined, sessionChoice: grant.task, statusVersion: 2 } }
      const result = this.runtime.store.atomic(() => {
        const result = this.runtime.engine.receive(routed)
        const disposition = this.runtime.store.triggers.disposition(routed.id)
        if (result !== 'filtered' && ticket && (!disposition?.fanout.includes(ticket.id) || disposition.context?.includes(ticket.id))) this.runtime.engine.attach(ticket.id, routed.id, 'Authenticated Huly member selected this existing session')
        return result
      })
      this.runtime.passes.request()
      return result
    } catch (error) {
      if (!(error instanceof UserError) && (!(error instanceof HulyError) || ![401, 403, 404, 409].includes(error.status))) throw error
      // Never fall back to auto routing after an explicit choice expires or loses permission.
      return this.runtime.receive({ ...trigger, meta: { ...trigger.meta, peppyRoute: undefined, routingError: true } })
    }
  }
}
