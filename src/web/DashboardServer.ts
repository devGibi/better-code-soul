import http from 'node:http'
import { spawn } from 'node:child_process'
import { db } from '../services/Database.js'
import { tokenTracker } from '../services/TokenTracker.js'
import { modelRegistry } from '../services/ModelRegistry.js'
import { authReader } from '../services/AuthReader.js'
import { graphifyService } from '../services/GraphifyService.js'
import { contextModeService } from '../services/ContextModeService.js'
import { doctorService } from '../services/DoctorService.js'
import { optimizationRules, getOptimizationStats } from '../tools/optimizationRules.js'
import { formatBytes, formatCost, formatDuration, formatRelativeTime, formatTokens } from '../utils/format.js'
import { logger } from '../utils/logger.js'

interface DashboardServerOptions {
  host?: string
  port?: number
  openBrowser?: boolean
  initializeServices?: boolean
}

interface DashboardServerHandle {
  url: string
  port: number
  alreadyRunning: boolean
  opened: boolean
}

let server: http.Server | null = null
let serverUrl: string | null = null
let serverPort: number | null = null
let serviceInitPromise: Promise<void> | null = null

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = options.host || '127.0.0.1'

  if (server && serverUrl && serverPort) {
    const opened = options.openBrowser ? openUrl(serverUrl) : false
    return { url: serverUrl, port: serverPort, alreadyRunning: true, opened }
  }

  if (options.initializeServices !== false) {
    await ensureServicesInitialized()
  }

  server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (err) {
      logger.error('Dashboard request failed', err)
      sendJson(res, 500, { error: String(err) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(options.port || 0, host, resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine dashboard server address')
  }

  serverPort = address.port
  serverUrl = `http://${host}:${serverPort}`

  const opened = options.openBrowser ? openUrl(serverUrl) : false
  return { url: serverUrl, port: serverPort, alreadyRunning: false, opened }
}

async function ensureServicesInitialized(): Promise<void> {
  if (!serviceInitPromise) {
    serviceInitPromise = (async () => {
      await db.init()
      modelRegistry.init()
      tokenTracker.init()
      try {
        modelRegistry.setAuthProviders(await authReader.getProviders())
      } catch (err) {
        logger.warn('Could not read auth providers for dashboard', err)
      }
    })()
  }

  await serviceInitPromise
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderDashboardHtml())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    sendJson(res, 200, await getOverviewData())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    sendJson(res, 200, getModelsData())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/agents') {
    sendJson(res, 200, getAgentsData())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    sendJson(res, 200, await getToolsData())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/doctor') {
    const report = await doctorService.run(process.cwd())
    sendJson(res, 200, { report, markdown: doctorService.formatMarkdown(report) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/optimize') {
    sendJson(res, 200, getOptimizeData())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/graphify/toggle') {
    graphifyService.toggle(process.cwd())
    sendJson(res, 200, await getToolsData())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/graphify/build') {
    const lines: string[] = []
    for await (const line of graphifyService.build(process.cwd())) {
      lines.push(line)
    }
    sendJson(res, 200, { lines, tools: await getToolsData() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/context-mode/toggle') {
    contextModeService.toggle(process.cwd())
    sendJson(res, 200, await getToolsData())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/context-mode/doctor') {
    const result = await contextModeService.runDoctor()
    sendJson(res, 200, { result, tools: await getToolsData() })
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

async function getOverviewData() {
  const errors: string[] = []
  const usage = db.getUsageHistory(7)
  const todayStats = db.getTodayStats()
  const graphifyStats = safeSync(() => graphifyService.getStats(process.cwd()), { installed: false, nodeCount: 0, edgeCount: 0, fileCount: 0, sizeBytes: 0, lastBuilt: null }, 'Graphify stats', errors)
  const ctxStats = await safeAsync(() => contextModeService.getStats(), { installed: false, active: false, savedThisSession: '$0.00', savedTotal: '$0.00', efficiencyPercent: 0 }, 'Context Mode stats', errors)
  const sessionStats = tokenTracker.getSessionStats()
  const providers = modelRegistry.getAuthProviders()
  errors.push(...authReader.getLastErrors())
  const activeModelId = modelRegistry.getActiveModelId()
  const activeModel = activeModelId ? modelRegistry.getById(activeModelId) : modelRegistry.getBestFor('code')
  const contextFill = activeModel ? Math.min((todayStats.totalTokens / activeModel.contextWindow) * 100, 100) : 0

  return {
    project: process.cwd(),
    usage,
    today: {
      ...todayStats,
      totalTokensLabel: formatTokens(todayStats.totalTokens),
      totalCostLabel: formatCost(todayStats.totalCost),
    },
    session: {
      inputLabel: formatTokens(sessionStats.totalInput),
      outputLabel: formatTokens(sessionStats.totalOutput),
      costLabel: formatCost(sessionStats.totalCost),
    },
    activeModel: activeModel ? {
      ...activeModel,
      contextFill: Math.round(contextFill),
      contextWindowLabel: formatTokens(activeModel.contextWindow),
    } : null,
    providers: providers.map((provider) => ({
      ...provider,
      label: provider.connected ? 'Connected' : 'Not connected',
    })),
    graphify: {
      ...graphifyStats,
      sizeLabel: formatBytes(graphifyStats.sizeBytes),
      lastBuiltLabel: graphifyStats.lastBuilt ? formatRelativeTime(graphifyStats.lastBuilt) : null,
    },
    contextMode: ctxStats,
    errors,
  }
}

function getModelsData() {
  const models = modelRegistry.listAll()
  const providers = modelRegistry.getAuthProviders()
  const connectedNames = providers.filter((provider) => provider.connected).map((provider) => provider.name)
  const activeModelId = modelRegistry.getActiveModelId()

  return {
    activeModelId,
    models: models.map((model) => {
      const connected = connectedNames.some((name) => model.provider === name || model.provider.startsWith(name))
      const source = connected ? 'OAUTH' : model.authMethod.includes('apikey') ? 'API' : 'CATALOG'
      return {
        ...model,
        source,
        connected,
        active: model.id === activeModelId,
        contextWindowLabel: formatTokens(model.contextWindow),
        priceLabel: `$${model.inputPrice}/$${model.outputPrice}`,
      }
    }),
  }
}

function getAgentsData() {
  const last = db.getLastOrchestration()
  if (!last) {
    return { last: null }
  }

  const row = last as any
  const totalTokens = row.totalTokens ?? row.total_tokens ?? 0
  const totalCost = row.totalCost ?? row.total_cost_usd ?? 0
  const durationMs = row.durationMs ?? row.duration_ms ?? 0

  return {
    last: {
      ...last,
      userRequest: row.userRequest ?? row.user_request ?? '',
      totalTokens,
      totalCost,
      durationMs,
      totalTokensLabel: formatTokens(totalTokens),
      totalCostLabel: formatCost(totalCost),
      durationLabel: formatDuration(durationMs),
      timestampLabel: new Date(row.timestamp).toLocaleString('tr-TR'),
      steps: last.steps.map((step) => ({
        ...step,
        success: Boolean(step.success),
        tokenLabel: formatTokens((step.input_tokens || 0) + (step.output_tokens || 0)),
        costLabel: formatCost(step.cost || 0),
        durationLabel: formatDuration(step.duration_ms || 0),
      })),
    },
  }
}

async function getToolsData() {
  const errors: string[] = []
  const graphify = await safeAsync(() => graphifyService.getFullStatus(process.cwd()), {
    installed: false,
    version: null,
    active: false,
    stats: { installed: false, nodeCount: 0, edgeCount: 0, fileCount: 0, sizeBytes: 0, lastBuilt: null },
    needsRebuild: true,
  }, 'Graphify status', errors)
  const contextModeStats = await safeAsync(() => contextModeService.getStats(), { installed: false, active: false, savedThisSession: '$0.00', savedTotal: '$0.00', efficiencyPercent: 0 }, 'Context Mode stats', errors)
  const contextModeInstalled = await safeAsync(() => contextModeService.isInstalled(), false, 'Context Mode install check', errors)
  const contextModeActive = contextModeService.isActive(process.cwd())

  return {
    graphify: {
      ...graphify,
      stats: {
        ...graphify.stats,
        sizeLabel: formatBytes(graphify.stats.sizeBytes),
        lastBuiltLabel: graphify.stats.lastBuilt ? formatRelativeTime(graphify.stats.lastBuilt) : null,
      },
    },
    contextMode: {
      installed: contextModeInstalled,
      active: contextModeActive,
      stats: contextModeStats,
    },
    errors,
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T, label: string, errors: string[]): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    errors.push(`${label}: ${String(err)}`)
    return fallback
  }
}

function safeSync<T>(fn: () => T, fallback: T, label: string, errors: string[]): T {
  try {
    return fn()
  } catch (err) {
    errors.push(`${label}: ${String(err)}`)
    return fallback
  }
}

function getOptimizeData() {
  const stats = getOptimizationStats()
  const suggestions = optimizationRules
    .filter((rule) => rule.check(stats))
    .map((rule) => ({ id: rule.id, message: rule.message(stats) }))

  return { stats, suggestions }
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

function openUrl(url: string): boolean {
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch (err) {
    logger.warn('Could not open dashboard URL', err)
    return false
  }
}

function renderDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Better Code Soul</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #0d1b2f;
      --panel-strong: #112640;
      --line: #1e4268;
      --muted: #89a4be;
      --text: #e8f2ff;
      --cyan: #36d7ff;
      --blue: #4f8cff;
      --green: #4ade80;
      --yellow: #facc15;
      --red: #fb7185;
      --purple: #c084fc;
      --shadow: 0 22px 80px rgba(0, 0, 0, .35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 15% 0%, rgba(54, 215, 255, .18), transparent 34rem),
        radial-gradient(circle at 90% 10%, rgba(192, 132, 252, .14), transparent 30rem),
        var(--bg);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell { width: min(1360px, calc(100% - 32px)); margin: 24px auto; }
    .frame { border: 1px solid var(--line); border-radius: 24px; background: rgba(7, 17, 31, .78); box-shadow: var(--shadow); overflow: hidden; }
    header { display: grid; grid-template-columns: 1.4fr repeat(4, minmax(120px, .6fr)); gap: 1px; background: var(--line); }
    .hero, .metric { background: linear-gradient(145deg, rgba(17, 38, 64, .98), rgba(13, 27, 47, .94)); padding: 20px; min-height: 126px; }
    .hero h1 { margin: 0 0 8px; font-size: clamp(24px, 4vw, 42px); letter-spacing: .02em; }
    .hero p, .metric span, .muted { color: var(--muted); }
    .metric strong { display: block; margin-top: 8px; font-size: 26px; color: var(--text); }
    .metric small { color: var(--muted); }
    .tabs { display: flex; gap: 0; padding: 0; background: #082a4b; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); overflow-x: auto; }
    .tab { border: 0; color: #dcecff; background: transparent; padding: 14px 18px; font: inherit; font-weight: 800; cursor: pointer; white-space: nowrap; }
    .tab.active { color: #06111f; background: var(--cyan); }
    main { padding: 22px; min-height: 560px; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .card { grid-column: span 6; border: 1px solid var(--line); border-radius: 18px; background: rgba(13, 27, 47, .9); padding: 18px; }
    .card.full { grid-column: 1 / -1; }
    .card.third { grid-column: span 4; }
    .card h2 { margin: 0 0 14px; font-size: 16px; color: var(--cyan); text-transform: uppercase; letter-spacing: .08em; }
    .status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; color: var(--muted); }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--red); box-shadow: 0 0 18px currentColor; }
    .on .dot, .dot.on { background: var(--green); }
    .warn .dot, .dot.warn { background: var(--yellow); }
    .bars { display: flex; align-items: end; gap: 10px; height: 230px; padding-top: 16px; }
    .bar { flex: 1; min-width: 28px; display: grid; align-items: end; gap: 8px; color: var(--muted); text-align: center; font-size: 12px; }
    .bar-fill { border-radius: 12px 12px 4px 4px; min-height: 5px; background: linear-gradient(180deg, var(--cyan), var(--blue)); box-shadow: 0 0 24px rgba(54, 215, 255, .22); }
    .gauge { --value: 0; width: 190px; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center; margin: 18px auto; background: conic-gradient(var(--green) calc(var(--value) * 1%), #172a42 0); }
    .gauge::before { content: attr(data-label); display: grid; place-items: center; width: 72%; aspect-ratio: 1; border-radius: 50%; background: var(--panel); color: var(--text); font-size: 32px; font-weight: 900; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 12px 10px; border-bottom: 1px solid rgba(30, 66, 104, .7); text-align: left; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    tr.active-row { background: rgba(74, 222, 128, .1); }
    .badge { display: inline-flex; border-radius: 999px; padding: 4px 9px; font-weight: 800; font-size: 12px; background: rgba(137, 164, 190, .12); color: var(--muted); }
    .think { color: var(--yellow); } .code { color: var(--purple); } .review { color: var(--green); }
    .oauth { color: var(--green); } .api { color: var(--cyan); } .catalog { color: var(--muted); }
    .steps { display: grid; gap: 12px; }
    .step { display: grid; grid-template-columns: 140px 1fr auto; gap: 14px; align-items: center; padding: 12px; border: 1px solid rgba(30, 66, 104, .7); border-radius: 14px; background: rgba(17, 38, 64, .48); }
    .track { height: 12px; border-radius: 999px; background: #172a42; overflow: hidden; }
    .track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--purple), var(--cyan)); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    button.action { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; color: var(--text); background: var(--panel-strong); font-weight: 800; cursor: pointer; }
    button.action:hover { border-color: var(--cyan); color: var(--cyan); }
    pre { white-space: pre-wrap; max-height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: 14px; background: #050b14; padding: 14px; color: #bdeaff; }
    .error-card { grid-column: 1 / -1; border-color: rgba(248, 113, 113, .55); background: rgba(127, 29, 29, .28); }
    .error-card h2 { color: var(--red); }
    footer { padding: 12px 20px; border-top: 1px solid var(--line); color: var(--muted); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .empty { padding: 36px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 18px; }
    @media (max-width: 900px) {
      header { grid-template-columns: 1fr 1fr; }
      .hero { grid-column: 1 / -1; }
      .card, .card.third { grid-column: 1 / -1; }
      .step { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="frame">
      <header>
        <section class="hero">
          <h1>Better Code Soul</h1>
          <p>OpenCode dashboard for tokens, models, agents, Graphify and Context Mode.</p>
          <div class="status on"><span class="dot"></span><span id="project">Loading project...</span></div>
        </section>
        <section class="metric"><span>DURUM</span><strong id="metric-status">...</strong><small id="metric-providers">providers</small></section>
        <section class="metric"><span>TOKEN</span><strong id="metric-tokens">...</strong><small>today</small></section>
        <section class="metric"><span>MALIYET</span><strong id="metric-cost">...</strong><small>today</small></section>
        <section class="metric"><span>AKTIF MODEL</span><strong id="metric-model">...</strong><small id="metric-model-tier">code tier</small></section>
      </header>
      <nav class="tabs" id="tabs">
        <button class="tab active" data-tab="overview">[1] GENEL</button>
        <button class="tab" data-tab="models">[2] MODELLER</button>
        <button class="tab" data-tab="agents">[3] AGENTLAR</button>
        <button class="tab" data-tab="tools">[4] ARACLAR</button>
        <button class="tab" data-tab="optimize">[5] OPTIMIZE</button>
      </nav>
      <main id="app"></main>
      <footer>
        <span id="footer-tools">[G]raphify: ...   [C]ontext Mode: ...</span>
        <span id="footer-updated">Last update: ...</span>
      </footer>
    </div>
  </div>
  <script>
    const state = { tab: 'overview', overview: null, models: null, agents: null, tools: null, optimize: null, errors: [] };
    const app = document.getElementById('app');
    const fmt = new Intl.NumberFormat('tr-TR');

    async function api(path, options) {
      const res = await fetch(path, options);
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(data?.error || text || res.statusText);
      return data;
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    }

    async function loadAll() {
      const names = ['overview', 'models', 'agents', 'tools', 'optimize'];
      const settled = await Promise.allSettled([
        api('/api/overview'), api('/api/models'), api('/api/agents'), api('/api/tools'), api('/api/optimize')
      ]);
      const errors = [];
      settled.forEach((result, index) => {
        const name = names[index];
        if (result.status === 'fulfilled') {
          state[name] = result.value;
          if (Array.isArray(result.value?.errors)) errors.push(...result.value.errors);
        } else {
          errors.push(name + ': ' + result.reason.message);
        }
      });
      state.errors = [...new Set(errors)];
      if (!state.overview) throw new Error(state.errors.join('\n') || 'overview verisi alinamadi');
      renderHeader();
      render();
    }

    function renderHeader() {
      const overview = state.overview;
      const tools = state.tools;
      if (!overview) return;
      const connected = overview.providers.filter(provider => provider.connected).length;
      document.getElementById('project').textContent = overview.project;
      document.getElementById('metric-status').textContent = connected > 0 ? 'Aktif' : 'Hazir';
      document.getElementById('metric-providers').textContent = connected + ' baglanti';
      document.getElementById('metric-tokens').textContent = overview.today.totalTokensLabel;
      document.getElementById('metric-cost').textContent = overview.today.totalCostLabel;
      document.getElementById('metric-model').textContent = overview.activeModel?.name || 'Unknown';
      document.getElementById('metric-model-tier').textContent = (overview.activeModel?.tier || 'code').toUpperCase();
      if (tools) {
        document.getElementById('footer-tools').textContent = '[G]raphify: ' + (tools.graphify.active ? 'Aktif' : 'Pasif') + '   [C]ontext Mode: ' + (tools.contextMode.active ? 'Aktif' : 'Pasif');
      }
      document.getElementById('footer-updated').textContent = 'Last update: ' + new Date().toLocaleTimeString('tr-TR');
    }

    function render() {
      if (!state.overview) {
        app.innerHTML = '<div class="empty">Dashboard yukleniyor...</div>';
        return;
      }
      if (state.tab === 'overview') renderOverview();
      if (state.tab === 'models') renderModels();
      if (state.tab === 'agents') renderAgents();
      if (state.tab === 'tools') renderTools();
      if (state.tab === 'optimize') renderOptimize();
    }

    function renderOverview() {
      const overview = state.overview;
      const max = Math.max(...overview.usage.map(day => day.tokens), 1);
      const bars = overview.usage.length ? overview.usage.map(day => \`
        <div class="bar"><div class="bar-fill" style="height:\${Math.max(5, Math.round(day.tokens / max * 100))}%"></div><span>\${esc(day.date.slice(5))}<br>\${esc(fmt.format(day.tokens))}</span></div>
      \`).join('') : '<div class="empty">Token gecmisi yok.</div>';
      app.innerHTML = \`
        <div class="grid">
          \${renderErrors()}
          <section class="card"><h2>Token Kullanimi (7 gun)</h2><div class="bars">\${bars}</div></section>
          <section class="card"><h2>Context Dolumu</h2><div class="gauge" style="--value:\${overview.activeModel?.contextFill || 0}" data-label="\${overview.activeModel?.contextFill || 0}%"></div><p class="muted">\${esc(overview.activeModel?.contextWindowLabel || '0')} context window</p></section>
          <section class="card third"><h2>Graphify</h2>\${statusPill(overview.graphify.installed, overview.graphify.installed ? 'Graf hazir' : 'Kurulu degil')}<p>\${fmt.format(overview.graphify.nodeCount)} dugum / \${fmt.format(overview.graphify.edgeCount)} baglanti</p><p class="muted">\${esc(overview.graphify.sizeLabel)} \${overview.graphify.lastBuiltLabel ? ' / ' + esc(overview.graphify.lastBuiltLabel) : ''}</p></section>
          <section class="card third"><h2>Context Mode</h2>\${statusPill(overview.contextMode.installed, overview.contextMode.installed ? 'Kurulu' : 'Kurulu degil')}<p>Bu session: \${esc(overview.contextMode.efficiencyPercent)}% tasarruf</p><p class="muted">Toplam: \${esc(overview.contextMode.savedTotal)}</p></section>
          <section class="card third"><h2>Session</h2><p>Input: \${esc(overview.session.inputLabel)}</p><p>Output: \${esc(overview.session.outputLabel)}</p><p class="muted">Cost: \${esc(overview.session.costLabel)}</p></section>
        </div>\`;
    }

    function renderModels() {
      const rows = state.models.models.map(model => \`
        <tr class="\${model.active ? 'active-row' : ''}">
          <td><strong>\${esc(model.name)}</strong><br><span class="muted">\${esc(model.id)}</span></td>
          <td><span class="badge \${esc(model.tier)}">\${esc(model.tier.toUpperCase())}</span></td>
          <td>\${esc(model.contextWindowLabel)}</td>
          <td>\${esc(model.priceLabel)}</td>
          <td><span class="badge \${esc(model.source.toLowerCase())}">\${esc(model.source)}</span></td>
        </tr>\`).join('');
      app.innerHTML = \`<div class="grid">\${renderErrors()}<section class="card full"><h2>Modeller</h2><table><thead><tr><th>Model</th><th>Tier</th><th>Ctx</th><th>Fiyat (G/C)</th><th>Kaynak</th></tr></thead><tbody>\${rows}</tbody></table></section></div>\`;
    }

    function renderAgents() {
      const last = state.agents.last;
      if (!last) {
        app.innerHTML = '<div class="grid">' + renderErrors() + '<section class="card full"><h2>Son Orkestrasyon</h2><div class="empty">Henuz /bcs-agent kullanilmadi. Buyuk gorevler icin /bcs-agent "kullanici profil sayfasi ekle" yaz.</div></section></div>';
        return;
      }
      const max = Math.max(...last.steps.map(step => step.duration_ms || 0), 1);
      const steps = last.steps.map(step => \`
        <div class="step"><strong>\${esc(step.role)}</strong><div><div class="track"><span style="width:\${Math.max(8, Math.round((step.duration_ms || 0) / max * 100))}%"></span></div><span class="muted">\${esc(step.model)} / \${esc(step.tokenLabel)} tok / \${esc(step.costLabel)} / \${esc(step.durationLabel)}\${step.error ? ' / ' + esc(step.error) : ''}</span></div><span class="badge \${step.success ? 'review' : 'catalog'}">\${step.success ? 'OK' : 'FAIL'}</span></div>\`).join('');
      app.innerHTML = \`<div class="grid">\${renderErrors()}<section class="card full"><h2>Son Orkestrasyon - \${esc(last.timestampLabel)}</h2><p><strong>Gorev:</strong> \${esc(last.userRequest)}</p><div class="steps">\${steps}</div><p><strong>Toplam:</strong> \${esc(last.totalTokensLabel)} tok / \${esc(last.totalCostLabel)} / \${esc(last.durationLabel)}</p></section></div>\`;
    }

    function renderTools(log = '') {
      const tools = state.tools;
      app.innerHTML = \`
        <div class="grid">
          \${renderErrors()}
          <section class="card"><h2>Graphify - Hafiza Sistemi</h2>\${statusPill(tools.graphify.installed, tools.graphify.installed ? 'Kurulu' : 'Kurulu degil')} \${statusPill(tools.graphify.active, tools.graphify.active ? 'OpenCode aktif' : 'OpenCode pasif', true)}<p>Graf: \${fmt.format(tools.graphify.stats.nodeCount)} dugum / \${fmt.format(tools.graphify.stats.edgeCount)} baglanti</p><p class="muted">Boyut: \${esc(tools.graphify.stats.sizeLabel)} / Son build: \${esc(tools.graphify.stats.lastBuiltLabel || 'yok')}</p><div class="actions"><button class="action" onclick="toggleGraphify()">[G] Toggle</button><button class="action" onclick="buildGraphify()">[B] Build/Guncelle</button></div></section>
          <section class="card"><h2>Context Mode - Token Tasarrufu</h2>\${statusPill(tools.contextMode.installed, tools.contextMode.installed ? 'Kurulu' : 'Kurulu degil')} \${statusPill(tools.contextMode.active, tools.contextMode.active ? 'OpenCode aktif' : 'OpenCode pasif', true)}<p>Bu session: \${esc(tools.contextMode.stats.efficiencyPercent)}% tasarruf</p><p class="muted">Toplam: \${esc(tools.contextMode.stats.savedTotal)}</p><div class="actions"><button class="action" onclick="toggleContextMode()">[C] Toggle</button><button class="action" onclick="doctorContextMode()">[D] Context Doctor</button><button class="action" onclick="doctorBcs()">BCS Doctor</button></div></section>
          <section class="card full"><h2>Islem Ciktisi</h2><pre>\${esc(log || 'Aksiyon ciktisi burada gorunecek.')}</pre></section>
        </div>\`;
    }

    function renderOptimize() {
      const suggestions = state.optimize.suggestions;
      const body = suggestions.length ? suggestions.map(item => \`<section class="card full"><h2>\${esc(item.id)}</h2><p>\${esc(item.message)}</p></section>\`).join('') : '<section class="card full"><h2>Optimizasyon</h2><div class="empty">Her sey optimize gorunuyor.</div></section>';
      app.innerHTML = \`<div class="grid">\${renderErrors()}\${body}</div>\`;
    }

    function renderErrors() {
      return state.errors.length ? \`<section class="card error-card"><h2>Hata / Uyari</h2><pre>\${esc(state.errors.join('\n'))}</pre><p class="muted">Detayli kontrol icin /bcs-doctor veya Tools sekmesindeki BCS Doctor'u calistir.</p></section>\` : '';
    }

    function statusPill(on, label, warnWhenOff = false) {
      return \`<span class="status \${on ? 'on' : warnWhenOff ? 'warn' : ''}"><span class="dot"></span>\${esc(label)}</span>\`;
    }

    async function refreshTools(log) {
      state.tools = await api('/api/tools');
      renderHeader();
      renderTools(log);
    }
    async function toggleGraphify() { state.tools = await api('/api/graphify/toggle', { method: 'POST' }); renderHeader(); renderTools('Graphify durumu degistirildi.'); }
    async function buildGraphify() { renderTools('Graphify build calisiyor...'); const result = await api('/api/graphify/build', { method: 'POST' }); state.tools = result.tools; renderHeader(); renderTools(result.lines.join('\n')); }
    async function toggleContextMode() { state.tools = await api('/api/context-mode/toggle', { method: 'POST' }); renderHeader(); renderTools('Context Mode durumu degistirildi. OpenCode yeniden baslatma gerektirebilir.'); }
    async function doctorContextMode() { const result = await api('/api/context-mode/doctor', { method: 'POST' }); state.tools = result.tools; renderHeader(); renderTools(result.result); }
    async function doctorBcs() { const result = await api('/api/doctor'); renderTools(result.markdown); }

    document.getElementById('tabs').addEventListener('click', event => {
      const button = event.target.closest('.tab');
      if (!button) return;
      state.tab = button.dataset.tab;
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
      render();
    });
    window.addEventListener('keydown', event => {
      const tabs = ['overview', 'models', 'agents', 'tools', 'optimize'];
      if (/^[1-5]$/.test(event.key)) document.querySelector(\`[data-tab="\${tabs[Number(event.key) - 1]}"]\`).click();
      if ((event.key === 'g' || event.key === 'G') && state.tab === 'tools') toggleGraphify();
      if ((event.key === 'c' || event.key === 'C') && state.tab === 'tools') toggleContextMode();
      if ((event.key === 'b' || event.key === 'B') && state.tab === 'tools') buildGraphify();
    });

    loadAll().catch(err => { app.innerHTML = '<div class="empty">Dashboard hata verdi: ' + esc(err.message) + '</div>'; });
    setInterval(() => loadAll().catch(() => {}), 3000);
  </script>
</body>
</html>`
}
