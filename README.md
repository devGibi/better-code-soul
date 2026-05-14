# Better Code Soul

OpenCode plugin for parallel subagent orchestration, token tracking, Graphify and Context Mode management.

## Installation

```bash
npm install -g better-code-soul
better-code-soul setup
# Restart OpenCode
/bcs-status
```

## Commands

| Command | Description |
|---------|-------------|
| `/bcs-status` | General status summary — tokens, cost, active tools |
| `/bcs-tokens [period]` | Token and cost report (session, today, week, month) |
| `/bcs-models` | Available models, auth status, and price comparison |
| `/bcs-agent "task"` | Parallel subagent orchestration |
| `/bcs-graphify` | Graphify memory system management |
| `/bcs-context-mode` | Context Mode token savings management |
| `/bcs-optimize` | Token optimization suggestions |

## How Parallel Subagent Orchestration Works

```
Traditional approach (slow):
  User: "Add user profile page"
  → Single model (Opus, $15/1M) does everything
  → Plan + code + test + review = single context, sequential
  → Time: 15 min · Cost: $0.45

Better Code Soul approach (fast):
  User: "Add user profile page"
  → Orchestrator analyzes the task
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

## Graphify

Graphify creates a knowledge graph from your codebase. The model queries the graph instead of reading all files.

```bash
/bcs-graphify install   # Install graphify
/bcs-graphify build     # Build graph for current project
/bcs-graphify enable    # Activate for this project
```

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

## Requirements

- Node.js 18+
- OpenCode installed

## License

MIT
