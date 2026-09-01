/**
 * Unit tests for the MCP client: quota/burst error mapping, the JSON-RPC
 * error ladder, and search argument mapping. Run `npm run build` first —
 * the tests exercise the built bundle, like scripts/smoke.mjs does.
 *
 * globalThis.fetch is stubbed per test; no network, no server.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  McpQuotaError,
  callMcpTool,
  humanizeSeconds,
  listCategories,
  quotaErrorMessage,
  searchProjects,
} from '../dist/index.mjs'

const API_BASE = 'https://radar.example'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Stub fetch to capture the request and resolve with the given Response. */
function stubFetch(responder) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return responder({ url, init })
  }
  return calls
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function toolResult(structuredContent) {
  return jsonResponse(200, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    },
  })
}

test('humanizeSeconds scales up and tolerates junk', () => {
  assert.equal(humanizeSeconds(0), 'a moment')
  assert.equal(humanizeSeconds(Number.NaN), 'a moment')
  assert.equal(humanizeSeconds(45), '45s')
  assert.equal(humanizeSeconds(119), '119s')
  assert.equal(humanizeSeconds(120), '2min')
  assert.equal(humanizeSeconds(3599), '60min')
  assert.equal(humanizeSeconds(3600), '1h')
  assert.equal(humanizeSeconds(7200), '2h')
  assert.equal(humanizeSeconds(86400), '24h')
})

test('quotaErrorMessage covers all three quota branches plus the burst fallback', () => {
  const daily = quotaErrorMessage(API_BASE, { quota_scope: 'daily', tier: 'free', limit: 100 }, 3600)
  assert.match(daily, /今日匿名调用上限/)
  assert.match(daily, /Anonymous daily quota/)
  assert.match(daily, /https:\/\/radar\.example\/mcp/)
  assert.match(daily, /https:\/\/radar\.example\/membership/)
  assert.match(daily, /重新生成带 token 的命令/)
  assert.match(daily, /regenerate the tokenized install command/)
  assert.match(daily, /登录后还可前往/)

  const free = quotaErrorMessage(API_BASE, { quota_scope: 'monthly', tier: 'free', limit: 2000 }, 86400)
  assert.match(free, /本月免费额度已用完/)
  assert.match(free, /Free monthly quota/)
  assert.match(free, /https:\/\/radar\.example\/membership/)
  assert.match(free, /无需更换或重新配置/)
  assert.match(free, /no reconfiguration needed/)

  const member = quotaErrorMessage(API_BASE, { quota_scope: 'monthly', tier: 'member', limit: 20000 }, 3600)
  assert.match(member, /本月 VIP 额度已用完/)
  assert.match(member, /VIP monthly quota/)
  assert.match(member, /resets in 1h/)
  assert.doesNotMatch(member, /membership/)

  const burst = quotaErrorMessage(API_BASE, undefined, 60)
  assert.match(burst, /slow down and retry after 60s/)
})

test('searchProjects posts tools/call with clamped limit and omits sort when unset', async () => {
  const calls = stubFetch(() => toolResult({ items: [], total: 0, has_next: false, min_stars: 500 }))
  await searchProjects(API_BASE, '', { q: 'mcp', page_size: 50 }, AbortSignal.timeout(5000))
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://radar.example/api/mcp')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, undefined)
  assert.equal(init.headers['mcp-protocol-version'], '2025-06-18')
  const body = JSON.parse(init.body)
  assert.equal(body.method, 'tools/call')
  assert.equal(body.params.name, 'search_github_ai_projects')
  assert.equal(body.params.arguments.limit, 20)
  assert.equal(body.params.arguments.q, 'mcp')
  assert.equal('page_size' in body.params.arguments, false)
  assert.equal('sort' in body.params.arguments, false)
})

test('searchProjects passes sort and sends the bearer token when configured', async () => {
  const calls = stubFetch(() => toolResult({ items: [], total: 0 }))
  await searchProjects(API_BASE, 'tok123', { q: 'rag', sort: 'hot', page: 2 }, AbortSignal.timeout(5000))
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.params.arguments.sort, 'hot')
  assert.equal(body.params.arguments.page, 2)
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok123')
})

test('listCategories calls get_project_categories with empty arguments', async () => {
  const taxonomy = { items: [{ slug: 'agent', name: 'Agent', project_count: 100, subcategories: [{ slug: 'mcp', name: 'MCP', project_count: 20 }] }], total: 1, min_stars: 500 }
  const calls = stubFetch(() => toolResult(taxonomy))
  const result = await listCategories(API_BASE, '', AbortSignal.timeout(5000))
  assert.deepEqual(JSON.parse(calls[0].init.body).params.arguments, {})
  assert.equal(result.total, 1)
  assert.equal(result.items[0].slug, 'agent')
  assert.equal(result.items[0].count, 100)
  assert.equal(result.items[0].children?.[0].count, 20)
})

test('429 with quota data rejects with an actionable McpQuotaError', async () => {
  stubFetch(() =>
    jsonResponse(429, {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'Anonymous daily quota exceeded (100 tool calls/day).',
        data: { quota_scope: 'daily', tier: 'free', limit: 100, retry_after: 3600 },
      },
    }, { 'retry-after': '3600' }),
  )
  const err = await callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000))
    .then(() => null, (e) => e)
  assert.ok(err instanceof McpQuotaError)
  assert.equal(err.quotaScope, 'daily')
  assert.equal(err.limit, 100)
  assert.equal(err.retryAfter, 3600)
  assert.match(err.message, /https:\/\/radar\.example\/mcp/)
})

test('429 without data falls back to the Retry-After header and the burst message', async () => {
  stubFetch(() =>
    jsonResponse(429, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'Rate limit exceeded.' },
    }, { 'retry-after': '60' }),
  )
  const err = await callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000))
    .then(() => null, (e) => e)
  assert.ok(err instanceof McpQuotaError)
  assert.equal(err.quotaScope, undefined)
  assert.equal(err.retryAfter, 60)
  assert.match(err.message, /slow down and retry after 60s/)
})

test('JSON-RPC error envelope rejects with the server message', async () => {
  stubFetch(() => jsonResponse(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }))
  await assert.rejects(
    callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000)),
    /bad params/,
  )
})

test('tool-level isError result rejects with the embedded error text', async () => {
  stubFetch(() =>
    jsonResponse(200, {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ error: 'q too long' }) }], isError: true },
    }),
  )
  await assert.rejects(
    callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000)),
    /q too long/,
  )
})

test('missing structuredContent rejects as malformed', async () => {
  stubFetch(() =>
    jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], isError: false } }),
  )
  await assert.rejects(
    callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000)),
    /malformed/,
  )
})

test('non-429 HTTP errors reject with the status', async () => {
  stubFetch(() => new Response('oops', { status: 502 }))
  await assert.rejects(
    callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000)),
    /HTTP 502/,
  )
})

test('401 rejects with actionable token guidance pointing at /mcp', async () => {
  stubFetch(() => jsonResponse(401, { detail: 'Invalid or expired MCP token' }))
  const err = await callMcpTool(API_BASE, 'tok123', 'search_github_ai_projects', {}, AbortSignal.timeout(5000))
    .then(() => null, (e) => e)
  assert.ok(err instanceof Error)
  assert.match(err.message, /invalid, expired, or revoked/)
  assert.match(err.message, /https:\/\/radar\.example\/mcp/)
  assert.match(err.message, /mcpToken/)
})

test('truncated structuredContent rejects instead of masquerading as empty results', async () => {
  stubFetch(() => toolResult({ truncated: true, reason: 'exceeds 100000 characters', preview: '{"items": [' }))
  await assert.rejects(
    callMcpTool(API_BASE, '', 'search_github_ai_projects', {}, AbortSignal.timeout(5000)),
    /truncated.*narrow the query/i,
  )
})
