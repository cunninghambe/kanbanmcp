import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encryptSecret, decryptSecret, maskApiKey } from '../../src/lib/secrets'

const TEST_KEY = 'a'.repeat(64) // 32 bytes as hex

describe('secrets', () => {
  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY
  })

  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
  })

  describe('encryptSecret / decryptSecret', () => {
    it('round-trips plaintext', () => {
      const plaintext = 'sk-ant-api03-super-secret-key-1234'
      expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext)
    })

    it('produces different ciphertext each time (random IV)', () => {
      const plaintext = 'hello'
      expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext))
    })

    it('throws on tampered ciphertext', () => {
      const encrypted = encryptSecret('sensitive')
      const buf = Buffer.from(encrypted, 'base64')
      // Flip a byte in the ciphertext portion (after 12-byte IV + 16-byte tag = 28 bytes)
      buf[30] ^= 0xff
      expect(() => decryptSecret(buf.toString('base64'))).toThrow()
    })

    it('throws on ciphertext that is too short', () => {
      expect(() => decryptSecret(Buffer.from('short').toString('base64'))).toThrow(
        'Invalid ciphertext: too short'
      )
    })
  })

  describe('missing SETTINGS_ENCRYPTION_KEY', () => {
    it('encryptSecret throws when key is unset', () => {
      delete process.env.SETTINGS_ENCRYPTION_KEY
      expect(() => encryptSecret('anything')).toThrow('SETTINGS_ENCRYPTION_KEY is not set')
    })

    it('decryptSecret throws when key is unset', () => {
      const encrypted = encryptSecret('anything')
      delete process.env.SETTINGS_ENCRYPTION_KEY
      expect(() => decryptSecret(encrypted)).toThrow('SETTINGS_ENCRYPTION_KEY is not set')
    })
  })

  describe('maskApiKey', () => {
    it('shows sk-ant- prefix and last 6 chars', () => {
      expect(maskApiKey('sk-ant-api03-abcdefgh')).toBe('sk-ant-…cdefgh')
    })

    it('handles short keys gracefully', () => {
      expect(maskApiKey('abc')).toBe('…abc')
    })
  })
})
