/** Authenticated Huly task views and an intentionally narrow bridge to the original worker Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Runtime } from '../app/runtime.ts'
import { key, UserError, ticketStage, type Ticket, type Trigger } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { HULY, HulyClient, HulyError, type HulyAccount } from '../sources/huly-client.ts'
import { contextView } from './context.ts'
import { HulyRouting, hulyDiscussionTitle, hulyMayChoose, hulyTaskSources, mayReadHulyTask, mayWriteHulyTask } from '../sources/huly-routing.ts'
import { hulyInputState, hulyMessageStatus, statusCutover } from '../sources/huly-feedback.ts'

const Send = z.object({ sessionId: z.string(), requestId: z.string().uuid(), text: z.string().trim().min(1).max(40_000), mode: z.literal('steer').default('steer') }).strict()
const Cancel = z.object({ sessionId: z.string() }).strict()
const json = (res: ServerResponse, code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
export function requestToken(req: Pick<IncomingMessage, 'headers'>, workspace: string): string {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('presentation-metadata-Token='))?.split('=').slice(1).join('=')
  const token = bearer ?? (cookie ? decodeURIComponent(cookie) : undefined)
  if (!token || token.length > 16_000) throw new HulyError(401, '请先登录 Huly 工作区')
  // This only selects the expected tenant; the Huly API verifies the signature and live membership below.
  let claims: { workspace?: string }
  try { claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as typeof claims } catch { throw new HulyError(401, '无效的 Huly 登录') }
  if (claims.workspace !== workspace) throw new HulyError(403, '请切换到对应的 Huly 工作区')
  return token
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const c of req) { size += c.length; if (size > 160_000) throw new HulyError(413, 'Request too large'); chunks.push(Buffer.from(c)) }
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { throw new HulyError(400, 'Invalid JSON') }
}
function ticketChannels(ticket: Ticket, workspace: string): string[] {
  return [...new Set(ticket.channels.filter(c => c.source === 'huly' && c.address.workspace === workspace).map(c => c.address.channelId!).filter(Boolean))]
}
/** Only explicit public message blocks are exposed. System/developer/reasoning and raw tool arguments stay private. */
export function publicEvent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return
  const event = value as { type?: string; seq?: number; time?: number; data?: unknown }
  const data = event.data as { content?: unknown[]; message?: { content?: unknown[] }; source?: { kind?: string }; name?: string; reason?: string } | undefined
  if (event.type === 'tool/call') return { seq: event.seq, time: event.time, role: 'activity', phase: 'tool', text: `正在调用工具 · ${(data?.name ?? '工具').replace(/[^\w.:-]/g, '').slice(0, 80)}` }
  if (event.type === 'turn/start' || event.type === 'assistant/attempt') return { seq: event.seq, time: event.time, role: 'activity', phase: 'analysis', text: 'Worker 正在分析任务' }
  if (event.type === 'turn/end') return { seq: event.seq, time: event.time, role: 'activity', phase: 'idle', text: data?.reason === 'cancelled' ? '当前轮已中断' : '本轮处理已结束，等待后续消息' }
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const content = event.type === 'assistant/message' ? data?.message?.content : data?.content
    let text = content?.flatMap(b => { const block = b as { type?: string; text?: string }; return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [] }).join('\n') ?? ''
    if (!text || event.type === 'user/message' && data?.source?.kind === 'notice') return
    if (event.type === 'user/message') {
      try {
        const message = JSON.parse(text) as { trigger_id?: unknown; thread?: unknown; text?: unknown }
        if (typeof message?.trigger_id === 'string' && typeof message.thread === 'string' && typeof message.text === 'string') text = message.text
      } catch { /* Ordinary conversation is already display text. */ }
    }
    return { seq: event.seq, time: event.time, role: event.type === 'user/message' ? 'user' : 'assistant', text }
  }
  if (event.type === 'tool/result') return { seq: event.seq, time: event.time, role: 'tool', text: '工具调用已返回' }
  return
}
export function publicStreamText(records: readonly unknown[] = []): string {
  return records.flatMap(record => {
    const r = record as { type?: string; texts?: string[]; chunk?: { type?: string; text?: string } }
    if (r.type === 'text-chunks' && Array.isArray(r.texts)) return r.texts.filter(s => typeof s === 'string')
    return r.type === 'chunk' && r.chunk?.type === 'text-delta' && typeof r.chunk.text === 'string' ? [r.chunk.text] : []
  }).join('')
}
export function registerTeamPeppy(ctx: Context, runtime: Runtime, huly: HulyClient, routing = new HulyRouting(runtime, huly)): () => void {
  const d = huly.deployment
  if (!runtime.store.get(statusCutover(d.workspace))) runtime.store.set(statusCutover(d.workspace), new Date().toISOString())
  const allowedChannels = () => runtime.sources.instance<{ channels: string[] }>('huly')?.config.channels ?? []
  const mayRead = (ticket: Ticket, token: string) => mayReadHulyTask(runtime, huly, ticket, token)
  const mayWrite = (ticket: Ticket, account: HulyAccount) => mayWriteHulyTask(huly, ticket, account)
  const task = (ticket: Ticket, canWrite: boolean) => ({ id: ticket.id, title: ticket.title, createdAt: ticket.createdAt,
    state: ticketStage(ticket), ended: ticket.ended, report: ticket.assignments.at(-1)?.report,
    sessionId: ticket.assignments.some(a => a.startedAt) ? workerSessionId(ticket.id) : null,
    sessionStatus: ctx.agents.get(workerSessionId(ticket.id) as SessionId)?.status ?? 'idle',
    sessionName: ticket.title, sessionUrl: huly.dashboardUrl(ticket.id),
    canWrite: canWrite && ticket.ended?.by !== 'human', channels: ticketChannels(ticket, d.workspace),
    sourceUrl: ticket.channels.find(c => c.source === 'huly') ? huly.threadUrl(ticket.channels[0]!.address.channelId!, ticket.channels[0]!.address.rootId!) : null })
  return ctx.webServer.register({ kind: 'prefix', path: '/team-peppy', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname.slice('/team-peppy'.length)
    const origin = req.headers.origin
    if (origin && origin !== d.origin) { json(res, 403, { error: 'Origin refused' }); return }
    if (req.method === 'GET' && (path === '/' || path === '' || path === '/app.js' || path === '/app.css')) {
      const name = path === '/app.js' ? 'app.js' : path === '/app.css' ? 'app.css' : 'index.html'
      const data = readFileSync(fileURLToPath(new URL(`../team-peppy-ui/${name}`, import.meta.url)))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" }); res.end(data); return
    }
    try {
      await runtime.ready
      const token = requestToken(req, d.workspace), account = await huly.account(token)
      if (req.method !== 'GET') {
        const fetchSite = req.headers['sec-fetch-site']
        // Electron's session.fetch forwards the explicit bearer but emits Sec-Fetch-Site: none.
        // Only verified explicit credentials can compensate for both missing origin and same-origin metadata.
        const explicit = req.headers.authorization === `Bearer ${token}`
        const foreign = fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none'
        const requestFromHuly = origin === d.origin || fetchSite === 'same-origin'
          || (explicit && (!fetchSite || fetchSite === 'none'))
        if (!requestFromHuly || foreign || req.headers['x-team-peppy-request'] !== '1') {
          throw new HulyError(403, '无法验证请求，请重试')
        }
      }
      if (path === '/api/status' && req.method === 'GET') { json(res, 200, { workspace: d.workspace, workspaceUrl: d.workspaceUrl, connected: runtime.configured(), account: account.uuid, botPerson: d.botPerson }); return }
      if (path === '/api/route-options' && req.method === 'GET') {
        if (!hulyMayChoose(runtime, account)) { json(res, 200, { canChoose: false, discussions: [], reason: '当前账号未获 Team Peppy 任务发起权限' }); return }
        const roots = runtime.store.read.hulyDiscussionRoots(d.workspace)
        const channels = new Map<string, Promise<string | undefined>>()
        const access = (id: string) => {
          if (!channels.has(id)) channels.set(id, allowedChannels().includes(id)
            ? huly.one(HULY.channel, id, token).then(channel => channel ? String(channel.name ?? '频道') : undefined)
            : Promise.resolve(undefined))
          return channels.get(id)!
        }
        const byThread = new Map<string, Array<{ id: string; title: string; ended: boolean }>>()
        for (const row of runtime.store.tickets.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
          if (!row.assignments.some(a => a.startedAt) || !mayWrite(row, account)) continue
          const sources = hulyTaskSources(runtime, row)
          if (!sources.length || !sources.every(c => c.source === 'huly' && c.address.workspace === d.workspace) ||
            !(await Promise.all(sources.map(c => access(c.address.channelId!)))).every(Boolean)) continue
          for (const thread of new Set(row.channels.map(c => c.thread))) {
            const items = byThread.get(thread) ?? []
            items.push({ id: row.id, title: row.title, ended: !!row.ended })
            byThread.set(thread, items)
          }
        }
        const discussions = []
        for (const root of roots) {
          if (!root.channel) continue
          const channel = await access(root.channel.address.channelId!)
          if (channel) discussions.push({ id: root.id, title: hulyDiscussionTitle(root), channel, sessions: byThread.get(root.channel.thread) ?? [] })
        }
        json(res, 200, { canChoose: true, discussions }); return
      }
      if (path === '/api/route' && req.method === 'POST') {
        const id = z.string().min(1).max(200)
        const value = z.object({ task: id.optional(), discussion: id.optional() }).strict().parse(await body(req))
        json(res, 200, await routing.issue(value, token, account)); return
      }
      const discussion = path.match(/^\/api\/conversations\/([^/]+)$/)
      if (discussion && req.method === 'GET') {
        const input = runtime.store.read.messageTriggers('huly', d.workspace, [decodeURIComponent(discussion[1]!)])[0]
        const channel = input?.channel?.address.channelId
        if (!input || !channel || !allowedChannels().includes(channel) || !await huly.one(HULY.channel, channel, token)) throw new HulyError(404, 'Conversation not found')
        const context = await contextView(runtime, huly, token, undefined, input)
        json(res, 200, { id: `conversation:${input.meta.messageId}`, title: context.title, sessionName: context.title,
          sessionId: null, conversation: true, canWrite: false, state: { stage: 'ended' }, context }); return
      }
      if (path === '/api/message-status' && req.method === 'GET') {
        const ids = z.array(z.string().min(1).max(200)).max(100).parse(url.searchParams.getAll('message'))
        const anchors = new Map<string, string | undefined>()
        const seen = new Set<string>(), channels = new Map<string, boolean>(), items = []
        for (const trigger of runtime.store.read.messageTriggers('huly', d.workspace, [...new Set(ids)])) {
          const messageId = String(trigger.meta.messageId), channel = trigger.channel?.address.channelId
          if (seen.has(messageId) || !channel || !allowedChannels().includes(channel)) continue
          seen.add(messageId)
          if (!channels.has(channel)) channels.set(channel, !!await huly.one(HULY.channel, channel, token))
          if (!channels.get(channel)) continue
          // A status must not disclose another channel's task name or a mixed-source worker.
          const linked = hulyInputState(runtime, d.workspace, trigger).tickets
          if ((await Promise.all(linked.map(t => mayRead(t, token)))).some(ok => !ok)) continue
          const status = hulyMessageStatus(runtime, d.workspace, trigger, anchors)
          if (status) items.push(status)
        }
        json(res, 200, { workspace: d.workspace, items }); return
      }
      if (path === '/api/tasks' && req.method === 'GET') {
        const rows = runtime.store.tickets.list().filter(t => ticketChannels(t, d.workspace).length).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        const visible = []
        for (const row of rows) if (await mayRead(row, token)) visible.push(task(row, mayWrite(row, account)))
        json(res, 200, { items: visible.slice(0, 100) }); return
      }
      const match = path.match(/^\/api\/tasks\/([^/]+)(?:\/(session|messages|cancel|context))?$/)
      const ticket = match && runtime.store.tickets.get(decodeURIComponent(match[1]!))
      if (!ticket || !await mayRead(ticket, token)) throw new HulyError(404, 'Task not found')
      const shown = task(ticket, mayWrite(ticket, account))
      if (!match![2] && req.method === 'GET') { json(res, 200, shown); return }
      if (match![2] === 'context' && req.method === 'GET') { json(res, 200, await contextView(runtime, huly, token, ticket)); return }
      if (!shown.sessionId) throw new HulyError(409, 'Worker session 尚未初始化')
      if (match![2] === 'session' && req.method === 'GET') {
        const stop = new AbortController(); const closed = () => stop.abort(); res.on('close', closed)
        const heartbeat = setInterval(() => { void huly.account(token).then(() => { const current = runtime.store.tickets.get(ticket.id); return current ? mayRead(current, token) : false }).then(ok => {
          if (!ok) stop.abort(); else if (!res.destroyed) {
            const current = runtime.store.tickets.get(ticket.id)
            res.write(`data: ${JSON.stringify({ type: 'status', status: ctx.agents.get(shown.sessionId as SessionId)?.status ?? 'idle', state: current ? ticketStage(current) : { stage: 'ended' } })}\n\n`)
          }
        }).catch(() => stop.abort()) }, 10_000)
        heartbeat.unref()
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        const send = (frame: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`) }
        let announcedActivity = ''
        try {
          for await (const frame of ctx.sessionController.follow({ address: { kind: 'session', sessionId: shown.sessionId as SessionId }, assistantStream: true, maxMessages: 100 }, stop.signal)) {
            if (frame.type === 'snapshot') {
              send({ type: 'snapshot', sessionId: shown.sessionId, cursor: frame.cursor, records: frame.records.flatMap(r => { const e = publicEvent(r.event); return e ? [e] : [] }), streaming: publicStreamText(frame.assistantStream?.activeAttempt?.stream), status: shown.sessionStatus })
            } else if (frame.type === 'event') { const event = publicEvent(frame.event); if (event?.role === 'activity') announcedActivity = String(event.phase); send({ type: 'event', cursor: frame.event.seq, ...(event ? { event } : {}) }) }
            else if (frame.type === 'assistant-stream') {
              const f = frame.frame
              if (f.type === 'chunk') {
                const c = f.chunk as { type?: string; text?: string }
                if (c.type === 'text-delta' && c.text) send({ type: 'delta', text: c.text })
                if (c.type === 'reasoning-delta' && announcedActivity !== 'analysis') { announcedActivity = 'analysis'; send({ type: 'activity', phase: 'analysis', text: 'Worker 正在分析任务' }) }
              }
              if (f.type === 'start' || f.type === 'end') { announcedActivity = ''; send({ type: 'stream', state: f.type }) }
            }
          }
        } finally { clearInterval(heartbeat); stop.abort(); res.off('close', closed); res.end() }
        return
      }
      if (!shown.canWrite) throw new HulyError(403, '当前用户不能接手此任务')
      if (match![2] === 'messages' && req.method === 'POST') {
        const value = Send.parse(await body(req))
        if (value.sessionId !== shown.sessionId) throw new HulyError(409, 'Session 已变化，请刷新')
        // A task-specific input Thread prevents fan-out to other tasks in the same Huly conversation.
        // Engine.attach preserves native Mandate revalidation and resumes completed work in its original worker Session.
        const channel = ticket.channels.find(c => c.source === 'huly')!
        const id = key('huly-dashboard', d.workspace, ticket.id, account.uuid, value.requestId)
        const thread = `dashboard:${d.workspace}:${ticket.id}`
        const trigger: Trigger = { id, source: 'huly', threads: [{ source: 'huly', id: thread }], human: true,
          actor: { source: 'huly', id: account.socialIds[0]! }, at: new Date().toISOString(), text: value.text,
          channel: { ...channel, thread }, meta: { ...channel.address, messageId: id, operator: account.uuid, surface: 'dashboard' } }
        try {
          runtime.store.atomic(() => {
            const previous = runtime.store.triggers.get(id)
            if (previous) { if (previous.text !== value.text) throw new HulyError(409, '请求标识已用于另一条消息'); return }
            const received = runtime.engine.receive(trigger)
            if (received === 'filtered') throw new HulyError(403, '任务来源已停用')
            const delivered = runtime.store.triggers.disposition(id)?.fanout.includes(ticket.id)
            if (!delivered) runtime.engine.attach(ticket.id, id, `Direct input from Huly operator ${account.uuid}`)
          })
          runtime.passes.request()
        } catch (error) { if (error instanceof UserError) throw new HulyError(409, '当前授权无法继续此任务，请返回频道重新发起请求'); throw error }
        json(res, 200, { accepted: true, sessionId: shown.sessionId }); return
      }
      if (match![2] === 'cancel' && req.method === 'POST') {
        const value = Cancel.parse(await body(req))
        if (value.sessionId !== shown.sessionId) throw new HulyError(409, 'Session 已变化，请刷新')
        const receipt = ctx.sessionController.cancel({ sessionId: shown.sessionId as SessionId }); json(res, 200, receipt); return
      }
      throw new HulyError(404, 'Unknown operation')
    } catch (error) {
      if (res.headersSent) { res.end(); return }
      json(res, error instanceof HulyError ? error.status : error instanceof z.ZodError ? 400 : 502,
        { error: error instanceof HulyError ? error.message : error instanceof z.ZodError ? 'Invalid request' : 'DSH 操作未完成，请稍后重试' })
    }
  } })
}
