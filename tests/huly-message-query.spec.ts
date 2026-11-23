import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
it('keeps original intake scoped to exact visible messages and workspace despite later edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'peppy-message-query-')), store = new Store(join(root, 'state.sqlite'))
  try {
    const original = { id: 'original', source: 'huly', at: '2026-11-23', human: true, text: 'request', threads: [], meta: { workspace: 'a', messageId: 'message' } } as unknown as Trigger
    for (const item of [original, { ...original, id: 'edit', human: false }, { ...original, id: 'other-workspace', meta: { workspace: 'b', messageId: 'message' } }, { ...original, id: 'other-message', meta: { workspace: 'a', messageId: 'hidden' } }]) store.triggers.save(item)
    expect(store.read.messageTriggers('huly', 'a', ['message']).map(t => t.id)).toEqual(['original'])
    expect(store.read.messageTriggers('huly', 'a', [])).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
