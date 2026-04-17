# Claude Code Skills, Subagents & Agent Teams — Master Reference

> Authoritative reference synthesised from the official Claude Code docs (agent-teams, skills, sub-agents) and the `fibwise-trading-claude` case study. This is the doc to consult before designing any multi-agent / multi-skill workflow in this repo.
>
> Sources (fetched 2026-04-15):
> - https://code.claude.com/docs/en/skills
> - https://code.claude.com/docs/en/sub-agents
> - https://code.claude.com/docs/en/agent-teams
> - Local: `~/engineering/saas-stock-market/fibwise-trading-claude`

---

## 0. How to read this doc

There are three primitives in Claude Code for structuring work that goes beyond a single prompt:

| Primitive      | One-line purpose                                                                 |
| :------------- | :------------------------------------------------------------------------------- |
| **Skill**      | A reusable prompt / playbook Claude can invoke by name. Cheap. Single context.   |
| **Subagent**   | A spawned worker with its own context window. Reports results back. Single session. |
| **Agent team** | Multiple parallel Claude sessions that share a task list and message each other. Experimental. |

Everything else (hooks, MCP servers, plugins) is orthogonal plumbing. Learn these three well and you can compose any workflow.

**Decision tree:**

- Recurring *prompt / procedure* → **Skill**
- Side task that would flood your context, need a *summary only* → **Subagent**
- Multiple workers that need to *talk to each other* in parallel over a long task → **Agent team** (only if 2.1.32+ and the env var is set)
- Simple question about conversation-local state → `/btw`, not a subagent

---

## 1. Mental model

```
┌──────────────────── main Claude Code session ─────────────────────┐
│                                                                   │
│  user turn ──► model ──► tools ──► model ──► text out             │
│                  ▲                                                │
│                  │ skills (in-context playbooks, inline)          │
│                  │                                                │
│                  ├──► Agent tool ──► subagent (own context)       │
│                  │                      │                         │
│                  │                      └── returns summary ──────┤
│                  │                                                │
│                  └──► SendMessage ──► teammate (separate session) │
│                                        │                         │
│                                        └── messages back ────────┤
└───────────────────────────────────────────────────────────────────┘
```

Three context regimes:

1. **Inline (skill):** content is part of the caller's context window. Loaded once on invocation, stays for the session.
2. **Forked (subagent):** brand-new context window, starts only with the system prompt + project context (CLAUDE.md, MCP, skills). Returns a summary.
3. **Separate session (teammate):** full independent Claude Code instance. Communicates via mailbox + shared task list.

---

## 2. Subagents — the foundation

Subagents are the base primitive that skills and agent teams both reuse. Master this first.

### 2.1 What they are

Specialised assistants that run **inside a single session**, each in its own context window with custom system prompt, tool access, and permissions. When Claude sees a task matching a subagent's `description`, it delegates; the subagent works independently and returns results.

Use a subagent when:

- The side task would flood your main context with logs/search results/file contents you won't reference again
- You want to enforce tool restrictions on a specific task (e.g. read-only research)
- You want to route a task to a cheaper/faster model (Haiku)
- The work is self-contained and can return a short summary

**Subagents cannot spawn other subagents.** For nested delegation use skills, or chain subagents from the main conversation.

### 2.2 File format

Subagents are Markdown files with YAML frontmatter. The body is the subagent's system prompt.

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

The subagent receives **only this system prompt** plus basic environment details (cwd, etc.). It does **not** see the main Claude Code system prompt, does **not** inherit conversation history, does **not** inherit parent skills. `CLAUDE.md` and MCP servers *are* loaded from the project the same way a regular session loads them.

### 2.3 Scopes & precedence

| Location                        | Scope                   | Priority    |
| :------------------------------ | :---------------------- | :---------- |
| Managed settings                | Organization-wide       | 1 (highest) |
| `--agents` CLI flag             | Current session         | 2           |
| `.claude/agents/`               | Current project         | 3           |
| `~/.claude/agents/`             | All your projects       | 4           |
| Plugin's `agents/` directory    | Where plugin is enabled | 5 (lowest)  |

Project subagents are discovered by walking up from cwd. `--add-dir` directories are **not** scanned for subagents (unlike skills, which *are* loaded from `--add-dir`).

CLI-defined subagents exist only for that session. Example:

```bash
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer...",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  }
}'
```

`prompt` in JSON ≡ the markdown body in a file-based subagent.

Plugin subagents **ignore** `hooks`, `mcpServers`, and `permissionMode` frontmatter for security. Copy the file into `.claude/agents/` to re-enable them.

### 2.4 Frontmatter — every field

Only `name` and `description` are required.

| Field             | Purpose                                                                                                  |
| :---------------- | :------------------------------------------------------------------------------------------------------- |
| `name`            | Unique identifier, lowercase + hyphens                                                                   |
| `description`     | When Claude should delegate. Write this like a trigger phrase                                            |
| `tools`           | Allowlist. Inherits all tools if omitted                                                                 |
| `disallowedTools` | Denylist. Applied before `tools`                                                                         |
| `model`           | `sonnet`, `opus`, `haiku`, full model ID (`claude-opus-4-6`), or `inherit`. Defaults to `inherit`         |
| `permissionMode`  | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`                                 |
| `maxTurns`        | Cap on agentic turns before stopping                                                                     |
| `skills`          | Skills to **preload** into this subagent's context at startup (full content, not just listed)            |
| `mcpServers`      | MCP servers available to this subagent. Inline definition or string reference to an existing server      |
| `hooks`           | Lifecycle hooks scoped to this subagent                                                                  |
| `memory`          | `user`, `project`, or `local`. Enables persistent `MEMORY.md` directory across conversations             |
| `background`      | `true` → always run in the background                                                                    |
| `effort`          | `low`, `medium`, `high`, `max` (Opus 4.6 only)                                                           |
| `isolation`       | `worktree` → run in a temp git worktree with its own copy of the repo                                    |
| `color`           | Display colour. `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`                     |
| `initialPrompt`   | First user turn when this subagent runs as the main agent via `--agent`                                  |

### 2.5 Tool control

Two knobs:

- `tools: Read, Grep, Glob, Bash` — pure allowlist
- `disallowedTools: Write, Edit` — denylist, everything else inherited

If both set, deny is applied first, then allow is resolved against the remainder.

**Restrict which subagents a main-thread agent can spawn** with `Agent(type1, type2)` syntax:

```yaml
tools: Agent(worker, researcher), Read, Bash
```

Only applies when that agent is running as the main thread (`claude --agent`). Subagents themselves cannot spawn subagents anyway.

### 2.6 Model resolution order

1. `CLAUDE_CODE_SUBAGENT_MODEL` env var
2. Per-invocation `model` parameter
3. Frontmatter `model`
4. Main conversation's model

### 2.7 Skill preloading vs fork

Two symmetric composition patterns:

| Approach                        | System prompt                 | Task                         | Also loads                   |
| :------------------------------ | :---------------------------- | :--------------------------- | :--------------------------- |
| **Subagent with `skills` field** | Subagent's markdown body      | Claude's delegation message  | Preloaded skills + CLAUDE.md |
| **Skill with `context: fork`**  | From agent type               | SKILL.md content             | CLAUDE.md                    |

Preloading injects *full* skill content (not just the description) into the subagent on startup.

```yaml
---
name: api-developer
description: Implement API endpoints following team conventions
skills:
  - api-conventions
  - error-handling-patterns
---

Implement API endpoints. Follow the preloaded skill conventions.
```

### 2.8 MCP scoping

`mcpServers` lets a subagent use MCP servers that aren't in the main conversation — useful when the tool descriptions would otherwise bloat the main context.

```yaml
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  - github   # string reference = share parent's connection
```

### 2.9 Persistent memory

`memory: user | project | local` gives the subagent a `MEMORY.md`-backed directory that survives across sessions.

| Scope     | Location                                      |
| :-------- | :-------------------------------------------- |
| `user`    | `~/.claude/agent-memory/<name>/`              |
| `project` | `.claude/agent-memory/<name>/`                |
| `local`   | `.claude/agent-memory-local/<name>/`          |

When memory is enabled: Read/Write/Edit auto-enabled, first 200 lines or 25KB of `MEMORY.md` injected into system prompt, subagent prompted to curate it.

Recommended: tell the subagent "consult your memory before starting" and "update your memory after finishing" in the body.

### 2.10 Permission modes

| Mode                | Behavior                                                                      |
| :------------------ | :---------------------------------------------------------------------------- |
| `default`           | Normal prompts                                                                |
| `acceptEdits`       | Auto-accept file edits in cwd / `additionalDirectories`                       |
| `auto`              | Background classifier reviews tool calls                                      |
| `dontAsk`           | Auto-deny permission prompts (allowlisted tools still work)                   |
| `bypassPermissions` | Skip prompts. `.git`, `.claude`, `.vscode`, `.idea`, `.husky` still prompt    |
| `plan`              | Read-only exploration                                                         |

If parent is `bypassPermissions`, subagent inherits and **cannot** override. If parent is `auto`, subagent inherits auto; frontmatter `permissionMode` is ignored.

### 2.11 Hooks in frontmatter

Subagent-scoped hooks run only while that subagent is active. Cleaned up when it finishes. `Stop` → auto-converted to `SubagentStop`.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./scripts/run-linter.sh"
```

Frontmatter hooks fire when spawned as a subagent via Agent tool / @-mention. They do **not** fire when running as the main session (`--agent`). For session-wide hooks use `settings.json` with `SubagentStart` / `SubagentStop`.

### 2.12 Built-in subagents

| Agent             | Model    | Tools                                              | Purpose                                                                 |
| :---------------- | :------- | :------------------------------------------------- | :---------------------------------------------------------------------- |
| **Explore**       | Haiku    | Read-only (no Write/Edit)                          | Fast codebase search. Claude delegates with a thoroughness level        |
| **Plan**          | Inherits | Read-only                                          | Research during plan mode                                               |
| **general-purpose** | Inherits | All tools                                          | Multi-step tasks needing exploration + action                           |
| statusline-setup  | Sonnet   | —                                                  | `/statusline` configuration                                             |
| Claude Code Guide | Haiku    | —                                                  | Questions about Claude Code itself                                      |

Explore accepts a **thoroughness** level: `quick`, `medium`, `very thorough`. Pass this in the dispatch prompt.

### 2.13 Invoking subagents

Four patterns, escalating:

1. **Automatic delegation** — Claude decides based on `description`. Add "use proactively" to encourage it.
2. **Natural language** — `"Use the code-reviewer subagent to look at my changes"`. Claude usually obeys.
3. **@-mention** — `@"code-reviewer (agent)" look at the auth changes` — guarantees that subagent runs.
4. **Session-wide** — `claude --agent code-reviewer` makes the main thread adopt the subagent's system prompt + restrictions. Or set `{"agent": "code-reviewer"}` in `.claude/settings.json`. CLI flag beats setting.

### 2.14 Foreground vs background

- **Foreground:** blocks main conversation. Permission prompts / clarifying questions pass through to user.
- **Background:** concurrent. Permissions pre-approved upfront; anything not pre-approved auto-denies. Clarifying questions fail silently but subagent continues.

Ctrl+B backgrounds a running task. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` disables backgrounding entirely.

### 2.15 Resume, transcripts, compaction

Each invocation creates a new instance with fresh context. **Resume** continues an existing subagent via `SendMessage` (requires agent-teams env var enabled).

- Transcripts: `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`
- Retained for `cleanupPeriodDays` (default 30)
- Subagent auto-compacts at ~95% capacity; override with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`

### 2.16 Common patterns

**Isolate high-volume operations:**
> "Use a subagent to run the test suite and report only the failing tests with their error messages"

**Parallel research:**
> "Research the authentication, database, and API modules in parallel using separate subagents"

**Chained subagents:**
> "Use the code-reviewer subagent to find performance issues, then use the optimizer subagent to fix them"

### 2.17 Verbatim example — code-reviewer

```markdown
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Review checklist:
- Code is clear and readable
- Functions and variables are well-named
- No duplicated code
- Proper error handling
- No exposed secrets or API keys
- Input validation implemented
- Good test coverage
- Performance considerations addressed

Provide feedback organized by priority:
- Critical issues (must fix)
- Warnings (should fix)
- Suggestions (consider improving)

Include specific examples of how to fix issues.
```

### 2.18 Gotchas

- Subagents **cannot** spawn subagents
- Subagents **don't** inherit the parent's conversation history
- Subagents **don't** inherit parent skills — list them in `skills:` explicitly
- `cd` inside a subagent's Bash does not persist between calls and doesn't affect the main cwd
- New subagent files require a session restart OR `/agents` refresh to be picked up
- Each returned result is added to parent context — many subagents returning long reports can still blow up the parent

---

## 3. Skills — reusable prompt playbooks

### 3.1 What a skill is

A `SKILL.md` file with YAML frontmatter + markdown body that extends what Claude can do. Claude Code loads the *description* into context always, so Claude knows it exists; the body only loads when the skill is invoked.

Create a skill when you keep pasting the same playbook, checklist, or multi-step procedure into chat, or when a CLAUDE.md section has grown into a procedure. Unlike CLAUDE.md content, skill bodies cost almost nothing until used.

**Commands merged:** `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both produce `/deploy`. Skill form adds a directory for supporting files and more frontmatter options.

Claude Code skills follow the [Agent Skills](https://agentskills.io) open standard and extend it with invocation control, subagent execution (`context: fork`), and dynamic context injection.

### 3.2 Where skills live

| Location   | Path                                                | Scope                      |
| :--------- | :-------------------------------------------------- | :------------------------- |
| Enterprise | Managed settings                                    | All users in the org       |
| Personal   | `~/.claude/skills/<skill-name>/SKILL.md`            | All your projects          |
| Project    | `.claude/skills/<skill-name>/SKILL.md`              | This project only          |
| Plugin     | `<plugin>/skills/<skill-name>/SKILL.md`             | Where plugin is enabled    |

Precedence: enterprise > personal > project. Plugin skills use `plugin-name:skill-name` namespace so they can't collide.

**Live change detection:** adding / editing / removing a skill under a watched directory takes effect **in the current session** without restart. Creating a *new top-level* `.claude/skills/` requires a restart.

**Nested discovery:** if you're editing a file in `packages/frontend/`, Claude also picks up `packages/frontend/.claude/skills/`. Good for monorepos.

**`--add-dir`:** grants file access, but `.claude/skills/` *is* loaded from added directories (this is an exception — other `.claude/` config is not).

### 3.3 Structure

```
my-skill/
├── SKILL.md           # required entrypoint
├── reference.md       # loaded only when needed (progressive disclosure)
├── examples/
│   └── sample.md
└── scripts/
    └── helper.py      # executed, not loaded
```

Reference supporting files from `SKILL.md` so Claude knows what they contain and when to load them:

```markdown
## Additional resources
- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

Keep `SKILL.md` under 500 lines. Move bulk reference material to sub-files.

### 3.4 Frontmatter — every field

All optional; only `description` is recommended.

| Field                      | Purpose                                                                                                                   |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `name`                     | Display / slash-command name. Lowercase letters, numbers, hyphens (max 64). Defaults to directory name                    |
| `description`              | What the skill does and when to use it. Claude uses this to decide when to auto-load. **Front-load the key use case.**     |
| `when_to_use`              | Extra trigger phrases / examples. Appended to description                                                                 |
| `argument-hint`            | Shown during autocomplete. E.g. `[issue-number]` or `[filename] [format]`                                                 |
| `disable-model-invocation` | `true` → only user can invoke via `/name`. Use for things with side effects (deploy, commit, send message)                |
| `user-invocable`           | `false` → hide from `/` menu. Use for background knowledge skills users shouldn't trigger directly                         |
| `allowed-tools`            | Tools this skill can use without per-use approval while active. Space-separated string or YAML list                       |
| `model`                    | Model to use when this skill is active                                                                                    |
| `effort`                   | `low`, `medium`, `high`, `max` (Opus 4.6)                                                                                 |
| `context`                  | `fork` → run in a forked subagent                                                                                         |
| `agent`                    | Which subagent type to use when `context: fork`                                                                           |
| `hooks`                    | Hooks scoped to this skill's lifecycle                                                                                    |
| `paths`                    | Glob patterns. Skill auto-loads only when working with matching files                                                     |
| `shell`                    | `bash` (default) or `powershell`. Controls `` !`cmd` `` block execution                                                   |

**Description budget:** combined `description` + `when_to_use` is truncated at **1,536 characters**. Total skill-listing budget is dynamic at 1% of the context window (fallback 8,000 chars). Bump via `SLASH_COMMAND_TOOL_CHAR_BUDGET`.

### 3.5 String substitutions

| Variable               | What it expands to                                                                  |
| :--------------------- | :---------------------------------------------------------------------------------- |
| `$ARGUMENTS`           | Full argument string. If absent, args appended as `ARGUMENTS: <value>`              |
| `$ARGUMENTS[N]`        | 0-indexed positional argument                                                       |
| `$N`                   | Shorthand for `$ARGUMENTS[N]` (`$0`, `$1`, ...)                                     |
| `${CLAUDE_SESSION_ID}` | Current session ID                                                                  |
| `${CLAUDE_SKILL_DIR}`  | Directory of the skill's `SKILL.md`. Use for referencing bundled scripts            |

Indexed arguments use shell-style quoting. `/my-skill "hello world" second` → `$0 = hello world`, `$1 = second`.

### 3.6 Invocation control matrix

| Frontmatter                       | User can invoke | Claude can invoke | Description in context    |
| :-------------------------------- | :-------------- | :---------------- | :------------------------ |
| (default)                         | Yes             | Yes               | Always                    |
| `disable-model-invocation: true`  | Yes             | No                | No                        |
| `user-invocable: false`           | No              | Yes               | Always                    |

`user-invocable: false` only hides from the menu — it does **not** block programmatic Skill-tool access. Use `disable-model-invocation: true` to actually block Claude.

### 3.7 Skill content lifecycle

When invoked, the rendered `SKILL.md` content becomes **a single message** that stays in context for the rest of the session. Claude Code **does not re-read** the skill file on later turns — write standing instructions, not one-time steps.

**Auto-compaction:** after summarisation, Claude Code re-attaches the most recent invocation of each skill, keeping the first 5,000 tokens. Combined re-attach budget is 25,000 tokens filled newest-first, so older skills can be dropped entirely.

If a skill seems to stop influencing behaviour after the first response: the content is still there. Strengthen the description/instructions, use hooks to enforce deterministically, or re-invoke the skill after compaction.

### 3.8 Pre-approved tools

`allowed-tools` grants permission while the skill is active — so Claude can use those tools without prompting. It does **not** restrict tools: other tools remain available under normal permission rules.

```yaml
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
```

To *block* a skill's use of a tool, add deny rules in `/permissions`.

### 3.9 Dynamic context injection

The `` !`cmd` `` syntax runs a shell command **before** the skill content is sent to Claude. The output replaces the placeholder. Claude never sees the command, only the result.

```markdown
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull request context
- PR diff: !`gh pr diff`
- Comments: !`gh pr view --comments`
- Files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

Multi-line form — fenced code block opened with ` ```! `:

````markdown
```!
node --version
npm --version
git status --short
```
````

Kill-switch for non-bundled skills: `"disableSkillShellExecution": true` in settings.

### 3.10 Running a skill in a subagent

`context: fork` → skill content becomes the prompt for a subagent. Isolated context. No conversation history.

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

Caveat: `context: fork` only makes sense for skills with an explicit **task**. Pure reference-content skills with `context: fork` leave the subagent with guidelines but no action — it returns nothing useful.

`agent` picks the subagent configuration (`Explore`, `Plan`, `general-purpose`, or any custom subagent from `.claude/agents/`). Defaults to `general-purpose`.

### 3.11 Skills vs commands vs CLAUDE.md

| For...                                    | Use                                                                                   |
| :---------------------------------------- | :------------------------------------------------------------------------------------ |
| A fact that should always be in context    | CLAUDE.md                                                                             |
| A playbook you sometimes invoke            | Skill (default)                                                                       |
| A playbook only you should trigger        | Skill with `disable-model-invocation: true`                                           |
| Background knowledge Claude needs contextually | Skill with `user-invocable: false`                                                  |
| A bash one-liner / fixed logic            | Built-in command (not a skill)                                                        |
| Heavy research that would bloat context   | Skill with `context: fork`                                                            |

### 3.12 Bundled scripts example

Skills can ship executables in any language. Reference via `${CLAUDE_SKILL_DIR}`:

```yaml
---
name: codebase-visualizer
description: Generate an interactive collapsible tree of your codebase
allowed-tools: Bash(python *)
---

python ${CLAUDE_SKILL_DIR}/scripts/visualize.py .
```

This pattern is how heavy domain logic (PDF generation, data plotting, API clients) can live in skills without bloating prompts.

### 3.13 Restricting skill access

- **Disable all skills:** deny `Skill` in `/permissions`
- **Allow specific:** `Skill(commit)`, `Skill(review-pr *)` (prefix match)
- **Deny specific:** `Skill(deploy *)`
- **Remove from Claude's toolkit entirely:** `disable-model-invocation: true`

### 3.14 Gotchas

- Description truncated at 1,536 chars — front-load the trigger phrase
- `name` limited to 64 chars, lowercase + hyphens only
- Skill content is **not** re-read per turn — write standing instructions
- Progressive-disclosure files aren't auto-loaded; they load only if Claude chooses to read them, so reference them clearly
- `user-invocable: false` does not prevent programmatic Skill-tool calls; use `disable-model-invocation: true` for true hiding
- If a skill stops influencing behaviour, it's usually still loaded — Claude just isn't matching it. Strengthen the description or add hooks

---

## 4. Agent teams — experimental parallel sessions

> Experimental. Disabled by default. Requires Claude Code **v2.1.32+** and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
> Known limitations around resume, task coordination, and shutdown (see 4.10).

### 4.1 What they are

Multiple Claude Code **instances** working together. One session acts as **lead**; teammates each run in their own context window with their own terminal session. Teammates can message each other directly — not just report to the lead — and they share a task list.

This is distinct from subagents. Subagents are spawned by a single session and only report back; teammates are peers that coordinate.

### 4.2 Subagents vs teammates

|               | Subagents                                | Agent teams                              |
| :------------ | :--------------------------------------- | :--------------------------------------- |
| Context       | Own window; result returns to caller     | Own window; fully independent session    |
| Communication | Back to main agent only                  | Any teammate can message any other       |
| Coordination  | Main agent manages                       | Shared task list, self-coordination      |
| Best for      | Focused work where only the result matters | Complex work requiring debate/coordination |
| Token cost    | Lower (result summarised back)           | Higher (each teammate is a separate instance) |

Use subagents for quick focused workers that report back. Use agent teams when teammates need to share findings, challenge each other, and coordinate autonomously.

### 4.3 Enable

```json
// settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 4.4 Starting a team

Tell Claude in natural language. Example (the three roles are independent — good fit):

```
I'm designing a CLI tool that helps developers track TODO comments across their codebase.
Create an agent team to explore this from different angles: one teammate on UX, one on
technical architecture, one playing devil's advocate.
```

Claude creates a team, spawns teammates, and coordinates. You keep control — Claude won't create a team without your approval.

### 4.5 Architecture

| Component     | Role                                                                                       |
| :------------ | :----------------------------------------------------------------------------------------- |
| **Team lead** | The session that creates the team. Spawns teammates, coordinates work                      |
| **Teammates** | Separate Claude Code instances. Each has own context window                                 |
| **Task list** | Shared work items. Teammates claim or get assigned                                          |
| **Mailbox**   | Messaging system. Any teammate → any teammate                                              |

Local storage:
- Team config: `~/.claude/teams/{team-name}/config.json`
- Task list: `~/.claude/tasks/{team-name}/`

**Do not hand-edit** the team config — it's runtime state and gets overwritten. There is no project-level equivalent (a file like `.claude/teams/teams.json` is ignored).

### 4.6 Display modes

- **In-process** (default in normal terminals) — all teammates in your main terminal. Shift+Down cycles. Press Enter to view a session, Escape to interrupt, Ctrl+T for task list.
- **Split panes** (requires tmux or iTerm2+it2 CLI) — each teammate gets a pane. Click into one to interact.

Override with `{"teammateMode": "tmux"}` in `~/.claude.json`, or `claude --teammate-mode in-process` per session.

### 4.7 Controlling the team

Natural language. Examples:

**Specify count and model:**
```
Create a team with 4 teammates to refactor these modules in parallel. Use Sonnet for each teammate.
```

**Require plan approval** (teammate sits in read-only plan mode until lead approves):
```
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```

If rejected, teammate revises in plan mode. Influence the lead's approval criteria in your prompt ("only approve plans with test coverage").

**Direct messaging:** each teammate is a full session. In-process: Shift+Down to target, then type. Split-panes: click the pane.

**Assign / claim tasks:** lead creates tasks; teammates self-claim the next unblocked one after finishing, or lead assigns explicitly. File locking prevents race conditions.

**Shut down a teammate:**
```
Ask the researcher teammate to shut down
```
Teammate can approve or reject with explanation.

**Clean up:** `Clean up the team`. Always run cleanup **from the lead** — doing it from a teammate risks inconsistent state. Cleanup fails if any teammate is still running.

### 4.8 Quality gates with hooks

- **`TeammateIdle`** — fires when a teammate is about to go idle. Exit code 2 → feedback + keep working
- **`TaskCreated`** — fires when a task is being created. Exit code 2 → prevent creation
- **`TaskCompleted`** — fires when a task is being marked complete. Exit code 2 → prevent completion

### 4.9 Using subagent definitions as teammate roles

Define a role once (e.g. `security-reviewer`) and reuse as both a delegated subagent and an agent-team teammate:

```
Spawn a teammate using the security-reviewer agent type to audit the auth module.
```

Teammate honours the definition's `tools` allowlist and `model`, and the body is **appended** to the teammate's system prompt (not a replacement). Team coordination tools (`SendMessage`, task tools) are always available.

**Not applied when running as a teammate:** `skills` and `mcpServers` frontmatter fields. Teammates load skills and MCP servers from project/user settings, same as any session.

### 4.10 Permissions & tokens

- Teammates start with **the lead's permission settings**. `--dangerously-skip-permissions` lead → all teammates too.
- You can change individual teammate modes after spawning, but not at spawn time.
- Tokens: scale linearly with teammates. Start with **3–5 teammates**, **5–6 tasks per teammate**. Research/review > single session on tokens for the kinds of tasks that benefit.

### 4.11 Best practices

- **Give enough context in spawn prompt** — teammates don't inherit conversation history. Project context loads automatically (CLAUDE.md, MCP, skills).
- **Start with research/review** — not parallel implementation. Parallel implementation fights file conflicts.
- **Avoid same-file edits** — break work so each teammate owns different files.
- **Wait for teammates** — lead sometimes starts working itself. Nudge: `"Wait for your teammates to complete their tasks before proceeding"`.
- **Size tasks right** — too small = coordination overhead, too large = long uncheckable work.
- **Monitor and steer** — check in; redirect; synthesise as findings come in.

### 4.12 Current limitations

- **No session resumption with in-process teammates** — `/resume` / `/rewind` don't restore teammates. Lead may try to message ghosts.
- **Task status can lag** — teammates occasionally don't mark tasks complete, blocking dependents.
- **Shutdown can be slow** — teammates finish current tool call before exiting.
- **One team per lead session**; **no nested teams**; **lead is fixed** for team lifetime.
- **Permissions set at spawn** — per-teammate permission modes not settable at spawn time.
- **Split panes need tmux or iTerm2** — default in-process works everywhere.

### 4.13 Canonical example: investigate with competing hypotheses

```
Users report the app exits after one message instead of staying connected.
Spawn 5 agent teammates to investigate different hypotheses. Have them talk to
each other to try to disprove each other's theories, like a scientific debate.
Update the findings doc with whatever consensus emerges.
```

The debate structure beats sequential investigation because it fights anchoring — once one theory is explored, further work biases toward it.

---

## 5. Composition matrix — how they interact

Read this table as: *given the caller in the row, what happens with the item in the column?*

|                        | Invoke a **skill**                                                   | Spawn a **subagent**                                                 | Spawn a **teammate** (agent team)                            |
| :--------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------- | :----------------------------------------------------------- |
| **Main session**       | Inline; description always in context; body loads on invoke          | Agent tool; returns summary; no nesting                              | Only the lead. Separate session, mailbox + task list         |
| **Subagent**           | Preload via `skills:` frontmatter (full content) or invoke at runtime | **Cannot** spawn further subagents                                   | n/a                                                          |
| **Skill `context: fork`** | n/a (the skill *is* forking)                                        | Becomes the subagent's prompt; `agent:` picks the subagent type      | n/a                                                          |
| **Teammate**           | Teammates load skills from project/user settings (not from teammate-role frontmatter `skills`)   | Teammate can dispatch subagents like any session                    | **Cannot** spawn nested teams                                |

**The two symmetric subagent↔skill compositions:**

| Direction                 | System prompt              | Task                         | Extras loaded                |
| :------------------------ | :------------------------- | :--------------------------- | :--------------------------- |
| Skill with `context: fork` | Built-in agent type        | SKILL.md content             | CLAUDE.md                    |
| Subagent with `skills`    | Subagent's markdown body   | Claude's delegation message  | Preloaded skills + CLAUDE.md |

Pick *skill fork* when you have a self-contained task script that should run in isolation. Pick *subagent preload* when you have a long-lived specialist that needs reference knowledge at startup.

---

## 6. Case study — `fibwise-trading-claude`

A production-style trading research system built entirely on Claude Code skills + agents. Location: `~/engineering/saas-stock-market/fibwise-trading-claude`. Worth studying because it shows the patterns at scale.

### 6.1 Layout

```
fibwise-trading-claude/
├── trade/
│   └── SKILL.md                     # single /trade router
├── skills/                          # 16 independent analysis skills
│   ├── trade-analyze/SKILL.md       # orchestrator, 5-agent parallel
│   ├── trade-quick/SKILL.md         # 60s snapshot, no subagents
│   ├── trade-technical/SKILL.md
│   ├── trade-fundamental/SKILL.md
│   ├── trade-sentiment/SKILL.md
│   ├── trade-risk/SKILL.md
│   ├── trade-thesis/SKILL.md
│   ├── trade-sector/SKILL.md
│   ├── trade-compare/SKILL.md
│   ├── trade-options/SKILL.md
│   ├── trade-earnings/SKILL.md
│   ├── trade-portfolio/SKILL.md
│   ├── trade-screen/SKILL.md
│   ├── trade-watchlist/SKILL.md
│   └── trade-report-pdf/SKILL.md
├── agents/                          # 5 agent definitions (.md, no SKILL.md)
│   ├── trade-technical.md
│   ├── trade-fundamental.md
│   ├── trade-sentiment.md
│   ├── trade-risk.md
│   └── trade-thesis.md
└── scripts/
    └── generate_trade_pdf.py        # invoked from a skill via allowed-tools Bash
```

### 6.2 Three canonical skill archetypes

1. **Triage skill** (`trade-quick`): single-stage, parallel WebSearches, fixed ~40-line terminal output, no subagent calls, sub-60-second target.
2. **Comprehensive analysis skill** (`trade-technical`, `trade-fundamental`): multi-stage, 5-dimension 0–20 rubric, writes a markdown file, callable independently OR as a subagent from the orchestrator.
3. **Orchestrator skill** (`trade-analyze`): 3-phase — discovery → 5 parallel subagents → synthesis. Produces master report.

### 6.3 Orchestration pattern — verbatim

```
User runs: /trade analyze AAPL
        ↓
    trade-analyze skill activates
        ↓
    PHASE 1 (orchestrator):
      1. WebSearch price & context
      2. WebSearch company overview
      3. WebSearch recent news
      4. WebSearch financial metrics
      5. Compile DISCOVERY_BRIEF
        ↓
    PHASE 2 (parallel Agent tool calls, SAME response):
      Agent → Technical Agent
      Agent → Fundamental Agent
      Agent → Sentiment Agent
      Agent → Risk Agent
      Agent → Thesis Agent
        ↓
    PHASE 3 (orchestrator):
      1. Extract sub-scores from each JSON
      2. Composite = weighted avg (T 0.25, F 0.25, S 0.20, R 0.15, Th 0.15)
      3. Grade (A+..F) and signal (Strong Buy..Avoid)
      4. Write TRADE-ANALYSIS-<TICKER>.md
```

The orchestrator is **obsessive** about parallelism:

> "CRITICAL: Launch all 5 agents in the SAME response. This is what makes the analysis fast. Do NOT wait for one to finish before launching the next."

### 6.4 The DISCOVERY_BRIEF anti-redundancy pattern

Phase 1 exists specifically so that Phase 2 agents don't all independently search for the same basics.

> "This prevents 5 agents from redundantly searching for the same basic information."

Every agent gets the full DISCOVERY_BRIEF as context in its dispatch prompt. Agents then use WebSearch *only* for their specific deep dives.

### 6.5 Composite scoring architecture

Each agent produces **5 sub-scores of 0–20** → agent composite of 0–100. Orchestrator combines the five composites with explicit weights:

```
Composite =
  (Technical   × 0.25) +
  (Fundamental × 0.25) +
  (Sentiment   × 0.20) +
  (Risk        × 0.15) +
  (Thesis      × 0.15)
```

Grade mapping:

| Range  | Grade | Signal              |
| :----- | :---- | :------------------ |
| 85–100 | A+    | Strong Buy          |
| 70–84  | A     | Buy                 |
| 55–69  | B     | Hold / Accumulate   |
| 40–54  | C     | Neutral             |
| 25–39  | D     | Caution             |
| 0–24   | F     | Avoid               |

**Graceful degradation** if an agent fails: drop its weight, rescale the remaining proportionally.

### 6.6 Notable patterns worth copying

- **Inverted risk score** — higher = *safer*. Forces explicit thinking, stops scoring inflation. Position size increases with risk score (counterintuitive at first).
- **JSON output contract** — every agent returns a strict JSON shape so the orchestrator can aggregate deterministically.
- **Rules block convention** — every skill and agent ends with a numbered "Rules" section of ~10 items (data sources, scoring methodology, distinctions, special cases, tone).
- **Mandatory disclaimer** — `"For educational/research purposes only. Not financial advice."` on every output.
- **Never-fabricate rule** — `"If you cannot find a metric, say 'Data not available' and score conservatively"`. Prevents hallucination over interpolation.
- **Contrarian detection** — multiple skills embed "what if the obvious read is wrong?" checks (euphoric buzz → top; panic → bottom; unanimous consensus → crowded).
- **Sector-specific assessment blocks** — Tech vs Healthcare vs Financials vs Energy vs REITs get different key-metric emphasis.
- **Market-cap tier adjustments** — large/mid/small/micro/ETF get different weights on signals (insider buying weighted heavier for small caps, analyst ratings for large caps).
- **Output file naming convention** — `TRADE-<SKILL>-<TICKER>.md`. Single predictable pattern.
- **Pull-based PDF generator** — `trade-report-pdf` scans cwd for `TRADE-*.md`, parses scores, shells out to a bundled Python script. Decoupled, reusable.

### 6.7 Verbatim — skill frontmatter examples

```yaml
# skills/trade-quick/SKILL.md
---
name: trade-quick
description: 60-Second Stock Snapshot — fast assessment with signal, key factors, and levels without launching subagents
---
```

```yaml
# skills/trade-analyze/SKILL.md
---
name: trade-analyze
description: Full Stock Analysis Orchestrator — launches 5 parallel subagents for comprehensive multi-dimensional stock analysis with composite Trade Score
---
```

```yaml
# skills/trade-risk/SKILL.md
---
name: trade-risk
description: Risk Assessment & Position Sizing — analyzes volatility, drawdown scenarios, correlation, liquidity, and provides position sizing calculators (Kelly Criterion, fixed percentage, volatility-adjusted) with a composite Risk Score (0-100) for any publicly traded stock.
---
```

Pattern: name is kebab-case namespaced on `trade-`, description leads with the *what* and packs the *when-to-use* keywords in the same sentence.

### 6.8 Verbatim — agent dispatch template (from `trade-analyze`)

```
You are a [ROLE] specialist. Analyze <TICKER> using the discovery data below.

DISCOVERY DATA:
<insert DISCOVERY_BRIEF here>

YOUR MANDATE — Deliver comprehensive analysis covering:
1. [dimension 1]
2. [dimension 2]
...

SCORING — Provide a [Score] (0-100) broken into:
   - [Sub 1]: 0-20
   - [Sub 2]: 0-20
   ...

Return your analysis in this exact format:
## [Analysis Type]: <TICKER>
### [Score Type]: [X]/100
[breakdown table]
### Signal: [classification]
[detailed analysis sections]

DISCLAIMER: For educational/research purposes only. Not financial advice.
```

### 6.9 Key takeaway

Fibwise uses **agents** (the `/agents/*.md` files) as *role prompts dispatched by the Agent tool from within a skill*, not as registered `.claude/agents/` subagents. They're instruction templates that `trade-analyze` embeds into Agent-tool calls. This is a legitimate alternative to formal subagent definitions when you want tight coupling between an orchestrator skill and its workers, and don't need the workers to be independently addressable (`/agents`, `@-mention`, etc.).

For a repo where workers should also be reusable standalone (outside the orchestrator), prefer real subagent definitions in `.claude/agents/` plus `skills:` preloading.

---

## 7. Canonical templates

### 7.1 Simple procedural skill

```yaml
---
name: quick-diagnose
description: Run a fast repo-wide health check. Use when the user asks "is this repo healthy?", before a release, or when triaging a failing build.
allowed-tools: Bash(git *) Bash(npm *)
---

# Quick repo diagnosis

Run these checks in parallel, then produce a short punch-list:

!`git status --short`
!`git log --oneline -5`
!`node --version`

Then assess:
1. Uncommitted work
2. Stale branch
3. Node version mismatch

Output in under 20 lines.
```

### 7.2 Skill that forks into a subagent

```yaml
---
name: deep-research
description: Thoroughly research a topic in an isolated context so findings don't flood this conversation. Use when the user asks "research X" or for codebase-wide investigation.
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:

1. Find relevant files (Glob + Grep)
2. Read the code
3. Summarize with specific file:line references
```

### 7.3 Orchestrator skill (fibwise-style, parallel specialists)

```yaml
---
name: ticker-pulse
description: Full multi-dimensional ticker analysis. Launches 3 parallel specialist subagents and synthesises their output.
---

# Ticker pulse — $ARGUMENTS

## Phase 1 — gather shared context

Use the TradingView MCP tools to get:
- Current chart state, symbol, timeframe
- Latest OHLCV summary (summary=true)
- Active indicator values

Compile a DISCOVERY_BRIEF with these facts.

## Phase 2 — launch 3 specialists IN THE SAME RESPONSE

Dispatch three Agent-tool calls in parallel:

- **trend-agent** (uses `trend-specialist` subagent)
- **setup-agent** (uses `setup-specialist` subagent)
- **risk-agent** (uses `risk-specialist` subagent)

Each receives DISCOVERY_BRIEF + its specific mandate.

## Phase 3 — synthesize

Collect their JSON outputs. Compute composite = T*0.4 + S*0.4 + R*0.2.
Produce a terminal-only 20-line summary.

## Rules
1. Never fabricate data — say "Data not available" and score conservatively
2. All three agents MUST be dispatched in a single response
3. Risk score is inverted: higher = safer
```

### 7.4 Specialist subagent

```markdown
---
name: trend-specialist
description: Trend analysis specialist for live charts. Use proactively when the orchestrator dispatches trend work, or when the user asks for "trend" / "momentum" / "direction".
tools: mcp__tradingview__chart_get_state, mcp__tradingview__data_get_study_values, mcp__tradingview__data_get_ohlcv
model: sonnet
---

You are a trend analysis specialist.

When invoked, the orchestrator will pass you a DISCOVERY_BRIEF and a mandate.

Your job:
1. Read the brief; do not re-fetch basics
2. Use the TradingView MCP tools to confirm EMA stack, MA direction, HH/HL structure
3. Score 5 sub-dimensions, 0–20 each: trend direction, EMA alignment, price structure, relative strength, persistence
4. Return strict JSON per the orchestrator's format

Never fabricate. If a value isn't available, say so and score conservatively.

DISCLAIMER: Educational/research only. Not financial advice.
```

### 7.5 Agent-team kickoff prompt

```
Create an agent team to diagnose why the bot's stop-loss placement keeps drifting.
Spawn 3 teammates with these distinct lenses:
- data-auditor: investigate the OHLCV/indicator values the bot sees
- logic-auditor: investigate the decision code
- devils-advocate: try to disprove whatever hypothesis the other two converge on

Have them debate. Update findings.md with the consensus when they agree.
Only approve plans that include a repro test.
```

---

## 8. Gotchas cheat sheet

### Skills
- Description + when_to_use capped at **1,536 chars** — front-load keywords
- Skill body is **not** re-read per turn — write standing instructions
- `user-invocable: false` does not block Skill-tool calls; use `disable-model-invocation: true` for real hiding
- `.claude/commands/` still works; skills override commands of the same name
- New top-level `.claude/skills/` dir → session restart. Adding to an existing dir → live
- `context: fork` needs an explicit task — pure reference skills fork into nothing useful
- Progressive-disclosure files must be **referenced** in SKILL.md, otherwise Claude never looks

### Subagents
- **No nesting.** Subagents cannot spawn subagents.
- Don't inherit parent conversation history; don't inherit parent skills — list them in `skills:`.
- New agent files require session restart or `/agents` refresh.
- `cd` in subagent Bash doesn't persist and doesn't affect the main cwd.
- `bypassPermissions` and `auto` at the parent override the subagent's `permissionMode`.
- Plugin subagents ignore `hooks`, `mcpServers`, `permissionMode`.
- Results flow back into parent context — many verbose returns can still blow up the parent.

### Agent teams
- Experimental. Requires **v2.1.32+** and the env var.
- No `/resume` / `/rewind` recovery for in-process teammates.
- Teammates DO NOT apply `skills` and `mcpServers` from a subagent-role definition — they use project/user settings.
- One team per lead; no nested teams; lead is fixed for team lifetime.
- Same-file parallel edits → conflicts. Partition work by file ownership.
- Each teammate is its own full session — **linear token cost** in team size.
- Always clean up **from the lead**, not from a teammate.

### Composition
- Skill `context: fork` → skill content becomes subagent prompt; picks agent type via `agent:`
- Subagent `skills:` → full skill content injected at startup
- Agent-team teammate with subagent role → honours `tools` + `model`, appends body to system prompt; drops `skills` / `mcpServers`

---

## 9. Source URLs

- **Skills:** https://code.claude.com/docs/en/skills
- **Sub-agents:** https://code.claude.com/docs/en/sub-agents
- **Agent teams:** https://code.claude.com/docs/en/agent-teams
- **Commands / built-ins:** https://code.claude.com/docs/en/commands
- **Hooks:** https://code.claude.com/docs/en/hooks
- **Plugins:** https://code.claude.com/docs/en/plugins
- **Permissions:** https://code.claude.com/docs/en/permissions
- **Settings:** https://code.claude.com/docs/en/settings
- **Memory / CLAUDE.md:** https://code.claude.com/docs/en/memory
- **Open standard:** https://agentskills.io

Case study: `~/engineering/saas-stock-market/fibwise-trading-claude`
