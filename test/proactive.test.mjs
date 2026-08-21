/**
 * Unit tests for the proactive reuse-check gate (`agent/pre-step` listener):
 * everyday build shapes (tools, scripts, crawlers, plugins, sync/backup jobs)
 * must fire the injection; narrow work and English substring traps
 * (description/async/client) must not. Run `npm run build` first — the tests
 * exercise the built bundle, like test/client.test.mjs does.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../dist/index.mjs'

// apply() kicks off the read-only npm release check; keep these tests
// hermetic by making the network unreachable (the check fails open).
globalThis.fetch = async () => { throw new Error('offline in tests') }

/** Capture every `ctx.on` registration; stub everything else as a no-op. */
function fakeContext() {
  const listeners = []
  const ctx = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === 'on') {
          return (event, handler, options) => listeners.push({ event, handler, options })
        }
        return new Proxy({}, { get: () => () => undefined })
      },
    },
  )
  return { ctx, listeners }
}

function userMessage(text) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }] }
}

/** Run the captured pre-step listener for one entering user message. */
async function runPreStep(listeners, text, { step = 1 } = {}) {
  const listener = listeners.find((entry) => entry.event === 'agent/pre-step')
  assert.ok(listener, 'plugin must register an agent/pre-step listener')
  const entering = [userMessage(text)]
  const decision = await listener.handler(
    { messages: entering, turn: 1, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [...entering] }),
  )
  assert.equal(decision.kind, 'enter')
  return decision.messages
}

const FIRE_PROMPTS = [
  '帮我写个网页截图工具',
  '写一个定时备份脚本，把 postgres 数据库每天备份到对象存储',
  '给我做个微信公众号文章爬虫',
  '实现一个本地文件同步模块',
  '帮我搭建一个 RSS 订阅聚合服务',
  '开发一个 VS Code 插件，选中代码一键生成流程图',
  '写个命令行 JSON 转 CSV 的小工具',
  '帮我做个 TG bot 每天推送 HN 热榜',
  '实现一个完整的 RAG 独立子系统',
  'Build a complete screenshot platform',
  'write a screenshot tool',
]

const SILENT_PROMPTS = [
  // English substring traps: \b must keep script/sync/cli from matching
  // inside description/async/client.
  'create a description for the release',
  'implement an async client library',
  // Narrow work: an isolated function or doc edit is not a capability.
  '手写一个 LRU 缓存',
  '帮我写一下项目 README',
  '修复 Agent 页面 CSS 样式',
]

const config = { apiBase: 'https://radar.example', mcpToken: '', timeoutMs: 1000, maxPageSize: 10 }

test('everyday build prompts inject the reuse check', async () => {
  for (const prompt of FIRE_PROMPTS) {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config)
    const messages = await runPreStep(listeners, prompt)
    assert.equal(messages.length, 2, `expected injection for: ${prompt}`)
    assert.match(messages[1].content[0].text, /AIGC Radar reuse check/)
  }
})

test('narrow work and substring traps stay silent', async () => {
  for (const prompt of SILENT_PROMPTS) {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config)
    const messages = await runPreStep(listeners, prompt)
    assert.equal(messages.length, 1, `expected no injection for: ${prompt}`)
  }
})

test('only step 1 of a turn injects', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, config)
  const messages = await runPreStep(listeners, '帮我写个网页截图工具', { step: 2 })
  assert.equal(messages.length, 1)
})
