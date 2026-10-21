import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, prepareChatBody, prepareInternationalChatBody, regionOf } from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces stream true', () => {
    expect(JSON.parse(prepareChatBody('{"model":"auto","messages":[]}'))['stream']).toBe(true)
  })

  it('keeps invalid JSON untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('flattens object tool_choice auto', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    expect(body['tool_choice']).toBe('auto')
  })

  it('passes `reasoning_effort` through verbatim, including the adapter\'s own `off` (issue #49)', () => {
    // The shared preparation is region-agnostic: the CN variant keeps its
    // existing wire behaviour, so `off` (and any other value) survives here.
    // The international-only strip lives one layer down, in
    // `prepareInternationalChatBody` — pinned by the tests below and by the
    // chatStream-level spec in upstream.spec.ts.
    for (const effort of ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareChatBody(JSON.stringify({ messages: [], reasoning_effort: effort })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('flattens named function tool_choice to the function name', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'grep' } },
    })))
    expect(body['tool_choice']).toBe('grep')
  })

  it('drops tool_choice and tools for none', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'none' },
      tools: [{ type: 'function', function: { name: 'grep' } }],
    })))
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('drops an unrecognized object tool_choice', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'weird' } })))
    expect('tool_choice' in body).toBe(false)
  })

  it('preserves the reasoning_effort the model picker selects', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    })))
    expect(body['reasoning_effort']).toBe('xhigh')
    expect(body['stream']).toBe(true)
  })

  it('rewrites developer messages to system (upstream rejects developer)', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      reasoning_effort: 'max',
    })))
    const roles = body['messages'].map((message: { role: string }) => message.role)
    expect(roles).toEqual(['system', 'user'])
    expect(body['reasoning_effort']).toBe('max')
  })
})

/**
 * The CN gateway's third-party-client check (issue #201 upstream).
 *
 * The measured rule: a body whose leading system message opens with the
 * harness identity sentence is refused with 400 / 11128; the same body opening
 * with the sentence the shipped client writes is accepted. These tests pin the
 * rewrite's scope, because an over-broad one would silently edit user prompts.
 */
describe('prepareChatBody harness-opener rewrite', () => {
  const HARNESS = 'You are an AI agent powered by DeepSeek Harness.'
  // The sentence as the prompt actually carries it: with the template's full stop.
  const HARNESS_SENTENCE = HARNESS
  const OFFICIAL = 'This conversation is powered by WorkBuddy'

  const messagesOf = (raw: string): { role: string; content: unknown }[] =>
    (JSON.parse(prepareChatBody(raw)) as { messages: { role: string; content: unknown }[] }).messages

  it('replaces the harness identity sentence with the official opener', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `${HARNESS_SENTENCE}\n\nYou are a coding agent.` }, { role: 'user', content: 'hi' }],
    }))
    // Only the identity sentence is swapped; the template's full stop and the
    // rest of the prompt stay byte-identical.
    expect(messages[0]?.content).toBe(`${OFFICIAL}.\n\nYou are a coding agent.`)
  })

  it('tolerates leading whitespace before the sentence', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `  ${HARNESS_SENTENCE}` }],
    }))
    expect(messages[0]?.content).toBe(`  ${OFFICIAL}.`)
  })

  it('rewrites an array-form system message too', () => {
    // A rewrite that only handles string content misses these requests, and the
    // gateway refuses them exactly the same way.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [
        { role: 'system', content: [{ type: 'text', text: HARNESS }] },
        { role: 'user', content: 'hi' },
      ],
    }))
    expect((messages[0]?.content as { text: string }[])[0]?.text).toBe(`${OFFICIAL}.`)
  })

  it('rewrites every system message, not only the first', () => {
    // DSH re-emits the system prompt when it changes, so a long session carries
    // several; upstream measured that fixing only the first still fails.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [
        { role: 'system', content: HARNESS_SENTENCE },
        { role: 'user', content: 'hi' },
        { role: 'system', content: `${HARNESS} again` },
      ],
    }))
    expect(messages[0]?.content).toBe(`${OFFICIAL}.`)
    expect(messages[2]?.content).toBe(`${OFFICIAL}. again`)
  })

  it('leaves a user message that quotes the sentence alone', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: `${HARNESS} what does this mean?` }],
    }))
    expect(messages[0]?.content).toBe(`${HARNESS} what does this mean?`)
  })

  it('leaves a system prompt that merely mentions the sentence in the middle alone', () => {
    // Anchoring is the measured rule: the same sentence anywhere but the front
    // is accepted by the gateway, so rewriting it would be an unnecessary edit
    // to a prompt the user wrote.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `Custom persona. ${HARNESS}` }],
    }))
    expect(messages[0]?.content).toBe(`Custom persona. ${HARNESS}`)
  })

  it('is idempotent, so the international second pass cannot double-apply', () => {
    const once = prepareChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'system', content: HARNESS_SENTENCE }] }))
    const twice = prepareChatBody(once)
    expect(JSON.parse(twice).messages[0].content).toBe(`${OFFICIAL}.`)
  })

  it('leaves a body with no system message untouched apart from stream', () => {
    const messages = messagesOf(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: HARNESS }] }))
    expect(messages[0]?.content).toBe(HARNESS)
  })
})

describe('classifyUpstreamError', () => {
  it('classifies 402 as hard credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('classifies credit wording in a 200-shaped business error', () => {
    expect(classifyUpstreamError(200, 'code=1 msg=积分不足，请充值')).toBe('hard_credit')
  })

  it('classifies the offline session marker as session dead', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
  })

  /**
   * The status code is what decides, because the marker is often absent.
   *
   * A real expired bearer does not come back as a JSON envelope at all: the
   * gateway in front of the upstream answers with an HTML error page
   * (`openresty`'s "401 Authorization Required"), which contains none of the
   * session markers. Reading the body first classified exactly the failure
   * rotation exists for as a malformed request — the one class that
   * deliberately does not switch accounts — so this case is pinned twice: with
   * a bare body, and with the HTML the gateway actually sends.
   */
  it('classifies a bare 401 as session dead even when the body says nothing', () => {
    expect(classifyUpstreamError(401, '')).toBe('session_dead')
    expect(classifyUpstreamError(401, '{"code":-1,"msg":"unauthorized"}')).toBe('session_dead')
  })

  it('classifies the gateway\'s HTML 401 as session dead', () => {
    const html = '<html><head><title>401 Authorization Required</title></head>'
      + '<body><center><h1>401 Authorization Required</h1></center><hr><center>openresty</center></body></html>'
    expect(classifyUpstreamError(401, html)).toBe('session_dead')
  })

  it('classifies 429 as soft rate', () => {
    expect(classifyUpstreamError(429, 'slow down')).toBe('soft_rate')
  })

  it('classifies 404 as transient not-found', () => {
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad')).toBe('client')
  })
})

describe('regionOf', () => {
  it('treats workbuddy.ai domains as global and everything else as cn', () => {
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('US.WorkBuddy.AI')).toBe('global')
    expect(regionOf('')).toBe('cn')
  })
})

describe('prepareInternationalChatBody effort handling (issue #49)', () => {
  it('drops the adapter\'s own `off` spelling on the international wire', () => {
    // pi-ai sends `model.thinkingLevelMap.off` for every request that carries
    // no explicit level; the international endpoint rejects it on the GPT
    // family with 400 / 11133 / `extError.param === 'reasoning.effort'`.
    // Omission is the only form measured good on every such model — including
    // `gpt-6-astra`, which also rejects a literal `'none'`.
    const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('keeps declared spellings and an explicit `none` untouched', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
        reasoning_effort: effort,
      })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('strips `off` on every early-return path, not only the system-prompt one', () => {
    // A body without a messages array takes an early return; the strip must
    // still apply, or such a request would reach the international endpoint
    // carrying the rejected spelling.
    const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({ reasoning_effort: 'off' })))
    expect('reasoning_effort' in body).toBe(false)
  })
})
