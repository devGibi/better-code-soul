# Better Code Soul

OpenCode plugin for parallel subagent orchestration, token tracking, Graphify and Context Mode management.

## Installation

```bash
npm install -g better-code-soul
better-code-soul setup
# Restart OpenCode
/bcs-doctor
```

## Commands

| Command | Description |
|---------|-------------|
| `/bcs` | Open local web dashboard |
| `/bcs-status` | General status summary — tokens, cost, active tools |
| `/bcs-tokens [period]` | Token and cost report (session, today, week, month) |
| `/bcs-models` | Available models, auth status, and price comparison |
| `/bcs-agent "task"` | Parallel subagent orchestration with deterministic decomposition |
| `/bcs-graphify` | Graphify memory system management |
| `/bcs-context-mode` | Context Mode token savings management |
| `/bcs-optimize` | Token optimization suggestions |
| `/bcs-doctor` | Install, auth, storage, and tool diagnostics |
| `/bcs-quality` | Quality loop report — success score, model performance, cost per successful task |

## Dashboard

The `/bcs` command starts a local dashboard server and opens it in your browser.
It keeps the same 6-panel design that was planned for the terminal UI:

1. **GENEL** — 7-day token usage chart, context fill gauge, tool status
2. **MODELLER** — Model table with tier, price, and connection status
3. **AGENTLAR** — Last orchestration result with agent steps
4. **ARACLAR** — Graphify and Context Mode status with toggle controls
5. **OPTIMIZE** — Optimization suggestions based on usage data
6. **QUALITY** — Success score, model performance history, retry/conflict rates, cost per successful task

Dashboard controls:
- `[1]-[6]` — Switch tabs
- `[G]` — Toggle Graphify on the Tools tab
- `[C]` — Toggle Context Mode on the Tools tab
- `[B]` — Build/Update Graphify graph on the Tools tab
- Use the browser tab to keep the dashboard open while working in OpenCode

You can also start it directly:

```bash
better-code-soul dashboard
```

## How Parallel Subagent Orchestration Works

```
Traditional approach (slow):
  User: "Add user profile page"
  → Single model (Opus, $15/1M) does everything
  → Plan + code + test + review = single context, sequential
  → Time: 15 min · Cost: $0.45

Better Code Soul approach (fast):
  User: "Add user profile page"
  → TaskDecomposer analyzes task type, complexity, and context
  → ModelRouter selects optimal model for each tier
  → PlannerAgent (Gemini Pro, $1.25/1M) → architecture plan → 2 min
  → Parallel start:
       CoderAgent A (Kimi K2, $0.60/1M) → ProfileCard component → 3 min
       CoderAgent B (Kimi K2, $0.60/1M) → API endpoint → 3 min
       CoderAgent C (DeepSeek V3, $0.27/1M) → DB migration → 3 min
  → ReviewerAgent (Haiku, $0.80/1M) → validation → 1 min
  → ResultMerger → merge + conflict resolution
  → Time: 4 min (parallel) · Cost: $0.06

Savings: 87% cost, 73% time
```

## Quality Loop

Phase 2 measures whether cheap work is also successful. After `/bcs-agent` finishes, Better Code Soul now:

- Detects project quality commands from `package.json` (`test:run` or `test`, `lint`, `build`)
- Runs the detected commands and records pass/fail, duration, and command output tails
- Calculates a task success score from command results, agent success, review issues, conflicts, and retry count
- Records model performance history by role/model: success rate, average cost, duration, and tokens
- Produces a diff summary: touched files, hunks, additions/deletions, and conflicts
- Creates a git diff checkpoint before orchestration and marks whether manual rollback is safe
- Reports `cost per successful task`, including failed work in the cost side of the metric

Use:

```bash
/bcs-quality month
better-code-soul quality
```

## Model Router

Model selection is isolated in `src/services/ModelRouter.ts`. When a new model is released, add one line to the routing table — no other files need to change.

Routing priority:
- **PLAN tier**: gemini-2.5-pro → claude-opus-4-5 → o3
- **CODE tier**: kimi-k2 → deepseek-v3 → glm-4-plus → claude-sonnet-4-5 → gpt-4o → gemini-2.5-flash
- **REVIEW tier**: claude-haiku-4-5 → gpt-4o-mini → gemini-2.5-flash

## Graphify

Graphify creates a knowledge graph from your codebase. The model queries the graph instead of reading all files.

```bash
/bcs-graphify install   # Install graphify
/bcs-graphify build     # Build graph for current project
/bcs-graphify enable    # Activate for this project
```

When active, Graphify automatically injects relevant context summaries into the system prompt.

## Context Mode

Context Mode summarizes tool outputs before they enter the model context.
This saves approximately 98% of tool output tokens.

```bash
/bcs-context-mode install   # Install globally
/bcs-context-mode enable    # Activate for this project
/bcs-context-mode stats     # View savings
```

## MCP Server

Better Code Soul also runs as an MCP server:

```bash
better-code-soul mcp
```

This exposes all tools via the Model Context Protocol (stdio transport).

## CLI Commands

```bash
better-code-soul setup     # Register plugin and commands with OpenCode
better-code-soul status    # Check installation status
better-code-soul doctor    # Run install/auth/tool diagnostics
better-code-soul quality   # Show quality loop report
better-code-soul dashboard # Start local web dashboard
better-code-soul mcp       # Start MCP server (stdio)
better-code-soul help      # Show help
```

## Requirements

- Node.js 18+
- OpenCode installed

## License

MIT
