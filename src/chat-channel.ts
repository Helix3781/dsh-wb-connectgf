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
 * ## Id spellings are part of the identity
 *
 * The official client does not use one UUID shape for all four ids, and a
 * client that does is recognisable by regex alone. Read out of the shipped
 * bundle (`cli/dist/codebuddy-lite-wb.mjs`):
 *
 * | id | official producer | shape |
 * |---|---|---|
 * | `X-Conversation-ID` | `SessionImpl` → `generateUUUID()` (= `crypto.randomUUID`) | 36-char dashed UUID |
 * | `X-Conversation-Request-ID` | `generateUUUID().replace(/-/g,'')` | 32-char hex |
 * | `X-Conversation-Message-ID` | `uuidv7().replace(/-/g,'')` | 32-char hex, **time-ordered** |
 * | `X-Request-ID` | the message id | 32-char hex, **time-ordered** |
 *
 * The message id being UUIDv7 is the part a random UUID cannot imitate: the
 * first 48 bits are the millisecond timestamp, so a day of requests from one
 * client sorts and clusters the way the official one does. It is also what the
 * gateway's per-conversation bucketing would use to interleave concurrent
 * requests, so this is a wire-visible property rather than cosmetics.
 *
 * @module dsh-workbuddy-connect/chat-channel
 */

import { randomBytes, randomUUID } from 'node:crypto'

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
  /** Stable for the life of the conversation; 36-char dashed, as the official session id is. */
  conversationId: string
  /** Stable for the life of the user turn; 32-char hex. */
  requestId: string
  /** Fresh for this HTTP request; 32-char hex UUIDv7. */
  messageId: string
  /**
   * The ACP connection the request claims to belong to.
   *
   * The official gateway proxy sets `acp-connection-id` on **every** chat
   * request from the session ledger, and that value is the id of a live ACP
   * connection the client opened by handshaking `POST <endpoint>/connect`.
   * This plugin calls `/v2/chat/completions` directly and never opens one, so
   * the value here is minted per conversation and is a claim rather than a
   * server-issued fact. It is still strictly better on the wire than omitting
   * the header: an absent required header is unambiguous, a stable per
   * conversation id is what a client that had opened a connection would send.
   *
   * Getting a real one means performing the ACP handshake before the first
   * chat call; that is a transport change, not a header change, and is out of
   * scope here.
   */
  acpConnectionId: string
}

/** What one key's channel looks like between requests. */
interface ChannelState {
  conversationId: string
  requestId: string
  acpConnectionId: string
  lastAtMs: number
}

/** 32-char lowercase hex, no dashes — the official `replace(/-/g,'')` form. */
function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * A UUIDv7 as 32 lowercase hex characters, matching the official message id.
 *
 * Besides being the version the official client's id generator emits, v7 is
 * time-ordered: the leading 48 bits are the millisecond clock, so a client
 * whose message ids sort by arrival time looks like the shipped one, and a
 * client whose ids are random does not.
 */
export function uuidv7Hex(now = Date.now()): string {
  const bytes = randomBytes(16)
  // 48-bit big-endian millisecond timestamp.
  const ts = BigInt(Math.trunc(now))
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((ts >> BigInt(8 * (5 - index))) & 0xffn)
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f) // version 7
  bytes[8] = 0x80 | (bytes[8]! & 0x3f) // RFC 4122 variant
  return bytes.toString('hex')
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
    // The message id is the one id minted on every call, and it is the one the
    // official client derives from a time-ordered v7 generator.
    const messageId = uuidv7Hex(now)

    if (current === undefined || now - current.lastAtMs > CONVERSATION_IDLE_MS) {
      // A new conversation: every id is new, and this request becomes its root.
      const fresh: ChannelState = {
        // The official session id is a plain `crypto.randomUUID()`, dashes and
        // all — the one id in the family that is *not* hex-stripped.
        conversationId: randomUUID(),
        requestId: hexId(16),
        acpConnectionId: randomUUID(),
        lastAtMs: now,
      }
      this.remember(key, fresh)
      return { ...fresh, messageId }
    }

    // Same conversation. The turn id rotates only after the user has been
    // silent long enough that the next request is a new message, not a
    // continuation of this one.
    const requestId = now - current.lastAtMs > TURN_IDLE_MS ? hexId(16) : current.requestId
    const next: ChannelState = { ...current, requestId, lastAtMs: now }
    this.remember(key, next)
    return { ...next, messageId }
  }

  /**
   * Drop one account's conversation so the next {@link claim} opens a new one.
   *
   * Used when a request was refused on grounds that name the *call* rather than
   * the account: the retry then arrives as a genuinely new conversation with a
   * new ACP connection, which is the only thing this side can change about how
   * it looks.
   */
  reset(key: string): void {
    this.channels.delete(key)
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
