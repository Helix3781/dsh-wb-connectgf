import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { FALLBACK_CN_APP_VERSION, type ChatIdentity } from '../src/client-identity.ts'
import { FALLBACK_APP_VERSION } from '../src/app-version.ts'

/**
 * Outbound wire pin for the phase-1 chat identity (plan §3, 阶段一离线检查):
 * capture the exact `(url, init)` the client hands to `fetch` and assert that
 * chat and probe present the desktop UA while everything else — the shared
 * header family, the body shapes, refresh, catalog, and billing — stays
 * byte-for-byte what it has always been.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch and return a probe for the last (url, init) pair it received. */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  return {
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, RequestInit]
    },
  }
}

describe('chatStream identity', () => {
  it('presents the CN desktop UA and leaves every other header unchanged', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe(IDENTITY.clientVersion)
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    // Chat must not claim to be a browser page posting cross-origin: the
    // official desktop client sends no Origin/Referer on this endpoint at all.
    // Those two stay on refresh/catalog/billing, where the console really is
    // the caller — see the regression pins below.
    expect(headers['Origin']).toBeUndefined()
    expect(headers['Referer']).toBeUndefined()
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['Authorization']).toBe('Bearer at')
    expect(headers['X-Refresh-Token']).toBeUndefined()
    // The CN branch now normalizes too (issue #4): the same object comes back
    // with `stream: true` set, which the upstream requires anyway.
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
  })

  it('strips the adapter\'s `off` effort before the CN wire (issue #4)', async () => {
    // End-to-end rather than unit: the CN branch used to hand the raw body to
    // fetch, so a unit test on the normalizer would have passed while every
    // real request still carried the rejected spelling.
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'off',
    }))
    const body = JSON.parse(wire.last()[1].body as string) as Record<string, unknown>
    expect('reasoning_effort' in body).toBe(false)
    expect(body['stream']).toBe(true)
  })

  it('keeps an explicit CN effort and prepends no system message', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
    }))
    const body = JSON.parse(wire.last()[1].body as string) as {
      reasoning_effort: string
      messages: { role: string }[]
    }
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages[0]?.role).toBe('user')
  })
  it('sends the same product token internationally, and still prepends the first system message', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    // Both shipped apps compose `WorkBuddy/<v> WorkBuddy/<v>` on the gateway
    // path; the international product name is not part of it. Only the region's
    // version, X-Domain, and the body rules differ.
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe(IDENTITY.clientVersion)
    const body = JSON.parse(init.body as string) as { messages: { role: string }[] }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
  })
})

describe('native attribution and channel headers', () => {
  it('sends the agent/trace attribution family the official client sends', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    const headers = wire.last()[1].headers as Record<string, string>
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Type']).toBe('main')
    expect(headers['x-codebuddy-request']).toBe('1')
    expect(headers['X-Private-Data']).toBe('true')
    // The three trace dialects must share one id, or the gateway cannot join
    // them; that is the official proxy's own stated rule.
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
    expect(headers['X-B3-TraceId']).toBe(headers['X-Trace-ID'])
    expect(headers['traceparent']?.split('-')[1]).toBe(headers['X-Trace-ID'])
    expect(headers['b3']?.startsWith(headers['X-Trace-ID'] as string)).toBe(true)
  })

  it('keeps one conversation across a turn and mints a message id per request', async () => {
    const upstream = client()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const wire = captureFetch('{}')
    await upstream.chatStream(CN, body)
    const first = wire.last()[1].headers as Record<string, string>
    await upstream.chatStream(CN, body)
    const second = wire.last()[1].headers as Record<string, string>

    // Same conversation, same turn: only the message id moves.
    expect(second['X-Conversation-ID']).toBe(first['X-Conversation-ID'])
    expect(second['X-Conversation-Request-ID']).toBe(first['X-Conversation-Request-ID'])
    expect(second['X-Conversation-Message-ID']).not.toBe(first['X-Conversation-Message-ID'])
    // The official client reuses the message id as the request id.
    expect(first['X-Request-ID']).toBe(first['X-Conversation-Message-ID'])
    // A top-level conversation carries no root request id at all: the official
    // client only sets one for a fork or a subagent, and an unconditional
    // header was an extra claim rather than an alignment.
    expect(first['X-Root-Request-ID']).toBeUndefined()
    expect(second['X-Root-Request-ID']).toBeUndefined()
    // Every chat call carries the ACP connection id, and it survives a turn.
    expect(first['acp-connection-id']).toBeDefined()
    expect(second['acp-connection-id']).toBe(first['acp-connection-id'])
  })

  it('spells the ids the way the official client does, and omits the pseudo-headers it never sends', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    const headers = wire.last()[1].headers as Record<string, string>
    // Session id keeps its dashes; the rest are hex-stripped, as upstream does.
    expect(headers['X-Conversation-ID']).toMatch(/^[0-9a-f-]{36}$/u)
    expect(headers['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/u)
    expect(headers['X-Conversation-Message-ID']).toMatch(/^[0-9a-f]{32}$/u)
    expect(headers['X-Request-ID']).toMatch(/^[0-9a-f]{32}$/u)
    expect(headers['acp-connection-id']).toMatch(/^[0-9a-f-]{36}$/u)
    // The `X-No-*` family belongs to `/v2/auth/state` alone. On chat it was a
    // claim the shipped client never makes — and this credential has no
    // enterprise, so the old code sent it on every single request.
    expect(headers['X-No-User-Id']).toBeUndefined()
    expect(headers['X-No-Enterprise-Id']).toBeUndefined()
    expect(headers['X-No-Department-Info']).toBeUndefined()
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Tenant-Id']).toBeUndefined()
  })

  it('never shares a conversation between two accounts', async () => {
    const upstream = client()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const wire = captureFetch('{}')
    await upstream.chatStream(CN, body)
    const a = wire.last()[1].headers as Record<string, string>
    await upstream.chatStream({ ...CN, uid: 'uid-2' }, body)
    const b = wire.last()[1].headers as Record<string, string>
    expect(b['X-Conversation-ID']).not.toBe(a['X-Conversation-ID'])
  })

  it('gives the probe its own message id but the account conversation', async () => {
    const upstream = client()
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await upstream.chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    const chat = wire.last()[1].headers as Record<string, string>
    await upstream.probeEffort(CN, 'model-x', 'low', new AbortController().signal)
    const probe = wire.last()[1].headers as Record<string, string>
    expect(probe['X-Conversation-ID']).toBe(chat['X-Conversation-ID'])
    expect(probe['X-Conversation-Message-ID']).not.toBe(chat['X-Conversation-Message-ID'])
  })
})

describe('probeEffort identity', () => {
  it('shares the chat identity rule — same UA family, CN probe shape', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(CN, 'model-x', 'low', new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(headers['X-IDE-Version']).toBe(IDENTITY.clientVersion)
    const body = JSON.parse(init.body as string) as {
      messages: { role: string }[]; max_tokens: number; reasoning_effort: string
    }
    expect(body.messages[0]?.role).toBe('user')
    expect(body.max_tokens).toBe(1)
    expect(body.reasoning_effort).toBe('low')
  })

  it('uses the international UA with the probe-only system and token floor', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(GLOBAL, 'model-x', undefined, new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(headers['X-IDE-Version']).toBe(IDENTITY.clientVersion)
    const body = JSON.parse(init.body as string) as { messages: { role: string }[]; max_tokens: number }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.max_tokens).toBe(16)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('still constructs chat and probe requests, in the desktop fallback form, when the resolver throws', async () => {
    const throwing = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        throw new Error('boom')
      },
    })
    const chatWire = captureFetch('{}')
    const chat = await throwing.chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(chat.ok).toBe(true)
    const chatHeaders = chatWire.last()[1].headers as Record<string, string>
    // Asserted against the constant, not a literal: the fallback is a
    // statement about which client version this build should claim when the
    // bundle is unreadable, and re-pinning the number here made every bump a
    // two-file edit for no added guarantee.
    expect(chatHeaders['User-Agent']).toBe(`WorkBuddy/${FALLBACK_CN_APP_VERSION} WorkBuddy/${FALLBACK_CN_APP_VERSION}`)
    // The fallback identity carries a version too, so the attribution header
    // names the same client the UA does instead of going missing.
    expect(chatHeaders['X-IDE-Type']).toBe('WorkBuddy')
    expect(chatHeaders['X-IDE-Name']).toBe('WorkBuddy')
    expect(chatHeaders['X-IDE-Version']).toBe(FALLBACK_CN_APP_VERSION)

    const probeWire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    const probe = await throwing.probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(probe.status).toBe(400)
    const probeHeaders = probeWire.last()[1].headers as Record<string, string>
    expect(probeHeaders['User-Agent']).toBe(`WorkBuddy/${FALLBACK_APP_VERSION} WorkBuddy/${FALLBACK_APP_VERSION}`)
    expect(probeHeaders['X-IDE-Version']).toBe(FALLBACK_APP_VERSION)
  })
})

describe('unchanged paths (regression pin)', () => {
  it('refresh keeps the CLI-form UA, the workbuddy source, and the shared family', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    // The attribution family is chat-only: refresh never claims to be the app.
    expect(headers['X-IDE-Type']).toBeUndefined()
    expect(headers['X-IDE-Version']).toBeUndefined()
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy')
    expect(headers['X-Refresh-Token']).toBe('rt')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
    // The native attribution family is chat-only: refresh is the console's own
    // request and must not claim to be a desktop conversation.
    expect(headers['X-Agent-Intent']).toBeUndefined()
    expect(headers['x-codebuddy-request']).toBeUndefined()
    expect(headers['X-Private-Data']).toBeUndefined()
  })

  it('CN catalog keeps the CLI-form UA', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    await client().fetchModels(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/console/enterprises/personal/models')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
  })

  it('international catalog keeps the no-space App-form UA', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    const intlClient = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.5.2', source: 'installed', bundle: '/x' }),
      resolveChatIdentity: async () => IDENTITY,
    })
    await intlClient.fetchModels(GLOBAL)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v3/config')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.2')
  })

  it('billing stays untouched by the identity change', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { Response: { Data: { Accounts: [] } } },
    }))
    await client().fetchCredits(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    expect((init.headers as Record<string, string>)['User-Agent']).toBeUndefined()
    expect((init.headers as Record<string, string>)['X-IDE-Version']).toBeUndefined()
  })

  it('catalog keeps the attribution family out as well', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    await client().fetchModels(CN)
    expect((wire.last()[1].headers as Record<string, string>)['X-IDE-Type']).toBeUndefined()
  })
})
