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

export { detailUrl, listCategories, searchProjects } from './client.js'
export type { ApiCategoriesResponse, ApiProjectItem, ApiProjectsResponse, SearchParams } from './client.js'

export const name = 'aigc-radar'
export const inject = ['tools', 'systemPrompt', 'agents'] as const

export interface Config {
  /** AIGC_NEWS API origin; point at a self-hosted deployment if you run one. */
  apiBase: string
  /** Cooperative per-request budget handed to every tool call. */
  timeoutMs: number
  /** Page size sent on every search; the model pages with `page`. */
  maxPageSize: number
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().default('https://aigcnews.cn'),
  timeoutMs: Schema.number().default(20000),
  maxPageSize: Schema.number().default(10),
})

export function apply(ctx: Context, config: Config) {
  const apiBase = config.apiBase.replace(/\/+$/, '')
  applyRadarTools(ctx, apiBase, config.timeoutMs, config.maxPageSize)
  applyProactiveReuse(ctx)
}
