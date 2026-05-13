/**
 * Tests for the log email provider
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('log email provider', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('returns a messageId string', async () => {
    const { sendEmail } = await import('../../src/lib/email/providers/log')
    const result = await sendEmail('test@example.com', 'Hello', 'Body text')
    expect(typeof result.messageId).toBe('string')
    expect(result.messageId.length).toBeGreaterThan(0)
  })

  it('emits a console.log with structured fields', async () => {
    const { sendEmail } = await import('../../src/lib/email/providers/log')
    await sendEmail('test@example.com', 'Subject', 'Body')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"provider":"log"')
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"to":"test@example.com"')
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"subject":"Subject"')
    )
  })

  it('returns a unique messageId on each call', async () => {
    const { sendEmail } = await import('../../src/lib/email/providers/log')
    const r1 = await sendEmail('a@example.com', 'S', 'B')
    const r2 = await sendEmail('b@example.com', 'S', 'B')
    expect(r1.messageId).not.toBe(r2.messageId)
  })
})
