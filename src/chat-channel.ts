/**
 * The conversation channel a chat request presents.
 *
 * The upstream gateway counts requests per **conversation**, and the official
 * desktop client keeps that identity stable for the life of a conversation.
 * Its own gateway proxy states the rule plainly (measured in the shipped
 * `WorkBuddy.app` bundle, `main/daemon-bootstrap.js`, `applyGatewayHeaders`):
 *
 * > 会话 | 会话级元数据 | **一次会话内必须稳定，现生成会把同一次桌面操作的几十次
 * > VLM 调用在网关侧拆成几十个会话**
 *
 * The plugin used to mint three fresh UUIDs per request. One DSH turn is a
 * dozen chat completions (agent loop, tool calls, title generation), so the
 * gateway saw hundreds of "new conversations" per hour from one account —
 * which is both a session-limit and a behaviour-fingerprint signal, and is the
 * one part of the disguise that was measurably wrong rather than merely
 * unverified.
 *
 * So the trio now follows the official split:
 *
 * | header | lifetime | why |
 * |---|---|---|
 * | `X-Conversation-ID` | one conversation (idle-rotated) | the gateway's session bucket |
 * | `X-Conversation-Request-ID` | one user turn | a turn's follow-up calls belong together |
 * | `X-Conversation-Message-ID` | one HTTP request | varies by definition |
 *
 * A "conversation" here is bounded by idleness rather than by a DSH session id,
 * because the upstream client never sees one: a chat body carries messages, not
 * a session. Idle rotation is what the desktop app's own conversation does when
 * the user walks away, and it keeps a conversation from living for days and
 * accumulating a misleadingly long history on the gateway's side.
 *
 * @module dsh-workbuddy-connect/chat-channel
 */

import { randomUUID } from 'node:crypto'

/**
 * How long a conversation survives without traffic.
 *
 * Chosen to match a sitting rather than a turn: long enough that a tool-heavy
 * turn never opens a second conversation, short enough that tomorrow's message
 * is not filed under today's session.
 */
export const CONVERSATION_IDLE_MS = 30 * 60_000

/**
 * How long a user turn keeps its request id.
 *
 * The official client reuses one `conversationRequestId` across every model
 * call a single user message causes, and mints the next one when the user
 * speaks again. Ten minutes covers a long agent run without welding two
 * separate messages into one turn.
 */
export const TURN_IDLE_MS = 10 * 60_000

/** How many accounts' channels are remembered; the oldest is dropped beyond it. */
const MAX_TRACKED_CHANNELS = 64

/** The headers' values for one request. */
export interface ChatChannel {
  /** Stable for the life of the conversation. */
  conversationId: string
  /** Stable for the life of the user turn. */
  requestId: string
  /** Stable for the life of the conversation; the first request's id. */
  rootRequestId: string
  /** Fresh for this HTTP request. */
  messageId: string
}

/** What one key's channel looks like between requests. */
interface ChannelState {
  conversationId: string
  requestId: string
  rootRequestId: string
  lastAtMs: number
}

/**
 * Per-account conversation bookkeeping.
 *
 * Keyed by account, not global: two accounts are two identities upstream, and
 * a conversation id shared between them would be a lie the gateway can see.
 */
export class WorkBuddyChatChannels {
  private readonly channels = new Map<string, ChannelState>()

  /**
   * The channel for the next request on `key`.
   *
   * @param key - account identity (`uid:enterpriseId`); callers pass the value
   *   {@link credentialAccountId} derives so the two cannot drift.
   * @param now - wall clock, injectable so tests never depend on timing.
   */
  claim(key: string, now = Date.now()): ChatChannel {
    const current = this.channels.get(key)
    const messageId = randomUUID()

    if (current === undefined || now - current.lastAtMs > CONVERSATION_IDLE_MS) {
      // A new conversation: every id is new, and this request becomes its root.
      const fresh: ChannelState = {
        conversationId: randomUUID(),
        requestId: randomUUID(),
        rootRequestId: messageId,
        lastAtMs: now,
      }
      this.remember(key, fresh)
      return { ...fresh, messageId }
    }

    // Same conversation. The turn id rotates only after the user has been
    // silent long enough that the next request is a new message, not a
    // continuation of this one.
    const requestId = now - current.lastAtMs > TURN_IDLE_MS ? randomUUID() : current.requestId
    const next: ChannelState = { ...current, requestId, lastAtMs: now }
    this.remember(key, next)
    return { ...next, messageId }
  }

  /** Forget every conversation; used by tests and by a credential change. */
  clear(): void {
    this.channels.clear()
  }

  /** Store one key's state, evicting the least recently used beyond the cap. */
  private remember(key: string, state: ChannelState): void {
    this.channels.delete(key)
    this.channels.set(key, state)
    if (this.channels.size <= MAX_TRACKED_CHANNELS) return
    const oldest = this.channels.keys().next()
    if (!oldest.done) this.channels.delete(oldest.value)
  }
}
