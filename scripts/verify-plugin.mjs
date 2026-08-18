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
const listeners = {}
const ctx = {
  tools: { register: (def) => tools.set(def.name, def) },
  systemPrompt: { section: (s) => sections.push(s) },
  on: (event, listener) => { listeners[event] = listener },
}

if (name !== 'aigc-radar') throw new Error(`unexpected plugin name: ${name}`)
for (const dep of ['tools', 'systemPrompt']) {
  if (!inject.includes(dep)) throw new Error(`missing inject: ${dep}`)
}

apply(ctx, {
  apiBase: 'https://aigcnews.cn',
  mcpToken: process.env.AIGC_RADAR_MCP_TOKEN ?? '',
  timeoutMs: 20000,
  maxPageSize: 10,
})

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

// The proactive reuse listener must inject on implementation-scale prompts
// and stay silent on narrow work.
const userMsg = (text) => ({
  id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
})
const runPreStep = (text, step = 1) => listeners['agent/pre-step'](
  { messages: [userMsg(text)], turn: 1, step, signal: AbortSignal.timeout(5000) },
  async () => ({ kind: 'enter', messages: [] }),
)
const positive = await runPreStep('帮我实现一个工作流引擎，支持定时任务和重试')
if (positive.kind !== 'enter' || positive.messages.length !== 1) throw new Error('proactive injection missing')
if (!positive.messages[0].content[0].text.includes('search_ai_projects')) throw new Error('injection lacks tool name')
console.log(`proactive: injected on implementation prompt (${positive.messages[0].content[0].text.length} chars)`)
const negative = await runPreStep('帮我修复 README 里的一个错别字')
if (negative.kind !== 'enter' || negative.messages.length !== 0) throw new Error('proactive fired on narrow work')
const lateStep = await runPreStep('帮我实现一个工作流引擎', 2)
if (lateStep.messages.length !== 0) throw new Error('proactive fired past step 1')
console.log('proactive: silent on narrow work and past step 1')

console.log('verify OK')
