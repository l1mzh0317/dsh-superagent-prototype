const $ = id => document.getElementById(id)
let tasks = [], selected, filter = 'all', stream, generation = 0, streaming = '', poll
const drafts = new Map(), requests = new Map(), records = new Map()
const labels = { working: '进行中', person: '待处理', idle: '等待消息', ended: '已结束' }
const stateText = t => t.ended ? '已结束' : t.state.action === 'queued' ? '排队中' : labels[t.state.stage] || t.state.stage
const element = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n }
async function api(path, data) {
  const res = await fetch(`./api/${path}`, { headers: { 'x-team-peppy-request': '1', ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}), cache: 'no-store' })
  const value = await res.json()
  if (!res.ok) throw Object.assign(new Error(value.error || '请求失败'), { status: res.status })
  return value
}
function feedback(text) { $('session-feedback').textContent = text }
function renderList() {
  const target = $('task-list'); target.replaceChildren()
  const query = $('search').value.toLowerCase()
  const items = tasks.filter(t => (filter === 'all' || (t.ended ? 'ended' : t.state.stage) === filter) && t.title.toLowerCase().includes(query))
  $('count').textContent = String(tasks.length)
  if (!items.length) { target.append(element('p', 'empty', tasks.length ? '没有符合条件的任务' : '还没有任务。在 Huly 频道中 @Team Peppy 开始。')); return }
  for (const t of items) {
    const button = element('button', 'task-row'); button.type = 'button'; button.setAttribute('aria-current', String(selected?.id === t.id))
    button.append(element('span', 'task-title', t.title))
    const meta = element('span', 'task-meta'); meta.append(element('span', `status-dot ${t.ended ? 'ended' : t.state.stage}`), element('span', '', stateText(t)), element('span', '', new Date(t.createdAt).toLocaleDateString('zh-CN')))
    button.append(meta); button.onclick = () => select(t); target.append(button)
  }
}
function detail(t) {
  const root = $('detail'); root.replaceChildren(); root.append(element('span', 'eyebrow', 'HULY · 团队任务'), element('h2', '', t.title))
  const meta = element('div', 'meta'); meta.append(element('span', `status-dot ${t.state.stage}`), element('span', '', stateText(t)))
  if (t.sourceUrl) { const link = element('a', '', '返回原线程 ↗'); link.href = t.sourceUrl; link.target = '_top'; meta.append(link) }
  root.append(meta)
  const report = element('section', 'report'); report.append(element('h3', '', '最新进展'), element('p', '', t.report?.summary || '任务已建立，正在等待 DSH 报告进展。')); root.append(report)
  const open = element('button', 'primary open-session', t.sessionId ? '打开 worker session →' : 'Worker session 正在初始化'); open.disabled = !t.sessionId; open.onclick = () => openSession(t); root.append(open)
}
function select(t) { selected = t; detail(t); renderList(); if (!$('session-panel').hidden || innerWidth < 650) openSession(t) }
function closeSession() { generation++; stream?.close(); stream = undefined; $('session-panel').hidden = true; $('layout').classList.remove('session-open', 'expanded'); $('expand').setAttribute('aria-label', '展开会话') }
function renderMessages() {
  const target = $('messages'), nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100
  const nodes = [...records.values()].sort((a, b) => a.seq - b.seq).map(r => {
    const row = element('article', `message ${r.role}`); const label = element('span', 'message-label', r.role === 'user' ? '输入' : r.role === 'tool' ? '工具' : 'Peppy'); row.append(label, document.createTextNode(r.text)); return row
  })
  if (streaming) nodes.push(element('article', 'message streaming', streaming))
  target.replaceChildren(...nodes)
  if (nearBottom) target.scrollTop = target.scrollHeight
}
function openSession(t) {
  if (!t.sessionId) return
  if (stream && stream.taskId === t.id) return
  generation++; const own = generation; stream?.close(); records.clear(); streaming = ''; renderMessages()
  $('session-panel').hidden = false; $('layout').classList.add('session-open'); $('session-title').textContent = t.title
  $('session-state').textContent = `${t.sessionStatus === 'running' ? '运行中' : '原有 worker session'} · ${t.sessionId.slice(0, 18)}`
  $('prompt').value = drafts.get(t.sessionId) || ''; $('prompt').disabled = !t.canWrite; $('send').disabled = !t.canWrite; $('cancel-turn').disabled = !t.canWrite
  $('input-hint').textContent = t.canWrite ? '直接参与原有会话' : '当前为只读'; feedback('正在连接会话…')
  stream = new EventSource(`./api/tasks/${encodeURIComponent(t.id)}/session`); stream.taskId = t.id
  stream.onmessage = e => {
    if (own !== generation) return
    const f = JSON.parse(e.data)
    if (f.type === 'snapshot') { records.clear(); f.records.forEach(r => records.set(r.seq, r)); streaming = f.streaming || ''; feedback('已连接原有 worker session') }
    else if (f.type === 'event' && f.event) { records.set(f.event.seq, f.event); if (f.event.role === 'assistant') streaming = '' }
    else if (f.type === 'delta') streaming += f.text
    else if (f.type === 'stream') { if (f.state === 'start') streaming = ''; $('session-state').textContent = f.state === 'start' ? '正在回复' : '本轮回复已结束' }
    renderMessages()
  }
  stream.onerror = () => { if (own === generation) feedback('连接中断，正在重新连接；会话继续在服务器运行。') }
}
async function refresh() {
  try {
    const result = await api('tasks'); tasks = result.items; $('connection').textContent = '已连接 DSH'
    if (selected) {
      const current = tasks.find(t => t.id === selected.id)
      if (!current) { closeSession(); selected = undefined; $('detail').replaceChildren(element('p', 'empty', '任务已不可访问，请重新选择。')) }
      else { const changed = current.sessionId !== selected.sessionId; selected = current; detail(current); if (changed && !$('session-panel').hidden) { closeSession(); openSession(current) }
        $('prompt').disabled = !current.canWrite; $('send').disabled = !current.canWrite || requests.get(current.sessionId)?.sending === true; $('cancel-turn').disabled = !current.canWrite }
    }
    renderList()
  } catch (error) { $('connection').textContent = error.message; if (error.status === 401 || error.status === 403) { closeSession(); tasks = []; selected = undefined; renderList(); $('task-list').replaceChildren(element('p', 'empty', '请先在当前浏览器登录 Huly 的 PT 工作区，再刷新此页。')) } }
}
$('search').oninput = renderList
$('filters').onclick = e => { const b = e.target.closest('[data-filter]'); if (!b) return; filter = b.dataset.filter; [...$('filters').children].forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderList() }
$('refresh').onclick = refresh
$('close-session').onclick = closeSession
$('expand').onclick = () => { const full = $('layout').classList.toggle('expanded'); $('expand').setAttribute('aria-label', full ? '还原会话宽度' : '展开会话') }
$('prompt').oninput = () => { if (selected?.sessionId) drafts.set(selected.sessionId, $('prompt').value) }
$('prompt').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit() } }
$('composer').onsubmit = async e => {
  e.preventDefault(); const t = selected, text = $('prompt').value.trim(), own = generation
  if (!t?.canWrite || !text || requests.get(t.sessionId)?.sending) return
  let request = requests.get(t.sessionId); if (!request || request.text !== text) { request = { text, requestId: crypto.randomUUID() }; requests.set(t.sessionId, request) }
  request.sending = true; $('send').disabled = true; feedback('正在提交到 worker…')
  try {
    await api(`tasks/${encodeURIComponent(t.id)}/messages`, { sessionId: t.sessionId, requestId: request.requestId, text, mode: 'steer' })
    requests.delete(t.sessionId); drafts.delete(t.sessionId)
    if (own === generation) { $('prompt').value = ''; feedback('已提交到原会话，等待 worker 读取。') }
  } catch (error) { request.sending = false; if (own === generation) feedback(`${error.message}。可重试本条消息。`) }
  finally { if (own === generation) $('send').disabled = !selected?.canWrite }
}
$('cancel-turn').onclick = async () => {
  const t = selected, own = generation; if (!t?.canWrite) return
  try { await api(`tasks/${encodeURIComponent(t.id)}/cancel`, { sessionId: t.sessionId }); if (own === generation) feedback('已请求中断当前轮，等待 DSH 更新；后台作业状态另行保留。') } catch (error) { if (own === generation) feedback(error.message) }
}
document.addEventListener('visibilitychange', () => { clearInterval(poll); if (!document.hidden) { refresh(); poll = setInterval(refresh, 5000) } })
window.addEventListener('pagehide', closeSession)
api('status').then(s => { $('workspace-link').href = `/workbench/${encodeURIComponent(s.workspaceUrl)}/chunter`; $('connection').textContent = s.connected ? '已连接 DSH' : 'DSH 尚未就绪' }).catch(e => { $('connection').textContent = e.message })
refresh(); poll = setInterval(refresh, 5000)
