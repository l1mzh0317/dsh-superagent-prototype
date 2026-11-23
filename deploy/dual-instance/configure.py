#!/usr/bin/env python3
"""Initialize native limits without copying another deployment's Store, sessions, identities or browser login."""
import json
from pathlib import Path
import re
import time
import urllib.request

root = Path('/etc/dsh-agents')
access = json.loads((root/'access.json').read_text())
for number in [1, 2]:
    port = 3083+number
    base = f'http://127.0.0.1:{port}/orchestrator/api/'
    def api(path, data=None, method=None):
        req = urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None,
                                     headers={'Host': f'127.0.0.1:{port}', 'x-orchestrator-request': '1', 'Content-Type': 'application/json'}, method=method)
        with urllib.request.urlopen(req, timeout=15) as res: return json.load(res)
    for _ in range(90):
        try:
            settings = api('settings')
            if any(s['id']=='github' for s in settings['sources']): break
        except Exception: pass
        time.sleep(1)
    else: raise RuntimeError(f'Instance {number} failed startup')
    home = Path(access[str(number)]['home'])
    if not (home/'.initialized').exists():
        for block, value in [('source:github', {'enabled': False, 'config': {'repository': '', 'cli': ''}}),
                             ('eval', {**settings['blocks']['eval']['value'], 'mode': 'off'}),
                             ('executor', {**settings['blocks']['executor']['value'], 'maxWorkers': 1, 'prepare': '', 'directory': str(home/'workspaces/tickets')})]:
            current = next(s for s in settings['sources'] if s['id']=='github') if block.startswith('source:') else settings['blocks'][block]
            api('settings/'+block, {'revision': current['revision'], 'value': value}, 'PUT')
            settings = api('settings')
        (home/'.initialized').touch()
    for _ in range(30):
        urls = re.findall(r'dsh web: (https?://\S+)', (home/'web.log').read_text())
        if urls: break
        time.sleep(1)
    else: raise RuntimeError('No authenticated launch URL was recorded')
    access[str(number)]['launchUrl'] = urls[-1]
    state = api('state')
    print(json.dumps({'instance': number, 'runtime': state['health']['runtime']['state'], 'masterId': state['masterId'], 'workerLimit': settings['blocks']['executor']['value']['maxWorkers']}))
(root/'access.json').write_text(json.dumps(access, indent=2))
note = '# DSH 服务访问说明\n\n此文件包含管理员口令和首次登录链接，请勿转发或提交到 Git。启动链接在服务重启后会变化，已登录的浏览器使用独立持久 Cookie。\n\n'
for number, item in access.items():
    note += f"## {item['name']}\n\n入口：{item['url']}\n\n网关账号：`{item['username']}`\n\n网关口令：`{item['password']}`\n\n首次登录：{item['launchUrl']}\n\n"
p=root/'access.md';p.write_text(note);p.chmod(0o600)
