/**
 * Planner shared DTO helpers.
 * Spec: docs/specs/mhud-today-planner.md §4.1 (WI-0).
 */
import { describe, it, expect } from 'vitest'
import type { PlannerDraft, PlannerItem } from '@prisma/client'
import {
  PLANNER_ACTIONS,
  PLANNER_PRIORITIES,
  PLANNER_SECTIONS,
  PLANNER_SOURCES,
  PLANNER_STATUSES,
  parseJsonObject,
  safeHttpUrl,
  safeItemUrl,
  toPlannerDraftDTO,
  toPlannerItemDTO,
} from '../../../src/lib/planner/types'

function itemRow(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: 'it-1',
    orgId: 'org-1',
    userId: 'user-1',
    source: 'card',
    sourceKey: 'card:c1',
    title: 'Ship the thing',
    summary: null,
    url: null,
    priority: 'high',
    dueAt: new Date('2026-09-17T10:00:00Z'),
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: '{"cardId":"c1","boardId":"b1"}',
    lastSeenAt: new Date('2026-09-16T08:00:00Z'),
    createdAt: new Date('2026-09-15T08:00:00Z'),
    updatedAt: new Date('2026-09-16T08:00:00Z'),
    ...overrides,
  }
}

describe('planner/types', () => {
  it('exports the closed vocabularies the spec names', () => {
    expect([...PLANNER_SOURCES]).toEqual(['card', 'email', 'calendar', 'slack', 'manual'])
    expect([...PLANNER_STATUSES]).toEqual(['open', 'done', 'dismissed', 'snoozed', 'wont_do'])
    expect([...PLANNER_ACTIONS]).toEqual(['done', 'dismiss', 'wont_do', 'snooze', 'reopen'])
    expect([...PLANNER_PRIORITIES]).toEqual(['none', 'low', 'medium', 'high', 'critical'])
    expect([...PLANNER_SECTIONS]).toEqual([
      'now',
      'today',
      'soon',
      'later',
      'snoozed',
      'done',
      'wont_do',
      'dismissed',
    ])
  })

  describe('parseJsonObject', () => {
    it('parses objects and degrades everything else to {}', () => {
      expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
      expect(parseJsonObject('[1,2]')).toEqual({})
      expect(parseJsonObject('"str"')).toEqual({})
      expect(parseJsonObject('not json')).toEqual({})
      expect(parseJsonObject(null)).toEqual({})
      expect(parseJsonObject('')).toEqual({})
    })
  })

  describe('toPlannerItemDTO', () => {
    it('serialises dates to ISO strings and parses the payload', () => {
      const dto = toPlannerItemDTO(itemRow())
      expect(dto).toMatchObject({
        id: 'it-1',
        source: 'card',
        sourceKey: 'card:c1',
        title: 'Ship the thing',
        summary: null,
        url: null,
        priority: 'high',
        dueAt: '2026-09-17T10:00:00.000Z',
        startsAt: null,
        endsAt: null,
        status: 'open',
        snoozedUntil: null,
        resolvedBy: null,
        resolvedAt: null,
        prepNotes: null,
        payload: { cardId: 'c1', boardId: 'b1' },
        lastSeenAt: '2026-09-16T08:00:00.000Z',
        createdAt: '2026-09-15T08:00:00.000Z',
        updatedAt: '2026-09-16T08:00:00.000Z',
      })
      // No Prisma internals leak (orgId/userId are server-side only).
      expect('userId' in dto).toBe(false)
      expect('orgId' in dto).toBe(false)
    })

    it('never throws on a malformed payload or unknown enum values', () => {
      const dto = toPlannerItemDTO(
        itemRow({
          payload: '{{oops',
          priority: 'urgent',
          status: 'weird',
          source: 'fax',
          resolvedBy: 'robot',
        })
      )
      expect(dto.payload).toEqual({})
      expect(dto.priority).toBe('none')
      expect(dto.status).toBe('open')
      expect(dto.source).toBe('manual')
      expect(dto.resolvedBy).toBeNull()
    })

    it('keeps resolved fields when set', () => {
      const dto = toPlannerItemDTO(
        itemRow({
          status: 'done',
          resolvedBy: 'source',
          resolvedAt: new Date('2026-09-16T09:00:00Z'),
        })
      )
      expect(dto.status).toBe('done')
      expect(dto.resolvedBy).toBe('source')
      expect(dto.resolvedAt).toBe('2026-09-16T09:00:00.000Z')
    })
  })

  describe('toPlannerDraftDTO', () => {
    const base: PlannerDraft = {
      id: 'd-1',
      orgId: 'org-1',
      userId: 'user-1',
      itemId: 'it-1',
      title: 'Re: Ship the thing',
      body: '# hi',
      status: 'draft',
      handoff: null,
      createdAt: new Date('2026-09-16T08:00:00Z'),
      updatedAt: new Date('2026-09-16T08:05:00Z'),
    }

    it('maps a plain draft', () => {
      expect(toPlannerDraftDTO(base)).toEqual({
        id: 'd-1',
        itemId: 'it-1',
        title: 'Re: Ship the thing',
        body: '# hi',
        status: 'draft',
        handoff: null,
        createdAt: '2026-09-16T08:00:00.000Z',
        updatedAt: '2026-09-16T08:05:00.000Z',
      })
    })

    it('parses a handoff record and drops malformed ones', () => {
      const ok = toPlannerDraftDTO({
        ...base,
        status: 'handed_off',
        handoff: JSON.stringify({
          kind: 'gdoc',
          ref: 'doc1',
          url: 'https://docs.google.com/document/d/doc1/edit',
          at: '2026-09-16T08:10:00.000Z',
        }),
      })
      expect(ok.status).toBe('handed_off')
      expect(ok.handoff).toEqual({
        kind: 'gdoc',
        ref: 'doc1',
        url: 'https://docs.google.com/document/d/doc1/edit',
        at: '2026-09-16T08:10:00.000Z',
      })

      const bad = toPlannerDraftDTO({ ...base, handoff: '{"kind":"gdoc"}' })
      expect(bad.handoff).toBeNull()
      const garbage = toPlannerDraftDTO({ ...base, handoff: 'nope', status: 'whatever' })
      expect(garbage.handoff).toBeNull()
      expect(garbage.status).toBe('draft')
    })
  })

  describe('safeHttpUrl', () => {
    it('allows only absolute http(s) and normalizes', () => {
      expect(safeHttpUrl('https://mail.google.com/mail/u/0/#inbox/abc')).toBe(
        'https://mail.google.com/mail/u/0/#inbox/abc'
      )
      expect(safeHttpUrl('HTTP://Example.com')).toBe('http://example.com/')
      expect(safeHttpUrl('  https://x.y/z  ')).toBe('https://x.y/z')
    })

    it('rejects every other scheme and non-URLs', () => {
      expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
      expect(safeHttpUrl('data:text/html,hi')).toBeUndefined()
      expect(safeHttpUrl('mailto:a@b.c')).toBeUndefined()
      expect(safeHttpUrl('//evil.com/x')).toBeUndefined()
      expect(safeHttpUrl('/board/b1?card=c1')).toBeUndefined()
      expect(safeHttpUrl('')).toBeUndefined()
      expect(safeHttpUrl(42)).toBeUndefined()
      expect(safeHttpUrl(null)).toBeUndefined()
    })
  })

  describe('safeItemUrl', () => {
    it('additionally allows app-relative paths with a single leading slash', () => {
      expect(safeItemUrl('/board/b1?card=c1')).toBe('/board/b1?card=c1')
      expect(safeItemUrl('https://slack.com/archives/C1/p1')).toBe(
        'https://slack.com/archives/C1/p1'
      )
      expect(safeItemUrl('//evil.com')).toBeUndefined()
      expect(safeItemUrl('/with space')).toBeUndefined()
      expect(safeItemUrl('javascript:alert(1)')).toBeUndefined()
      expect(safeItemUrl('board/b1')).toBeUndefined()
    })
  })
})
