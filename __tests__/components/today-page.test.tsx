// @vitest-environment jsdom
/**
 * /today page — spec §7.3 and §7.4. Renders the real page with the real
 * usePlanner hook against a routed fetch stub: topbar in all states, stats,
 * sections from a fixture, optimistic done, a 200 with a failed write-through,
 * reviewer/reopen labels, source chips, empty state, truncated notice,
 * plan my day, refresh, quick add, selection and keyboard actions. (WI-5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import {
  rankedItem,
  emailItem,
  slackItem,
  todayResponse,
  installFetch,
  deferred,
  sleep,
  T0,
} from './_helpers/planner-fixtures'
import type { FetchCall, FetchReply } from './_helpers/planner-fixtures'
import type { RankedItemDTO, TodayResponse } from '../../src/lib/planner/types'

const nav = vi.hoisted(() => ({ search: 'date=2026-09-16', push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/today',
}))
vi.mock('../../src/hooks/useSession', () => ({
  useSession: () => ({
    user: { id: 'user-1', email: 'beth@example.com', name: 'Beth' },
    org: { id: 'org-1', name: 'Acme' },
    orgMemberships: [],
    isLoading: false,
    isError: false,
    mutate: vi.fn(),
  }),
}))
vi.mock('../../src/app/(app)/today/today.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  )
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const TODAY_RE = /\/api\/planner\/today\?date=2026-09-16&tz=/

function fixtureItems(): RankedItemDTO[] {
  return [
    rankedItem({
      id: 'n1',
      sourceKey: 'card:n1',
      title: 'Ship the release notes',
      reasons: ['assigned to you', 'overdue 2d'],
      dueAt: '2026-09-14T00:00:00.000Z',
      score: 60,
    }),
    emailItem({ id: 'n2', section: 'now', score: 45 }),
    slackItem({ id: 'n3', section: 'now', score: 30 }),
    rankedItem({
      id: 't1',
      sourceKey: 'card:t1',
      title: 'Review the PR',
      section: 'today',
      score: 20,
      reasons: ['review requested'],
      payload: { cardId: 't1', boardId: 'b1', role: 'reviewer' },
    }),
    rankedItem({
      id: 'cal1',
      source: 'calendar',
      sourceKey: 'calendar:ev1',
      title: 'Design sync',
      url: 'https://calendar.google.com/event?eid=ev1',
      section: 'today',
      score: 30,
      reasons: ['meeting in 2h'],
      startsAt: '2026-09-16T10:00:00.000Z',
      endsAt: '2026-09-16T11:00:00.000Z',
      payload: { allDay: false, attendees: 'Jane, Bob' },
    }),
    rankedItem({
      id: 's1',
      source: 'manual',
      sourceKey: 'manual:s1',
      title: 'Book flights',
      section: 'soon',
      score: 8,
      reasons: [],
      url: null,
      payload: {},
    }),
    rankedItem({
      id: 'l1',
      sourceKey: 'card:l1',
      title: 'Tidy the backlog',
      section: 'later',
      score: 2,
      reasons: [],
    }),
    rankedItem({
      id: 'z1',
      sourceKey: 'card:z1',
      title: 'Snoozed thing',
      section: 'snoozed',
      status: 'snoozed',
      snoozedUntil: '2026-09-17T09:00:00.000Z',
      score: 0,
      reasons: [],
    }),
    rankedItem({
      id: 'd1',
      sourceKey: 'card:d1',
      title: 'Already done',
      section: 'done',
      status: 'done',
      resolvedBy: 'user',
      resolvedAt: T0,
      score: 0,
      reasons: [],
    }),
    rankedItem({
      id: 'w1',
      sourceKey: 'card:w1',
      title: 'Not doing this',
      section: 'wont_do',
      status: 'wont_do',
      resolvedBy: 'user',
      resolvedAt: T0,
      score: 0,
      reasons: [],
    }),
    rankedItem({
      id: 'x1',
      sourceKey: 'card:x1',
      title: 'Dismissed noise',
      section: 'dismissed',
      status: 'dismissed',
      resolvedBy: 'user',
      resolvedAt: T0,
      score: 0,
      reasons: [],
    }),
  ]
}

function fixture(over: Partial<TodayResponse> = {}): TodayResponse {
  return todayResponse(fixtureItems(), {
    counts: {
      now: 3,
      open: 8,
      overdue: 2,
      meetingsToday: 4,
      inbox: 5,
      slack: 1,
      doneToday: 6,
      dismissed: 1,
    },
    ...over,
  })
}

/** Stateful router: GET today returns state.today; other routes are programmable. */
function makeRouter(
  state: { today: TodayResponse },
  extra?: (c: FetchCall) => FetchReply | Promise<FetchReply> | undefined
) {
  return (c: FetchCall): FetchReply | Promise<FetchReply> => {
    const r = extra?.(c)
    if (r) return r
    if (c.method === 'GET' && TODAY_RE.test(c.url)) return { json: state.today }
    if (c.method === 'GET' && /\/api\/planner\/drafts\?itemId=/.test(c.url))
      return { json: { drafts: [] } }
    return { json: {} }
  }
}

async function renderPage() {
  const Page = (await import('../../src/app/(app)/today/page')).default
  return render(<Page />, { wrapper })
}

const region = (name: string) => screen.getByRole('region', { name })

describe('/today page', () => {
  beforeEach(() => {
    nav.search = 'date=2026-09-16'
    vi.clearAllMocks()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders the topbar while loading, on error, and when ready', async () => {
    const pending = deferred<FetchReply>()
    installFetch(() => pending.promise)
    const loading = await renderPage()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('wed 16 sep')
    expect(screen.getByText('today', { selector: '.km-mono' })).toBeInTheDocument()
    expect(screen.getByText('loading…')).toBeInTheDocument()
    loading.unmount()
    vi.unstubAllGlobals()

    installFetch(() => ({ status: 500, json: { error: 'Internal server error' } }))
    const errored = await renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load today/)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('wed 16 sep')
    errored.unmount()
    vi.unstubAllGlobals()

    const f = installFetch(makeRouter({ today: fixture() }))
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    expect(f.calls[0].url).toBe(`/api/planner/today?date=2026-09-16&tz=${encodeURIComponent(TZ)}`)
    expect(screen.getByRole('button', { name: 'plan my day' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('shows the stats row with zero-padded counts', async () => {
    installFetch(makeRouter({ today: fixture() }))
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    for (const [label, value] of [
      ['now', '03'],
      ['overdue', '02'],
      ['meetings today', '04'],
      ['inbox', '05'],
      ['slack', '01'],
      ['done today', '06'],
    ]) {
      const eyebrow = screen.getByText(label, { selector: '.km-eyebrow' })
      expect(eyebrow.parentElement).toHaveTextContent(value)
    }
  })

  it('places every item in its section, in order, and labels rows by their state', async () => {
    installFetch(makeRouter({ today: fixture() }))
    await renderPage()
    await screen.findByRole('region', { name: 'now' })

    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(
      names.filter((n) =>
        [
          'meetings today',
          'now',
          'today',
          'soon',
          'later',
          'snoozed',
          'done today',
          "won't do",
        ].includes(n ?? '')
      )
    ).toEqual([
      'meetings today',
      'now',
      'today',
      'soon',
      'later',
      'snoozed',
      'done today',
      "won't do",
    ])

    const now = region('now')
    expect(
      within(now)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label'))
    ).toEqual([
      'Ship the release notes',
      'Contract renewal — Jane',
      'Jane in #ops: can you look at the deploy?',
    ])
    expect(
      within(region('today')).getByRole('listitem', { name: 'Review the PR' })
    ).toBeInTheDocument()
    expect(
      within(region('today')).getByRole('listitem', { name: 'Design sync' })
    ).toBeInTheDocument()
    expect(within(region('meetings today')).getByText('Design sync')).toBeInTheDocument()
    expect(
      within(region('soon')).getByRole('listitem', { name: 'Book flights' })
    ).toBeInTheDocument()
    expect(
      within(region('later')).getByRole('listitem', { name: 'Tidy the backlog' })
    ).toBeInTheDocument()
    expect(
      within(region('snoozed')).getByRole('listitem', { name: 'Snoozed thing' })
    ).toBeInTheDocument()
    expect(
      within(region('done today')).getByRole('listitem', { name: 'Already done' })
    ).toBeInTheDocument()
    expect(
      within(region("won't do")).getByRole('listitem', { name: 'Not doing this' })
    ).toBeInTheDocument()

    // reviewer row + resolved rows
    const review = within(region('today')).getByRole('listitem', { name: 'Review the PR' })
    expect(within(review).getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument()
    const done = within(region('done today')).getByRole('listitem', { name: 'Already done' })
    expect(within(done).getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(within(done).queryByRole('button', { name: 'Mark done' })).toBeNull()

    // dismissed stays behind a toggle
    expect(screen.queryByRole('listitem', { name: 'Dismissed noise' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'show dismissed' }))
    expect(
      within(region('dismissed')).getByRole('listitem', { name: 'Dismissed noise' })
    ).toBeInTheDocument()
  })

  it('done is optimistic: the row moves to done today before the PATCH resolves, then stays', async () => {
    const user = userEvent.setup()
    const state = { today: fixture() }
    const patch = deferred<FetchReply>()
    const f = installFetch(
      makeRouter(state, (c) => (c.method === 'PATCH' ? patch.promise : undefined))
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })

    const row = within(region('now')).getByRole('listitem', { name: 'Ship the release notes' })
    await user.click(within(row).getByRole('button', { name: 'Mark done' }))
    await waitFor(() =>
      expect(
        within(region('done today')).getByRole('listitem', { name: 'Ship the release notes' })
      ).toBeInTheDocument()
    )
    expect(
      within(region('now')).queryByRole('listitem', { name: 'Ship the release notes' })
    ).toBeNull()
    expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)[0].body).toEqual({ action: 'done' })

    const doneRow = {
      ...fixtureItems()[0],
      status: 'done' as const,
      section: 'done' as const,
      resolvedBy: 'user' as const,
      resolvedAt: T0,
    }
    state.today = todayResponse([doneRow, ...fixtureItems().slice(1)], {
      counts: state.today.counts,
    })
    patch.resolve({
      json: {
        item: doneRow,
        writeThrough: [
          {
            kind: 'card_moved',
            ok: true,
            cardId: 'n1',
            toColumnId: 'col-done',
            toColumnName: 'Done',
          },
        ],
      },
    })
    await sleep(50)
    await waitFor(() => expect(f.of('GET', TODAY_RE).length).toBeGreaterThanOrEqual(2))
    expect(
      within(region('done today')).getByRole('listitem', { name: 'Ship the release notes' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/couldn't/)).toBeNull()
  })

  it('a non-ok PATCH reverts the move and shows the error on the row', async () => {
    const user = userEvent.setup()
    installFetch(
      makeRouter({ today: fixture() }, (c) =>
        c.method === 'PATCH' ? { status: 404, json: { error: 'Item not found' } } : undefined
      )
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const row = within(region('now')).getByRole('listitem', { name: 'Ship the release notes' })
    await user.click(within(row).getByRole('button', { name: 'Mark done' }))
    await waitFor(() =>
      expect(
        within(region('now')).getByRole('listitem', { name: 'Ship the release notes' })
      ).toBeInTheDocument()
    )
    const back = within(region('now')).getByRole('listitem', { name: 'Ship the release notes' })
    expect(within(back).getByText('Item not found').className).toMatch(/km-chip--err/)
  })

  it('a 200 with a failed write-through keeps the status change, shows an err chip, and retry re-issues the PATCH', async () => {
    const user = userEvent.setup()
    const state = { today: fixture() }
    const doneRow = {
      ...fixtureItems()[0],
      status: 'done' as const,
      section: 'done' as const,
      resolvedBy: 'user' as const,
      resolvedAt: T0,
    }
    const f = installFetch(
      makeRouter(state, (c) => {
        if (c.method !== 'PATCH') return undefined
        state.today = todayResponse([doneRow, ...fixtureItems().slice(1)], {
          counts: state.today.counts,
        })
        return {
          json: {
            item: doneRow,
            writeThrough: [{ kind: 'card_moved', ok: false, error: "couldn't move the card" }],
          },
        }
      })
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const row = within(region('now')).getByRole('listitem', { name: 'Ship the release notes' })
    await user.click(within(row).getByRole('button', { name: 'Mark done' }))

    const moved = await within(region('done today')).findByRole('listitem', {
      name: 'Ship the release notes',
    })
    const chip = await within(moved).findByText("couldn't move the card")
    expect(chip.className).toMatch(/km-chip--err/)
    await sleep(50)
    // survives the refetch
    expect(
      within(region('done today')).getByRole('listitem', { name: 'Ship the release notes' })
    ).toContainElement(screen.getByText("couldn't move the card"))
    await user.click(within(moved).getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)).toHaveLength(2))
    expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)[1].body).toEqual({ action: 'done' })

    await user.click(within(moved).getByRole('button', { name: 'Dismiss error' }))
    expect(screen.queryByText("couldn't move the card")).toBeNull()
  })

  it('renders source chips with links for needs_scope and skipped, and a title for errors', async () => {
    installFetch(
      makeRouter({
        today: fixture({
          sources: { card: 'ok', email: 'error', calendar: 'needs_scope', slack: 'skipped' },
          sourceErrors: { email: 'Inbox agent timed out' },
        }),
      })
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    expect(screen.getByText('card · ok').className).toMatch(/km-chip--ok/)
    const err = screen.getByText('email · error')
    expect(err.className).toMatch(/km-chip--err/)
    expect(err.closest('[title]')).toHaveAttribute('title', 'Inbox agent timed out')
    expect(screen.getByRole('link', { name: 'calendar · needs google upgrade' })).toHaveAttribute(
      'href',
      '/api/me/google/connect?upgrade=planner'
    )
    expect(screen.getByRole('link', { name: 'slack · not connected' })).toHaveAttribute(
      'href',
      '/settings/integrations'
    )
  })

  it('shows the empty state when nothing is open, and the truncated notice when the read was capped', async () => {
    installFetch(makeRouter({ today: fixture({ items: [], truncated: true }) }))
    await renderPage()
    expect(await screen.findByText(/nothing needs attention/)).toBeInTheDocument()
    expect(screen.getByText('showing the newest 500 open items')).toBeInTheDocument()
  })

  it('selecting a row fills the workspace; ?item= preselects; nothing selected shows the day brief', async () => {
    const user = userEvent.setup()
    installFetch(
      makeRouter({
        today: fixture({
          brief: { text: '# Today\n\nReply to Jane first.', model: 'claude-sonnet-4-6', at: T0 },
        }),
      })
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const workspace = screen.getByRole('region', { name: 'workspace' })
    expect(within(workspace).getByRole('heading', { name: 'Today' })).toBeInTheDocument()

    const row = within(region('now')).getByRole('listitem', { name: 'Contract renewal — Jane' })
    await user.click(within(row).getByText('Contract renewal — Jane'))
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(
      within(workspace).getByRole('heading', { name: 'Contract renewal — Jane' })
    ).toBeInTheDocument()
    const gmail = within(workspace).getByRole('link', { name: 'open in gmail' })
    expect(gmail).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#inbox/t1')
    expect(gmail).toHaveAttribute('target', '_blank')
    expect(gmail.getAttribute('rel') ?? '').toMatch(/noreferrer/)
    expect(within(workspace).getByRole('link', { name: 'open card' })).toHaveAttribute(
      'href',
      '/board/inbox-board?card=e1'
    )
    expect(await within(workspace).findByRole('button', { name: 'new draft' })).toBeInTheDocument()
  })

  it('?item= preselects the row and shows its prep notes', async () => {
    nav.search = 'date=2026-09-16&item=n1'
    const items = fixtureItems()
    items[0] = { ...items[0], prepNotes: 'Check the numbers before you send.' }
    installFetch(makeRouter({ today: todayResponse(items, { counts: fixture().counts }) }))
    await renderPage()
    const row = await screen.findByRole('listitem', { name: 'Ship the release notes' })
    expect(row).toHaveAttribute('aria-selected', 'true')
    const workspace = screen.getByRole('region', { name: 'workspace' })
    expect(within(workspace).getByText('Check the numbers before you send.')).toBeInTheDocument()
    expect(within(workspace).getByRole('link', { name: 'open card' })).toHaveAttribute(
      'href',
      '/board/b1?card=c1'
    )
  })

  it('plan my day posts { date, tz }, is disabled meanwhile, then shows the brief; a failure is announced', async () => {
    const user = userEvent.setup()
    const state = { today: fixture() }
    const plan = deferred<FetchReply>()
    const f = installFetch(
      makeRouter(state, (c) =>
        c.method === 'POST' && /\/api\/planner\/plan$/.test(c.url) ? plan.promise : undefined
      )
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    await user.click(screen.getByRole('button', { name: 'plan my day' }))
    expect(screen.getByRole('button', { name: 'plan my day' })).toBeDisabled()
    expect(f.of('POST', /\/api\/planner\/plan$/)[0].body).toEqual({ date: '2026-09-16', tz: TZ })
    state.today = fixture({
      brief: { text: '# Today\n\nReply to Jane first.', model: 'claude-sonnet-4-6', at: T0 },
    })
    plan.resolve({
      json: {
        brief: '# Today\n\nReply to Jane first.',
        model: 'claude-sonnet-4-6',
        updatedItems: 2,
        inputTokens: 900,
        outputTokens: 200,
      },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'plan my day' })).toBeEnabled())
    const workspace = screen.getByRole('region', { name: 'workspace' })
    expect(await within(workspace).findByText('Reply to Jane first.')).toBeInTheDocument()

    vi.unstubAllGlobals()
    installFetch(
      makeRouter(state, (c) =>
        c.method === 'POST'
          ? { status: 429, json: { error: 'Plan my day is limited to 3 runs per 10 minutes' } }
          : undefined
      )
    )
    await user.click(screen.getByRole('button', { name: 'plan my day' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Plan my day is limited to 3 runs per 10 minutes'
    )
  })

  it('refresh requests a forced collection', async () => {
    const user = userEvent.setup()
    const f = installFetch(makeRouter({ today: fixture() }))
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(f.of('GET', /refresh=1/)).toHaveLength(1))
  })

  it('quick add posts the title on Enter, clears the input and shows the new row', async () => {
    const user = userEvent.setup()
    const state = { today: fixture() }
    const f = installFetch(
      makeRouter(state, (c) => {
        if (c.method === 'POST' && /\/api\/planner\/items$/.test(c.url)) {
          const title = (c.body as { title: string }).title
          const item = rankedItem({
            id: 'm-new',
            source: 'manual',
            sourceKey: 'manual:x',
            title,
            section: 'today',
            url: null,
            payload: {},
            reasons: [],
          })
          state.today = todayResponse([...fixtureItems(), item], { counts: state.today.counts })
          return { status: 201, json: { item } }
        }
        return undefined
      })
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const input = screen.getByLabelText('Quick add')
    expect(input).toHaveAttribute('placeholder', 'quick add a to-do…')
    await user.type(input, 'Call the landlord{Enter}')
    expect(f.of('POST', /\/api\/planner\/items$/)[0].body).toEqual({ title: 'Call the landlord' })
    expect(await screen.findByRole('listitem', { name: 'Call the landlord' })).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('keyboard: ArrowDown selects the next row and d marks it done', async () => {
    const user = userEvent.setup()
    const f = installFetch(
      makeRouter({ today: fixture() }, (c) =>
        c.method === 'PATCH' ? { json: { item: fixtureItems()[0], writeThrough: [] } } : undefined
      )
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const list = screen.getByRole('group', { name: 'planner items' })
    list.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listitem', { name: 'Ship the release notes' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listitem', { name: 'Contract renewal — Jane' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('listitem', { name: 'Ship the release notes' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await user.keyboard('d')
    await waitFor(() => expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)).toHaveLength(1))
    expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)[0].body).toEqual({ action: 'done' })
  })

  it("keyboard: s opens the selected row's snooze menu and a pick sends the snooze", async () => {
    const user = userEvent.setup()
    const f = installFetch(
      makeRouter({ today: fixture() }, (c) =>
        c.method === 'PATCH' ? { json: { item: fixtureItems()[0], writeThrough: [] } } : undefined
      )
    )
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    const list = screen.getByRole('group', { name: 'planner items' })
    list.focus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('s')
    const menu = await screen.findByRole('menu', { name: 'Snooze until' })
    await user.click(within(menu).getByRole('menuitem', { name: 'tomorrow 9:00' }))
    await waitFor(() => expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)).toHaveLength(1))
    expect(f.of('PATCH', /\/api\/planner\/items\/n1$/)[0].body).toEqual({
      action: 'snooze',
      snoozedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keyboard shortcuts do not fire while typing in the quick-add input', async () => {
    const user = userEvent.setup()
    const f = installFetch(makeRouter({ today: fixture() }))
    await renderPage()
    await screen.findByRole('region', { name: 'now' })
    await user.click(screen.getByLabelText('Quick add'))
    await user.keyboard('dx')
    await sleep(50)
    expect(f.of('PATCH', /\/api\/planner\/items\//)).toHaveLength(0)
  })
})
