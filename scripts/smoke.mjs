/**
 * Smoke test: exercise the API client against the live AIGC Radar deployment.
 * Run with `npm run smoke` after `npm run build`.
 */
import { detailUrl, listCategories, searchProjects } from '../dist/index.mjs'

const API_BASE = process.env.AIGC_RADAR_API_BASE ?? 'https://aigcnews.cn'
const signal = AbortSignal.timeout(15000)

const search = await searchProjects(API_BASE, { q: 'mcp', sort: 'relevance' }, signal)
const first = search.items?.[0]
console.log(`search: total=${search.total} has_next=${search.has_next} min_stars=${search.min_stars}`)
console.log(`first: ${first?.full_name} ★${first?.stars} (+${first?.daily_star_growth}/day)`)
console.log(`detail: ${first ? detailUrl(API_BASE, first.full_name) : '(none)'}`)
if (!first?.full_name) throw new Error('smoke: empty search result')

const categories = await listCategories(API_BASE, signal)
console.log(`categories: total=${categories.total} top=${categories.items?.length}`)
if (!categories.items?.length) throw new Error('smoke: empty category list')

console.log('smoke OK')
