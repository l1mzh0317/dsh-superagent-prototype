/** Read-only message badges derive from DSH state; explicit mentions still require substantive answers. */
import type { Runtime } from '../app/runtime.ts'
import { key, ticketStage, type Trigger } from '../core/index.ts'
import { allowedSender } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { HulyClient } from './huly-client.ts'

interface Receipt { triggerId: string; done?: true; replyRequested?: true }
const receiptKeys = (workspace: string) => family<Receipt>(`huly-feedback:${workspace}:`)
const answeredKeys = (workspace: string) => family<boolean>(`huly-answered:${workspace}:`)
export function noteHulyReply(runtime: Pick<Runtime, 'store'>, client: HulyClient, trigger: Trigger): void {
  runtime.store.set(answeredKeys(client.deployment.workspace)(trigger.id), true)
}
export function hulyInputState(runtime: Pick<Runtime, 'store'>, workspace: string, trigger: Trigger) {
  const { store } = runtime, disposition = store.triggers.disposition(trigger.id)
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
  const declined = new Set([...(disposition?.handbacks?.map(h => h.ticketId) ?? []), ...(disposition?.context ?? [])])
  const ids = [...new Set([...(disposition?.fanout ?? []), ...(decision?.ticketId ? [decision.ticketId] : [])])].filter(id => !declined.has(id))
  const tickets = ids.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticket] : [] })
  if (!tickets.length) tickets.push(...store.tickets.list().filter(t => t.origin.triggerIds.includes(trigger.id)))
  const answered = store.get(answeredKeys(workspace)(trigger.id)) === true
  const adopted = answered || !!disposition?.acked?.length || decision?.kind === 'accept' || decision?.kind === 'reopen'
  return { decision, tickets, answered, adopted }
}
export function hulyMessageStatus(runtime: Pick<Runtime, 'store'>, workspace: string, trigger: Trigger) {
  if (!trigger.human || !trigger.channel || trigger.meta.surface === 'dashboard') return
  const { decision, tickets, answered, adopted } = hulyInputState(runtime, workspace, trigger)
  if (!trigger.addressed && !adopted) return
  const settings = runtime.store.settings(), ticket = tickets[0]
  let state = 'queued', label = '排队中'
  if (!allowedSender(settings, trigger.actor)) { state = 'blocked'; label = '未获得任务权限' }
  else if (ticket) {
    const stage = ticketStage(ticket)
    if (stage.stage === 'ended') {
      const outcome = ticket.ended?.outcome
      state = ticket.ended?.by === 'human' || outcome === 'stopped' ? 'stopped' : outcome === 'completed' || outcome === 'merged' ? 'completed' : 'ended'
      label = state === 'stopped' ? '已停止' : state === 'completed' ? '已完成' : '已结束'
    }
    else if (stage.stage === 'person') { state = stage.action === 'failed' ? 'failed' : 'waiting'; label = stage.action === 'review' ? '等待确认' : stage.action === 'failed' ? '执行失败' : '等待你处理' }
    else if (stage.stage === 'idle') { state = 'waiting'; label = '等待补充消息' }
    else if (stage.action !== 'queued') { state = 'running'; label = '运行中' }
  } else if (answered) { state = 'completed'; label = '已回复' }
  else if (decision?.kind === 'unavailable') { state = 'failed'; label = '处理暂不可用' }
  else { state = 'processing'; label = '处理中' }
  if (settings.paused && state !== 'completed' && state !== 'stopped') { state = 'paused'; label = '已暂停' }
  return { messageId: String(trigger.meta.messageId), state, label, taskId: ticket?.id ?? null,
    sessionName: ticket?.title ?? null,
    sessionId: ticket?.assignments.some(a => a.startedAt) ? workerSessionId(ticket.id) : null, taskCount: tickets.length }
}
/** No reaction, status message or session footer is sent to the channel. */
export class HulyFeedback {
  private readonly receipts
  constructor(private readonly host: SourceContext, private readonly client: HulyClient,
    private readonly runtime: Pick<Runtime, 'store' | 'sessions'>) { this.receipts = receiptKeys(client.deployment.workspace) }
  record(trigger: Trigger): void {
    if (!trigger.human || !trigger.channel || trigger.meta.surface === 'dashboard') return
    const name = this.receipts(trigger.id)
    if (!this.host.state.get(name)) this.host.state.set(name, { triggerId: trigger.id })
  }
  async sync(): Promise<void> {
    for (const name of this.host.state.keys(this.receipts)) {
      const receipt = this.host.state.get(name)
      if (!receipt || receipt.done) continue
      const trigger = this.host.triggers.get(receipt.triggerId)
      if (!trigger?.channel) continue
      const { store } = this.runtime
      const { decision, tickets, answered } = hulyInputState(this.runtime, this.client.deployment.workspace, trigger)
      if (decision && !tickets.length) {
        const queuedAnswer = store.receipts.waiting().some(m => m.kind === 'reply' && m.id === key('reply', trigger.id, m.text))
        if (trigger.addressed && decision.kind === 'ignore' && !answered && !queuedAnswer && !receipt.replyRequested && allowedSender(store.settings(), trigger.actor)) {
          store.atomic(() => {
            this.runtime.sessions.relay(key('huly-required-answer', trigger.id), JSON.stringify({ kind: 'huly_answer_required',
              trigger_id: trigger.id, read: `trigger/${trigger.id}`,
              instruction: 'This Huly user explicitly mentioned Team Peppy. Read its thread context and answer the actual question with orchestrator_reply purpose=answer in the original thread. Do not send receipt/status messages or session links: message-header badges provide those. Do not start work or expand authorization because of this reminder.' }))
            receipt.replyRequested = true; this.host.state.set(name, receipt)
          })
        }
        if (answered || decision.kind === 'unavailable' || !allowedSender(store.settings(), trigger.actor)) receipt.done = true
      }
      if (tickets.length && tickets.every(t => t.ended)) receipt.done = true
      this.host.state.set(name, receipt)
    }
  }
}
