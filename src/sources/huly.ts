/** Huly Source and Team Peppy integration. Uses the existing Engine, Store, Executor and Sessions. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { record, family } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import type { SourceContext } from './host.ts'
import type { Runtime } from '../app/runtime.ts'
import { HULY, HulyClient, hulyThreadUrl, readMarkup, type HulyDeployment, type HulyDoc } from './huly-client.ts'
import { registerTeamPeppy } from '../team-peppy/http.ts'
import { HulyFeedback, noteHulyReply } from './huly-feedback.ts'

export const SOURCE = 'huly'
export const HulyConfig = z.object({ workspace: z.string(), channels: z.array(z.string()), pollMs: z.number().int().min(1000).max(60_000).default(2000) })
export type HulyConfig = z.infer<typeof HulyConfig>
export interface Cursor { time: number; id: string }
const cursorKey = (workspace: string) => record<Cursor>(`huly:cursor:${workspace}`)
const watchedThread = (workspace: string) => family<boolean>(`huly-watched-thread:${workspace}:`)
export function hulyTrigger(message: HulyDoc, deployment: HulyDeployment, channelId: string): Trigger | undefined {
  const actor = message.createdBy ?? message.modifiedBy
  if (!actor || actor === deployment.botSocial) return
  const markup = readMarkup(message.message)
  if (!markup.text) return
  const root = message._class === HULY.reply ? String(message.attachedTo) : message._id
  const thread = `${deployment.workspace}:${channelId}:${root}`
  const revised = typeof message.editedOn === 'number' ? message.editedOn : message.createdOn ?? message.modifiedOn
  return { id: key('huly', deployment.workspace, message._id, String(revised)), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }], actor: { source: SOURCE, id: actor }, human: !message.editedOn,
    ...(markup.mentions.includes(deployment.botPerson) && !message.editedOn ? { addressed: 'mention' as const } : {}),
    at: new Date(message.modifiedOn).toISOString(), text: markup.text,
    url: hulyThreadUrl(deployment, channelId, root),
    channel: { source: SOURCE, thread, address: { workspace: deployment.workspace, channelId, rootId: root } },
    meta: { workspace: deployment.workspace, channelId, rootId: root, messageId: message._id, edited: !!message.editedOn } }
}
export function hulyKind(client: HulyClient, runtime?: Pick<Runtime, 'store'>): SourceKind<HulyConfig> {
  const d = client.deployment
  return {
    kind: SOURCE, title: { zh: 'Huly', en: 'Huly' }, description: { zh: '接收工作区频道中的 @Team Peppy 和订阅线程。', en: 'Receives mentions and subscribed threads from Huly.' },
    schema: HulyConfig.extend({ workspace: z.literal(d.workspace).default(d.workspace), channels: z.array(z.string()).default(d.channels) }),
    fields: [],
    health: ['huly', 'hulyFeedback'],
    scope: ({ meta }, config) => meta.workspace === config.workspace && config.channels.includes(String(meta.channelId))
      ? { listened: true, observed: meta.observedThread === true, row: String(meta.channelId) } : { listened: false, reason: 'huly_channel_not_enabled' },
    channel: {
      allowed: (a, c) => a.workspace === c.workspace && c.channels.includes(a.channelId ?? ''),
      send: async (_, m) => {
        // Native acknowledgement/disposition remains intact; its visual receipt is the message-header badge.
        if (m.kind === 'acknowledgement') return 'sent'
        const result = await client.reply(m.channel.address.rootId!, m.channel.address.channelId!, m.id, m.text)
        if (result === 'sent' && runtime) {
          // Match a native answer/ack receipt to its exact original input, not every message in the conversation.
          for (const trigger of runtime.store.read.threadTriggers(`huly:${m.channel.thread}`, 100)) {
            if (m.id === key('reply', trigger.id, m.text)) noteHulyReply(runtime, client, trigger)
          }
        }
        return result
      },
      link: a => ({ url: client.threadUrl(a.channelId!, a.rootId!), label: { zh: '打开 Huly 线程', en: 'Open Huly thread' } }),
    },
    threadContext: {
      messageId: t => String(t.meta.messageId),
      async read(_, trigger, part, cursor) {
        const root = String(trigger.meta.rootId)
        const rows = part === 'root' || part === 'parent' ? [await client.one(HULY.message, root)].filter((x): x is HulyDoc => !!x)
          : await client.find(HULY.reply, { attachedTo: root }, { limit: 50, skip: Number(cursor ?? 0), sort: { createdOn: 1, _id: 1 } })
        const messages = rows.map(m => ({ id: m._id, from: m.createdBy ?? m.modifiedBy, at: new Date(m.createdOn ?? m.modifiedOn).toISOString(),
          text: readMarkup(m.message).text, ...(m.createdBy === d.botSocial ? { bot: true as const } : {}) }))
        return { messages, body: {}, ...(rows.length === 50 ? { next: String(Number(cursor ?? 0) + 50) } : {}) }
      },
    },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]) }),
      fields: [], explicit: { zh: '允许的成员 @Team Peppy 发起工作。', en: 'Allowed members may mention Team Peppy.' } },
  }
}
export async function pollHuly(host: SourceContext, client: HulyClient, config: HulyConfig, received?: (trigger: Trigger) => void): Promise<number> {
  const d = client.deployment, k = cursorKey(d.workspace)
  const cursor = host.state.get(k)
  // Start at activation, never execute pre-existing mentions retroactively.
  if (!cursor) { host.state.set(k, { time: Date.now(), id: '' }); return 0 }
  // v0.7.426's REST/SQL adapter does not support this compound $or. Two keyset reads preserve timestamp ties.
  const ties = await client.find(HULY.message, { space: { $in: config.channels }, modifiedOn: cursor.time, _id: { $gt: cursor.id } },
    { limit: 100, sort: { _id: 1 } })
  const rows = ties.length === 100 ? ties : [...ties, ...await client.find(HULY.message,
    { space: { $in: config.channels }, modifiedOn: { $gt: cursor.time } }, { limit: 100, sort: { modifiedOn: 1, _id: 1 } })]
  for (const message of rows) {
    const channel = config.channels.includes(message.space) ? message.space : String(message.attachedTo)
    if (config.channels.includes(channel)) {
      const trigger = hulyTrigger(message, d, channel)
      if (trigger) {
        // Unmentioned channel traffic is ignored; existing subscriptions receive all follow-ups.
        const threadId = trigger.threads[0]!.id
        const watch = watchedThread(d.workspace)(threadId)
        const followed = host.state.get(watch) || !!host.threads.get(`huly:${threadId}`)
        const edited = trigger.meta.edited === true
        if ((!edited && trigger.addressed) || followed) {
          trigger.meta.observedThread = true
          const result = await host.receive(trigger)
          if (result !== 'filtered') {
            host.state.set(watch, true)
            received?.(trigger)
          }
        }
      }
    }
    host.state.set(k, { time: message.modifiedOn, id: message._id })
  }
  return rows.length
}
async function run(host: SourceContext, client: HulyClient, runtime: Runtime, signal: AbortSignal): Promise<void> {
  await host.ready
  const feedback = new HulyFeedback(host, client, runtime)
  while (!signal.aborted) {
    const cfg = host.config<HulyConfig>(SOURCE)
    if (host.configured() && cfg) {
      try { await pollHuly(host, client, cfg, trigger => feedback.record(trigger)); host.report('huly', { state: 'ready', detail: 'Connected', at: new Date().toISOString() }) }
      catch (error) { host.report('huly', { state: 'error', detail: `Huly poll failed; cursor retained: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}` }) }
      try { await feedback.sync(); host.report('hulyFeedback', { state: 'ready', detail: 'Message receipts synchronized' }) }
      catch { host.report('hulyFeedback', { state: 'error', detail: 'Message received; channel feedback will retry' }) }
    }
    await delay(cfg?.pollMs ?? 2000, undefined, { signal }).catch(() => {})
  }
}
export function deploymentFromEnv(): HulyDeployment {
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
  return { workspace: required('HULY_WORKSPACE_ID'), workspaceUrl: required('HULY_WORKSPACE_URL'), origin: required('HULY_ORIGIN'),
    endpoint: required('HULY_TRANSACTOR_URL'), tokenFile: required('HULY_TOKEN_FILE'), botPerson: required('HULY_BOT_PERSON'),
    botSocial: required('HULY_BOT_SOCIAL'), botAccount: required('HULY_BOT_ACCOUNT'),
    channels: JSON.parse(required('HULY_CHANNELS')) as string[], operators: JSON.parse(required('HULY_OPERATORS')) as string[] }
}
export const name = 'dsh-superagent-huly'
export const inject = ['orchestrator', 'webServer', 'sessionController', 'agents']
export function apply(ctx: Context): void {
  const client = new HulyClient(deploymentFromEnv()), runtime = ctx.orchestrator as Runtime, kind = hulyKind(client, runtime)
  ctx.effect(() => ctx.orchestrator.sources.register(kind))
  ctx.effect(() => registerTeamPeppy(ctx, ctx.orchestrator as Runtime, client))
  ctx.effect(() => { const stop = new AbortController(); const running = run(ctx.orchestrator.context(kind), client, runtime, stop.signal)
    return async () => { stop.abort(); await running } })
}
