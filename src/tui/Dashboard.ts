import blessed from 'blessed'
import contrib from 'blessed-contrib'
import { db } from '../services/Database.js'
import { modelRegistry } from '../services/ModelRegistry.js'
import { authReader } from '../services/AuthReader.js'
import { graphifyService } from '../services/GraphifyService.js'
import { contextModeService } from '../services/ContextModeService.js'
import { ModelRouter, ROUTING_TABLE_EXPORT } from '../services/ModelRouter.js'
import { optimizationRules, getOptimizationStats } from '../tools/optimizationRules.js'
import { formatTokens, formatCost, formatDuration, formatRelativeTime, formatBytes } from '../utils/format.js'
import { logger } from '../utils/logger.js'

export class Dashboard {
  private screen!: blessed.Widgets.Screen
  private grid!: any
  private currentTab = 1
  private refreshInterval: NodeJS.Timeout | null = null
  private modelRouter: ModelRouter

  constructor() {
    this.modelRouter = new ModelRouter({
      getById: (id) => modelRegistry.getById(id),
      getAllModels: () => modelRegistry.getAllModels(),
    })
  }

  async open(): Promise<void> {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Better Code Soul',
      fullUnicode: true,
    })

    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen })

    this.renderHeader()
    this.renderTabBar()
    this.renderStatusBar()
    await this.renderTab(1)
    this.setupKeys()

    this.refreshInterval = setInterval(() => this.refresh(), 3000)
    this.screen.render()

    return new Promise(resolve => {
      this.screen.once('destroy', resolve)
    })
  }

  private setupKeys(): void {
    this.screen.key(['escape', 'q'], () => {
      if (this.refreshInterval) clearInterval(this.refreshInterval)
      this.screen.destroy()
    })

    this.screen.key(['1'], () => this.switchTab(1))
    this.screen.key(['2'], () => this.switchTab(2))
    this.screen.key(['3'], () => this.switchTab(3))
    this.screen.key(['4'], () => this.switchTab(4))
    this.screen.key(['5'], () => this.switchTab(5))
    this.screen.key(['6'], () => this.switchTab(6))

    this.screen.key(['g', 'G'], async () => {
      if (this.currentTab !== 4) return
      graphifyService.toggle(process.cwd())
      await this.renderTab(4)
      this.screen.render()
    })

    this.screen.key(['c', 'C'], async () => {
      if (this.currentTab !== 4) return
      contextModeService.toggle(process.cwd())
      await this.renderTab(4)
      this.screen.render()
    })

    this.screen.key(['b', 'B'], async () => {
      if (this.currentTab !== 4) return
      await this.showGraphifyBuild()
    })
  }

  private async renderTab(tab: number): Promise<void> {
    this.clearTabArea()
    this.currentTab = tab

    switch (tab) {
      case 1: await this.renderOverviewTab(); break
      case 2: await this.renderModelsTab(); break
      case 3: await this.renderAgentsTab(); break
      case 4: await this.renderToolsTab(); break
      case 5: await this.renderOptimizeTab(); break
      case 6: await this.renderQualityTab(); break
    }

    this.screen.render()
  }

  private async renderOverviewTab(): Promise<void> {
    const usage = db.getUsageHistory(7)
    const todayStats = db.getTodayStats()
    const graphifyStats = graphifyService.getStats(process.cwd())
    const ctxStats = await contextModeService.getStats()

    const sparkline = this.grid.set(3, 0, 6, 6, contrib.sparkline, {
      label: ' Token Kullanimi (7 gun) ',
      tags: true,
      border: { type: 'line' },
      style: { fg: 'cyan', border: { fg: 'cyan' } },
    })

    const tokenData = usage.length > 0
      ? usage.map(u => Math.round(u.tokens / 1000))
      : [0]

    sparkline.setData(
      ['Token (K)'],
      tokenData
    )

    const gauge = this.grid.set(3, 6, 3, 6, contrib.gauge, {
      label: ' Context Dolumu ',
      stroke: 'green',
      fill: 'white',
      border: { type: 'line' },
    })

    const activeModelId = modelRegistry.getActiveModelId()
    const activeModel = activeModelId ? modelRegistry.getById(activeModelId) : modelRegistry.getBestFor('code')
    const ctxPct = activeModel ? (todayStats.totalTokens / activeModel.contextWindow) * 100 : 0
    gauge.setPercent(Math.min(Math.round(ctxPct), 100))

    const toolBox = this.grid.set(6, 6, 3, 6, blessed.box, {
      label: ' Araç Durumu ',
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      content: this.buildToolStatusContent(graphifyStats, ctxStats),
      tags: true,
    })
  }

  private buildToolStatusContent(graphify: any, ctx: any): string {
    const on = '{green-fg}● AKTIF{/green-fg}'
    const off = '{red-fg}○ PASIF{/red-fg}'

    return [
      `Graphify: ${graphify?.installed ? on : off}`,
      graphify?.installed ? `  ${graphify.nodeCount} dugum · ${graphify.edgeCount} baglanti` : '  /bcs-graphify install',
      '',
      `Context Mode: ${ctx?.installed ? on : off}`,
      ctx?.installed ? `  Bu session: %${ctx.efficiencyPercent} tasarruf` : '  /bcs-context-mode install',
    ].join('\n')
  }

  private async renderModelsTab(): Promise<void> {
    const models = modelRegistry.listAll()
    const connectedProviders = modelRegistry.getAuthProviders()
    const connectedNames = connectedProviders.filter(p => p.connected).map(p => p.name)

    const tableData = models.map(m => {
      const source = connectedNames.some(n => m.provider === n || m.provider.startsWith(n))
        ? '🔗 OAUTH'
        : m.authMethod.includes('apikey') ? '🔑 API' : '⚫ KAT.'
      return [m.name, m.tier.toUpperCase(), `$${m.inputPrice}/$${m.outputPrice}`, source]
    })

    const table = this.grid.set(3, 0, 8, 12, contrib.table, {
      label: ' Modeller ',
      keys: true,
      fg: 'white',
      selectedFg: 'black',
      selectedBg: 'green',
      interactive: true,
      border: { type: 'line' },
      columnSpacing: 3,
      columnWidth: [28, 8, 16, 12],
      style: { border: { fg: 'cyan' } },
    })

    table.setData({
      headers: ['Model', 'Tier', 'Fiyat (G/C)', 'Kaynak'],
      data: tableData,
    })

    table.focus()
  }

  private async renderAgentsTab(): Promise<void> {
    const lastOrch = db.getLastOrchestration()

    if (!lastOrch) {
      this.grid.set(3, 0, 8, 12, blessed.box, {
        label: ' Son Orkestrasyon ',
        border: { type: 'line' },
        content: [
          '',
          '  Henuz /bcs-agent kullanilmadi.',
          '',
          '  Buyuk gorevler icin:',
          '  {cyan-fg}/bcs-agent "kullanici profil sayfasi ekle"{/cyan-fg}',
          '',
          '  Better Code Soul gorevi otomatik olarak:',
          '    1. PlannerAgent ile mimari plan yapar',
          '    2. Paralel CoderAgent\'lara dagitir',
          '    3. ReviewerAgent ile dogrular',
          '    4. Sonuclari birlestirir',
        ].join('\n'),
        tags: true,
        style: { border: { fg: 'cyan' } },
      })
      return
    }

    const steps = lastOrch.steps || []
    let content = `  Gorev: ${lastOrch.userRequest}\n`
    content += `  ${'─'.repeat(60)}\n`

    for (const step of steps) {
      const bar = '█'.repeat(Math.floor((step.duration_ms || 0) / 500)).padEnd(20, '░')
      const status = step.success ? '{green-fg}✓{/green-fg}' : '{red-fg}✗{/red-fg}'
      content += `  ${step.role.padEnd(12)} ${bar} ${status} (${step.model} · ${((step.input_tokens || 0) + (step.output_tokens || 0)).toLocaleString()} tok · $${(step.cost || 0).toFixed(4)})\n`
    }

    content += `  ${'─'.repeat(60)}\n`
    content += `  Toplam: ${lastOrch.totalTokens.toLocaleString()} tok · $${lastOrch.totalCost.toFixed(4)} · ${Math.round(lastOrch.durationMs / 1000)} saniye\n`

    this.grid.set(3, 0, 8, 12, blessed.box, {
      label: ' Son Orkestrasyon — ' + new Date(lastOrch.timestamp).toLocaleString('tr-TR'),
      border: { type: 'line' },
      content,
      tags: true,
      style: { border: { fg: 'magenta' } },
    })
  }

  private async renderToolsTab(): Promise<void> {
    const gStatus = await graphifyService.getFullStatus(process.cwd())
    const cStatus = await contextModeService.getStats()
    const cInstalled = await contextModeService.isInstalled()
    const cActive = contextModeService.isActive(process.cwd())

    this.grid.set(3, 0, 4, 6, blessed.box, {
      label: ' Graphify — Hafiza Sistemi ',
      border: { type: 'line' },
      tags: true,
      style: { border: { fg: gStatus.installed ? 'green' : 'red' } },
      content: this.buildGraphifyContent(gStatus),
    })

    this.grid.set(3, 6, 4, 6, blessed.box, {
      label: ' Context Mode — Token Tasarrufu ',
      border: { type: 'line' },
      tags: true,
      style: { border: { fg: cInstalled ? 'green' : 'red' } },
      content: this.buildContextModeContent(cInstalled, cActive, cStatus),
    })

    this.grid.set(7, 0, 2, 12, blessed.box, {
      content: '  [G] Graphify toggle  [B] Graf build  [C] Context Mode toggle',
      style: { fg: 'yellow' },
      tags: true,
    })
  }

  private buildGraphifyContent(s: any): string {
    if (!s.installed) return '\n  {red-fg}✗ Kurulu degil{/red-fg}\n\n  pip install graphifyy'
    const active = s.active ? '{green-fg}● AKTIF{/green-fg}' : '{yellow-fg}○ PASIF{/yellow-fg}'
    return [
      '',
      `  Durum: {green-fg}● Kurulu{/green-fg}  v${s.version || '?'}`,
      `  OpenCode: ${active}  {yellow-fg}[G] toggle{/yellow-fg}`,
      '',
      s.stats ? `  Graf: ${s.stats.nodeCount} dugum · ${s.stats.edgeCount} baglanti` : '  Graf: henuz build edilmedi',
      s.stats ? `  Boyut: ${formatBytes(s.stats.sizeBytes)}` : '',
      s.stats?.lastBuilt ? `  Son build: ${formatRelativeTime(s.stats.lastBuilt)}` : '',
      s.needsRebuild ? '\n  {yellow-fg}[!] Graf guncellenmeli{/yellow-fg}' : '',
      '',
      '  {yellow-fg}[B] Build/Guncelle{/yellow-fg}',
    ].join('\n')
  }

  private buildContextModeContent(installed: boolean, active: boolean, stats: any): string {
    if (!installed) return '\n  {red-fg}✗ Kurulu degil{/red-fg}\n\n  npm install -g context-mode'
    const activeStr = active ? '{green-fg}● AKTIF{/green-fg}' : '{yellow-fg}○ PASIF{/yellow-fg}'
    return [
      '',
      `  Durum: {green-fg}● Kurulu{/green-fg}`,
      `  OpenCode: ${activeStr}  {yellow-fg}[C] toggle{/yellow-fg}`,
      '',
      stats ? `  Bu session: %${stats.efficiencyPercent} tasarruf` : '  Bu session: veri yok',
      stats ? `  Toplam: ${stats.savedTotal} tasarruf` : '',
    ].join('\n')
  }

  private async renderOptimizeTab(): Promise<void> {
    const stats = getOptimizationStats()
    const suggestions: string[] = []

    for (const rule of optimizationRules) {
      if (rule.check(stats)) {
        suggestions.push(rule.message(stats))
      }
    }

    const content = suggestions.length === 0
      ? '\n  {green-fg}✓ Her sey optimize gorunuyor!{/green-fg}'
      : suggestions.map(msg => `  ⚠ ${msg}`).join('\n\n  ─────────────────────────────\n\n')

    this.grid.set(3, 0, 8, 12, blessed.box, {
      label: ' Optimizasyon Onerileri ',
      border: { type: 'line' },
      content,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      style: { border: { fg: 'yellow' } },
    })
  }

  private async renderQualityTab(): Promise<void> {
    const summary = db.getQualitySummary(30)
    const models = db.getModelPerformanceHistory(30).slice(0, 12)
    const recent = db.getRecentQualityRuns(6)

    const summaryContent = [
      `  Success score: ${summary.avgSuccessScore.toFixed(1)}/100`,
      `  Success rate: ${(summary.successRate * 100).toFixed(0)}% (${summary.successfulRuns}/${summary.totalRuns})`,
      `  Cost / successful task: ${formatCost(summary.avgCostPerSuccessfulTask)}`,
      `  Retry rate: ${(summary.retryRate * 100).toFixed(0)}%`,
      `  Conflict rate: ${(summary.conflictRate * 100).toFixed(0)}%`,
    ].join('\n')

    this.grid.set(3, 0, 3, 6, blessed.box, {
      label: ' Quality Summary ',
      border: { type: 'line' },
      content: summaryContent,
      tags: true,
      style: { border: { fg: 'green' } },
    })

    const recentContent = recent.length === 0
      ? '\n  Henuz quality run yok. /bcs-agent calistir.'
      : recent.map((run) => `  #${run.orchestration_id} ${Number(run.success_score || 0).toFixed(0)}/100 ${run.passed ? 'PASS' : 'FAIL'} · ${formatCost(run.cost_per_successful_task || 0)}/success · retry ${run.retry_count || 0}`).join('\n')

    this.grid.set(3, 6, 3, 6, blessed.box, {
      label: ' Recent Runs ',
      border: { type: 'line' },
      content: recentContent,
      tags: true,
      style: { border: { fg: 'yellow' } },
    })

    const table = this.grid.set(6, 0, 5, 12, contrib.table, {
      label: ' Model Performance ',
      keys: true,
      fg: 'white',
      selectedFg: 'black',
      selectedBg: 'green',
      interactive: true,
      border: { type: 'line' },
      columnSpacing: 2,
      columnWidth: [28, 14, 8, 10, 12, 12],
      style: { border: { fg: 'cyan' } },
    })

    table.setData({
      headers: ['Model', 'Role', 'Runs', 'Success', 'Avg Cost', 'Avg Time'],
      data: models.map((model) => [
        model.model,
        model.role,
        String(model.runs),
        `${(model.successRate * 100).toFixed(0)}%`,
        formatCost(model.avgCost),
        formatDuration(model.avgDurationMs),
      ]),
    })
  }

  private renderHeader(): void {
    this.grid.set(0, 0, 3, 12, blessed.box, {
      label: ' BETTER CODE SOUL ',
      border: { type: 'line' },
      tags: true,
      style: { border: { fg: 'blue' } },
      content: [
        '',
        '  {bold}Better Code Soul{/bold} — OpenCode Plugin',
        '  [TAB: sekme degistir]  [ESC: kapat]',
      ].join('\n'),
    })
  }

  private renderTabBar(): void {
    blessed.box({
      parent: this.screen,
      top: 6,
      left: 0,
      width: '100%',
      height: 1,
      content: ' {bold}[1]{/bold} GENEL  {bold}[2]{/bold} MODELLER  {bold}[3]{/bold} AGENTLAR  {bold}[4]{/bold} ARACLAR  {bold}[5]{/bold} OPTIMIZE  {bold}[6]{/bold} QUALITY  {gray-fg}[ESC] Kapat{/gray-fg}',
      tags: true,
      style: { bg: 'blue', fg: 'white' },
    })
  }

  private renderStatusBar(): void {
    const graphifyActive = db.getSetting('graphifyEnabled') === '1'
    const ctxModeActive = db.getSetting('contextModeEnabled') === '1'

    this.grid.set(11, 0, 1, 12, blessed.box, {
      content: `  [G]raphify: ${graphifyActive ? '● Aktif' : '○ Pasif'}   [C]ontext Mode: ${ctxModeActive ? '● Aktif' : '○ Pasif'}   Son guncelleme: simdi`,
      tags: true,
      style: { fg: 'gray' },
    })
  }

  private clearTabArea(): void {
    // blessed-contrib handles clearing via grid.set
  }

  private async refresh(): Promise<void> {
    await this.renderTab(this.currentTab)
  }

  private async switchTab(tab: number): Promise<void> {
    this.currentTab = tab
    await this.renderTab(tab)
  }

  private async showGraphifyBuild(): Promise<void> {
    const logBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '80%',
      label: ' Graphify Build ',
      border: { type: 'line' },
      tags: true,
      style: { border: { fg: 'yellow' } },
      scrollable: true,
      alwaysScroll: true,
    })

    logBox.focus()

    const projectPath = process.cwd()
    for await (const line of graphifyService.build(projectPath)) {
      logBox.setContent(logBox.getContent() + '\n' + line)
      this.screen.render()
    }

    logBox.setContent(logBox.getContent() + '\n\n{green-fg}✓ Graf guncellendi{/green-fg}')
    this.screen.render()

    setTimeout(() => {
      logBox.destroy()
      this.screen.render()
    }, 2000)
  }
}
