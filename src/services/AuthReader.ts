import fs from 'node:fs'
import { runCommand } from '../utils/spawn.js'
import { paths } from '../utils/platform.js'
import { logger } from '../utils/logger.js'

export interface AuthProvider {
  name: string
  connected: boolean
  method: 'oauth' | 'apikey' | 'unknown'
  status?: 'connected' | 'configured' | 'error' | 'unknown'
  source?: 'opencode-auth' | 'opencode-config' | 'environment' | 'catalog'
  email?: string
  plan?: string
  models?: string[]
  error?: string
}

const CACHE_TTL_MS = 30_000

const KNOWN_PROVIDERS: Array<{ name: string; env: string[] }> = [
  { name: 'anthropic', env: ['ANTHROPIC_API_KEY'] },
  { name: 'openai', env: ['OPENAI_API_KEY'] },
  { name: 'google', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  { name: 'deepseek', env: ['DEEPSEEK_API_KEY'] },
  { name: 'moonshot', env: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { name: 'zhipu', env: ['ZHIPU_API_KEY', 'GLM_API_KEY'] },
  { name: 'minimax', env: ['MINIMAX_API_KEY'] },
]

export class AuthReader {
  private cachedProviders: AuthProvider[] | null = null
  private cachedAt = 0
  private lastErrors: string[] = []

  async getProviders(forceRefresh = false): Promise<AuthProvider[]> {
    if (!forceRefresh && this.cachedProviders && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedProviders
    }

    const providers = await this.readProviders()
    this.cachedProviders = providers
    this.cachedAt = Date.now()
    return providers
  }

  getLastErrors(): string[] {
    return [...this.lastErrors]
  }

  async getConnectedModels(): Promise<string[]> {
    const providers = await this.getProviders()
    const models: string[] = []
    for (const p of providers) {
      if (p.connected && p.models) {
        models.push(...p.models)
      }
    }
    return models
  }

  private async readProviders(): Promise<AuthProvider[]> {
    this.lastErrors = []
    const fromCommand = await this.tryCommand()
    const fromConfig = this.tryConfigFile()
    const fromEnv = this.tryEnvironment()
    const providers = this.mergeProviders([...fromCommand, ...fromConfig, ...fromEnv])

    if (providers.length === 0) {
      logger.warn('Could not read auth providers from any source')
    }

    return this.addKnownProviderPlaceholders(providers)
  }

  private async tryCommand(): Promise<AuthProvider[]> {
    try {
      const result = await runCommand('opencode', ['auth', 'status', '--json'], { timeout: 5000 })
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return await this.tryAuthListCommand(result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`)
      }

      const data = JSON.parse(result.stdout)
      const providers: AuthProvider[] = []

      if (Array.isArray(data.providers)) {
        for (const p of data.providers) {
          providers.push(this.normalizeProvider(p.name || p.provider || 'unknown', p, 'opencode-auth'))
        }
      } else if (data && typeof data === 'object') {
        const providerMap = (data.providers && typeof data.providers === 'object') ? data.providers : data
        for (const [name, info] of Object.entries(providerMap)) {
          if (typeof info === 'object' && info !== null) providers.push(this.normalizeProvider(name, info as Record<string, unknown>, 'opencode-auth'))
        }
      }

      return providers
    } catch (err) {
      return await this.tryAuthListCommand(String(err))
    }
  }

  private async tryAuthListCommand(statusError: string): Promise<AuthProvider[]> {
    try {
      const result = await runCommand('opencode', ['auth', 'list'], { timeout: 5000 })
      if (result.exitCode !== 0) {
        this.lastErrors.push(`opencode auth check failed: ${statusError}; auth list: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
        return []
      }
      return this.parseAuthList(result.stdout)
    } catch (err) {
      this.lastErrors.push(`opencode auth check failed: ${statusError}; auth list: ${String(err)}`)
      return []
    }
  }

  private parseAuthList(output: string): AuthProvider[] {
    const clean = output.replace(/\x1B\[[0-9;]*m/g, '')
    const providers: AuthProvider[] = []
    let section: 'credentials' | 'environment' | null = null

    for (const rawLine of clean.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.includes('Credentials')) {
        section = 'credentials'
        continue
      }
      if (line.includes('Environment')) {
        section = 'environment'
        continue
      }

      const match = line.match(/^.*•\s+(.+?)\s+([A-Za-z0-9_]+)$/)
      if (!match || !section) continue

      const name = this.normalizeProviderName(match[1])
      const marker = match[2]
      if (section === 'credentials') {
        providers.push({
          name,
          connected: true,
          status: 'connected',
          source: 'opencode-auth',
          method: marker.toLowerCase() === 'oauth' ? 'oauth' : 'apikey',
        })
      } else {
        providers.push({
          name,
          connected: true,
          status: 'configured',
          source: 'environment',
          method: 'apikey',
          plan: `env:${marker}`,
        })
      }
    }

    return providers
  }

  private tryConfigFile(): AuthProvider[] {
    try {
      const configPath = paths.opencodeConfig()
      if (!fs.existsSync(configPath)) return []

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const providers: AuthProvider[] = []
      const authData = config.provider || config.providers || config.auth || {}

      for (const [name, info] of Object.entries(authData)) {
        if (typeof info === 'object' && info !== null) {
          providers.push(this.normalizeProvider(name, info as Record<string, unknown>, 'opencode-config'))
        }
      }

      return providers
    } catch (err) {
      this.lastErrors.push(`Could not read opencode config auth: ${String(err)}`)
      return []
    }
  }

  private tryEnvironment(): AuthProvider[] {
    const providers: AuthProvider[] = []
    for (const known of KNOWN_PROVIDERS) {
      const key = known.env.find((envName) => !!process.env[envName])
      if (!key) continue
      providers.push({
        name: known.name,
        connected: true,
        status: 'configured',
        source: 'environment',
        method: 'apikey',
        plan: `env:${key}`,
      })
    }
    return providers
  }

  private normalizeProvider(name: string, info: Record<string, unknown>, source: AuthProvider['source']): AuthProvider {
    const method = this.detectMethod(info)
    const hasCredential = !!info.connected || !!info.apiKey || !!info.token || !!info.key || !!info.options
    const error = typeof info.error === 'string' ? info.error : undefined
    const status: AuthProvider['status'] = error ? 'error' : info.connected ? 'connected' : hasCredential ? 'configured' : 'unknown'

    return {
      name: this.normalizeProviderName(name),
      connected: status === 'connected' || status === 'configured',
      status,
      source,
      method,
      email: typeof info.email === 'string' ? info.email : undefined,
      plan: typeof info.plan === 'string' ? info.plan : undefined,
      models: Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === 'string') : [],
      error,
    }
  }

  private detectMethod(info: Record<string, unknown>): AuthProvider['method'] {
    if (info.method === 'oauth' || info.method === 'apikey') return info.method
    if (info.email || info.token) return 'oauth'
    if (info.apiKey || info.key || info.options) return 'apikey'
    return 'unknown'
  }

  private mergeProviders(providers: AuthProvider[]): AuthProvider[] {
    const byName = new Map<string, AuthProvider>()
    for (const provider of providers) {
      const existing = byName.get(provider.name)
      if (!existing || this.providerRank(provider) > this.providerRank(existing)) {
        byName.set(provider.name, { ...provider, models: [...new Set([...(existing?.models || []), ...(provider.models || [])])] })
      } else if (provider.models?.length) {
        existing.models = [...new Set([...(existing.models || []), ...provider.models])]
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private providerRank(provider: AuthProvider): number {
    if (provider.status === 'connected') return 4
    if (provider.status === 'configured') return 3
    if (provider.status === 'error') return 2
    return provider.connected ? 3 : 1
  }

  private addKnownProviderPlaceholders(providers: AuthProvider[]): AuthProvider[] {
    const names = new Set(providers.map((provider) => provider.name))
    const result = [...providers]
    for (const known of KNOWN_PROVIDERS) {
      if (names.has(known.name)) continue
      result.push({
        name: known.name,
        connected: false,
        status: 'unknown',
        source: 'catalog',
        method: 'unknown',
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  private normalizeProviderName(name: string): string {
    const normalized = name.trim().toLowerCase()
    if (normalized.includes('openai')) return 'openai'
    if (normalized.includes('google') || normalized.includes('gemini')) return 'google'
    if (normalized.includes('anthropic') || normalized.includes('claude')) return 'anthropic'
    if (normalized.includes('deepseek')) return 'deepseek'
    if (normalized.includes('moonshot') || normalized.includes('kimi')) return 'moonshot'
    if (normalized.includes('z.ai') || normalized.includes('zhipu') || normalized.includes('glm')) return 'zhipu'
    if (normalized.includes('minimax')) return 'minimax'
    return normalized.replace(/\s+/g, '-')
  }

  clearCache(): void {
    this.cachedProviders = null
    this.cachedAt = 0
  }
}

export const authReader = new AuthReader()
