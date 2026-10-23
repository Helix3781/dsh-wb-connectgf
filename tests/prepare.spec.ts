import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, prepareChatBody, prepareCnChatBody, prepareInternationalChatBody, regionOf } from '../src/upstream.ts'

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
 * The CN gateway's third-party-client check (upstream issue #201; this fork
 * extends it).
 *
 * Two measured rules against the live CN gateway (code 11128, "Illegal API
 * invocation from an unapproved channel"):
 *
 * - the harness identity sentence must never leave the machine — it marks a
 *   third-party caller;
 * - the leading system message must open with the bytes the shipped client
 *   actually writes, not a sentence only this plugin would produce; and a
 *   client-surface claim ("you talk to the user through <surface>" + "this
 *   page/GUI/app means X") trips the same check.
 *
 * These tests pin the rewrite's scope, because an over-broad one would
 * silently edit user prompts.
 */
describe('prepareChatBody system-prompt rewrite', () => {
  const HARNESS = 'You are an AI agent powered by DeepSeek Harness.'
  const OFFICIAL = 'You are CodeBuddy Code.You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user. Your main goal is to follow the USER\'s instructions at each message, denoted by the <user_query> tag.'

  const messagesOf = (raw: string): { role: string; content: unknown }[] =>
    (JSON.parse(prepareChatBody(raw)) as { messages: { role: string; content: unknown }[] }).messages

  it('replaces the harness identity sentence with the official opening', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `${HARNESS}\n\nYou are a coding agent.` }, { role: 'user', content: 'hi' }],
    }))
    expect(messages[0]?.content).toBe(`${OFFICIAL}\n\nYou are a coding agent.`)
  })

  it('tolerates leading whitespace before the sentence', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `  ${HARNESS}` }],
    }))
    expect(messages[0]?.content).toBe(OFFICIAL)
  })

  it('flattens an array-form system message to a string', () => {
    // The official client sends system content as a single string; an array of
    // text parts is a shape it never produces and the CN gateway rejects.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [
        { role: 'system', content: [{ type: 'text', text: HARNESS }] },
        { role: 'user', content: 'hi' },
      ],
    }))
    expect(messages[0]?.content).toBe(OFFICIAL)
    expect(typeof messages[0]?.content).toBe('string')
  })

  it('rewrites every system message, not only the first', () => {
    // DSH re-emits the system prompt when it changes, so a long session carries
    // several; only the first opens with the official bytes, the rest lose the
    // identity sentence but keep their own text.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [
        { role: 'system', content: HARNESS },
        { role: 'user', content: 'hi' },
        { role: 'system', content: `${HARNESS} again` },
      ],
    }))
    expect(messages[0]?.content).toBe(OFFICIAL)
    expect(messages[2]?.content).toBe(' again')
  })

  it('leaves a user message that quotes the sentence alone', () => {
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: `${HARNESS} what does this mean?` }],
    }))
    expect(messages[0]?.content).toBe(`${HARNESS} what does this mean?`)
  })

  it('removes the harness sentence anywhere in a system message', () => {
    // Unlike upstream's anchored rule, this fork drops every occurrence: the
    // sentence is the third-party marker, and the user asked for it to never be
    // sent. A system re-emission that mentions it mid-prompt must not leak it.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: `Custom persona. ${HARNESS}` }],
    }))
    // The first system message opens with the official bytes, and the harness
    // sentence is gone from its own paragraph; the persona text is kept.
    expect(messages[0]?.content).toBe(`${OFFICIAL}\n\nCustom persona. `)
  })

  it('removes the harness sentence from a later system re-emission', () => {
    // A long session re-emits the system prompt; only the first message opens
    // with the official bytes, the rest still drop every occurrence.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [
        { role: 'system', content: HARNESS },
        { role: 'user', content: 'hi' },
        { role: 'system', content: `Custom persona. ${HARNESS}` },
      ],
    }))
    expect(messages[0]?.content).toBe(OFFICIAL)
    expect(messages[2]?.content).toBe('Custom persona. ')
  })

  it('is idempotent, so the international second pass cannot double-apply', () => {
    const once = prepareChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'system', content: HARNESS }] }))
    const twice = prepareChatBody(once)
    expect(JSON.parse(twice).messages[0].content).toBe(OFFICIAL)
  })

  it('leaves a body with no system message untouched apart from stream', () => {
    const messages = messagesOf(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: HARNESS }] }))
    expect(messages[0]?.content).toBe(HARNESS)
    expect(JSON.parse(prepareChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })))['stream']).toBe(true)
  })

  it('drops the client-surface claim and UI-target disambiguation sentences', () => {
    // Measured on the live CN gateway (2026-10-23): the two together trip
    // code 11128; every other paragraph, including all 116 tool schemas, passes.
    const messages = messagesOf(JSON.stringify({
      model: 'hy3',
      messages: [{
        role: 'system',
        content: `${HARNESS}\n\n`
          + 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.\n'
          + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.\n\n'
          + 'Keep the rest of this paragraph intact.',
      }, { role: 'user', content: 'hi' }],
    }))
    const content = messages[0]?.content as string
    expect(content.startsWith(OFFICIAL)).toBe(true)
    expect(content).toContain('Keep the rest of this paragraph intact.')
    expect(content).not.toContain('interacting with the user through')
    expect(content).not.toContain('they mean this')
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

describe('prepareCnChatBody effort handling (issue #4)', () => {
  it('drops the adapter\'s own `off` spelling on the CN wire too', () => {
    // The CN endpoint refuses `off` on `deepseek-v4.1-flash` with 400 / 11133
    // (「模型无法处理此请求，请重试」). That row declares `canDisableThinking: true`,
    // so pi-ai pins `off` for it, and any caller that omits an explicit level
    // — notably the experimental auto-review — was refused before its body ran.
    // The strip used to be international-only; this pins the CN side.
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('keeps every declared spelling and an explicit `none` on the CN wire', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareCnChatBody(JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: effort,
      })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('strips `off` on the CN early-return path as well', () => {
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({ reasoning_effort: 'off' })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('leaves the CN body otherwise untouched: no system prompt is prepended', () => {
    // The leading-system rule belongs to the international endpoint; the CN
    // endpoint accepts a body that opens with a user message, and prepending
    // there would change what the model sees for no reason.
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: 'hello' }],
    })))
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }])
    expect(body['stream']).toBe(true)
  })

  it('still applies the shared system-prompt rewrite on the CN wire', () => {
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }],
    })))
    expect(body['messages'][0].content).toBe(
      'You are CodeBuddy Code.You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user. Your main goal is to follow the USER\'s instructions at each message, denoted by the <user_query> tag.',
    )
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
