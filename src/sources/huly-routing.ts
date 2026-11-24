/** Optional, authenticated mention routing. Grants live briefly in memory; credentials never enter message markup. */
import { randomUUID } from 'node:crypto'
import type { Runtime } from '../app/runtime.ts'
import { type Ticket, type Trigger, type ReceiveResult, UserError } from '../core/index.ts'
import { allowedSender } from '../policy.ts'
import { HULY, HulyClient, HulyError, type HulyAccount } from './huly-client.ts'
import { Instances } from '../team-peppy/instances.ts'

/** Include physical message sources for older attached tickets, whose original channel list predates discussion selection. */
export function hulyTaskSources(runtime: Runtime, ticket: Ticket) {
  const channels = [...ticket.channels]
  for (const input of ticket.inputs ?? []) {
    if (input.kind !== 'trigger') continue
    const trigger = runtime.store.triggers.get(input.triggerId)
    if (trigger?.channel) channels.push(trigger.channel)
    if (trigger?.contextChannel) channels.push(trigger.contextChannel)
  }
  return channels
}
export async function mayReadHulyTask(runtime: Runtime, client: HulyClient, ticket: Ticket, token: string): Promise<boolean> {
  const enabled = runtime.sources.instance<{ channels: string[] }>('huly')?.config.channels ?? []
  const channels = hulyTaskSources(runtime, ticket)
  if (!channels.length || !channels.every(c => c.source === 'huly' && c.address.workspace === client.deployment.workspace && enabled.includes(c.address.channelId!))) return false
  for (const channel of new Set(channels.map(c => c.address.channelId!))) if (!await client.one(HULY.channel, channel, token)) return false
  return true
}
export function mayWriteHulyTask(client: HulyClient, ticket: Ticket, a: HulyAccount): boolean {
  return ticket.ended?.by !== 'human' && (client.deployment.operators.includes(a.uuid) || ['OWNER', 'ADMIN'].includes(a.role)
    || ticket.mandate.actor.source === 'huly' && a.socialIds.includes(ticket.mandate.actor.id))
}
export interface HulyChoice { task?: string; discussion?: string }
interface Grant extends HulyChoice { token: string; account: string; actors: string[]; expires: number }
export function hulyDiscussionTitle(trigger: Trigger): string {
  return trigger.text.replace(/@?Team\s*Peppy/ig, '').trim().slice(0, 80) || '频道讨论'
}
export function hulyMayChoose(runtime: Runtime, account: HulyAccount): boolean {
  const settings = runtime.store.settings()
  return account.socialIds.some(id => allowedSender(settings, { source: 'huly', id }))
}
function sameDiscussion(ticket: Ticket, input: Trigger): boolean {
  return ticket.channels.some(c => c.source === 'huly' && c.thread === input.channel?.thread)
}
export async function hulyDiscussion(runtime: Runtime, client: HulyClient, id: string, token: string): Promise<Trigger> {
  const trigger = runtime.store.triggers.get(id)
  if (!trigger?.human || trigger.addressed !== 'mention' || trigger.source !== 'huly' || trigger.meta.surface || trigger.meta.discussionId ||
    trigger.meta.workspace !== client.deployment.workspace || !trigger.channel || runtime.store.triggers.disposition(id)?.filtered ||
    !runtime.sources.instance<{ channels: string[] }>('huly')?.config.channels.includes(trigger.channel.address.channelId!) ||
    !await client.one(HULY.channel, trigger.channel.address.channelId!, token)) throw new HulyError(404, '此讨论已不可访问')
  return trigger
}
/** Validates a member’s optional choice at issuance and again at source intake, then uses the native Engine. */
export class HulyRouting {
  private grants = new Map<string, Grant>()
  constructor(private runtime: Runtime, private client: HulyClient,
    private instances: Pick<Instances, 'requestedTarget'> = new Instances(runtime.store, client)) {}
  async issue(choice: string | HulyChoice, token: string, account: HulyAccount): Promise<{ route: string; expires: number }> {
    this.prune()
    if (this.grants.size >= 1000) throw new HulyError(429, '请稍后重试')
    if (!hulyMayChoose(this.runtime, account)) throw new HulyError(403, '当前账号未获 Team Peppy 任务发起权限')
    const { task, discussion } = typeof choice === 'string' ? { task: choice, discussion: undefined } : choice
    if (!task && !discussion) throw new HulyError(400, '请选择讨论或工作会话')
    const parent = discussion ? await hulyDiscussion(this.runtime, this.client, discussion, token) : undefined
    if (task && task !== 'new') {
      const ticket = this.runtime.store.tickets.get(task)
      if (!ticket || !await mayReadHulyTask(this.runtime, this.client, ticket, token) || !mayWriteHulyTask(this.client, ticket, account)) throw new HulyError(403, '此工作会话已不可接手')
      if (parent && !sameDiscussion(ticket, parent)) throw new HulyError(409, '此工作会话不属于所选讨论')
    }
    const route = randomUUID(), expires = Date.now() + 30 * 60_000
    this.grants.set(route, { token, account: account.uuid, actors: account.socialIds, task, discussion, expires })
    return { route, expires }
  }
  private prune(): void { for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(id) }
  async receive(trigger: Trigger): Promise<ReceiveResult> {
    const stored = this.runtime.store.triggers.get(trigger.id)
    if (stored) return 'duplicate'
    const ids = trigger.meta.requestedInstanceIds
    if (Array.isArray(ids)) {
      const meta = { ...trigger.meta, requestedInstanceIds: undefined }
      const target = ids.length === 1 && typeof ids[0] === 'string' && allowedSender(this.runtime.store.settings(), trigger.actor)
        ? await this.instances.requestedTarget(ids[0], trigger.actor.id).catch((error: unknown) => {
          if (error instanceof HulyError && [401, 403, 404].includes(error.status)) return undefined
          throw error
        }) : undefined
      if (!target) return this.runtime.receive({ ...trigger, meta: { ...meta, routingError: true, instanceSelectionInvalid: true } })
      trigger = { ...trigger, meta: { ...meta, resolvedInstance: target } }
    }
    const route = trigger.addressed && trigger.human ? trigger.meta.peppyRoute : undefined
    if (!route) return this.runtime.receive(trigger)
    this.prune()
    const grant = typeof route === 'string' ? this.grants.get(route) : undefined
    try {
      if (!grant || !grant.actors.includes(trigger.actor.id) || !allowedSender(this.runtime.store.settings(), trigger.actor)) throw new HulyError(409, 'Expired selection')
      const account = await this.client.account(grant.token)
      if (account.uuid !== grant.account || !account.socialIds.includes(trigger.actor.id) || !await this.client.one(HULY.channel, String(trigger.meta.channelId), grant.token)) throw new HulyError(403, 'Membership changed')
      const parent = grant.discussion ? await hulyDiscussion(this.runtime, this.client, grant.discussion, grant.token) : undefined
      const ticket = grant.task && grant.task !== 'new' ? this.runtime.store.tickets.get(grant.task) : undefined
      if (grant.task && grant.task !== 'new' && (!ticket || !await mayReadHulyTask(this.runtime, this.client, ticket, grant.token) || !mayWriteHulyTask(this.client, ticket, account))) throw new HulyError(403, 'Task access changed')
      // A private primary evaluation lane isolates a new request; verified core routing limits fan-out.
      // Keep original native Threads too, so later unmentioned discussion reaches the selected worker.
      if (parent && ticket && !sameDiscussion(ticket, parent)) throw new HulyError(409, '此工作会话已不属于所选讨论')
      const discussionThread = parent?.channel?.thread
      const primary = { source: 'huly', id: !grant.task && discussionThread ? discussionThread : `selected:${trigger.id}` }
      const threads = [primary, ...trigger.threads]
      if (discussionThread) threads.push({ source: 'huly', id: discussionThread })
      const routed: Trigger = { ...trigger, threads: [...new Map(threads.map(t => [t.id, t])).values()],
        ...(ticket ? { targetTicket: ticket.id } : grant.task === 'new' ? { newTicket: true } : { routeToRouter: true }),
        contextChannel: parent?.channel, meta: { ...trigger.meta, peppyRoute: undefined, sessionChoice: grant.task, discussionId: parent?.id, discussionUrl: parent?.url } }
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
