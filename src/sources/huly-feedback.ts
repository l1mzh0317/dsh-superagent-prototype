/** Delivery feedback is an external receipt, derived from native DSH state rather than a second task lifecycle. */
import type { Runtime } from '../app/runtime.ts'
import { key, ticketStage, type Trigger } from '../core/index.ts'
import { allowedSender } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { HulyClient, HulySessionLink } from './huly-client.ts'

interface Receipt { triggerId: string; reaction?: true; fingerprint?: string; done?: true; replyRequested?: true }
const receiptKeys = (workspace: string) => family<Receipt>(`huly-feedback:${workspace}:`)
const answeredKeys = (workspace: string) => family<boolean>(`huly-answered:${workspace}:`)
export function noteHulyReply(runtime: Pick<Runtime, 'store'>, client: HulyClient, trigger: Trigger): void {
  runtime.store.set(answeredKeys(client.deployment.workspace)(trigger.id), true)
}
/** Reconciles native intake, routing and worker adoption into idempotent Huly-visible receipts. */
export class HulyFeedback {
  private readonly receipts
  constructor(private readonly host: SourceContext, private readonly client: HulyClient,
    private readonly runtime: Pick<Runtime, 'store' | 'sessions'>) {
    this.receipts = receiptKeys(client.deployment.workspace)
  }
  record(trigger: Trigger): void {
    if (!trigger.human || !trigger.channel || trigger.meta.surface === 'dashboard') return
    const name = this.receipts(trigger.id)
    if (!this.host.state.get(name)) this.host.state.set(name, { triggerId: trigger.id })
  }
  async sync(): Promise<void> {
    const errors: unknown[] = []
    for (const name of this.host.state.keys(this.receipts)) {
      const receipt = this.host.state.get(name)
      if (!receipt || receipt.done) continue
      const trigger = this.host.triggers.get(receipt.triggerId)
      if (!trigger?.channel) continue
      try {
        const { store } = this.runtime
        const settings = store.settings()
        const disposition = store.triggers.disposition(trigger.id)
        const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
        const declined = new Set([...(disposition?.handbacks?.map(h => h.ticketId) ?? []), ...(disposition?.context ?? [])])
        const ids = [...new Set([...(disposition?.fanout ?? []), ...(decision?.ticketId ? [decision.ticketId] : [])])].filter(id => !declined.has(id))
        const tickets = ids.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticket] : [] })
        if (!tickets.length) tickets.push(...store.tickets.list().filter(t => t.origin.triggerIds.includes(trigger.id)))
        const answered = this.host.state.get(answeredKeys(this.client.deployment.workspace)(trigger.id)) === true
        const adopted = answered || !!disposition?.acked?.length || decision?.kind === 'accept' || decision?.kind === 'reopen'
        // Plain thread traffic is context until the Router or worker actually chooses to handle it.
        if (!trigger.addressed && !adopted) continue
        if (!receipt.reaction) {
          await this.client.receivedReaction(String(trigger.meta.messageId))
          receipt.reaction = true; this.host.state.set(name, receipt)
        }
        const label = trigger.addressed ? '已接收' : '已纳入处理'
        const thread = trigger.threads?.[0] ? this.host.threads.get(`huly:${trigger.threads[0].id}`) : undefined
        let text = `${label} · ${settings.paused ? '处理已暂停，等待恢复' : thread?.evaluating?.delivered ? 'Router 正在处理请求' : '等待 Router 处理'}。✅ 表示收到消息，不代表任务已完成。`
        let session: HulySessionLink | undefined
        if (tickets.length) {
          const ticket = tickets[0]!, stage = ticketStage(ticket)
          session = { ticketId: ticket.id, title: ticket.title, sessionId: workerSessionId(ticket.id) }
          const phase = stage.stage === 'ended' ? '任务已结束' : stage.stage === 'person' ? '等待你处理'
            : stage.stage === 'idle' ? '等待补充消息' : stage.action === 'queued' ? '排队中，等待分配 worker' : 'Worker 已接手，正在执行'
          text = `${label} · ${phase}。点击下方会话可查看实时进展或接手。`
          if (tickets.length > 1) text += ` 本次消息关联 ${tickets.length} 个任务，其余任务可在 Dashboard 查看。`
          if (ticket.ended) receipt.done = true
        } else if (decision) {
          const queuedAnswer = store.receipts.waiting().some(m => m.kind === 'reply' && m.id === key('reply', trigger.id, m.text))
          text = decision.kind === 'unavailable' ? `${label} · Router 暂未完成处理，请稍后重试。`
            : answered ? `${label} · Router 已回复，本次无需分配 worker session。`
              : queuedAnswer ? `${label} · Router 已整理回复，正在发送。`
              : `${label} · Router 正在整理回复，本次未分配 worker session。`
          const member = allowedSender(settings, trigger.actor)
          if (trigger.addressed && decision.kind === 'ignore' && !answered && !queuedAnswer && !receipt.replyRequested && member) {
            // A native ignore may settle routing of a discussion, but does not satisfy an explicit mention's answer.
            store.atomic(() => {
              this.runtime.sessions.relay(key('huly-required-answer', trigger.id), JSON.stringify({ kind: 'huly_answer_required',
                trigger_id: trigger.id, read: `trigger/${trigger.id}`,
                instruction: 'This Huly user explicitly mentioned Team Peppy. Routing was settled without a worker, but no answer was delivered. Read the original trigger and its thread context, then use orchestrator_reply purpose=answer with this trigger_id to answer the actual question in the original thread. A received/status receipt is not an answer. Do not start work or expand authorization because of this reminder.' }))
              receipt.replyRequested = true; this.host.state.set(name, receipt)
            })
          }
          if (!member) { text = `${label} · 当前发起者未获得任务权限，请联系工作区管理员。`; receipt.done = true }
          if (answered || decision.kind === 'unavailable') receipt.done = true
        }
        const fingerprint = JSON.stringify([text, session])
        if (receipt.fingerprint !== fingerprint) {
          await this.client.feedback(trigger.channel.address.rootId!, trigger.channel.address.channelId!, trigger.id, text, session)
          receipt.fingerprint = fingerprint
        }
        this.host.state.set(name, receipt)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors[0]
  }
}
