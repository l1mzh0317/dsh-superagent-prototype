#!/usr/bin/env python3
"""Verify isolated state, authenticated gateways and actual model calls. Run as root."""
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import pwd
import subprocess
import urllib.error
import urllib.request
import yaml

access = json.loads(Path('/etc/dsh-agents/access.json').read_text())
masters = []
for number in [1, 2]:
    item = access[str(number)]
    home = Path(item['home'])
    auth = 'Basic '+base64.b64encode((item['username']+':'+item['password']).encode()).decode()
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))
    def get(url, authenticated=True, origin=None):
        headers = {'x-orchestrator-request': '1'}
        if authenticated: headers['Authorization'] = auth
        if origin: headers['Origin'] = origin
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err: return err.code, err.read()
    assert get(item['url'], False)[0] == 401, 'Gateway must require authentication'
    assert get(item['launchUrl'])[0] == 200, 'Native browser token/cookie exchange failed'
    assert len(list(cookies)) > 0, 'Native browser login did not issue a cookie'
    assert get(item['url'])[0] == 200
    status, body = get(item['url']+'orchestrator/api/state')
    assert status == 200, 'Authenticated management request failed'
    state = json.loads(body)
    masters.append(state['masterId'])
    assert state['health']['runtime']['state'] == 'ready'
    assert state['load']['maxWorkers'] == 1
    assert get(item['url']+'orchestrator/api/state', origin='https://foreign.invalid')[0] == 403
    other = pwd.getpwnam('dsh-agent-'+str(3-number))
    assert subprocess.run(['test', '-r', str(home/'dsh/.credentials.yaml')], user=other.pw_uid, group=other.pw_gid).returncode != 0
    account = pwd.getpwnam('dsh-agent-'+str(number))
    profile = home/'dsh/profiles/model-smoke'
    profile.mkdir(mode=0o700, exist_ok=True)
    (profile/'package.json').write_text(json.dumps({'name': 'dsh-profile-model-smoke', 'private': True, 'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']}}}))
    config = yaml.safe_load((home/'dsh/profiles/superagent/cordis.patch.yml').read_text())
    (profile/'cordis.patch.yml').write_text(yaml.safe_dump([row for row in config if row['id'] in ['agent-default-model', 'llm-pi-ai']], sort_keys=False))
    for path in [profile, profile/'package.json', profile/'cordis.patch.yml']:
        os.chown(path, account.pw_uid, account.pw_gid)
    env = {'HOME': str(home), 'DSH_HOME': str(home/'dsh'), 'PATH': '/usr/local/bin:/usr/bin:/bin', 'NODE_OPTIONS': '--max-old-space-size=640'}
    env.update(yaml.safe_load((home/'dsh/.credentials.yaml').read_text())['refs'])
    marker = 'DSH_AGENT_'+str(number)+'_OK'
    result = subprocess.run(['/usr/local/bin/dsh', '--profile', 'model-smoke', 'Do not use any tools. Reply exactly '+marker+'.'],
                            user=account.pw_uid, group=account.pw_gid, env=env, cwd=home/'workspaces', capture_output=True, timeout=180)
    log = home/'model-smoke.log'
    log.write_bytes(result.stdout+b'\n'+result.stderr); log.chmod(0o600)
    assert result.returncode == 0 and marker.encode() in result.stdout, 'Model smoke failed; inspect private model-smoke.log'
    print(json.dumps({'instance': number, 'authenticatedGateway': True, 'foreignOriginBlocked': True, 'privateState': True, 'modelResponse': True, 'workerLimit': 1}), flush=True)
assert len(set(masters)) == 2, 'Instances must not share the same master/session namespace'
print(json.dumps({'independentMasterIds': True, 'instancesVerified': 2}))
