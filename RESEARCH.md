# Research Notes

## Motivation

Agent-forward trading represents an emerging paradigm where LLM agents assist — but do not replace — human traders. This project is a practical exploration of the interface layer required to make that possible.

The Model Context Protocol (MCP) provides a standardized way for LLMs to interact with external tools. Financial desktop applications like TradingView are among the most complex, stateful, real-time interfaces that exist. Connecting the two raises genuine research questions about agent reliability, context management, and human-AI collaboration that have not been well-studied.

## Open Questions This Project Explores

### 1. Context Window Constraints

A full chart state with multiple indicators can easily exceed practical context limits. A single Pine Script source file can be 200KB+. OHLCV data for 500 bars is ~40KB.

How should agents prioritize what to read? This project's approach: compact-by-default output (`summary: true`, `study_filter`, deduplicated pine graphics), with verbose mode as opt-in. The tool design itself encodes a hypothesis about agent-friendly data granularity.

### 2. Temporal Consistency

Market data changes continuously. A quote fetched at the start of an agent's reasoning may be stale by the time it responds. Indicator values shift every tick.

How does an agent reason about data that may be stale by the time it responds? What's the practical latency budget for chart-reading workflows?

### 3. Tool Granularity

Should an agent have one `read_chart` tool or 84 granular tools? This project chose granularity — separate tools for quote, OHLCV, indicator values, pine lines, pine labels, pine tables, pine boxes, etc.

The tradeoff: granular tools give the agent precise control and small payloads, but require the agent to know which tool to call (solved via `CLAUDE.md` decision trees and MCP server instructions). A single coarse tool would be simpler but would waste context on unneeded data.

### 4. Failure Transparency

When an agent misreads a chart — interpreting a label incorrectly, reading stale data, or misunderstanding indicator values — how should it communicate uncertainty?

This project surfaces raw data and lets the agent reason about it, rather than pre-interpreting. This means failures are visible in the agent's reasoning trace rather than hidden behind an abstraction.

### 5. Human-in-the-Loop Design

What decisions should always require explicit human confirmation? Currently, all chart mutations (symbol changes, indicator additions, drawing) are executed immediately. Replay trading is simulated only.

The boundary between "agent acts autonomously" and "agent proposes, human confirms" is a design decision with implications for both usability and safety.

### 6. Multi-Asset Agent Reasoning

When an agent monitors multiple symbols simultaneously (via `pane_set_layout` + `stream all`), how does it reason about cross-asset relationships? Can it identify divergences, correlations, or relative strength from raw OHLCV across 4 panes?

### 7. Pine Script as Agent Output

Can an LLM agent write, debug, and iterate on Pine Script effectively? Pine Script is a domain-specific language with unusual constraints (series types, historical referencing, repainting). The compile-error-fix loop (`pine_set_source` → `pine_smart_compile` → `pine_get_errors`) tests whether agents can handle DSL-specific debugging.

## Findings So Far

### Context Management is the Primary Constraint

The most impactful design decision was making all tools return compact output by default. Without this, a single "analyze my chart" workflow would consume 80KB+ of context. With compact defaults and `study_filter`, it's 5-10KB.

### Tool Count Does Not Confuse the Agent

84 tools seems excessive, but with clear MCP server instructions and a `CLAUDE.md` decision tree, Claude consistently selects the right tools. The key is descriptive tool names and the instruction block — not reducing tool count.

### Pine Script Development is the Strongest Use Case

The compile → error → fix loop is where agent assistance provides the most value. Pine Script has unusual semantics that even experienced programmers struggle with. Having an agent that can read errors, understand the language, and propose fixes significantly accelerates development.

### Streaming Reveals Agent Latency Issues

When streaming data changes faster than the agent can respond, the agent's reasoning becomes stale. This is a fundamental limitation of request-response LLM architectures operating on real-time data. The practical solution is using streaming for human monitoring (piped to dashboards) rather than agent consumption.

## Limitations

- Depends on undocumented internal APIs subject to change without notice
- Not suitable for production automated trading
- Agent performance varies significantly by model and context length
- Real-time streaming introduces race conditions in agent reasoning
- TradingView Desktop updates can break any tool at any time
- No formal evaluation framework — findings are observational

## Related Work

- **Model Context Protocol** — Anthropic (2024). The protocol this project implements for LLM-tool communication.
- **ReAct: Synergizing Reasoning and Acting in Language Models** — Yao et al. (2022). The reasoning-action paradigm that underlies how agents use these tools.
- **FinAgent: A Multimodal Foundation Agent for Financial Trading** — Zhang et al. (2024). Explores LLM agents in financial contexts with multimodal inputs.
- **Toolformer: Language Models Can Teach Themselves to Use Tools** — Schick et al. (2023). Foundational work on LLMs learning to use external tools.
- **FinGPT: Open-Source Financial Large Language Models** — Yang et al. (2023). Open-source LLMs fine-tuned for financial applications.
- **Can Large Language Models Provide Useful Advice on How to Invest?** — Pelster & Val (2024). Studies LLM capability in financial reasoning.
