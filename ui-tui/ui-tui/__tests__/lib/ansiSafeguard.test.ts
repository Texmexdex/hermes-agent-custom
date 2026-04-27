import { describe, expect, it } from 'vitest'
import { ensureSafeAnsi } from '../../src/lib/ansiSafeguard'

describe('ansiSafeguard', () => {
  describe('ensureSafeAnsi', () => {
    it('should handle text without any ANSI codes', () => {
      const input = 'Hello, world!'
      expect(ensureSafeAnsi(input)).toBe(input)
    })

    it('should properly handle already terminated invert sequences', () => {
      const input = '\x1b[7mInverted text\x1b[27m'
      expect(ensureSafeAnsi(input)).toBe(input)
    })

    it('should add missing invert termination', () => {
      const input = '\x1b[7mInverted text'
      expect(ensureSafeAnsi(input)).toBe('\x1b[7mInverted text\x1b[27m\x1b[0m')
    })

    it('should handle multiple unterminated sequences', () => {
      const input = '\x1b[7mInverted \x1b[2mdim text'
      const expected = '\x1b[7mInverted \x1b[2mdim text\x1b[22m\x1b[27m\x1b[0m'
      expect(ensureSafeAnsi(input)).toBe(expected)
    })

    it('should add reset code to any string with ANSI sequences', () => {
      const input = '\x1b[7mInverted text\x1b[27m'
      expect(ensureSafeAnsi(input)).toBe('\x1b[7mInverted text\x1b[27m\x1b[0m')
    })
  })
})