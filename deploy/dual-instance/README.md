# Two independent Super-agent services

This deployment targets `team-peppy-server` (4 vCPUs / 4 GB), separately from the Huly host. It shares a read-only installation of Node 24.22.2, DSH 0.2.1-rc.3 and this bundle; each instance has its own OS user, DSH_HOME, SQLite Store, model credential reference file, browser login, sessions and working directory.

`provision.py` consumes a root-only `/var/lib/dsh-agents-bootstrap.json` containing the existing profile/package and **only** the model API-key references it needs. It must never contain another instance's auth records, Huly token, GitHub identity, Store or sessions. The transferred runtime uses its original `/usr/local` and `/opt/pop-super-agent` locations. No Docker daemon is required on this host.

Run provision.py as root after staging the runtime. It creates `dsh-agent@1` and `dsh-agent@2`, loopback listeners 3084/3085, and Caddy gateways 8764/8765. Configure Tailscale Serve HTTPS 8444/8445 to those respective gateways, then run configure.py to set **one worker per instance**, disable unbound Sources, and write the private access note. A memory ceiling of 1100 MB and CPU ceiling of 1.5 cores per service include worker subprocesses; large compilations may exceed these limits.

The native DSH operator token/cookie remains enabled. Separate gateway accounts protect the entire site, including Superagent's management API. The gateway refuses foreign browser Origins before translating the management API's loopback Host. The normal DSH API retains the explicitly trusted public authority. Neither the native operator-auth fence nor the management CSRF fence is disabled. Access details are root-only in `/etc/dsh-agents/access.md`; do not log or commit them.

These instances start **unbound**, using the fork's explicit `DSH_SUPERAGENT_HULY_ONLY=1` mode to allow startup without inventing a GitHub identity. The optional Huly plugin is disabled too. They are not additional PT bots. Binding a Huly workspace requires its own service member and configuration; binding GitHub requires a scoped agent identity and switching back to the normal GitHub deployment mode. Model connectivity and standby runtime readiness do not mean channel automation has been enabled.

Logs containing initial operator launch URLs stay in each private `/var/lib/dsh-agent-N/web.log`. Re-run configure.py after a restart to refresh the root-only launch links; native browser cookies survive a process restart. Instance data can be backed up independently. Stop only the selected `dsh-agent@N` unit for maintenance, and preserve its home. The existing update compatibility proxy, Caddy downloads and other services are separate.

Run `verify.py` as root after configuration. It checks authentication and the native launch-token exchange through the real HTTPS gateways, rejects foreign Origins, verifies independent master IDs and OS file permissions, then makes a small real model request from each instance's own DSH home. The smoke profiles are separate from the running Superagent profiles. Its output contains only verification results; private model diagnostics remain under the respective instance home.

Before adding HTTPS listeners, preserve `tailscale serve status --json`, then add listeners without resetting the existing 443 service:

```sh
sudo tailscale serve --bg --https=8444 http://127.0.0.1:8764
sudo tailscale serve --bg --https=8445 http://127.0.0.1:8765
```

These are Tailnet-only endpoints. Each service is managed with `systemctl status dsh-agent@1` or `dsh-agent@2`. Deployment scripts and shared runtime files should be owned by root. Remove the temporary bootstrap JSON after successful configuration; keep the actual instance credential files and private access note.

Validated on 2026-11-23: both units were enabled and ready, each with a distinct master ID and one-worker limit. Both returned real model replies, issued native login cookies through their HTTPS gateways, rejected the other instance's gateway account and foreign browser Origins, and kept the management request-marker check. Installed Sources were disabled. Idle memory was approximately 300 MB per unit, leaving approximately 2.5 GB available on the host. Existing Caddy/update services and all pre-existing Tailscale Serve routes were preserved.
