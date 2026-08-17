/**
 * Thin HTTP client for the public AIGC_NEWS (AIGC Radar) API.
 *
 * The plugin never talks to GitHub directly: every query hits the curated
 * AIGC_NEWS library, which enriches GitHub projects with categories, bilingual
 * tags/descriptions, and growth metrics, and enforces a 500-star floor.
 */

/** One project item as returned by `GET /api/projects`. */
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
}

/** Response envelope of `GET /api/projects`. */
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
}

/** One category node of `GET /api/projects/categories`. */
export interface ApiCategoryItem {
  slug: string
  name: string
  name_zh?: string
  name_en?: string
  count: number
  kind?: string
  scope?: string | null
  children?: ApiCategoryItem[]
}

/** Response envelope of `GET /api/projects/categories`. */
export interface ApiCategoriesResponse {
  items?: ApiCategoryItem[]
  total?: number
  today_count?: number
  recommended_count?: number
  min_stars?: number
}

/** Query parameters accepted by `GET /api/projects`. */
export interface SearchParams {
  q?: string
  scope?: 'all' | 'today' | 'recommended'
  category?: string
  subcategory?: string
  language?: string
  sort?: 'relevance' | 'hot' | 'stars' | 'updated' | 'recent' | 'name'
  page?: number
  page_size?: number
}

/** Fetch JSON from the AIGC Radar API, honoring the caller's signal. */
export async function fetchJson<T>(
  apiBase: string,
  path: string,
  params: Record<string, string | number>,
  signal: AbortSignal,
): Promise<T> {
  const url = new URL(path, apiBase)
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length === 0) continue
    url.searchParams.set(key, String(value))
  }
  let res: Response
  try {
    res = await fetch(url, {
      signal,
      headers: { accept: 'application/json' },
    })
  } catch (cause) {
    throw new Error(`AIGC Radar request failed: ${url.href} (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  if (!res.ok) {
    throw new Error(`AIGC Radar API returned HTTP ${res.status} for ${url.href}`)
  }
  return await res.json() as T
}

/** Run a project search against the curated library. */
export function searchProjects(
  apiBase: string,
  params: SearchParams,
  signal: AbortSignal,
): Promise<ApiProjectsResponse> {
  return fetchJson<ApiProjectsResponse>(apiBase, '/api/projects', {
    source: 'github',
    scope: params.scope ?? 'all',
    category: params.category ?? '',
    subcategory: params.subcategory ?? '',
    q: params.q ?? '',
    language: params.language ?? '',
    sort: params.sort ?? 'relevance',
    page: params.page ?? 1,
    page_size: params.page_size ?? 10,
  }, signal)
}

/** List the curated category taxonomy. */
export function listCategories(
  apiBase: string,
  signal: AbortSignal,
): Promise<ApiCategoriesResponse> {
  return fetchJson<ApiCategoriesResponse>(apiBase, '/api/projects/categories', { source: 'github' }, signal)
}

/** Site detail URL for one project, with dsh attribution. */
export function detailUrl(apiBase: string, fullName: string): string {
  const base = apiBase.replace(/\/+$/, '')
  return `${base}/projects?q=${encodeURIComponent(fullName)}&utm_source=dsh&utm_medium=tool`
}
