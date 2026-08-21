# dsh-aigc-radar

**English** | [简体中文](https://github.com/Kaixxrua/dsh-aigc-radar/blob/main/README.zh-CN.md)

[AIGC Radar](https://aigcnews.cn) project search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

**Stop rebuilding what already exists.** While you plan and implement, the agent proactively checks the curated AIGC Radar library for mature, battle-tested projects that already solve your problem — before you write a line of code. Results render as **native search cards** in the dsh Web UI — not raw markdown — and survive session replay.

![search_ai_projects rendering as a native search card in the dsh Web UI](https://raw.githubusercontent.com/Kaixxrua/dsh-aigc-radar/main/docs/search-card.png)

## What you get

| Tool | What it does |
|---|---|
| `search_ai_projects` | Searches the curated AIGC Radar library: GitHub projects above a 500-star floor, enriched with categories, bilingual (zh/en) tags and descriptions, and daily star-growth metrics |
| `get_project_categories` | Lists the category taxonomy (categories + subcategory counts) for filter discovery |

Two routing layers make discovery automatic rather than opt-in:

- **Explicit discovery** — ask "找个能做 deep research 的开源框架" and the agent comes back with starred, categorized results, no "use the tool" needed
- **Proactive reuse check** — before the agent implements a major module or subsystem (auth, payments, workflow engines, search/indexing, protocol implementations, end-to-end RAG/Agent pipelines…), it runs one library check on its own initiative, so mature alternatives surface before anyone rebuilds them. Narrow work (bug fixes, renames, styling, CRUD) is deliberately excluded

### Why a native plugin instead of the MCP server?

AIGC Radar also ships as an MCP server — and this plugin now **rides that same MCP endpoint** (`POST /api/mcp`), so every call counts against the same rate limits and quotas. What the plugin adds on top:

- **Native `web` search cards** — structured sources render as cards in the Web UI and are rebuilt faithfully on session replay (`presentationMeta`), which the MCP transport cannot express
- **Typed canonical output** — the result is one validated JSON value, so Code Mode can compose it programmatically (`await tools.search_ai_projects({ q: 'mcp' })`) with full type inference
- **First-party prompt routing** — the discovery-routing guidance lives in system-prompt assembly, not in MCP instructions that clients may truncate

## Measured performance

The search tool is a single HTTPS call to the AIGC Radar public edge — the numbers below measure that full path, taken 2026-08-18 from a China home-broadband connection (GeoDNS → CN edge) with [scripts/benchmark-search.sh](https://github.com/Kaixxrua/dsh-aigc-radar/blob/main/scripts/benchmark-search.sh) (10 representative zh/en queries × 3 trials against `https://aigcnews.cn/api/mcp`):

| Metric | Value |
|---|---|
| Search latency p50 | 355 ms |
| Search latency p95 | 810 ms |
| Curated projects served | 18,426 — every one above the 500-star admission bar |
| Taxonomy | 11 top-level categories, bilingual zh/en tags and descriptions |

Index-quality benchmarks measured on the MCP interface — **3.5× faster than WebSearch** end-to-end (7.4 s vs 25.8 s median) and **98.3% first-tool routing accuracy** (59/60 trials) — live in the [main repo's benchmark section](https://github.com/Kaixxrua/AIGC_NEWS#benchmarks); this plugin serves the same dataset over the same API, so those numbers carry over.

## Install

Requires `dsh` (`npx @deepseek-ai/dsh web`).

**Recommended — install the prebuilt package from npm:**

```sh
dsh plugin --profile web add dsh-aigc-radar
```

For a reproducible install, pin the published release:

```sh
dsh plugin --profile web add dsh-aigc-radar@0.2.1
```

**Source fallback — install from GitHub:**

```sh
dsh plugin --profile web add github:Kaixxrua/dsh-aigc-radar
```

Git installs run the package's `prepare` build, which pnpm ≥10 refuses until you allow it: copy the package key pnpm prints into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-aigc-radar: true
```

Then re-run the GitHub `add`. Pin a commit (`github:Kaixxrua/dsh-aigc-radar#<sha>`) if you want the source install to be immutable.

Verify without booting:

```sh
dsh --profile web --dump-config   # shows a "# == dsh-aigc-radar" layer
```

### Updates

Update an npm install within its declared semver range:

```sh
dsh plugin --profile web update dsh-aigc-radar
```

Restart dsh afterwards to load the new version — a running dsh process is not hot-swapped.

If you pinned an exact version (for example `dsh-aigc-radar@0.2.1`), name the target version explicitly:

```sh
dsh plugin --profile web add dsh-aigc-radar@<version>
```

Git/Git SHA or branch, file/link, workspace, tarball, and local-path installs stay manual and are never changed by these commands. Startup-time automatic update checks are not yet available in released dsh builds; until then, the commands above are the update path.

**Recommended: register on the origin site and grab a free token.** The plugin works anonymously out of the box, but anonymous calls share a 100-calls/day per-IP bucket. A free account at [aigcnews.cn](https://aigcnews.cn) gets you a per-account monthly quota instead — create an MCP token on the [/mcp page](https://aigcnews.cn/mcp) (no special scopes needed for search) and paste it as `mcpToken` in the config below. See [Quotas and the MCP token](#quotas-and-the-mcp-token).

## Configure

Defaults point at the public deployment. Override the row from your profile's `cordis.patch.yml` (a patch replaces the row's whole config):

```yaml
- replace:
    - id: aigc-radar
      name: dsh-aigc-radar
      config:
        apiBase: 'https://aigcnews.cn'   # or your self-hosted AIGC_NEWS origin
        mcpToken: ''                     # MCP token from {apiBase}/mcp; empty = anonymous
        timeoutMs: 20000
        maxPageSize: 10                  # capped at 20 by the MCP contract
```

### Quotas and the MCP token

Every call lands in the MCP endpoint's quota domain — anonymous callers are bucketed per IP, token callers per account:

| Caller | Quota | Window |
|---|---|---|
| Anonymous (no `mcpToken`) | 100 tool calls | per day, per IP |
| Free account token | 2,000 tool calls | rolling 30 days |
| Member token | 20,000 tool calls | rolling 30 days |

To move out of the anonymous bucket, create a token at [aigcnews.cn/mcp](https://aigcnews.cn/mcp) (no special scopes needed for search) and set it as `mcpToken`. The token lives in your dsh profile config in plaintext, same as your LLM keys. When a quota is exhausted the tool returns an actionable error — which bucket, the limit, and how long to wait or where to upgrade — so the agent can relay it instead of failing silently.

## Develop from a source checkout

The commands below are for contributors working from a Git checkout. `test`, `verify`, and `smoke` use the built bundle; `verify` and `smoke` also call the live MCP endpoint.

```sh
pnpm install
pnpm build        # tsdown → dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test (client unit tests against the built bundle)
pnpm verify       # validates registration, cards, routing, and live search
pnpm smoke        # hits the live MCP endpoint through the built client
```

Load from a dsh source checkout without installing:

```sh
pnpm dsh --profile web --patch /path/to/dsh-aigc-radar/cordis.dev.yml
```

where `cordis.dev.yml` inserts the row by absolute path:

```yaml
- insert:
    - id: aigc-radar
      name: /absolute/path/to/dsh-aigc-radar/dist/index.mjs
```

## Data and attribution

Data provided by [AIGC Radar](https://aigcnews.cn) — your dsh instance calls the same MCP endpoint that backs the AIGC Radar MCP server, with the same quotas and rate limits. The curated library only covers GitHub projects with 500+ stars; general non-AI GitHub search with direct-GitHub fallback remains an MCP-server capability by design.

## License

[MIT](LICENSE)
