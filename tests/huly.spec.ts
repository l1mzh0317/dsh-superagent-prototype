import { describe, expect, it, vi } from 'vitest'
import { HulyClient, HULY, readMarkup, textMarkup, type HulyDeployment, type HulyDoc } from '../src/sources/huly-client.ts'
import { hulyTrigger, pollHuly } from '../src/sources/huly.ts'
import { publicEvent, requestToken } from '../src/team-peppy/http.ts'
import type { SourceContext } from '../src/sources/host.ts'

const d: HulyDeployment = { workspace: 'workspace-a', workspaceUrl: 'pt', origin: 'https://huly.example', endpoint: 'http://transactor:3333',
  tokenFile: '/unused', botPerson: 'bot-person', botSocial: 'bot-social', botAccount: 'bot-account', channels: ['channel'], operators: ['owner'] }
const mention = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'reference', attrs: { id: 'bot-person', objectclass: HULY.person, label: 'Team Peppy' } }, { type: 'text', text: ' 请检查这个问题' }] }] })
const message = (overrides: Partial<HulyDoc> = {}): HulyDoc => ({ _id: 'root', _class: HULY.message, space: 'channel', createdOn: 1000, modifiedOn: 1000,
  modifiedBy: 'alice', createdBy: 'alice', message: mention, ...overrides })

describe('Huly Source', () => {
  it('recognizes typed Person mentions and preserves thread identity across follow-ups', () => {
    const root = hulyTrigger(message(), d, 'channel')!
    expect(root.addressed).toBe('mention')
    const reply = hulyTrigger(message({ _id: 'reply', _class: HULY.reply, attachedTo: 'root', message: textMarkup('补充信息') }), d, 'channel')!
    expect(reply.threads).toEqual(root.threads)
    expect(reply.channel?.address.rootId).toBe('root')
    expect(reply.addressed).toBeUndefined()
    expect(hulyTrigger(message({ createdBy: 'bot-social' }), d, 'channel')).toBeUndefined()
  })
  it('does not interpret plain text mentions or references to another class as authority', () => {
    expect(readMarkup(textMarkup('@Team Peppy')).mentions).toEqual([])
    expect(readMarkup(mention.replace(HULY.person, 'tracker:class:Issue')).mentions).toEqual([])
    const edited = hulyTrigger(message({ editedOn: 2000, modifiedOn: 2000 }), d, 'channel')!
    expect(edited.addressed).toBeUndefined()
    expect(edited.id).not.toBe(hulyTrigger(message(), d, 'channel')!.id)
    expect(hulyTrigger(message({ modifiedOn: 3000 }), d, 'channel')!.id).toBe(hulyTrigger(message(), d, 'channel')!.id)
  })
  it('retains the read cursor when ingestion fails, allowing replay', async () => {
    const state = new Map<string, unknown>(), receive = vi.fn().mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue({ stored: true })
    const host = { state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) }, receive,
      threads: { get: () => undefined } } as unknown as SourceContext
    const client = { deployment: d, find: vi.fn().mockImplementation((_, q) => typeof q.modifiedOn === 'number' ? [] : [message({ modifiedOn: 5000 })]) } as unknown as HulyClient
    state.set('huly:cursor:workspace-a', { time: 4000, id: '' })
    const config = { workspace: d.workspace, channels: d.channels, pollMs: 2000 }
    await expect(pollHuly(host, client, config)).rejects.toThrow('interrupted')
    expect(state.get('huly:cursor:workspace-a')).toEqual({ time: 4000, id: '' })
    await pollHuly(host, client, config)
    expect(state.get('huly:cursor:workspace-a')).toEqual({ time: 5000, id: 'root' })
    expect(receive.mock.calls[0]![0].id).toBe(receive.mock.calls[1]![0].id)
  })
  it('ignores old history on activation, then accepts unmentioned subscribed replies', async () => {
    const state = new Map<string, unknown>(), receive = vi.fn()
    const host = { state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) }, receive,
      threads: { get: () => ({ subscriptions: ['task'] }) } } as unknown as SourceContext
    const find = vi.fn().mockImplementation((_, q) => typeof q.modifiedOn === 'number' ? [] : [message({ _id: 'followup', message: textMarkup('继续'), modifiedOn: Date.now() + 1 })])
    const client = { deployment: d, find } as unknown as HulyClient
    const config = { workspace: d.workspace, channels: d.channels, pollMs: 2000 }
    await pollHuly(host, client, config); expect(find).not.toHaveBeenCalled()
    await pollHuly(host, client, config); expect(receive).toHaveBeenCalledOnce()
  })
  it('reconciles a successful reply after a lost HTTP receipt instead of creating another message', async () => {
    const client = new HulyClient(d)
    vi.spyOn(client, 'one').mockResolvedValue(message({ _id: 'existing' }))
    const tx = vi.spyOn(client, 'api')
    await expect(client.reply('root', 'channel', 'receipt', 'answer')).resolves.toBe('sent')
    expect(tx).not.toHaveBeenCalled()
  })
})
describe('Team Peppy presentation boundaries', () => {
  it('rejects another workspace before any Session lookup', () => {
    const token = `header.${Buffer.from(JSON.stringify({ workspace: 'workspace-b' })).toString('base64url')}.signature`
    expect(() => requestToken({ headers: { authorization: `Bearer ${token}` } }, d.workspace)).toThrow('工作区')
  })
  it('omits internal prompts and reasoning while retaining visible conversation text', () => {
    expect(publicEvent({ type: 'system/message', seq: 1, data: { content: [{ type: 'text', text: 'secret' }] } })).toBeUndefined()
    expect(publicEvent({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'public' }] } } })).toMatchObject({ role: 'assistant', text: 'public' })
    expect(publicEvent({ type: 'tool/result', seq: 3, data: { content: [{ type: 'text', text: 'credential' }] } })).not.toHaveProperty('text', 'credential')
  })
})
