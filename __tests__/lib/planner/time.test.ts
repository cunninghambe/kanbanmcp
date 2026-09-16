/**
 * Planner time helpers — day windows in the user's IANA zone, no date library.
 * Spec: docs/specs/mhud-today-planner.md §4.2 (WI-0).
 */
import { describe, it, expect } from 'vitest'
import {
  DATE_RE,
  addDays,
  dayBounds,
  isValidTimeZone,
  localDate,
  tzOffsetMinutes,
} from '../../../src/lib/planner/time'

const HOUR = 60 * 60 * 1000

describe('planner/time', () => {
  describe('isValidTimeZone', () => {
    it('accepts IANA names and rejects garbage', () => {
      expect(isValidTimeZone('UTC')).toBe(true)
      expect(isValidTimeZone('Europe/London')).toBe(true)
      expect(isValidTimeZone('America/New_York')).toBe(true)
      expect(isValidTimeZone('Mars/Olympus')).toBe(false)
      expect(isValidTimeZone('')).toBe(false)
      expect(isValidTimeZone(undefined as unknown as string)).toBe(false)
    })
  })

  describe('tzOffsetMinutes', () => {
    it('returns the offset in force at the instant', () => {
      expect(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(60)
      expect(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0)
      expect(tzOffsetMinutes(new Date('2026-09-16T12:00:00Z'), 'America/New_York')).toBe(-240)
      expect(tzOffsetMinutes(new Date('2026-09-16T12:00:00Z'), 'Asia/Kolkata')).toBe(330)
      expect(tzOffsetMinutes(new Date('2026-09-16T12:00:00Z'), 'UTC')).toBe(0)
    })

    it('throws RangeError for an invalid zone', () => {
      expect(() => tzOffsetMinutes(new Date(), 'Nope/Nowhere')).toThrow(RangeError)
    })
  })

  describe('localDate', () => {
    it('formats the local calendar date of an instant', () => {
      expect(localDate(new Date('2026-09-16T23:30:00Z'), 'Pacific/Auckland')).toBe('2026-09-17')
      expect(localDate(new Date('2026-09-16T03:30:00Z'), 'America/Los_Angeles')).toBe('2026-09-15')
      expect(localDate(new Date('2026-09-16T03:30:00Z'), 'UTC')).toBe('2026-09-16')
    })
  })

  describe('addDays', () => {
    it('does calendar arithmetic across month and year ends', () => {
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
      expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
      expect(addDays('2026-09-16', 7)).toBe('2026-09-23')
    })

    it('rejects impossible dates', () => {
      expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
      expect(() => addDays('2026-13-01', 1)).toThrow(RangeError)
      expect(() => addDays('16-09-2026', 1)).toThrow(RangeError)
    })
  })

  describe('dayBounds', () => {
    it('returns [local midnight, next local midnight) as UTC instants', () => {
      const w = dayBounds('2026-09-16', 'America/New_York')
      expect(w.start.toISOString()).toBe('2026-09-16T04:00:00.000Z')
      expect(w.end.toISOString()).toBe('2026-09-17T04:00:00.000Z')
    })

    it('is the identity in UTC', () => {
      const w = dayBounds('2026-09-16', 'UTC')
      expect(w.start.toISOString()).toBe('2026-09-16T00:00:00.000Z')
      expect(w.end.toISOString()).toBe('2026-09-17T00:00:00.000Z')
    })

    it('produces a 23-hour day when DST starts (Europe/London 2026-03-29)', () => {
      const w = dayBounds('2026-03-29', 'Europe/London')
      expect(w.start.toISOString()).toBe('2026-03-29T00:00:00.000Z')
      expect(w.end.toISOString()).toBe('2026-03-29T23:00:00.000Z')
      expect(w.end.getTime() - w.start.getTime()).toBe(23 * HOUR)
    })

    it('produces a 25-hour day when DST ends (Europe/London 2026-10-25)', () => {
      const w = dayBounds('2026-10-25', 'Europe/London')
      expect(w.start.toISOString()).toBe('2026-10-24T23:00:00.000Z')
      expect(w.end.toISOString()).toBe('2026-10-26T00:00:00.000Z')
      expect(w.end.getTime() - w.start.getTime()).toBe(25 * HOUR)
    })

    it('handles zones ahead of UTC', () => {
      const w = dayBounds('2026-09-16', 'Asia/Kolkata')
      expect(w.start.toISOString()).toBe('2026-09-15T18:30:00.000Z')
      expect(w.end.toISOString()).toBe('2026-09-16T18:30:00.000Z')
    })

    it('round-trips with localDate at both edges', () => {
      const w = dayBounds('2026-09-16', 'Australia/Sydney')
      expect(localDate(w.start, 'Australia/Sydney')).toBe('2026-09-16')
      expect(localDate(new Date(w.end.getTime() - 1), 'Australia/Sydney')).toBe('2026-09-16')
      expect(localDate(w.end, 'Australia/Sydney')).toBe('2026-09-17')
    })

    it('throws RangeError for a bad date or zone', () => {
      expect(() => dayBounds('2026-02-30', 'UTC')).toThrow(RangeError)
      expect(() => dayBounds('2026/09/16', 'UTC')).toThrow(RangeError)
      expect(() => dayBounds('2026-09-16', 'Mars/Olympus')).toThrow(RangeError)
    })
  })

  it('DATE_RE matches only YYYY-MM-DD', () => {
    expect(DATE_RE.test('2026-09-16')).toBe(true)
    expect(DATE_RE.test('2026-9-16')).toBe(false)
    expect(DATE_RE.test('2026-09-16T00:00')).toBe(false)
  })
})
