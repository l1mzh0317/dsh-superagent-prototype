/** Context views project native Huly triggers and ticket dispositions; no extra task or trace store. */
import type { Runtime } from '../app/runtime.ts'
import type { Ticket, Trigger } from '../core/index.ts'
import { HULY, HulyClient, readMarkup, type HulyDoc } from '../sources/huly-client.ts'
import { hulyInputState } from '../sources/huly-feedback.ts'
export function threadMessages(runtime: Pick<Runtime, 'store'>, workspace: string, trigger: Trigger): Trigger[] {
  const channel = String(trigger.meta.channelId ?? trigger.channel?.address.channelId ?? '')
  const root = String(trigger.meta.rootId ?? trigger.channel?.address.rootId ?? '')
  return runtime.store.read.hulyThreadMessages(workspace, channel, root)
}
export async function contextView(runtime: Runtime, client: HulyClient, token: string, ticket?: Ticket, conversation?: Trigger) {
  const workspace = client.deployment.workspace, inputs = new Map<string, Trigger>(), sources = new Map<string, { channelId: string; rootId: string }>()
  if (conversation) {
    const logical = typeof conversation.meta.discussionId === 'string' ? runtime.store.triggers.get(conversation.meta.discussionId) : undefined
    for (const input of [conversation, logical, ...runtime.store.read.hulyDiscussionMessages(workspace, logical?.id ?? conversation.id)]) {
      if (!input || input.meta.workspace !== workspace || !input.channel) continue
      const { channelId, rootId } = input.channel.address
      if (channelId && rootId) sources.set(`${channelId}:${rootId}`, { channelId, rootId })
    }
  }
  for (const channel of ticket?.channels ?? []) if (channel.source === 'huly' && channel.address.workspace === workspace) sources.set(`${channel.address.channelId}:${channel.address.rootId}`, { channelId: channel.address.channelId!, rootId: channel.address.rootId! })
  for (const id of [...(ticket?.origin.triggerIds ?? []), ...(ticket?.inputs.flatMap(i => i.kind === 'trigger' ? [i.triggerId] : []) ?? [])]) {
    const t = runtime.store.triggers.get(id)
    if (t?.source === 'huly' && t.meta.workspace === workspace) {
      inputs.set(t.id, t)
      if (t.meta.surface !== 'dashboard') sources.set(`${t.meta.channelId}:${t.meta.rootId}`, { channelId: String(t.meta.channelId), rootId: String(t.meta.rootId) })
    }
  }
  const channels = new Map<string, string>(), people = new Map<string, string>(), nodes = []
  const sourceMessages: Array<{ doc: HulyDoc; channelId: string; rootId: string }> = []
  let truncated = false
  for (const { channelId, rootId } of sources.values()) {
    const channel = await client.one(HULY.channel, channelId, token)
    if (!channel) continue
    channels.set(channelId, typeof channel.name === 'string' ? channel.name : channelId)
    const rows = runtime.store.read.hulyThreadMessages(workspace, channelId, rootId, 1001)
    truncated ||= rows.length > 1000
    for (const t of rows.slice(0, 1000)) inputs.set(t.id, t)
    // Fetch public discussion with this reader's token, including replies not ingested before the first mention.
    const parent = await client.one(HULY.message, rootId, token)
    if (parent && (parent.space === channelId || parent.attachedTo === channelId)) sourceMessages.push({ doc: parent, channelId, rootId })
    const replies = await client.find(HULY.reply, { attachedTo: rootId, space: channelId }, { limit: 101, sort: { createdOn: 1, _id: 1 } }, token)
    truncated ||= replies.length > 100
    for (const doc of replies.slice(0, 100)) if (doc.attachedTo === rootId && doc.space === channelId) sourceMessages.push({ doc, channelId, rootId })
  }
  const dedup = new Set<string>()
  for (const t of [...inputs.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    if (!t.human || t.meta.edited || t.meta.workspace !== workspace) continue
    const dashboard = t.meta.surface === 'dashboard', channelId = String(t.meta.channelId), rootId = String(t.meta.rootId)
    if (!dashboard && !channels.has(channelId)) continue
    const messageId = String(t.meta.messageId), unique = `${dashboard ? 'dashboard' : channelId}:${messageId}`
    if (dedup.has(unique)) continue
    dedup.add(unique)
    const state = hulyInputState(runtime, workspace, t), disposition = runtime.store.triggers.disposition(t.id)
    const linked = !!ticket && (ticket.origin.triggerIds.includes(t.id) || !!disposition?.fanout.includes(ticket.id))
    const adopted = ticket ? linked && (ticket.origin.triggerIds.includes(t.id) || !!disposition?.acked?.includes(ticket.id)) && !disposition?.context?.includes(ticket.id) && !disposition?.handbacks?.some(h => h.ticketId === ticket.id) : state.adopted
    if (!people.has(t.actor.id)) {
      let name = '团队成员'
      try { const social = await client.one(HULY.social, t.actor.id, token); const person = social?.attachedTo ? await client.one(HULY.person, String(social.attachedTo), token) : undefined
        if (typeof person?.name === 'string') name = person.name.split(',').reverse().join(' ').trim()
      } catch { /* An inaccessible directory entry does not expose a service-token lookup. */ }
      people.set(t.actor.id, name)
    }
    nodes.push({ id: t.id, messageId, at: t.at, sender: people.get(t.actor.id), text: t.text,
      channelId, channelName: dashboard ? '会话侧栏' : channels.get(channelId), rootId,
      threadKey: dashboard ? 'dashboard' : `${channelId}:${rootId}`, mentioned: !!t.addressed,
      inclusion: adopted || dashboard ? 'adopted' : linked ? 'included' : 'context',
      sourceUrl: dashboard ? null : client.threadUrl(channelId, rootId).replace(/([?&]message=)[^&]*/, `$1${encodeURIComponent(messageId)}`) })
  }
  const known = new Set(nodes.map(n => `${n.channelId}:${n.messageId}`))
  for (const { doc, channelId, rootId } of sourceMessages) {
    if (known.has(`${channelId}:${doc._id}`)) continue
    const text = readMarkup(doc.message).text
    if (!text) continue
    const actor = doc.createdBy ?? doc.modifiedBy, bot = actor === client.deployment.botSocial
    let sender = bot ? 'Team Peppy' : people.get(actor)
    if (!sender) {
      const social = await client.one(HULY.social, actor, token), person = social?.attachedTo ? await client.one(HULY.person, String(social.attachedTo), token) : undefined
      sender = typeof person?.name === 'string' ? person.name.split(',').reverse().join(' ').trim() : '团队成员'; people.set(actor, sender)
    }
    nodes.push({ id: `huly:${doc._id}`, messageId: doc._id, at: new Date(doc.createdOn ?? doc.modifiedOn).toISOString(), sender, text,
      channelId, channelName: channels.get(channelId), rootId, threadKey: `${channelId}:${rootId}`, mentioned: readMarkup(doc.message).mentions.includes(client.deployment.botPerson),
      inclusion: bot ? 'reply' : 'context', sourceUrl: client.threadUrl(channelId, rootId).replace(/([?&]message=)[^&]*/, `$1${encodeURIComponent(doc._id)}`) })
  }
  nodes.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  return { nodes, truncated, title: ticket?.title ?? (conversation?.text.replace(/@?Team\s*Peppy/ig, '').trim().slice(0, 80) || '频道讨论') }
}
