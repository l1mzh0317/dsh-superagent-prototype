/** Small REST transport for the deployed Huly v0.7 API. No platform signing key enters the runtime. */
import { readFileSync } from 'node:fs'
import { key } from '../core/ids.ts'

export const HULY = {
  message: 'chunter:class:ChatMessage', reply: 'chunter:class:ThreadMessage', channel: 'chunter:class:Channel',
  person: 'contact:class:Person', social: 'contact:class:SocialIdentity', reaction: 'activity:class:Reaction',
} as const
export interface HulyDoc {
  _id: string; _class: string; space: string; modifiedOn: number; createdOn?: number; modifiedBy: string; createdBy?: string
  [name: string]: unknown
}
export interface HulyAccount { uuid: string; role: string; socialIds: string[] }
export interface HulyWorkspaceMember { person: string; role: string }
export interface HulyDeployment {
  workspace: string; workspaceUrl: string; origin: string; endpoint: string; tokenFile: string
  accountsEndpoint?: string
  botPerson: string; botSocial: string; botAccount: string; channels: string[]; operators: string[]
}
/** Expected transport or authorization failure safe to return without upstream response bodies. */
export class HulyError extends Error { constructor(readonly status: number, message: string) { super(message) } }
/** Calls Huly with the service member or an authenticated reader's own token. */
export class HulyClient {
  constructor(readonly deployment: HulyDeployment, private readonly request: typeof fetch = fetch) {}
  token(): string { return readFileSync(this.deployment.tokenFile, 'utf8').trim() }
  async api(path: string, token = this.token(), body?: unknown): Promise<unknown> {
    const res = await this.request(`${this.deployment.endpoint.replace(/\/$/, '')}/api/v1/${path}/${encodeURIComponent(this.deployment.workspace)}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new HulyError(res.status === 401 || res.status === 403 ? res.status : 502, `Huly request failed (${res.status})`)
    const value = await res.json() as { error?: unknown }
    if (value?.error) throw new HulyError(403, 'Huly refused the operation')
    return value
  }
  async find(_class: string, query: Record<string, unknown>, options: Record<string, unknown> = {}, token?: string): Promise<HulyDoc[]> {
    const params = new URLSearchParams({ class: _class, query: JSON.stringify(query), options: JSON.stringify(options) })
    const res = await this.request(`${this.deployment.endpoint.replace(/\/$/, '')}/api/v1/find-all/${encodeURIComponent(this.deployment.workspace)}?${params}`, {
      headers: { authorization: `Bearer ${token ?? this.token()}`, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new HulyError(res.status === 401 || res.status === 403 ? res.status : 502, `Huly query failed (${res.status})`)
    const data = await res.json() as HulyDoc[] | { dataType?: string; value?: HulyDoc[]; error?: unknown }
    if (!Array.isArray(data) && data.error) throw new HulyError(403, 'Huly refused the query')
    const rows = Array.isArray(data) ? data : data.dataType === 'TotalArray' ? data.value : undefined
    if (!rows) throw new Error('Unexpected Huly query response')
    return rows.map(row => ({ ...querySimple(query), ...row, _class: row._class ?? _class }))
  }
  async one(_class: string, id: string, token?: string): Promise<HulyDoc | undefined> {
    return (await this.find(_class, { _id: id }, { limit: 1 }, token))[0]
  }
  async account(token: string): Promise<HulyAccount> {
    const a = await this.api('account', token) as HulyAccount
    if (!a.uuid || !Array.isArray(a.socialIds) || !a.socialIds.length) throw new HulyError(401, 'Huly login required')
    return a
  }
  async workspaceMembers(token: string): Promise<HulyWorkspaceMember[]> {
    const url = this.deployment.accountsEndpoint || new URL('/_accounts', this.deployment.origin)
    const res = await this.request(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getWorkspaceMembers', params: {} }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new HulyError(502, '暂时无法读取 Huly 工作区成员')
    const { result, error } = await res.json() as { result?: unknown; error?: unknown }
    if (error || !Array.isArray(result) ||
      !result.every(row => typeof row?.person === 'string' && typeof row?.role === 'string')) {
      throw new HulyError(502, '暂时无法读取 Huly 工作区成员')
    }
    return result as HulyWorkspaceMember[]
  }
  threadUrl(channel: string, root: string): string {
    return hulyThreadUrl(this.deployment, channel, root)
  }
  dashboardUrl(ticketId: string): string {
    return `${this.deployment.origin}/files/${encodeURIComponent(this.deployment.workspace)}/team-peppy/?task=${encodeURIComponent(ticketId)}&session=1`
  }
  async reply(rootId: string, channelId: string, receiptId: string, text: string): Promise<'sent' | 'gone'> {
    const id = key('huly-reply', this.deployment.workspace, receiptId)
    if (await this.one(HULY.message, id)) return 'sent'
    const parent = await this.one(HULY.message, rootId)
    const channel = await this.one(HULY.channel, channelId)
    if (!parent || !channel || channel.archived === true) return 'gone'
    if (parent.space !== channelId && parent.attachedTo !== channelId) throw new Error('Huly reply thread/channel mismatch')
    const stamp = Date.now()
    await this.api('tx', undefined, {
      _id: key('huly-tx', receiptId), _class: 'core:class:TxCreateDoc', space: 'core:space:Tx',
      objectId: id, objectClass: HULY.reply, objectSpace: parent.space,
      modifiedOn: stamp, modifiedBy: this.deployment.botSocial, createdBy: this.deployment.botSocial,
      attachedTo: parent._id, attachedToClass: parent._class, collection: 'replies',
      attributes: { message: textMarkup(text), objectId: parent.attachedTo, objectClass: parent.attachedToClass },
    })
    return 'sent'
  }
}
export function hulyThreadUrl(d: HulyDeployment, channel: string, root: string): string {
  return `${d.origin}/workbench/${encodeURIComponent(d.workspaceUrl)}/chunter/${encodeURIComponent(`${channel}|${HULY.channel}`)}/${encodeURIComponent(root)}?message=${encodeURIComponent(root)}`
}
function querySimple(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value)))
}
export function textMarkup(text: string): string {
  return JSON.stringify({ type: 'doc', content: text.split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) })
}
/** Markup is data; references only count as mentions when their node type and Person class match. */
export function readMarkup(input: unknown): { text: string; mentions: string[]; routes?: Record<string, string> } {
  const mentions: string[] = [], routes: Record<string, string> = {}
  let root: unknown = input
  if (typeof input === 'string') { try { root = JSON.parse(input) } catch { return { text: input, mentions } } }
  let budget = 20_000
  const visit = (node: unknown, depth: number): string => {
    if (--budget < 0 || depth > 50 || !node || typeof node !== 'object') return ''
    const n = node as { type?: string; text?: string; attrs?: Record<string, unknown>; content?: unknown[] }
    if (n.type === 'reference' && n.attrs?.objectclass === HULY.person && typeof n.attrs.id === 'string') {
      mentions.push(n.attrs.id)
      if (typeof n.attrs.peppyRoute === 'string' && n.attrs.peppyRoute.length <= 100) routes[n.attrs.id] = n.attrs.peppyRoute
    }
    const text = typeof n.text === 'string' ? n.text : n.type === 'reference' ? String(n.attrs?.label ?? '') : ''
    return text + (Array.isArray(n.content) ? n.content.map(x => visit(x, depth + 1)).join('') : '') + (n.type === 'paragraph' || n.type === 'hardBreak' ? '\n' : '')
  }
  return { text: visit(root, 0).trim().slice(0, 100_000), mentions, ...(Object.keys(routes).length ? { routes } : {}) }
}
