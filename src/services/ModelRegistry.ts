import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from '../utils/platform.js'
import { logger } from '../utils/logger.js'
import { db } from './Database.js'

export type ModelTier = 'think' | 'code' | 'review'

export interface Model {
  id: string
  name: string
  provider: string
  tier: ModelTier
  contextWindow: number
  inputPrice: number
  outputPrice: number
  authMethod: string[]
}

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

export class ModelRegistry {
  private catalog: Model[] = []
  private userModels: Model[] = []
  private authProviders: AuthProvider[] = []

  init(): void {
    this.loadCatalog()
    this.loadUserModels()
  }

  private loadCatalog(): void {
    try {
      const catalogPath = this.findCatalogPath()
      if (catalogPath && fs.existsSync(catalogPath)) {
        const data = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))
        this.catalog = data.models || []
      }
    } catch (err) {
      logger.warn('Failed to load model catalog', err)
    }
  }

  private findCatalogPath(): string | null {
    const candidates = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'catalog.json'),
      path.join(process.cwd(), 'src', 'models', 'catalog.json'),
      path.join(process.cwd(), 'dist', 'models', 'catalog.json'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  private loadUserModels(): void {
    try {
      const userPath = path.join(paths.hubData(), 'models.json')
      if (fs.existsSync(userPath)) {
        const data = JSON.parse(fs.readFileSync(userPath, 'utf-8'))
        this.userModels = data.models || []
      }
    } catch {
      // No user models yet
    }
  }

  addUserModel(model: Model): void {
    this.userModels.push(model)
    const userPath = path.join(paths.hubData(), 'models.json')
    fs.writeFileSync(userPath, JSON.stringify({ models: this.userModels }, null, 2), 'utf-8')
  }

  getAllModels(): Model[] {
    const merged = new Map<string, Model>()
    for (const m of this.catalog) merged.set(m.id, m)
    for (const m of this.userModels) merged.set(m.id, m)
    return [...merged.values()]
  }

  getModel(id: string): Model | undefined {
    return this.getAllModels().find((m) => m.id === id)
  }

  getModelsByTier(tier: ModelTier): Model[] {
    return this.getAllModels().filter((m) => m.tier === tier)
  }

  getModelsByProvider(provider: string): Model[] {
    return this.getAllModels().filter((m) => m.provider === provider)
  }

  getConnectedModels(): Model[] {
    const connectedProviders = this.authProviders.filter((p) => p.connected).map((p) => p.name)
    return this.getAllModels().filter((m) =>
      connectedProviders.some((cp) => m.provider === cp || m.provider.startsWith(cp))
    )
  }

  getBestFor(tier: ModelTier): Model {
    const connected = this.getConnectedModels().filter((m) => m.tier === tier)
    if (connected.length > 0) {
      return connected.sort((a, b) => a.inputPrice - b.inputPrice)[0]
    }

    const all = this.getModelsByTier(tier)
    if (all.length > 0) {
      logger.warn(`No connected model for tier "${tier}", using catalog fallback`)
      return all.sort((a, b) => a.inputPrice - b.inputPrice)[0]
    }

    return {
      id: 'unknown',
      name: 'Unknown Model',
      provider: 'unknown',
      tier,
      contextWindow: 128000,
      inputPrice: 3.0,
      outputPrice: 15.0,
      authMethod: [],
    }
  }

  setAuthProviders(providers: AuthProvider[]): void {
    this.authProviders = providers
  }

  getAuthProviders(): AuthProvider[] {
    return this.authProviders
  }

  listAll(): Model[] {
    return this.getAllModels()
  }

  getById(id: string): Model | undefined {
    return this.getModel(id)
  }

  getActiveModelId(): string | null {
    return db.getSetting('activeModel')
  }

  setActiveModel(modelId: string): void {
    db.updateSetting('activeModel', modelId)
  }

  getConnectedModelIds(): string[] {
    return this.getConnectedModels().map(m => m.id)
  }
}

export const modelRegistry = new ModelRegistry()
