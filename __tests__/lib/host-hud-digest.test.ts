import { describe, it, expect } from 'vitest'
import type { HudEntry } from '@prisma/client'
import { buildDigest, type DigestInput } from '../../src/lib/host-hud/digest'

function entry(overrides: Partial<HudEntry> & Pick<HudEntry, 'kind' | 'text'>): HudEntry {
  return {
    id: 'entry-id',
    orgId: 'org-1',
    hudSessionId: 'hud-1',
    authorId: 'user-chair',
    position: 0,
    checkedAt: null,
    assigneeId: null,
    dueDate: null,
    cardId: null,
    createdAt: new Date('2026-07-13T14:00:00'),
    updatedAt: new Date('2026-07-13T14:00:00'),
    ...overrides,
  }
}

// Full fixture: 2 decisions, 1/2 agenda checked, 1 action with a card + 1
// without (assignee + due), 3 dispatches (done/done/failed), 2 changesets
// (pending/applied), 0 notes — the zero-notes gap doubles as the
// empty-section-omission case.
function fullFixtureInput(overrides: Partial<DigestInput> = {}): DigestInput {
  const entries: HudEntry[] = [
    entry({ kind: 'agenda', text: 'Review roadmap', position: 0, checkedAt: new Date('2026-07-13T14:05:00') }),
    entry({ kind: 'agenda', text: 'Discuss budget', position: 1, checkedAt: null }),
    entry({ kind: 'decision', text: 'Adopt new pricing', createdAt: new Date('2026-07-13T14:10:00') }),
    entry({ kind: 'decision', text: 'Sunset legacy tier', createdAt: new Date('2026-07-13T14:20:00') }),
    entry({
      kind: 'action',
      text: 'send contract',
      assigneeId: 'user-brad',
      dueDate: new Date(2026, 6, 15),
      cardId: 'card-1',
    }),
    entry({
      kind: 'action',
      text: 'schedule kickoff',
      assigneeId: 'user-nadia',
      dueDate: new Date(2026, 6, 20),
      cardId: null,
    }),
  ]

  return {
    session: {
      id: 'hud-1',
      title: 'Weekly Sync',
      startedAt: new Date('2026-07-13T14:00:00'),
      endedAt: new Date('2026-07-13T15:32:00'),
    },
    boardName: 'Product Board',
    entries,
    dispatches: [
      { target: 'board', question: 'What changed today?', status: 'done', answer: 'Three cards moved to Done.' },
      { target: 'email', question: 'Any urgent replies?', status: 'done', answer: null },
      { target: 'drive', question: 'Latest doc updates?', status: 'failed', answer: null },
    ],
    changeSets: [
      { id: 'cs-1', status: 'pending', summary: 'Move 3 cards to Done', itemCount: 3 },
      { id: 'cs-2', status: 'applied', summary: null, itemCount: 1 },
    ],
    memberNames: new Map([
      ['user-brad', 'Brad Pitt'],
      ['user-nadia', 'Nadia Ray'],
    ]),
    ...overrides,
  }
}

describe('buildDigest', () => {
  it('POSITIVE: computes every stats field from the full fixture', () => {
    const digest = buildDigest(fullFixtureInput())
    expect(digest.stats).toEqual({
      durationMs: 92 * 60_000,
      dispatches: 3,
      answered: 2,
      failed: 1,
      proposals: 2,
      proposalsPending: 1,
      actions: 2,
      actionsWithCards: 1,
      decisions: 2,
      notes: 0,
      agendaDone: 1,
      agendaTotal: 2,
    })
  })

  it('POSITIVE: shapes the structured sections (agenda, decisions, actions, dispatches, changeSets)', () => {
    const digest = buildDigest(fullFixtureInput())

    expect(digest.agenda).toEqual([
      { text: 'Review roadmap', checked: true },
      { text: 'Discuss budget', checked: false },
    ])
    expect(digest.decisions).toEqual([
      { text: 'Adopt new pricing', at: new Date('2026-07-13T14:10:00').toISOString() },
      { text: 'Sunset legacy tier', at: new Date('2026-07-13T14:20:00').toISOString() },
    ])
    expect(digest.notes).toEqual([])
    expect(digest.actions).toEqual([
      { text: 'send contract', assigneeName: 'Brad Pitt', dueDate: '2026-07-15', cardId: 'card-1' },
      { text: 'schedule kickoff', assigneeName: 'Nadia Ray', dueDate: '2026-07-20', cardId: null },
    ])
    expect(digest.dispatches).toEqual([
      { target: 'board', question: 'What changed today?', status: 'done', answerExcerpt: 'Three cards moved to Done.' },
      { target: 'email', question: 'Any urgent replies?', status: 'done', answerExcerpt: null },
      { target: 'drive', question: 'Latest doc updates?', status: 'failed', answerExcerpt: null },
    ])
    expect(digest.changeSets).toEqual([
      { id: 'cs-1', status: 'pending', summary: 'Move 3 cards to Done', itemCount: 3 },
      { id: 'cs-2', status: 'applied', summary: null, itemCount: 1 },
    ])
  })

  it('POSITIVE: markdown contains headers, checkbox rows, and action fragments; empty sections are omitted entirely', () => {
    const { markdown } = buildDigest(fullFixtureInput())

    expect(markdown).toContain('## Decisions')
    expect(markdown).toContain('## Action items')
    expect(markdown).toContain('## Agenda (1/2)')
    expect(markdown).toContain('## Agent dispatches (3)')
    expect(markdown).toContain('## Proposed changes')

    expect(markdown).toContain('- [x] Review roadmap')
    expect(markdown).toContain('- [ ] Discuss budget')
    // Action checkboxes are always unchecked — an action item is a task, not
    // "done"; `(card: id)` alone carries the has-a-card signal.
    expect(markdown).toContain('- [ ] send contract — @Brad Pitt, due 2026-07-15 (card: card-1)')
    expect(markdown).toContain('- [ ] schedule kickoff — @Nadia Ray, due 2026-07-20')
    expect(markdown).toContain('- Move 3 cards to Done — pending, 3 items')
    expect(markdown).toContain('- (no summary) — applied, 1 item')

    // Zero notes in this fixture -> the whole section, including its header, is absent.
    expect(markdown).not.toContain('## Notes')
  })

  it('EDGE: a live session (endedAt null) has null durationMs and renders "(live)" with no duration', () => {
    const input = fullFixtureInput({
      session: { id: 'hud-1', title: 'Weekly Sync', startedAt: new Date('2026-07-13T14:00:00'), endedAt: null },
    })
    const digest = buildDigest(input)

    expect(digest.stats.durationMs).toBeNull()
    const startedLocal = new Date('2026-07-13T14:00:00').toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    expect(digest.markdown).toContain(`**When:** ${startedLocal} → (live)`)
    expect(digest.markdown).not.toMatch(/\(\d+:\d{2}\)/)
  })

  it('EDGE: an ended session renders the started/ended local times and an h:mm duration', () => {
    const digest = buildDigest(fullFixtureInput())
    const startedLocal = new Date('2026-07-13T14:00:00').toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    const endedLocal = new Date('2026-07-13T15:32:00').toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    expect(digest.markdown).toContain(`**When:** ${startedLocal} → ${endedLocal} (1:32)`)
  })

  it('NEGATIVE (FP boundary): a null boardName omits the Board line entirely', () => {
    const digest = buildDigest(fullFixtureInput({ boardName: null }))
    expect(digest.markdown).not.toContain('**Board:**')
  })

  it('POSITIVE: a non-null boardName renders the Board line', () => {
    const digest = buildDigest(fullFixtureInput())
    expect(digest.markdown).toContain('**Board:** Product Board')
  })

  it('DEGRADATION: an answer of exactly 200 chars is not truncated (no ellipsis)', () => {
    const answer = 'a'.repeat(200)
    const digest = buildDigest(
      fullFixtureInput({
        dispatches: [{ target: 'board', question: 'q', status: 'done', answer }],
      })
    )
    expect(digest.dispatches[0].answerExcerpt).toBe(answer)
    expect(digest.dispatches[0].answerExcerpt).toHaveLength(200)
    expect(digest.dispatches[0].answerExcerpt).not.toContain('…')
  })

  it('DEGRADATION: an answer of 201 chars truncates to 200 chars plus an ellipsis', () => {
    const answer = 'a'.repeat(201)
    const digest = buildDigest(
      fullFixtureInput({
        dispatches: [{ target: 'board', question: 'q', status: 'done', answer }],
      })
    )
    expect(digest.dispatches[0].answerExcerpt).toBe(`${'a'.repeat(200)}…`)
  })

  it('DEGRADATION: a null answer excerpts to null', () => {
    const digest = buildDigest(
      fullFixtureInput({
        dispatches: [{ target: 'board', question: 'q', status: 'done', answer: null }],
      })
    )
    expect(digest.dispatches[0].answerExcerpt).toBeNull()
  })

  it('EDGE: no agenda entries omits the Agenda section, including its header', () => {
    const digest = buildDigest(
      fullFixtureInput({
        entries: fullFixtureInput().entries.filter((e) => e.kind !== 'agenda'),
      })
    )
    expect(digest.stats.agendaTotal).toBe(0)
    expect(digest.markdown).not.toContain('## Agenda')
  })

  it('EDGE: an assigneeId with no matching entry in memberNames renders assigneeName null and no @ fragment', () => {
    const digest = buildDigest(
      fullFixtureInput({
        entries: [
          entry({ kind: 'action', text: 'follow up', assigneeId: 'user-unknown', dueDate: null, cardId: null }),
        ],
        memberNames: new Map(),
      })
    )
    expect(digest.actions[0].assigneeName).toBeNull()
    expect(digest.markdown).toContain('- [ ] follow up')
    expect(digest.markdown).not.toContain('@')
  })

  it('DEGRADATION: a multi-line decision renders as a single markdown row with no injected header/rows', () => {
    const digest = buildDigest(
      fullFixtureInput({
        entries: [entry({ kind: 'decision', text: 'Line one\r\nLine two\n## Fake header\n- fake row' })],
      })
    )
    // The structured (non-markdown) shape keeps the raw text untouched.
    expect(digest.decisions[0].text).toBe('Line one\r\nLine two\n## Fake header\n- fake row')

    const rows = digest.markdown.split('\n')
    expect(rows).toContain('- Line one Line two ## Fake header - fake row')
    expect(digest.markdown).not.toMatch(/^## Fake header$/m)
  })

  it('POSITIVE: sections render in the spec-mandated order (Decisions, Action items, Agenda, Notes, Agent dispatches, Proposed changes)', () => {
    const input = fullFixtureInput({
      entries: [...fullFixtureInput().entries, entry({ kind: 'note', text: 'parking lot: revisit pricing' })],
    })
    const { markdown } = buildDigest(input)

    const headers = ['## Decisions', '## Action items', '## Agenda (1/2)', '## Notes', '## Agent dispatches (3)', '## Proposed changes']
    const positions = headers.map((h) => markdown.indexOf(h))

    expect(positions.every((p) => p !== -1)).toBe(true)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })
})
