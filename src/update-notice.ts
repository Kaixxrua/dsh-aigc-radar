/**
 * Update notice: a read-only, once-per-process check against the npm
 * registry for a newer dsh-aigc-radar release.
 *
 * The plugin deliberately never updates itself — replacing the
 * installation underneath a running dsh process is unsafe, and startup
 * updates are the dsh launcher's job. What this module does is narrower:
 * discover that a newer release exists and hand the model an exact,
 * copy-pastable update command to relay to the user. Every failure mode
 * (offline, registry mirror lag, malformed payload, version parse)
 * collapses to "no notice"; the check never blocks a tool call or boot.
 */

import { PLUGIN_VERSION } from './client.js'

/** The resolved outcome of a check: a newer release exists on the registry. */
export interface UpdateNotice {
  latest: string
  current: string
}

/**
 * Compare two `x.y.z` versions; returns 1/−1/0 by semver precedence of the
 * numeric core. Unparseable input compares as "not newer" — a registry
 * answering with a surprising shape must not produce a phantom notice.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    if (match === null) return undefined
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === undefined || pb === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    const diff = pa[index]! - pb[index]!
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Bilingual model-facing notice, mirroring quotaErrorMessage's zh-then-en convention. */
export function updateNoticeMessage(notice: UpdateNotice): string {
  return (
    `[dsh-aigc-radar 插件更新] 新版本 ${notice.latest} 已发布（当前安装 ${notice.current}）。` +
    `请告知用户：运行 \`dsh plugin --profile web update dsh-aigc-radar\` 然后重启 dsh 即可完成更新` +
    `（若 dsh 安装在非 web 的 profile，请替换命令中的 profile 名；固定了精确版本的用户需运行` +
    ` \`dsh plugin --profile web add dsh-aigc-radar@${notice.latest}\`）。` +
    ` A newer dsh-aigc-radar release is available: ${notice.latest} (installed: ${notice.current}). ` +
    `Tell the user: run \`dsh plugin --profile web update dsh-aigc-radar\` and restart dsh ` +
    `(replace "web" if the plugin lives in another profile; exact-pin installs need ` +
    `\`dsh plugin --profile web add dsh-aigc-radar@${notice.latest}\`).`
  )
}

/** The registry base URL to query: the user's configured npm registry wins. */
export function registryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  if (configured !== undefined && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, '')
  return 'https://registry.npmjs.org'
}

interface LatestEndpointBody {
  version?: unknown
}

/** One fetch of the `{pkg}/latest` endpoint; resolves to the version string or undefined. */
async function fetchLatestVersion(registryBase: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const response = await fetchImpl(`${registryBase}/dsh-aigc-radar/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as LatestEndpointBody
  return typeof body.version === 'string' ? body.version : undefined
}

/** Module state: the in-flight/resolved check, so it runs at most once per process. */
let pendingCheck: Promise<UpdateNotice | undefined> | undefined

/**
 * Kick off the registry check. Idempotent: repeat calls share the first
 * promise. Resolves to undefined on any failure or when already current.
 */
export function startUpdateCheck(
  registryBase: string = registryBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateNotice | undefined> {
  pendingCheck ??= fetchLatestVersion(registryBase, fetchImpl)
    .then((latest): UpdateNotice | undefined =>
      latest !== undefined && compareVersions(latest, PLUGIN_VERSION) > 0
        ? { latest, current: PLUGIN_VERSION }
        : undefined,
    )
    .catch(() => undefined)
  return pendingCheck
}

/**
 * The notice if the check has already resolved to "newer release exists",
 * undefined otherwise. Awaits the in-flight promise but never starts a
 * check on its own: pre-step listeners must not introduce network I/O —
 * they only consume what startUpdateCheck already set in motion.
 */
export async function resolvedUpdateNotice(): Promise<UpdateNotice | undefined> {
  return pendingCheck
}

/** Test seam: drop the memoized check so each test starts clean. */
export function resetUpdateNoticeForTests(): void {
  pendingCheck = undefined
}
