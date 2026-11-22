import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const windows: JSDOM[] = []
afterEach(() => { windows.splice(0).forEach(w => w.window.close()) })
async function boot(items: unknown[], query = '?task=task&session=1') {
  const dom = new JSDOM(readFileSync(new URL('../team-peppy-ui/index.html', import.meta.url), 'utf8'), { url: 'https://huly.example/files/ws/team-peppy/'+query, runScripts: 'outside-only' }); windows.push(dom)
  const streams: { url: string; close: ReturnType<typeof vi.fn>; onmessage?: (e: { data: string }) => void }[] = []
  class Events { close = vi.fn(); constructor(readonly url: string) { streams.push(this) } }
  const w = dom.window
  Object.assign(w, { EventSource: Events, fetch: vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('status') ? { connected: true, workspaceUrl: 'pt' } : { items } })), setInterval: vi.fn() })
  w.eval(readFileSync(new URL('../team-peppy-ui/app.js', import.meta.url), 'utf8'))
  await vi.waitFor(() => expect(w.document.getElementById('connection')!.textContent).toBe('已连接 DSH'))
  return { w, streams }
}
const task = (id = 'task', sessionId: string | null = 'worker-task') => ({ id, title: '检查部署', sessionName: '检查部署', sessionId, sessionStatus: 'running', createdAt: '2026-11-23', state: { stage: 'working' }, canWrite: true })
describe('Huly reply-to-session navigation', () => {
  it('opens the exact worker panel from a channel link and preserves it across a page reload', async () => {
    const { w, streams } = await boot([task()])
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    expect(streams[0]!.url).toBe('./api/tasks/task/session')
    expect(w.document.getElementById('session-panel')!.hidden).toBe(false)
    expect(w.document.getElementById('session-state')!.textContent).toBe('worker-task')
    streams[0]!.onmessage?.({ data: JSON.stringify({ type: 'activity', phase: 'analysis', text: 'Worker 正在分析任务' }) })
    expect(w.document.getElementById('session-activity')!.textContent).toBe('Worker 正在分析任务')
    w.dispatchEvent(new w.Event('pagehide'))
    expect(w.location.search).toContain('session=1'); expect(streams[0]!.close).toHaveBeenCalled()
  })
  it('waits for the linked task to allocate a worker, then opens it after refresh', async () => {
    const items = [task('task', null)], { w, streams } = await boot(items)
    expect(streams).toHaveLength(0)
    expect(w.document.getElementById('detail')!.textContent).toContain('等待创建 worker session')
    items[0] = task(); w.document.getElementById('refresh')!.click()
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    expect(w.document.getElementById('session-panel')!.hidden).toBe(false)
  })
  it('does not open another worker when the linked task is absent from the authorized list', async () => {
    const { w, streams } = await boot([task('another')])
    expect(streams).toHaveLength(0)
    expect(w.document.getElementById('detail')!.textContent).toContain('无权访问')
  })
})
