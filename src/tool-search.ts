/**
 * Model-facing tools: `search_ai_projects` and `get_project_categories`.
 *
 * Mirrors the presentation discipline of `@deepseek-ai/dsh-tool-web`: the
 * canonical value is one typed JSON object, `output.render` owns model-facing
 * prose, and `presentationMeta` / `presentResult` own the replayable `web`
 * search card. Presenters stay pure — no I/O, no clocks, no session reads.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult, WebSearchResultView, WebSource } from '@deepseek-ai/dsh-tools'
import {
  detailUrl,
  listCategories,
  searchProjects,
  type ApiCategoryItem,
  type ApiProjectItem,
} from './client.js'

/** One project in the canonical `search_ai_projects` output value. */
interface ProjectEntry {
  fullName: string
  url: string
  description?: string
  descriptionZh?: string
  language?: string
  stars: number
  forks: number
  dailyStarGrowth?: number
  hotScore?: number
  category?: string
  subcategory?: string
  tags: string[]
  isRecommended: boolean
  detailUrl: string
}

/** The canonical `search_ai_projects` output value. */
interface SearchOutput {
  total: number
  page: number
  pageSize: number
  hasNext: boolean
  minStars: number
  projects: ProjectEntry[]
}

/** The persisted card payload, carried opaquely on `tool/result` meta. */
interface RadarSearchMeta {
  sources: WebSource[]
  truncated: boolean
}

/** Project one API item into the canonical entry, omitting absent fields. */
function projectEntry(apiBase: string, item: ApiProjectItem): ProjectEntry {
  const description = item.description_zh ?? item.description ?? undefined
  return {
    fullName: item.full_name,
    url: item.url ?? `https://github.com/${item.full_name}`,
    ...description !== undefined ? { description: item.description ?? description } : {},
    ...item.description_zh !== undefined && item.description_zh !== null ? { descriptionZh: item.description_zh } : {},
    ...item.language !== undefined && item.language !== null ? { language: item.language } : {},
    stars: item.stars ?? 0,
    forks: item.forks ?? 0,
    ...item.daily_growth_available === true && typeof item.daily_star_growth === 'number'
      ? { dailyStarGrowth: item.daily_star_growth }
      : {},
    ...typeof item.hot_score === 'number' && item.hot_score > 0 ? { hotScore: item.hot_score } : {},
    ...item.category_name !== undefined && item.category_name !== null ? { category: item.category_name } : {},
    ...item.subcategory_name !== undefined && item.subcategory_name !== null ? { subcategory: item.subcategory_name } : {},
    tags: item.tags ?? [],
    isRecommended: item.is_recommended === true,
    detailUrl: detailUrl(apiBase, item.full_name),
  }
}

/** Format the canonical value as model-facing markdown. */
function formatSearchOutput(value: SearchOutput, query: string): string {
  if (value.projects.length === 0) {
    return `No projects found in the AIGC Radar library${query ? ` for "${query}"` : ''}. ` +
      `The library only covers GitHub projects with ${value.minStars}+ stars; broaden the query or drop filters.`
  }
  const lines = value.projects.map((project, index) => {
    const growth = project.dailyStarGrowth !== undefined ? `, +${project.dailyStarGrowth}/day` : ''
    const meta = [project.language, project.category].filter(Boolean).join(' · ')
    const description = project.descriptionZh ?? project.description ?? ''
    return `${index + 1}. [${project.fullName}](${project.url}) — ★ ${project.stars.toLocaleString('en-US')}${growth}` +
      `${meta ? ` · ${meta}` : ''}\n   ${description}\n   Detail: ${project.detailUrl}`
  })
  const footer = value.hasNext
    ? `Showing page ${value.page} (${value.projects.length} of ${value.total} results); pass page=${value.page + 1} for more.`
    : `${value.total} result(s) total.`
  return `${lines.join('\n')}\n\n${footer}\nData provided by AIGC Radar · https://aigcnews.cn`
}

/** Pending-state card: a generic search card titled by the query. */
export function presentSearchCall(args: { q?: string }): GenericCallView {
  const title = args.q !== undefined && args.q.length > 0 ? args.q : 'AIGC Radar project search'
  return { card: 'generic', title, kind: 'search', rawInput: args.q ?? '' }
}

/** Project the canonical value into its replayable card meta. */
export function searchMetaFromValue(value: SearchOutput): JsonValue {
  // Fresh object literals (no interface annotation) so the value keeps the
  // implicit index signature `JsonValue` requires — same pattern as
  // `dsh-tool-web`'s `projectSource`.
  const sources = value.projects.map((project) => ({
    url: project.url,
    title: project.fullName,
    snippet: [
      `★ ${project.stars.toLocaleString('en-US')}`,
      project.dailyStarGrowth !== undefined ? `+${project.dailyStarGrowth}/day` : undefined,
      project.descriptionZh ?? project.description,
    ].filter((part): part is string => typeof part === 'string').join(' · '),
  }))
  return { sources, truncated: value.hasNext } satisfies RadarSearchMeta
}

/** Defensive narrowing of opaque live/replayed meta; malformed → undefined (generic card). */
function searchMetaFromResult(meta: unknown): RadarSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || typeof truncated !== 'boolean') return undefined
  for (const source of sources) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
    const { url, title, snippet } = source as Record<string, unknown>
    if (typeof url !== 'string') return undefined
    if (title !== undefined && typeof title !== 'string') return undefined
    if (snippet !== undefined && typeof snippet !== 'string') return undefined
  }
  return { sources: sources as WebSource[], truncated }
}

/** Completed-call presentation: a native `web` search card rebuilt from meta. */
export function presentSearchResult(args: { q?: string }, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.q !== undefined && args.q.length > 0 ? args.q : 'AIGC Radar project search',
    sources: meta.sources,
    truncated: meta.truncated,
  }
}

const PROJECT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number', required: true },
    page: { type: 'number', required: true },
    pageSize: { type: 'number', required: true },
    hasNext: { type: 'boolean', required: true },
    minStars: { type: 'number', required: true },
    projects: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullName: { type: 'string', required: true },
          url: { type: 'string', required: true },
          description: { type: 'string' },
          descriptionZh: { type: 'string' },
          language: { type: 'string' },
          stars: { type: 'number', required: true },
          forks: { type: 'number', required: true },
          dailyStarGrowth: { type: 'number' },
          hotScore: { type: 'number' },
          category: { type: 'string' },
          subcategory: { type: 'string' },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          isRecommended: { type: 'boolean', required: true },
          detailUrl: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const CATEGORY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number', required: true },
    minStars: { type: 'number', required: true },
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', required: true },
          name: { type: 'string', required: true },
          nameZh: { type: 'string' },
          count: { type: 'number', required: true },
          children: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                name: { type: 'string', required: true },
                nameZh: { type: 'string' },
                count: { type: 'number', required: true },
              },
            },
          },
        },
      },
    },
  },
} as const

/** Format the category taxonomy as model-facing markdown. */
function formatCategories(value: { total: number; minStars: number; items: ApiCategoryItem[] }): string {
  if (value.items.length === 0) return 'No categories available.'
  const lines = value.items.map((category) => {
    const children = (category.children ?? [])
      .map((child) => `  - ${child.slug} (${child.name}${child.name_zh ? ` / ${child.name_zh}` : ''}, ${child.count})`)
      .join('\n')
    return `- ${category.slug} (${category.name}${category.name_zh ? ` / ${category.name_zh}` : ''}, ${category.count})${children ? `\n${children}` : ''}`
  })
  return `${lines.join('\n')}\n\n${value.total} categories; library floor is ${value.minStars} stars.`
}

/**
 * Register both tools and the routing guidance. All registrations are
 * effect-scoped and unwind when the plugin unloads.
 */
export function applyRadarTools(ctx: Context, apiBase: string, timeoutMs: number, maxPageSize: number): void {
  ctx.systemPrompt.section({
    name: 'tool:aigc_radar',
    order: 110,
    text: 'Use the search_ai_projects tool whenever the user asks to find, compare, recommend, or reuse AI, Agent, MCP, RAG, or LLM open-source projects, repositories, SDKs, frameworks, components, templates, or examples — even if they do not name GitHub. It searches the curated AIGC Radar library: GitHub projects above a 500-star floor, enriched with categories and bilingual tags/descriptions. Translate non-English intent into concise English GitHub-style query terms while preserving product names. Run at most one search per unchanged requirement; inspect results before refining. The scope "today" is exploratory discovery of newly hot projects, not an official ranking. Call get_project_categories first only when the category taxonomy is unclear. Cite returned GitHub URLs as markdown links.',
  })

  ctx.tools.register(defineTool({
    name: 'search_ai_projects',
    description:
      'Search the curated AIGC Radar library for AI/Agent/MCP/RAG/LLM open-source projects on GitHub ' +
      '(500+ stars, enriched with categories, bilingual tags, and growth metrics). ' +
      'Returns matching projects with stars, daily growth, categories, and links.',
    parameters: {
      q: { type: 'string', description: 'Concise query; translate non-English intent into English GitHub-style terms, preserving product names.' },
      scope: {
        type: 'string',
        enum: ['all', 'today', 'recommended'],
        description: '"all" (default) searches the whole library; "today" finds newly hot projects; "recommended" lists editor picks.',
      },
      category: { type: 'string', description: 'Category slug filter; discover slugs via get_project_categories.' },
      subcategory: { type: 'string', description: 'Subcategory slug filter.' },
      language: { type: 'string', description: 'Programming language filter, e.g. Python, TypeScript. Not a query-language filter.' },
      sort: {
        type: 'string',
        enum: ['relevance', 'hot', 'stars', 'updated', 'recent', 'name'],
        description: 'Result order; defaults to relevance.',
      },
      page: { type: 'number', description: 'Result page, 1-based; defaults to 1.' },
    },
    output: {
      schema: PROJECT_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: formatSearchOutput(value, args.q ?? '') }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const q = args.q?.trim() ?? ''
      const scope = args.scope ?? 'all'
      const sort = args.sort ?? (q.length > 0 ? 'relevance' : 'stars')
      const data = await searchProjects(apiBase, {
        q,
        scope,
        ...args.category !== undefined ? { category: args.category.trim() } : {},
        ...args.subcategory !== undefined ? { subcategory: args.subcategory.trim() } : {},
        ...args.language !== undefined ? { language: args.language.trim() } : {},
        sort,
        page: args.page ?? 1,
        page_size: maxPageSize,
      }, exec.signal)
      const projects = (data.items ?? []).map((item) => projectEntry(apiBase, item))
      return {
        total: data.total ?? projects.length,
        page: data.page ?? args.page ?? 1,
        pageSize: data.page_size ?? maxPageSize,
        hasNext: data.has_next === true,
        minStars: data.min_stars ?? 500,
        projects,
      } satisfies SearchOutput
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))

  ctx.tools.register(defineTool({
    name: 'get_project_categories',
    description:
      'List the AIGC Radar project category taxonomy (categories with subcategory counts). ' +
      'Call this only when category/subcategory slugs for search_ai_projects filters are unclear.',
    parameters: {},
    output: {
      schema: CATEGORY_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatCategories(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const data = await listCategories(apiBase, exec.signal)
      const items = data.items ?? []
      return {
        total: data.total ?? items.length,
        minStars: data.min_stars ?? 500,
        items,
      }
    },
  }))
}
