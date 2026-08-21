/**
 * dsh-aigc-radar: AIGC Radar project search for DeepSeek Harness.
 *
 * Registers `search_ai_projects` and `get_project_categories` on `ctx.tools`
 * (results render as native `web` search cards in capable UIs) plus a
 * system-prompt section that teaches the model when to route discovery
 * questions here, and an `agent/pre-step` listener that deterministically
 * injects a reuse-check instruction when a turn opens with "implement a
 * substantial capability" intent. Everything unwinds on plugin unload.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { applyProactiveReuse } from './proactive.js'
import { applyRadarTools } from './tool-search.js'
import { startUpdateCheck } from './update-notice.js'

export { detailUrl, listCategories, searchProjects, callMcpTool, McpQuotaError, quotaErrorMessage, humanizeSeconds, PLUGIN_VERSION } from './client.js'
export type { ApiCategoriesResponse, ApiCategoryItem, ApiProjectItem, ApiProjectsResponse, QuotaErrorData, SearchParams } from './client.js'
export { compareVersions, resolvedUpdateNotice, resetUpdateNoticeForTests, startUpdateCheck, updateNoticeMessage } from './update-notice.js'
export type { UpdateNotice } from './update-notice.js'

export const name = 'aigc-radar'
export const inject = ['tools', 'systemPrompt', 'agents'] as const

export interface Config {
  /** AIGC_NEWS API origin; point at a self-hosted deployment if you run one. */
  apiBase: string
  /**
   * MCP token from {apiBase}/mcp; empty means anonymous, which the server
   * buckets per IP with a tighter daily quota instead of your account's
   * monthly one.
   */
  mcpToken: string
  /** Cooperative per-request budget handed to every tool call. */
  timeoutMs: number
  /** Page size sent on every search; the model pages with `page`. Capped at 20 by the MCP contract. */
  maxPageSize: number
  /**
   * Once-per-process npm registry check for a newer plugin release; when one
   * exists, the first turn of the session carries the exact update command.
   * Read-only — the plugin never modifies its own installation.
   */
  updateCheck: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().default('https://aigcnews.cn'),
  mcpToken: Schema.string().default(''),
  timeoutMs: Schema.number().default(20000),
  maxPageSize: Schema.number().default(10),
  updateCheck: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config) {
  const apiBase = config.apiBase.replace(/\/+$/, '')
  if (config.updateCheck !== false) void startUpdateCheck()
  applyRadarTools(ctx, apiBase, config.mcpToken ?? '', config.timeoutMs, config.maxPageSize)
  applyProactiveReuse(ctx)
}
