import { describe, expect, it } from 'vitest'
import { CONVERSATION_IDLE_MS, TURN_IDLE_MS, WorkBuddyChatChannels } from '../src/chat-channel.ts'

/**
 * The lifetimes the gateway sees. These tests exist because the rule is about
 * *time*, not about a single request: a block that mints a fresh UUID per call
 * passes every one-shot test while making one DSH turn look like a dozen
 * separate gateway conversations.
 */

const T0 = 1_792_000_000_000

describe('conversation channel lifetimes', () => {
  it('keeps one conversation and one turn across consecutive requests', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const second = channels.claim('uid-1:', T0 + 1_000)
    expect(second.conversationId).toBe(first.conversationId)
    expect(second.requestId).toBe(first.requestId)
    expect(second.acpConnectionId).toBe(first.acpConnectionId)
    expect(second.messageId).not.toBe(first.messageId)
  })

  it('rotates the turn after the idle window but keeps the conversation', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const later = channels.claim('uid-1:', T0 + TURN_IDLE_MS + 1)
    expect(later.conversationId).toBe(first.conversationId)
    expect(later.requestId).not.toBe(first.requestId)
    // The ACP connection belongs to the conversation, not to the turn.
    expect(later.acpConnectionId).toBe(first.acpConnectionId)
  })

  it('opens a new conversation once the conversation idle window passes', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const next = channels.claim('uid-1:', T0 + CONVERSATION_IDLE_MS + 1)
    expect(next.conversationId).not.toBe(first.conversationId)
    expect(next.requestId).not.toBe(first.requestId)
    expect(next.acpConnectionId).not.toBe(first.acpConnectionId)
  })

  it('keeps each account on its own conversation', () => {
    const channels = new WorkBuddyChatChannels()
    const a = channels.claim('uid-1:', T0)
    const b = channels.claim('uid-2:', T0)
    expect(b.conversationId).not.toBe(a.conversationId)
    expect(channels.claim('uid-1:', T0 + 1_000).conversationId).toBe(a.conversationId)
  })

  it('treats a boundary exactly at the idle window as still inside it', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const edge = channels.claim('uid-1:', T0 + CONVERSATION_IDLE_MS)
    expect(edge.conversationId).toBe(first.conversationId)
  })

  it('forgets everything on clear, as a credential change must', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    channels.clear()
    expect(channels.claim('uid-1:', T0 + 1_000).conversationId).not.toBe(first.conversationId)
  })

  it('bounds the table so a long-lived process cannot grow it without limit', () => {
    const channels = new WorkBuddyChatChannels()
    const evicted = channels.claim('uid-0:', T0)
    for (let index = 1; index < 200; index += 1) channels.claim(`uid-${String(index)}:`, T0)
    // The most recent key still has its conversation.
    const kept = channels.claim('uid-199:', T0 + 1)
    expect(kept.conversationId).not.toBe(evicted.conversationId)
    // The evicted key starts over rather than resuming the conversation the
    // cap was supposed to have released.
    const recycled = channels.claim('uid-0:', T0 + 2)
    expect(recycled.conversationId).not.toBe(evicted.conversationId)
  })

  it('opens a new conversation when one is reset after a refused call', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    channels.reset('uid-1:')
    const next = channels.claim('uid-1:', T0 + 1_000)
    expect(next.conversationId).not.toBe(first.conversationId)
    expect(next.acpConnectionId).not.toBe(first.acpConnectionId)
  })

  it('spells each id the way the official client does', () => {
    const channels = new WorkBuddyChatChannels()
    const channel = channels.claim('uid-1:', T0)
    // Session id: a plain dashed UUID, the one id the official client does not
    // strip. The other three are 32-char hex.
    expect(channel.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(channel.requestId).toMatch(/^[0-9a-f]{32}$/u)
    expect(channel.messageId).toMatch(/^[0-9a-f]{32}$/u)
    expect(channel.acpConnectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  })

  it('makes the message id a time-ordered UUIDv7', () => {
    const channels = new WorkBuddyChatChannels()
    const early = channels.claim('uid-1:', T0)
    const late = channels.claim('uid-1:', T0 + 60_000)
    // Version and variant nibbles: the official generator emits v7.
    expect(early.messageId[12]).toBe('7')
    expect('89ab').toContain(early.messageId[16] as string)
    // Time-ordered: the leading 48 bits are the clock, so a later request sorts
    // after an earlier one even if its random tail does not.
    expect(late.messageId.slice(0, 12) > early.messageId.slice(0, 12)).toBe(true)
  })
})
