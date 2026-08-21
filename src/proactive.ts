/**
 * Deterministic proactive reuse check.
 *
 * The system-prompt routing section (see tool-search.ts) is a soft trigger:
 * it relies on the model remembering to check the library before building.
 * This module adds the hard trigger: an `agent/pre-step` listener that fires
 * on the first step of every turn, pattern-matches the entering user messages
 * for "implement a substantial capability" intent, and — when matched —
 * durably injects a plugin-sourced message instructing the model to run
 * `search_ai_projects` before writing code. The decision to check is made by
 * code, not by the model; only the query wording is left to the model.
 *
 * The heuristic mirrors the AIGC_NEWS MCP routing contract: fire on
 * implementation intent combined with a capability-scale signal, and never on
 * narrow work (fixes, renames, styling, CRUD, isolated edits). The gate is
 * kept in sync with the Claude Code hook `aigc_radar_reuse_check.py`: scale
 * covers everyday build shapes (tools, scripts, crawlers, plugins, sync /
 * backup / export jobs…), not only "complete systems".
 */


import type { Context } from '@deepseek-ai/cordis'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { resolvedUpdateNotice, updateNoticeMessage } from './update-notice.js'

/**
 * Local mirror of `@deepseek-ai/dsh-agent`'s `PreStepDecision` and pre-step
 * payload. Declared here (plus the Events merge below) instead of depending
 * on the package: its 0.1.0-rc line peer-conflicts with the 0.0.1-rc line
 * (dsh-invariants), and a git-installed plugin must not drag that closure
 * into the profile's install.
 */
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

interface PreStepPayload {
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Enter one proposed step with the given messages, or reject it. */
    'agent/pre-step'(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }
}

/** Implementation-intent verbs, Chinese and English. */
const INTENT_PATTERN =
  /(?:实现|开发|搭建|构建|做一|做个|写一|写个|新增|新建|自建|自研|设计一|从零|从头|手写|撸一|撸个)|\b(?:implement|build|create|develop|scaffold|design|architect|write\s+a|set\s+up|from\s+scratch)\b/i

/**
 * Capability-scale nouns: anything with its own integration or maintenance
 * boundary — from full systems down to everyday tools, scripts, crawlers,
 * plugins, and sync/backup/conversion jobs. English alternatives rely on
 * `\b` word boundaries, so `async`/`client`/`description` never false-match
 * `sync`/`cli`/`script`.
 */
const SCALE_PATTERN =
  /(?:系统|模块|服务|平台|引擎|框架|管道|管线|流水线|子系统|工作流|队列|鉴权|认证|登录|支付|搜索|索引|网关|缓存层|中间件|调度|看板|面板|完整|全栈|整套|后端|前端|微服务|插件|工具|脚本|爬虫|机器人|命令行|同步|备份|抓取|聚合|推送|转换|导入|导出)|\b(?:system|module|service|platform|engine|framework|pipeline|middleware|subsystem|workflow|queue|auth(?:entication)?|payment|billing|search|indexing|sandbox|gateway|orm|cms|scheduler|notification|dashboard|panel|backend|frontend|microservices?|plugins?|tools?|utility|scripts?|cli|bots?|crawlers?|scrapers?|extensions?|backup|sync|full[- ]?stack|complete)\b/i

/** Extract the text of all text blocks in one message. */
function messageText(message: UserMessage): string {
  return message.content
    .flatMap((block) => (block.type === 'text' && 'text' in block ? [block.text] : []))
    .join('\n')
}

/** The model-facing instruction injected on a match. */
function reuseCheckMessage(matched: string[]): string {
  const hints = matched.slice(0, 4).map((word) => `"${word}"`).join(', ')
  return (
    `[AIGC Radar reuse check] This request appears to implement a substantial capability (matched: ${hints}). ` +
    'Before writing any code, call search_ai_projects once — translate the capability into concise English ' +
    'GitHub-style query terms — and weigh mature matches (500+ stars, categorized, with growth metrics) as ' +
    'reuse or design-reference options alongside your plan. If nothing fits, proceed and note that the check ran. ' +
    'This check fires at most once per turn; do not repeat it.'
  )
}

/**
 * Build the injected message inline rather than importing `createUserMessage`
 * from `@deepseek-ai/dsh-llm`: keeping that package type-only spares
 * git-installed deployments its whole peer closure for one UUID factory.
 */
function pluginUserMessage(text: string): UserMessage {
  return {
    id: crypto.randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'aigc-radar', form: 'snapshot', sections: [{ name: 'aigc-radar', text }] },
  }
}

/**
 * Register the pre-step listener for the lifetime of `ctx`.
 * Fires only on step 1, only when intent and scale signals both match, and at
 * most once per turn.
 */
export function applyProactiveReuse(ctx: Context): void {
  // Per-process latch: the update notice is injected on the first turn that
  // opens after the registry check resolved, then never again.
  let updateNoticePending = true
  ctx.on('agent/pre-step', async (
    { messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision

    const extras: UserMessage[] = []
    if (updateNoticePending) {
      const notice = await resolvedUpdateNotice()
      if (notice !== undefined) {
        updateNoticePending = false
        extras.push(pluginUserMessage(updateNoticeMessage(notice)))
      }
    }

    const text = messages.map(messageText).join('\n')
    if (INTENT_PATTERN.test(text) && SCALE_PATTERN.test(text)) {
      const matched = [...new Set(text.match(new RegExp(SCALE_PATTERN.source, 'gi')) ?? [])]
      extras.push(pluginUserMessage(reuseCheckMessage(matched)))
    }

    if (extras.length === 0) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, ...extras],
    }
  }, { prepend: true })
}
