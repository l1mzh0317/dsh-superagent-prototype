import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Setup } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { workerBin } from '../src/infra/environment.ts'
import { testMachine } from './fixtures/deployment.ts'

describe('Explicit Huly-only deployment', () => {
  it('starts with no GitHub account and makes GitHub operations fail honestly', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'huly-only-'))
    const spawn = vi.fn()
    vi.stubEnv('DSH_SUPERAGENT_HULY_ONLY', '1')
    const setup = new Setup({ machine: testMachine({ stateDir }), context: { subprocess: { spawn }, logger: { warn: vi.fn() } } as unknown as Context,
      lifetime: new AbortController().signal, restart: vi.fn() })
    try {
      expect(await setup.run(SettingsSchema.parse({}))).toBe(true)
      expect(setup.deployment.github).toBeUndefined()
      expect(setup.deployment.repository).toBe('')
      expect(spawn).not.toHaveBeenCalled()
      expect(readFileSync(join(workerBin(stateDir), 'gh'), 'utf8')).toContain('GitHub is not connected')
      const commands = new Commands(() => setup.deployment, {}, new AbortController().signal)
      await expect(commands.gh(['api', 'user'])).rejects.toThrow('GitHub is not connected')
    } finally { setup.restore(); vi.unstubAllEnvs(); rmSync(stateDir, { recursive: true, force: true }) }
  })
})
