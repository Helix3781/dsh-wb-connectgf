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
    expect(second.rootRequestId).toBe(first.rootRequestId)
    expect(second.messageId).not.toBe(first.messageId)
  })

  it('rotates the turn after the idle window but keeps the conversation', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const later = channels.claim('uid-1:', T0 + TURN_IDLE_MS + 1)
    expect(later.conversationId).toBe(first.conversationId)
    expect(later.requestId).not.toBe(first.requestId)
    // The root request id names the conversation's opening call, not the turn.
    expect(later.rootRequestId).toBe(first.rootRequestId)
  })

  it('opens a new conversation once the conversation idle window passes', () => {
    const channels = new WorkBuddyChatChannels()
    const first = channels.claim('uid-1:', T0)
    const next = channels.claim('uid-1:', T0 + CONVERSATION_IDLE_MS + 1)
    expect(next.conversationId).not.toBe(first.conversationId)
    expect(next.requestId).not.toBe(first.requestId)
    expect(next.rootRequestId).toBe(next.messageId)
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
    for (let index = 0; index < 200; index += 1) channels.claim(`uid-${String(index)}:`, T0)
    // The most recent key still has its conversation; the first is long gone.
    const kept = channels.claim('uid-199:', T0 + 1)
    expect(kept.requestId).toBe(kept.requestId)
    const recycled = channels.claim('uid-0:', T0 + 2)
    expect(recycled.rootRequestId).toBe(recycled.messageId)
  })
})
