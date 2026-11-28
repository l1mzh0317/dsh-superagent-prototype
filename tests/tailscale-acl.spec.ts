import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HulyError } from '../src/sources/huly-client.ts'
import { tailscalePolicyFromEnv, type InstancePolicy } from '../src/team-peppy/tailscale-acl.ts'

const alice = 'alice@example.test'
const bob = 'bob@example.test'
const dest = '100.70.0.9:443'
const rule = { src: [alice, bob], dst: ['100.70.0.9'], ip: ['tcp:443'] }
const accept = (src: string, ...accept: string[]) => ({ src, proto: 'tcp' as const, accept })
const update: InstancePolicy = { grants: [rule], tests: [accept(alice, dest), accept(bob, dest)] }
const empty: InstancePolicy = { grants: [], tests: [] }
const endpoint = 'https://api.tailscale.com/api/v2/tailnet/-/acl'
const keyEnv = { TAILSCALE_API_KEY: 'test-api-key' }

afterEach(() => vi.restoreAllMocks())

describe('Tailscale policy sync', () => {
  it('reads an OAuth secret file, exchanges it for policy scope, and refreshes 60 seconds before expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailscale-acl-'))
    try {
      const secretFile = join(dir, 'secret')
      writeFileSync(secretFile, 'test+secret\n')
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
      const base = 'https://tailscale.example'
      let exchanges = 0
      const request = vi.fn<typeof fetch>(async (url, init) => {
        if (url === base + '/api/v2/oauth/token') {
          expect(init?.method).toBe('POST')
          expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
          expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
            grant_type: 'client_credentials', scope: 'policy_file', client_id: 'test-id', client_secret: 'test+secret',
          })
          return Response.json({ access_token: 'test-token-' + ++exchanges, expires_in: 120 })
        }
        expect(url).toBe(base + '/api/v2/tailnet/team%2Ftailnet/acl')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token-' + exchanges)
        return Response.json({})
      })
      const sync = tailscalePolicyFromEnv({
        ...keyEnv, TAILSCALE_OAUTH_CLIENT_ID: 'test-id', TAILSCALE_OAUTH_CLIENT_SECRET_FILE: secretFile,
        TAILSCALE_API_BASE: base + '/', TAILSCALE_TAILNET: 'team/tailnet',
      }, request)!
      await sync.apply(update)
      now.mockReturnValue(60_999)
      await sync.apply(update)
      expect(exchanges).toBe(1)
      now.mockReturnValue(61_000)
      await sync.apply(update)
      expect(exchanges).toBe(2)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('supports an API key file and treats incomplete or missing credentials as unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailscale-key-'))
    try {
      const file = join(dir, 'key')
      expect(tailscalePolicyFromEnv({ TAILSCALE_OAUTH_CLIENT_ID: 'only-id', TAILSCALE_API_KEY_FILE: file })).toBeUndefined()
      writeFileSync(file, 'file-api-key\n')
      const request = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe(endpoint)
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer file-api-key')
        expect(new Headers(init?.headers).has('if-match')).toBe(false)
        return Response.json({})
      })
      await tailscalePolicyFromEnv({ TAILSCALE_API_KEY_FILE: file }, request)!.apply(update)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('sends the ETag and rereads the latest policy for each of two 412 retries', async () => {
    let revision = 0
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(endpoint)
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer test-api-key')
      expect(headers.get('accept')).toBe('application/json')
      if (init?.method === 'GET') return Response.json({ hosts: { revision: ++revision } }, { headers: { ETag: `"${revision}"` } })
      expect(init?.method).toBe('POST')
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('if-match')).toBe(`"${revision}"`)
      expect(JSON.parse(String(init?.body))).toEqual({ hosts: { revision }, ...update })
      return new Response(null, { status: revision < 3 ? 412 : 204 })
    })
    await tailscalePolicyFromEnv(keyEnv, request)!.apply(update)
    expect(request).toHaveBeenCalledTimes(6)
  })

  it('only changes matching rules and TCP tests, preserving separately retained grants and accept pairs', async () => {
    const unrelatedRule = { ...rule, via: ['tag:router'] }
    const unrelatedTest = { src: alice, proto: 'udp', deny: [dest] }
    const otherDest = '100.70.0.10:22'
    const topLevel = {
      acls: [{ action: 'accept', src: ['tag:legacy'], dst: ['*:22'] }],
      groups: { 'group:dev': [alice] }, hosts: { build: '100.70.0.9' },
      tagOwners: { 'tag:legacy': [bob] }, ssh: [], custom: { active: true },
    }
    const existing = { ...rule, src: [bob, alice, bob] }
    let current: Record<string, unknown> = {
      ...topLevel,
      grants: [unrelatedRule, existing, rule],
      tests: [unrelatedTest, { src: alice, deny: [dest, otherDest] }, accept(alice, dest, otherDest),
        accept(alice, dest), { src: bob, proto: 'tcp', deny: [dest] }],
    }
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'GET') return Response.json(current)
      current = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    })
    const sync = tailscalePolicyFromEnv(keyEnv, request)!
    await sync.apply({ grants: [rule], tests: [...update.tests, accept(bob, dest)] })
    const appliedTests = [unrelatedTest, { src: alice, deny: [otherDest] }, accept(alice, dest, otherDest), accept(bob, dest)]
    expect(current).toEqual({ ...topLevel, grants: [unrelatedRule, existing], tests: appliedTests })
    await sync.remove(update, { grants: [rule], tests: [accept(bob, dest)] })
    const remainingTests = [unrelatedTest, { src: alice, deny: [otherDest] }, accept(alice, otherDest)]
    expect(current).toEqual({ ...topLevel, grants: [unrelatedRule, existing], tests: [...remainingTests, accept(bob, dest)] })
    await sync.remove(update, empty)
    expect(current).toEqual({ ...topLevel, grants: [unrelatedRule], tests: remainingTests })
  })

  it('serializes concurrent writes across the entire GET and POST sequence', async () => {
    let current = {}
    const methods: string[] = []
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      methods.push(init!.method!)
      if (init?.method === 'GET') return Response.json(current)
      current = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    })
    const sync = tailscalePolicyFromEnv(keyEnv, request)!
    const second = { ...rule, ip: ['tcp:22'] }
    await Promise.all([sync.apply(update), sync.apply({ grants: [second], tests: [] })])
    expect(methods).toEqual(['GET', 'POST', 'GET', 'POST'])
    expect(current).toMatchObject({ grants: [rule, second] })
  })

  it('sanitizes upstream HTTP, network and response parsing failures and keeps the queue usable', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('test-api-key upstream secret', { status: 403 }))
      .mockRejectedValueOnce(new HulyError(502, 'test-api-key upstream secret'))
      .mockResolvedValueOnce(new Response('test-api-key upstream secret'))
      .mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({}) : new Response('test-api-key', { status: 412 }))
    const sync = tailscalePolicyFromEnv(keyEnv, request)!
    await expect(sync.apply(update)).rejects.toMatchObject({ status: 502, message: 'Tailscale 策略读取失败（HTTP 403）' })
    for (let i = 0; i < 2; i++) {
      await expect(sync.apply(update)).rejects.toMatchObject({ status: 502, message: 'Tailscale 策略同步失败' })
    }
    await expect(sync.apply(update)).rejects.toMatchObject({ status: 502, message: 'Tailscale 策略更新失败（HTTP 412）' })
    expect(request).toHaveBeenCalledTimes(9)
  })
})
