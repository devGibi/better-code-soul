import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectCommandDetector } from '../src/services/ProjectCommandDetector'

describe('ProjectCommandDetector', () => {
  const created: string[] = []

  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempProject(packageJson: object, files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-detector-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8')
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content, 'utf-8')
    }
    return dir
  }

  it('detects npm scripts and prefers non-watch test command', () => {
    const dir = tempProject({
      scripts: {
        build: 'tsup',
        test: 'vitest',
        'test:run': 'vitest run',
        lint: 'tsc --noEmit',
      },
    }, { 'package-lock.json': '{}' })

    const profile = new ProjectCommandDetector().detect(dir)

    expect(profile.primary?.ecosystem).toBe('node')
    expect(profile.primary?.packageManager).toBe('npm')
    expect(profile.primary?.commands.build?.display).toBe('npm run build')
    expect(profile.primary?.commands.testRun?.display).toBe('npm run test:run')
    expect(profile.primary?.commands.lint?.display).toBe('npm run lint')
    expect(profile.primary?.commands.typecheck?.script).toBe('lint')
  })

  it('uses packageManager field before lockfiles', () => {
    const dir = tempProject({
      packageManager: 'pnpm@9.0.0',
      scripts: { build: 'vite build' },
    }, { 'package-lock.json': '{}' })

    const profile = new ProjectCommandDetector().detect(dir)

    expect(profile.primary?.packageManager).toBe('pnpm')
    expect(profile.primary?.commands.build?.display).toBe('pnpm run build')
  })

  it('returns unknown when no project files are present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-detector-empty-'))
    created.push(dir)

    const profile = new ProjectCommandDetector().detect(dir)

    expect(profile.primary?.ecosystem).toBe('unknown')
    expect(profile.primary?.confidence).toBe(0)
  })
})
