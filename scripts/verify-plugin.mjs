/**
 * Plugin verification: load the built plugin with a minimal fake Cordis
 * context, execute `search_ai_projects` against the live API, and assert the
 * full pipeline — registration, canonical value, model-facing render,
 * presentation meta, and the replayed `web` search card.
 *
 * Run with `npm run verify` after `npm run build`.
 */
import { apply, inject, name } from '../dist/index.mjs'

const tools = new Map()
const sections = []
const ctx = {
  tools: { register: (def) => tools.set(def.name, def) },
  systemPrompt: { section: (s) => sections.push(s) },
}

if (name !== 'aigc-radar') throw new Error(`unexpected plugin name: ${name}`)
for (const dep of ['tools', 'systemPrompt']) {
  if (!inject.includes(dep)) throw new Error(`missing inject: ${dep}`)
}

apply(ctx, { apiBase: 'https://aigcnews.cn', timeoutMs: 20000, maxPageSize: 10 })

const search = tools.get('search_ai_projects')
const categories = tools.get('get_project_categories')
if (!search || !categories) throw new Error(`tools not registered: ${[...tools.keys()]}`)
if (sections.length !== 1 || !sections[0].text.includes('search_ai_projects')) {
  throw new Error('system-prompt routing section missing')
}
if (!sections[0].text.includes('proactive reuse check')) {
  throw new Error('routing section lost the proactive reuse clause')
}
console.log(`registered: ${[...tools.keys()].join(', ')}`)
console.log(`prompt section: ${sections[0].name} (order ${sections[0].order}, ${sections[0].text.length} chars)`)

const args = { q: 'mcp' }
const value = await search.execute(args, { signal: AbortSignal.timeout(15000) })
if (!Array.isArray(value.projects) || value.projects.length === 0) throw new Error('empty canonical value')
console.log(`execute: ${value.projects.length} projects, total=${value.total}, first=${value.projects[0].fullName}`)

const rendered = search.output.render(args, value)
if (rendered[0]?.type !== 'text' || !rendered[0].text.includes('AIGC Radar')) throw new Error('render broken')

const callView = search.presentCall(args)
if (callView?.card !== 'generic' || callView.kind !== 'search') throw new Error('presentCall broken')

const meta = search.output.presentationMeta(args, value)
const resultView = search.presentResult(args, { isError: false, meta })
if (resultView?.card !== 'web' || resultView.kind !== 'search' || resultView.sources.length === 0) {
  throw new Error('presentResult card broken')
}
console.log(`card: web/search with ${resultView.sources.length} sources, truncated=${resultView.truncated}`)
console.log(`first source: ${resultView.sources[0].title} — ${resultView.sources[0].snippet.slice(0, 80)}`)

const catValue = await categories.execute({}, { signal: AbortSignal.timeout(15000) })
if (!Array.isArray(catValue.items) || catValue.items.length === 0) throw new Error('categories empty')
console.log(`categories: ${catValue.items.length} roots`)

console.log('verify OK')
