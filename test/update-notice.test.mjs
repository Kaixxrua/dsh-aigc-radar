/**
 * Unit tests for the update notice: version comparison, registry check
 * outcomes (fail-open on every error shape), per-process memoization, the
 * bilingual notice copy, and the PLUGIN_VERSION ↔ package.json invariant.
 * Run `npm run build` first — the tests exercise the built bundle.
 *
 * fetch is passed in per call; no network, no stubs on globalThis.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import {
  PLUGIN_VERSION,
  compareVersions,
  resetUpdateNoticeForTests,
  resolvedUpdateNotice,
  startUpdateCheck,
  updateNoticeMessage,
} from '../dist/index.mjs'

/** The version declared in package.json. */
function packageVersion() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return manifest.version
}

const REGISTRY = 'https://registry.example'

afterEach(() => {
  resetUpdateNoticeForTests()
})

/** A fetch stub resolving to a `{pkg}/latest`-shaped payload. */
function fetchWith(body, options = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (options.throw !== undefined) throw options.throw
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

test('compareVersions orders numeric cores and rejects malformed input', () => {
  assert.equal(compareVersions('0.2.3', '0.2.2'), 1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.2.2', '0.2.2'), 0)
  assert.equal(compareVersions('0.2.1', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.3-beta.1', '0.2.2'), 1)
  // Malformed input compares as "not newer" — a weird registry payload must
  // never produce a phantom notice.
  assert.equal(compareVersions('not-a-version', '0.2.2'), 0)
  assert.equal(compareVersions('0.2.3', 'not-a-version'), 0)
})

test('startUpdateCheck resolves a notice when the registry is newer', async () => {
  const { fetchImpl, calls } = fetchWith({ version: '99.0.0' })
  const notice = await startUpdateCheck(REGISTRY, fetchImpl)
  assert.deepEqual(notice, { latest: '99.0.0', current: PLUGIN_VERSION })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${REGISTRY}/dsh-aigc-radar/latest`)
  // The resolved notice is what the pre-step listener consumes.
  assert.deepEqual(await resolvedUpdateNotice(), notice)
})

test('startUpdateCheck runs at most once per process', async () => {
  const { fetchImpl, calls } = fetchWith({ version: '99.0.0' })
  const first = await startUpdateCheck(REGISTRY, fetchImpl)
  const second = await startUpdateCheck(REGISTRY, fetchImpl)
  assert.equal(calls.length, 1)
  assert.deepEqual(first, second)
})

test('startUpdateCheck stays silent when already current or ahead', async () => {
  const { fetchImpl } = fetchWith({ version: PLUGIN_VERSION })
  assert.equal(await startUpdateCheck(REGISTRY, fetchImpl), undefined)
  assert.equal(await resolvedUpdateNotice(), undefined)

  resetUpdateNoticeForTests()
  const older = fetchWith({ version: '0.0.1' })
  assert.equal(await startUpdateCheck(REGISTRY, older.fetchImpl), undefined)
})

test('startUpdateCheck fails open on HTTP errors, bad payloads, and network throws', async () => {
  const httpError = fetchWith({ version: '99.0.0' }, { status: 503 })
  assert.equal(await startUpdateCheck(REGISTRY, httpError.fetchImpl), undefined)

  resetUpdateNoticeForTests()
  const wrongShape = fetchWith({ name: 'dsh-aigc-radar' })
  assert.equal(await startUpdateCheck(REGISTRY, wrongShape.fetchImpl), undefined)

  resetUpdateNoticeForTests()
  const invalidJson = fetchWith('not json at all')
  assert.equal(await startUpdateCheck(REGISTRY, invalidJson.fetchImpl), undefined)

  resetUpdateNoticeForTests()
  const offline = fetchWith(undefined, { throw: new TypeError('fetch failed') })
  assert.equal(await startUpdateCheck(REGISTRY, offline.fetchImpl), undefined)

  // A failed check memoizes to "no notice" too — no retry storms per process.
  assert.equal(await startUpdateCheck(REGISTRY, offline.fetchImpl), undefined)
  assert.equal((await startUpdateCheck(REGISTRY, fetchWith({ version: '99.0.0' }).fetchImpl)), undefined)
})

test('updateNoticeMessage carries both versions and the update command, bilingual', () => {
  const message = updateNoticeMessage({ latest: '0.3.0', current: '0.2.2' })
  assert.match(message, /0\.3\.0 已发布（当前安装 0\.2\.2）/)
  assert.match(message, /dsh plugin --profile web update dsh-aigc-radar/)
  assert.match(message, /dsh plugin --profile web add dsh-aigc-radar@0\.3\.0/)
  assert.match(message, /release is available: 0\.3\.0 \(installed: 0\.2\.2\)/)
})

test('resolvedUpdateNotice is undefined before any check runs', async () => {
  assert.equal(await resolvedUpdateNotice(), undefined)
})

test('PLUGIN_VERSION matches package.json', () => {
  assert.equal(PLUGIN_VERSION, packageVersion())
})
