/**
 * MCP JSON-RPC client for the AIGC Radar server (`POST {apiBase}/api/mcp`).
 *
 * The plugin never talks to GitHub directly: every query hits the curated
 * AIGC_NEWS library, which enriches GitHub projects with categories, bilingual
 * tags/descriptions, and growth metrics, and enforces a 500-star floor.
 *
 * The transport is the same stateless MCP endpoint that backs the public
 * AIGC Radar MCP server, so every call lands in the server's rate-limit and
 * quota domains: anonymous callers are bucketed per IP (daily quota), callers
 * with an `mcpToken` per account tier (monthly quota). No `initialize`
 * handshake — the endpoint is stateless and `tools/call` stands alone.
 */

/** One project item as returned by the `search_github_ai_projects` tool. */
export interface ApiProjectItem {
  id?: string | null
  full_name: string
  url?: string | null
  description?: string | null
  description_zh?: string | null
  description_en?: string | null
  category_name?: string | null
  category_name_zh?: string | null
  category_name_en?: string | null
  subcategory_name?: string | null
  subcategory_name_zh?: string | null
  subcategory_name_en?: string | null
  tags?: string[]
  tags_zh?: string[]
  tags_en?: string[]
  language?: string | null
  topics?: string[]
  stars?: number
  forks?: number
  daily_star_growth?: number
  daily_growth_available?: boolean
  hot_score?: number
  growth_suspicion_score?: number
  is_recommended?: boolean
  pushed_at?: string | null
  /** Server-built site link with utm_source=mcp; the plugin builds its own dsh-attributed one. */
  detail_url?: string | null
}

/** Structured content of the `search_github_ai_projects` tool result. */
export interface ApiProjectsResponse {
  items?: ApiProjectItem[]
  total?: number
  page?: number
  page_size?: number
  has_next?: boolean
  min_stars?: number
  scope?: string
  category?: string
  subcategory?: string
  q?: string
  sort?: string
  lang?: string
  attribution?: string
}

/** One category node of the `get_project_categories` tool result. */
export interface ApiCategoryItem {
  slug: string
  name: string
  name_zh?: string
  name_en?: string
  /** Canonical plugin field; the server calls this project_count. */
  count: number
  kind?: string
  scope?: string | null
  children?: ApiCategoryItem[]
}

/** Normalize the Python MCP taxonomy payload to the plugin's stable shape. */
function normalizeCategory(item: Record<string, unknown>): ApiCategoryItem {
  const rawChildren = Array.isArray(item.subcategories) ? item.subcategories : item.children
  return {
    slug: String(item.slug ?? ''),
    name: String(item.name ?? ''),
    ...typeof item.name_zh === 'string' ? { name_zh: item.name_zh } : {},
    ...typeof item.name_en === 'string' ? { name_en: item.name_en } : {},
    count: typeof item.project_count === 'number' ? item.project_count : typeof item.count === 'number' ? item.count : 0,
    ...typeof item.kind === 'string' ? { kind: item.kind } : {},
    ...typeof item.scope === 'string' || item.scope === null ? { scope: item.scope } : {},
    children: Array.isArray(rawChildren)
      ? rawChildren.filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null).map(normalizeCategory)
      : [],
  }
}

/** Structured content of the `get_project_categories` tool result. */
export interface ApiCategoriesResponse {
  items?: ApiCategoryItem[]
  total?: number
  today_count?: number
  recommended_count?: number
  min_stars?: number
  attribution?: string
}

/** Query parameters mapped onto `search_github_ai_projects` arguments. */
export interface SearchParams {
  q?: string
  scope?: 'all' | 'today' | 'recommended'
  category?: string
  subcategory?: string
  language?: string
  /** Omitted from the wire when undefined, so the server's documented defaults rule. */
  sort?: 'relevance' | 'hot' | 'stars' | 'updated' | 'recent' | 'name'
  page?: number
  /** Sent as `limit`; the MCP contract caps it at 20. */
  page_size?: number
}

/** Quota/rate-limit failure from the MCP endpoint (HTTP 429), with structured detail. */
export class McpQuotaError extends Error {
  /** 'daily' | 'monthly' for quota buckets; undefined for the minute burst bucket. */
  readonly quotaScope?: string | undefined
  readonly tier?: string | undefined
  readonly limit?: number | undefined
  readonly retryAfter: number

  constructor(
    message: string,
    opts: { quotaScope?: string | undefined; tier?: string | undefined; limit?: number | undefined; retryAfter: number },
  ) {
    super(message)
    this.name = 'McpQuotaError'
    this.quotaScope = opts.quotaScope
    this.tier = opts.tier
    this.limit = opts.limit
    this.retryAfter = opts.retryAfter
  }
}

const MCP_PROTOCOL_VERSION = '2025-06-18'
const PLUGIN_VERSION = '0.2.0'
/** The MCP `search_github_ai_projects` contract caps `limit` at 20. */
const MCP_TOOL_LIMIT_MAX = 20
/** Mirror of the server's minute-window burst bucket, for header-less 429s. */
const BURST_WINDOW_SECONDS = 60

let requestCounter = 0

/** Humanize a retry delay: seconds up close, then minutes, then hours. */
export function humanizeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a moment'
  if (seconds < 120) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}min`
  return `${Math.ceil(seconds / 3600)}h`
}

/** Structured `error.data` carried by the server's 429 quota projection. */
export interface QuotaErrorData {
  quota_scope?: string
  tier?: string
  limit?: number
  retry_after?: number
}

/** Build the actionable message for a 429, from the server's structured error data. */
export function quotaErrorMessage(
  apiBase: string,
  data: QuotaErrorData | undefined,
  retryAfter: number,
): string {
  const wait = humanizeSeconds(retryAfter)
  if (data?.quota_scope === 'daily') {
    const limit = data.limit ?? 100
    return (
      `AIGC Radar 已达今日匿名调用上限（${limit} 次/天，按 IP 计）。` +
      `游客安装未配置 token。请前往 ${apiBase}/mcp 登录并创建 MCP token，` +
      `再在安装向导重新生成带 token 的命令（或手动写入 dsh 的 mcpToken 配置）；` +
      `登录后还可前往 ${apiBase}/membership 开通 VIP。` +
      `Anonymous daily quota exhausted (${limit} calls/day per IP): the guest install has no token. ` +
      `Sign in at ${apiBase}/mcp, create an MCP token, then regenerate the tokenized install command ` +
      `(or set mcpToken in dsh config manually). After signing in, you can also upgrade to VIP at ` +
      `${apiBase}/membership. Retry in ${wait}.`
    )
  }
  if (data?.quota_scope === 'monthly' && data.tier === 'member') {
    const limit = data.limit ?? 20000
    return (
      `AIGC Radar 本月 VIP 额度已用完（${limit} 次/月），配额窗口将在 ${wait} 后重置。` +
      `VIP monthly quota exhausted (${limit} calls/month); the window resets in ${wait}.`
    )
  }
  if (data?.quota_scope === 'monthly') {
    const limit = data.limit ?? 2000
    return (
      `AIGC Radar 本月免费额度已用完（${limit} 次/月）。` +
      `请前往 ${apiBase}/membership 开通 VIP；支付成功后会立即作用于当前 MCP token，` +
      `无需更换或重新配置。也可等待配额窗口重置（${wait}）。` +
      `Free monthly quota exhausted (${limit} calls/month): upgrade to VIP at ` +
      `${apiBase}/membership — it takes effect immediately on your existing MCP token, ` +
      `with no reconfiguration needed — or retry in ${wait}.`
    )
  }
  return `AIGC Radar rate limit exceeded; slow down and retry after ${wait}.`
}

interface JsonRpcErrorBody {
  error?: {
    code?: number
    message?: string
    data?: QuotaErrorData
  }
  result?: {
    content?: { type?: string; text?: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
}

/** Extract the tool-level error message out of an isError tool result. */
function toolResultError(result: NonNullable<JsonRpcErrorBody['result']>): string {
  const text = result.content?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error
    } catch {
      // not JSON — fall through to the raw text
    }
    if (text.length > 0) return text
  }
  return 'AIGC Radar tool call failed.'
}

/**
 * Call one tool on the AIGC Radar MCP endpoint and return its structured content.
 *
 * Error ladder: transport failure → HTTP 429 (McpQuotaError, quota or burst) →
 * other HTTP errors → JSON-RPC error envelope → tool-level isError result →
 * malformed structuredContent. Anything the model can act on (bad arguments,
 * exhausted quota) surfaces as a message it can relay or retry against.
 */
export async function callMcpTool<T>(
  apiBase: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const url = `${apiBase}/api/mcp`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'user-agent': `dsh-aigc-radar/${PLUGIN_VERSION}`,
  }
  if (token.length > 0) headers.authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestCounter,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
  } catch (cause) {
    throw new Error(
      `AIGC Radar request failed: ${url} (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }

  if (res.status === 429) {
    let parsed: JsonRpcErrorBody | undefined
    try {
      parsed = (await res.json()) as JsonRpcErrorBody
    } catch {
      parsed = undefined
    }
    const data = parsed?.error?.data
    const headerRetry = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
    const retryAfter =
      typeof data?.retry_after === 'number' && data.retry_after > 0
        ? data.retry_after
        : Number.isFinite(headerRetry) && headerRetry > 0
          ? headerRetry
          : BURST_WINDOW_SECONDS
    throw new McpQuotaError(quotaErrorMessage(apiBase, data, retryAfter), {
      quotaScope: typeof data?.quota_scope === 'string' ? data.quota_scope : undefined,
      tier: typeof data?.tier === 'string' ? data.tier : undefined,
      limit: typeof data?.limit === 'number' ? data.limit : undefined,
      retryAfter,
    })
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        `AIGC Radar MCP token is invalid, expired, or revoked. ` +
          `Create a new token at ${apiBase}/mcp and update mcpToken in the dsh-aigc-radar plugin config.`,
      )
    }
    throw new Error(`AIGC Radar MCP returned HTTP ${res.status} for ${url}`)
  }

  const body = (await res.json()) as JsonRpcErrorBody
  if (body.error !== undefined) {
    throw new Error(`AIGC Radar MCP error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown error'}`)
  }
  const result = body.result
  if (result === undefined || typeof result !== 'object') {
    throw new Error('AIGC Radar MCP returned a malformed response (missing result).')
  }
  if (result.isError === true) {
    throw new Error(toolResultError(result))
  }
  if (typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error('AIGC Radar MCP returned a malformed tool result (missing structuredContent).')
  }
  const structured = result.structuredContent as Record<string, unknown>
  if (structured.truncated === true) {
    // Server-side MAX_TOOL_RESULT_CHARS overflow swaps the payload for
    // {truncated, reason, preview} — rendering it as an empty search would lie.
    throw new Error(
      'AIGC Radar tool result exceeded the server size cap and was truncated; ' +
        'narrow the query or reduce the page size and retry.',
    )
  }
  return structured as T
}

/** Run a project search against the curated library via `search_github_ai_projects`. */
export function searchProjects(
  apiBase: string,
  token: string,
  params: SearchParams,
  signal: AbortSignal,
): Promise<ApiProjectsResponse> {
  const args: Record<string, unknown> = {
    q: params.q ?? '',
    scope: params.scope ?? 'all',
    category: params.category ?? '',
    subcategory: params.subcategory ?? '',
    language: params.language ?? '',
    page: params.page ?? 1,
    limit: Math.min(MCP_TOOL_LIMIT_MAX, params.page_size ?? 10),
  }
  if (params.sort !== undefined) args.sort = params.sort
  return callMcpTool<ApiProjectsResponse>(apiBase, token, 'search_github_ai_projects', args, signal)
}

/** List the curated category taxonomy via `get_project_categories`. */
export async function listCategories(
  apiBase: string,
  token: string,
  signal: AbortSignal,
): Promise<ApiCategoriesResponse> {
  const data = await callMcpTool<ApiCategoriesResponse>(apiBase, token, 'get_project_categories', {}, signal)
  return {
    ...data,
    items: (data.items ?? []).map((item) => normalizeCategory(item as unknown as Record<string, unknown>)),
  }
}

/** Site detail URL for one project, with dsh attribution. */
export function detailUrl(apiBase: string, fullName: string): string {
  const base = apiBase.replace(/\/+$/, '')
  return `${base}/projects?q=${encodeURIComponent(fullName)}&utm_source=dsh&utm_medium=tool`
}
