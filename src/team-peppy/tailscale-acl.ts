import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { HulyError } from '../sources/huly-client.ts'

export interface PolicyGrant { src: string[]; dst: string[]; ip: string[] }
export interface PolicyAccept { src: string; proto: 'tcp'; accept: string[] }
export interface InstancePolicy { grants: PolicyGrant[]; tests: PolicyAccept[] }
export interface PolicySync {
  apply(policy: InstancePolicy): Promise<void>
  remove(policy: InstancePolicy, keep: InstancePolicy): Promise<void>
}

/** Serializes writes and lets subsequent operations proceed after a failure. */
export class PolicyWriteQueue {
  private tail = Promise.resolve()

  run<T>(write: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(write)
    this.tail = result.then(() => {}, () => {})
    return result
  }
}

/** An error built from an operation name and HTTP status without upstream response content. */
class PolicyResponseError extends HulyError {}

const rule = z.looseObject({})
const document = z.looseObject({ grants: z.array(rule).optional(), tests: z.array(rule).optional() })
const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function canonicalGrant({ src, dst, ip }: PolicyGrant): string {
  return JSON.stringify([src, dst, ip].map(values => [...new Set(values)].sort()))
}

function grantKey(grant: Record<string, unknown>): string | undefined {
  const { src, dst, ip, ...extra } = grant
  // Rules with additional constraints or application capabilities are independent of Instances grants.
  if (Object.keys(extra).length || !strings(src) || !strings(dst) || !strings(ip)) return
  return canonicalGrant({ src, dst, ip })
}

function acceptSets(tests: PolicyAccept[]): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>()
  for (const { src, accept } of tests) {
    const destinations = bySource.get(src) ?? new Set<string>()
    for (const destination of accept) destinations.add(destination)
    bySource.set(src, destinations)
  }
  return bySource
}

function patchPolicy(current: z.infer<typeof document>, change: InstancePolicy, keep?: InstancePolicy): void {
  const grantKeys = new Set(change.grants.map(canonicalGrant))
  const keptKeys = new Set(keep?.grants.map(canonicalGrant))
  const seenGrants = new Set<string>()
  const grants = (current.grants ?? []).filter(grant => {
    const key = grantKey(grant)
    if (key === undefined || !grantKeys.has(key)) return true
    if (keep) return keptKeys.has(key)
    if (seenGrants.has(key)) return false
    seenGrants.add(key)
    return true
  })
  if (!keep) {
    for (const grant of change.grants) {
      const key = canonicalGrant(grant)
      if (seenGrants.has(key)) continue
      seenGrants.add(key)
      grants.push({ ...grant })
    }
  }
  if (current.grants || grants.length) current.grants = grants

  const targets = acceptSets(change.tests)
  const kept = acceptSets(keep?.tests ?? [])
  const remaining = acceptSets(change.tests)
  const tests = (current.tests ?? []).flatMap(test => {
    if (typeof test.src !== 'string' || (test.proto !== undefined && test.proto !== 'tcp')) return [test]
    const affected = targets.get(test.src)
    if (!affected) return [test]
    const retain = kept.get(test.src)
    const missing = remaining.get(test.src)!
    const next = { ...test }
    const fields = keep ? ['accept'] as const : ['accept', 'deny'] as const
    for (const field of fields) {
      const destinations = test[field]
      if (!strings(destinations)) continue
      const filtered = destinations.filter(dest => {
        if (!affected.has(dest)) return true
        if (keep) return retain?.has(dest)
        return field === 'accept' && missing.delete(dest)
      })
      if (filtered.length === destinations.length) continue
      if (filtered.length) next[field] = filtered
      else delete next[field]
    }
    return next.accept === undefined && next.deny === undefined && (test.accept !== undefined || test.deny !== undefined)
      ? [] : [next]
  })
  if (!keep) {
    for (const [src, destinations] of remaining) {
      if (destinations.size) tests.push({ src, proto: 'tcp', accept: [...destinations] })
    }
  }
  if (current.tests || tests.length) current.tests = tests
}

function credential(value: string | undefined, file: string | undefined): string | undefined {
  if (value?.trim()) return value.trim()
  if (!file) return
  try { return readFileSync(file, 'utf8').trim() || undefined }
  catch { return undefined }
}

export function tailscalePolicyFromEnv(env = process.env, request = fetch): PolicySync | undefined {
  const clientId = env.TAILSCALE_OAUTH_CLIENT_ID?.trim()
  const clientSecret = clientId && credential(env.TAILSCALE_OAUTH_CLIENT_SECRET, env.TAILSCALE_OAUTH_CLIENT_SECRET_FILE)
  const apiKey = credential(env.TAILSCALE_API_KEY, env.TAILSCALE_API_KEY_FILE)
  if (!clientSecret && !apiKey) return

  const base = (env.TAILSCALE_API_BASE || 'https://api.tailscale.com').replace(/\/+$/, '')
  const endpoint = `${base}/api/v2/tailnet/${encodeURIComponent(env.TAILSCALE_TAILNET || '-')}/acl`
  const queue = new PolicyWriteQueue()
  let cached: { token: string; refreshAt: number } | undefined

  const send = (url: string, init: RequestInit) => request(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
  })
  const failure = (operation: string, status: number) => new PolicyResponseError(502, `Tailscale ${operation}失败（HTTP ${status}）`)
  async function bearer(): Promise<string> {
    if (!clientSecret) return apiKey!
    if (cached && Date.now() < cached.refreshAt) return cached.token
    const startedAt = Date.now()
    const response = await send(`${base}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', scope: 'policy_file', client_id: clientId!, client_secret: clientSecret,
      }),
    })
    if (!response.ok) throw failure('OAuth 授权', response.status)
    const { access_token: token, expires_in: expiresIn } = tokenResponse.parse(await response.json())
    cached = { token, refreshAt: startedAt + (expiresIn - 60) * 1000 }
    return token
  }

  const write = (change: InstancePolicy, keep?: InstancePolicy) => queue.run(async () => {
    try {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${await bearer()}` }
      for (let retries = 0; ; retries++) {
        const response = await send(endpoint, { method: 'GET', headers })
        if (!response.ok) throw failure('策略读取', response.status)
        const etag = response.headers.get('etag')
        const current = document.parse(await response.json())
        patchPolicy(current, change, keep)
        const saved = await send(endpoint, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
          body: JSON.stringify(current),
        })
        if (saved.ok) return
        if (saved.status !== 412 || retries >= 2) throw failure('策略更新', saved.status)
      }
    } catch (error) {
      // Fetch errors, upstream response bodies, and validation errors can contain credentials.
      if (error instanceof PolicyResponseError) throw error
      throw new HulyError(502, 'Tailscale 策略同步失败')
    }
  })
  return { apply: change => write(change), remove: (change, keep) => write(change, keep) }
}
