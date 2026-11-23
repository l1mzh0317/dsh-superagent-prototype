#!/usr/bin/env python3
"""Provision two independent, unbound DSH services on team-peppy-server. Run as root."""
import crypt
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import yaml

# The source container exports some package directories with a restrictive umask.
# This tree contains program files only; instance credentials live elsewhere.
for directory in ['/usr/local/lib/node_modules', '/opt/pop-super-agent']:
    subprocess.run(['chown', '-R', 'root:root', directory], check=True)
    subprocess.run(['chmod', '-R', 'a+rX,go-w', directory], check=True)

ROOT = Path('/etc/dsh-agents')
ROOT.mkdir(mode=0o700, exist_ok=True)
bundle = json.loads(Path('/var/lib/dsh-agents-bootstrap.json').read_text())
access_file = ROOT/'access.json'
access = json.loads(access_file.read_text()) if access_file.exists() else {}
sites = []
for number in [1, 2]:
    user = 'dsh-agent-'+str(number)
    home = Path('/var/lib')/user
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        subprocess.run(['useradd', '--system', '--create-home', '--home-dir', str(home), '--shell', '/usr/sbin/nologin', user], check=True)
        account = pwd.getpwnam(user)
    def own(path, mode):
        os.chown(path, account.pw_uid, account.pw_gid); os.chmod(path, mode)
    home.mkdir(mode=0o700, exist_ok=True); own(home, 0o700)
    for path in [home/'dsh', home/'state', home/'workspaces', home/'dsh/profiles', home/'dsh/profiles/superagent']:
        path.mkdir(mode=0o700, parents=True, exist_ok=True); own(path, 0o700)
    profile = home/'dsh/profiles/superagent'
    port, public_port = 3083+number, 8443+number
    url = f'https://team-peppy-server.tail0ac8b2.ts.net:{public_port}/'
    if not (profile/'package.json').exists():
        (profile/'package.json').write_text(json.dumps(bundle['package'], indent=2))
        config = json.loads(json.dumps(bundle['profile']))
        for row in config:
            if row['id'] == 'webserver': row['config'] = {'host': '127.0.0.1', 'port': port}
            if row['id'] == 'dsh-superagent': row['config']['stateDir'] = str(home/'state/superagent')
            if row['id'] in ['dsh-superagent-huly', 'dsh-superagent-feishu']: row['disabled'] = True
        (profile/'cordis.patch.yml').write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
        modules = profile/'node_modules'; modules.mkdir(mode=0o700)
        (modules/'dsh-superagent').symlink_to('/opt/pop-super-agent')
        for path in [profile/'package.json', profile/'cordis.patch.yml']: own(path, 0o600)
        own(modules, 0o700)
    credentials_file = home/'dsh/.credentials.yaml'
    credentials = yaml.safe_load(credentials_file.read_text()) if credentials_file.exists() else {'version': bundle['credentials']['version'], 'records': {}, 'refs': {}}
    for name, value in bundle['credentials']['refs'].items(): credentials.setdefault('refs', {}).setdefault(name, value)
    credentials_file.write_text(yaml.safe_dump(credentials, sort_keys=False)); own(credentials_file, 0o600)
    log = home/'web.log'; log.touch(exist_ok=True); own(log, 0o600)
    if str(number) not in access:
        password = secrets.token_urlsafe(30)
        access[str(number)] = {'name': f'Peppy {number}', 'url': url, 'username': f'agent{number}', 'password': password,
                               'hash': crypt.crypt(password, crypt.mksalt(crypt.METHOD_BLOWFISH)), 'home': str(home)}
    entry = access[str(number)]
    env = ROOT/f'instance-{number}.env'
    env.write_text(f'DSH_HOME={home}/dsh\nDSH_SUPERAGENT_HULY_ONLY=1\nDSH_PORT={port}\nDSH_PUBLIC_URL={url}\nDSH_AUTHORITY=team-peppy-server.tail0ac8b2.ts.net:{public_port}\nNODE_OPTIONS=--max-old-space-size=640\n')
    env.chmod(0o600)
    sites.append(f'''http://:{8763+number} {{
    bind 127.0.0.1
    route {{
        @foreign {{
            header Origin *
            not header Origin {url.rstrip('/')}
        }}
        respond @foreign 403
        basic_auth {{
            {entry['username']} {entry['hash']}
        }}
        @management path /orchestrator/api/*
        handle @management {{
            reverse_proxy 127.0.0.1:{port} {{
                header_up Host 127.0.0.1:{port}
                header_up -Origin
            }}
        }}
        handle {{
            reverse_proxy 127.0.0.1:{port}
        }}
    }}
}}
''')
access_file.write_text(json.dumps(access, indent=2)); access_file.chmod(0o600)
unit = Path('/etc/systemd/system/dsh-agent@.service')
unit.write_text('''[Unit]
Description=DeepSeek Super-agent %i
After=network-online.target
Wants=network-online.target

[Service]
User=dsh-agent-%i
Group=dsh-agent-%i
WorkingDirectory=/var/lib/dsh-agent-%i/workspaces
Environment=HOME=/var/lib/dsh-agent-%i
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/dsh-agents/instance-%i.env
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile superagent --no-open --public-url ${DSH_PUBLIC_URL} --trusted-host ${DSH_AUTHORITY}
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
KillMode=mixed
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/dsh-agent-%i
MemoryAccounting=yes
MemoryHigh=700M
MemoryMax=1100M
CPUQuota=150%
TasksMax=256
StandardOutput=append:/var/lib/dsh-agent-%i/web.log
StandardError=journal

[Install]
WantedBy=multi-user.target
''')
unit.chmod(0o644)
site = Path('/etc/caddy/dsh-agents.caddy'); site.write_text('\n'.join(sites)); site.chmod(0o640)
os.chown(site, 0, pwd.getpwnam('caddy').pw_gid)
main = Path('/etc/caddy/Caddyfile')
line = 'import /etc/caddy/dsh-agents.caddy'
content = main.read_text()
if line not in content:
    backup = ROOT/'Caddyfile.before-dsh-agents'
    if not backup.exists(): shutil.copy2(main, backup)
    content += '\n'+line+'\n'
candidate = ROOT/'Caddyfile.candidate'
candidate.write_text(content)
subprocess.run(['caddy', 'validate', '--adapter', 'caddyfile', '--config', str(candidate)], check=True, capture_output=True)
main.write_text(content)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'dsh-agent@1', 'dsh-agent@2'], check=True)
print(json.dumps({'provisioned': 2, 'ports': [3084, 3085], 'workerLimitToConfigure': 1, 'sourcesBound': False}))
