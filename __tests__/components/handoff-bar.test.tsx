// @vitest-environment jsdom
/**
 * HandoffBar — spec §7.3 "HandoffBar" and §7.4. The email two-step runs
 * through the real Composer so the interaction with the editor (autosave
 * flush before compose, edits discarding the preview) is covered; the
 * single-step handoffs render HandoffBar directly. (WI-5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { Composer } from '../../src/components/planner/Composer'
import { HandoffBar } from '../../src/components/planner/HandoffBar'
import {
  draftDTO,
  emailItem,
  slackItem,
  rankedItem,
  installFetch,
  deferred,
  sleep,
  T0,
} from './_helpers/planner-fixtures'
import type { FetchCall, FetchReply } from './_helpers/planner-fixtures'
import type { PendingEmail, PlannerDraftDTO } from '../../src/lib/planner/types'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  )
}

const HANDOFF_RE = /\/api\/planner\/drafts\/d1\/handoff$/
const PATCH_RE = /\/api\/planner\/drafts\/d1$/
const PENDING: PendingEmail = {
  gmailDraftId: 'r1',
  to: 'jane@example.com',
  cc: 'bob@example.com',
  threadId: 't1',
  bodyHash: 'abc',
  at: T0,
}

function composeReply(body: string): FetchReply {
  return {
    json: {
      draft: draftDTO({ body, pendingEmail: PENDING }),
      handoff: null,
      result: { pendingEmail: PENDING },
    },
  }
}
function sendReply(): FetchReply {
  const handoff = { kind: 'email', ref: 'm1', at: T0 }
  return {
    json: {
      draft: draftDTO({ status: 'handed_off', handoff, pendingEmail: null }),
      handoff,
      result: { messageId: 'm1', to: PENDING.to, cc: PENDING.cc },
    },
  }
}

/** Composer router with a programmable handoff handler. */
function composerHandler(
  handoff: (c: FetchCall) => FetchReply | Promise<FetchReply>,
  drafts = [draftDTO()]
) {
  return (c: FetchCall): FetchReply | Promise<FetchReply> => {
    if (c.method === 'GET' && /\/api\/planner\/drafts\?itemId=/.test(c.url))
      return { json: { drafts } }
    if (c.method === 'PATCH' && PATCH_RE.test(c.url))
      return { json: { draft: draftDTO({ ...(c.body as object) }) } }
    if (c.method === 'POST' && HANDOFF_RE.test(c.url)) return handoff(c)
    return { json: {} }
  }
}

describe('HandoffBar — email two-step through the Composer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('every handoff button is disabled while the body is empty', async () => {
    installFetch(composerHandler(() => ({ json: {} }), [draftDTO({ body: '   ' })]))
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    for (const name of [
      'send as email',
      'create google doc',
      'comment on card',
      'create card',
      'post to slack',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('compose flushes the pending autosave first, then previews the real recipients; approve & send sends once', async () => {
    const user = userEvent.setup()
    const patch = deferred<FetchReply>()
    const f = installFetch((c) => {
      if (c.method === 'PATCH' && PATCH_RE.test(c.url)) return patch.promise
      return composerHandler((h) =>
        (h.body as { kind: string }).kind === 'email_compose'
          ? composeReply('Hello Jane,\n\nDone.!')
          : sendReply()
      )(c)
    })
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    await user.type(body, '!')
    await user.click(screen.getByRole('button', { name: 'send as email' }))

    await waitFor(() => expect(f.of('PATCH', PATCH_RE)).toHaveLength(1))
    expect(f.of('PATCH', PATCH_RE)[0].body).toEqual({ body: 'Hello Jane,\n\nDone.!' })
    await sleep(50)
    expect(f.of('POST', HANDOFF_RE)).toHaveLength(0)
    patch.resolve({ json: { draft: draftDTO({ body: 'Hello Jane,\n\nDone.!' }) } })

    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({ kind: 'email_compose', replyAll: false })

    const preview = await screen.findByTestId('email-preview')
    expect(preview).toHaveTextContent('to: jane@example.com')
    expect(preview).toHaveTextContent('cc: bob@example.com')
    expect(preview).toHaveTextContent('Hello Jane')
    const approve = screen.getByRole('button', { name: 'approve & send' })
    expect(approve).toBeEnabled()
    await user.click(approve)
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(2))
    expect(f.of('POST', HANDOFF_RE)[1].body).toEqual({ kind: 'email_send' })
    expect(await screen.findByText(/handed off · email · \d{2}:\d{2}/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'approve & send' })).toBeNull()
  })

  it('approve & send ignores a double click while the send is in flight', async () => {
    const user = userEvent.setup()
    const send = deferred<FetchReply>()
    const f = installFetch(
      composerHandler((h) =>
        (h.body as { kind: string }).kind === 'email_compose'
          ? composeReply('Hello Jane,\n\nDone.')
          : send.promise
      )
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    await screen.findByTestId('email-preview')
    const approve = screen.getByRole('button', { name: 'approve & send' })
    await user.click(approve)
    await user.click(approve)
    await sleep(50)
    expect(
      f.of('POST', HANDOFF_RE).filter((c) => (c.body as { kind: string }).kind === 'email_send')
    ).toHaveLength(1)
    send.resolve(sendReply())
    await screen.findByText(/handed off · email/)
  })

  it('editing the body after compose discards the preview and blocks send until re-compose', async () => {
    const user = userEvent.setup()
    const f = installFetch(composerHandler(() => composeReply('Hello Jane,\n\nDone.')))
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    await screen.findByTestId('email-preview')

    await user.type(body, ' PS')
    await waitFor(() => expect(screen.queryByTestId('email-preview')).toBeNull())
    expect(screen.queryByRole('button', { name: 'approve & send' })).toBeNull()
    expect(screen.getByText('body changed · re-compose to send')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'send as email' })).toBeEnabled()
    // exactly one compose so far and no send
    expect(f.of('POST', HANDOFF_RE).map((c) => (c.body as { kind: string }).kind)).toEqual([
      'email_compose',
    ])
  })

  it('discard drops the preview without sending; a 409 on send shows the re-compose message', async () => {
    const user = userEvent.setup()
    const f = installFetch(
      composerHandler((h) =>
        (h.body as { kind: string }).kind === 'email_compose'
          ? composeReply('Hello Jane,\n\nDone.')
          : {
              status: 409,
              json: { error: 'The draft changed since it was composed; re-compose to send' },
            }
      )
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    await screen.findByTestId('email-preview')
    await user.click(screen.getByRole('button', { name: 'discard' }))
    expect(screen.queryByTestId('email-preview')).toBeNull()
    expect(f.of('POST', HANDOFF_RE)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'send as email' }))
    await screen.findByTestId('email-preview')
    await user.click(screen.getByRole('button', { name: 'approve & send' }))
    expect(await screen.findByText('body changed · re-compose to send')).toBeInTheDocument()
    expect(screen.queryByTestId('email-preview')).toBeNull()
    expect(f.of('POST', HANDOFF_RE).map((c) => (c.body as { kind: string }).kind)).toEqual([
      'email_compose',
      'email_compose',
      'email_send',
    ])
  })

  it('a non-owner (403) and an unconfigured agent (503) disable email with the spec messages', async () => {
    const user = userEvent.setup()
    installFetch(
      composerHandler(() => ({
        status: 403,
        json: { error: 'Forbidden: this mailbox belongs to another user' },
      }))
    )
    const a = render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    expect(await screen.findByText('email is bound to another mailbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'send as email' })).toBeDisabled()
    a.unmount()
    vi.unstubAllGlobals()

    installFetch(
      composerHandler(() => ({
        status: 503,
        json: { error: 'Inbox agent is not configured (INBOX_AGENT_OWNER unset)' },
      }))
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    expect(await screen.findByText('inbox agent not configured')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'send as email' })).toBeDisabled()
  })

  it('a draft on a non-email item asks for to + subject before composing', async () => {
    const user = userEvent.setup()
    const f = installFetch(
      composerHandler(() => composeReply('Hello Jane,\n\nDone.'), [draftDTO({ itemId: 'it-1' })])
    )
    render(<Composer item={rankedItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    expect(f.of('POST', HANDOFF_RE)).toHaveLength(0)
    await user.type(screen.getByLabelText('To'), 'jane@example.com')
    await user.type(screen.getByLabelText('Subject'), 'Release notes')
    await user.click(screen.getByRole('button', { name: 'compose' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({
      kind: 'email_compose',
      to: 'jane@example.com',
      subject: 'Release notes',
    })
    await screen.findByTestId('email-preview')
  })

  it('switching to another draft discards a held preview', async () => {
    const user = userEvent.setup()
    installFetch(
      composerHandler(
        () => composeReply('Hello Jane,\n\nDone.'),
        [draftDTO(), draftDTO({ id: 'd2', title: 'Second', body: 'Second body' })]
      )
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.click(screen.getByRole('button', { name: 'send as email' }))
    await screen.findByTestId('email-preview')
    await user.selectOptions(screen.getByLabelText('Draft'), 'd2')
    expect(screen.queryByTestId('email-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'approve & send' })).toBeNull()
  })
})

describe('HandoffBar — single-step handoffs', () => {
  afterEach(() => vi.unstubAllGlobals())

  function renderBar(item = emailItem(), draft: PlannerDraftDTO = draftDTO(), body = draft.body) {
    const onDraftChange = vi.fn()
    const flush = vi.fn(async () => {})
    render(
      <HandoffBar
        item={item}
        draft={draft}
        body={body}
        orgId="org-1"
        flush={flush}
        onDraftChange={onDraftChange}
      />
    )
    return { onDraftChange, flush }
  }

  it('create google doc posts { kind: gdoc } and shows the open link; the draft is reported as handed off', async () => {
    const user = userEvent.setup()
    const handoff = {
      kind: 'gdoc',
      ref: 'doc-1',
      url: 'https://docs.google.com/document/d/doc-1/edit',
      at: T0,
    }
    const f = installFetch(() => ({
      json: {
        draft: draftDTO({ status: 'handed_off', handoff }),
        handoff,
        result: { id: 'doc-1', url: handoff.url },
      },
    }))
    const { onDraftChange, flush } = renderBar()
    await user.click(screen.getByRole('button', { name: 'create google doc' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({ kind: 'gdoc' })
    expect(flush).toHaveBeenCalled()
    const link = await screen.findByRole('link', { name: 'open doc →' })
    expect(link).toHaveAttribute('href', handoff.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel') ?? '').toMatch(/noreferrer/)
    expect(screen.getByText(/handed off · gdoc · \d{2}:\d{2}/)).toBeInTheDocument()
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'handed_off' }))
  })

  it('INSUFFICIENT_SCOPES shows the upgrade link; GOOGLE_NOT_CONNECTED points at integrations', async () => {
    const user = userEvent.setup()
    installFetch(() => ({
      status: 409,
      json: {
        error: 'INSUFFICIENT_SCOPES',
        missing: ['https://www.googleapis.com/auth/drive.file'],
        upgradeUrl: '/api/me/google/connect?upgrade=planner',
      },
    }))
    const a = renderBar()
    await user.click(screen.getByRole('button', { name: 'create google doc' }))
    expect(
      await screen.findByRole('link', { name: 'upgrade google connection →' })
    ).toHaveAttribute('href', '/api/me/google/connect?upgrade=planner')
    expect(a.onDraftChange).not.toHaveBeenCalled()
    vi.unstubAllGlobals()

    installFetch(() => ({ status: 409, json: { error: 'GOOGLE_NOT_CONNECTED' } }))
    await user.click(screen.getByRole('button', { name: 'create google doc' }))
    expect(await screen.findByRole('link', { name: /connect google/i })).toHaveAttribute(
      'href',
      '/settings/integrations'
    )
  })

  it("post to slack uses the slack item's channel and thread and shows the permalink", async () => {
    const user = userEvent.setup()
    const handoff = {
      kind: 'slack',
      ref: 'C1:1.3',
      url: 'https://acme.slack.com/archives/C1/p1300',
      at: T0,
    }
    const f = installFetch(() => ({
      json: {
        draft: draftDTO({ status: 'handed_off', handoff }),
        handoff,
        result: { channel: 'C1', ts: '1.3', url: handoff.url },
      },
    }))
    renderBar(
      slackItem({ payload: { channelId: 'C1', ts: '1.2', threadTs: '1.1', kind: 'mention' } }),
      draftDTO({ itemId: 'it-slack' })
    )
    await user.click(screen.getByRole('button', { name: 'post to slack' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({
      kind: 'slack',
      channel: 'C1',
      threadTs: '1.1',
    })
    expect(await screen.findByRole('link', { name: 'open in slack →' })).toHaveAttribute(
      'href',
      handoff.url
    )
  })

  it('post to slack from a non-slack item asks for a channel id; SLACK_NOT_CONNECTED links to integrations', async () => {
    const user = userEvent.setup()
    const f = installFetch(() => ({ status: 409, json: { error: 'SLACK_NOT_CONNECTED' } }))
    renderBar(rankedItem(), draftDTO({ itemId: 'it-1' }))
    await user.click(screen.getByRole('button', { name: 'post to slack' }))
    expect(f.of('POST', HANDOFF_RE)).toHaveLength(0)
    await user.type(screen.getByLabelText('Slack channel id'), 'C9')
    await user.click(screen.getByRole('button', { name: 'post' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({ kind: 'slack', channel: 'C9' })
    expect(await screen.findByRole('link', { name: /connect slack/i })).toHaveAttribute(
      'href',
      '/settings/integrations'
    )
  })

  it('comment on card posts { kind: card_comment, cardId } and links to the card', async () => {
    const user = userEvent.setup()
    const handoff = { kind: 'card_comment', ref: 'cm-1', url: '/board/inbox-board?card=e1', at: T0 }
    const f = installFetch(() => ({
      json: {
        draft: draftDTO({ status: 'handed_off', handoff }),
        handoff,
        result: { commentId: 'cm-1', cardId: 'e1', boardId: 'inbox-board' },
      },
    }))
    renderBar()
    await user.click(screen.getByRole('button', { name: 'comment on card' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({ kind: 'card_comment', cardId: 'e1' })
    expect(await screen.findByRole('link', { name: 'open card →' })).toHaveAttribute(
      'href',
      '/board/inbox-board?card=e1'
    )
  })

  it('comment on card is absent for items without a cardId', () => {
    renderBar(slackItem(), draftDTO({ itemId: 'it-slack' }))
    expect(screen.queryByRole('button', { name: 'comment on card' })).toBeNull()
  })

  it('create card lists the org boards, then posts { kind: card_create, boardId }', async () => {
    const user = userEvent.setup()
    const handoff = { kind: 'card_create', ref: 'c-new', url: '/board/b2?card=c-new', at: T0 }
    const f = installFetch((c) => {
      if (c.method === 'GET' && /\/api\/orgs\/org-1\/boards$/.test(c.url)) {
        return {
          json: {
            boards: [
              { id: 'b1', name: 'Demo Board' },
              { id: 'b2', name: 'Ops' },
            ],
          },
        }
      }
      return {
        json: {
          draft: draftDTO({ status: 'handed_off', handoff }),
          handoff,
          result: { cardId: 'c-new', boardId: 'b2', columnId: 'col' },
        },
      }
    })
    renderBar()
    await user.click(screen.getByRole('button', { name: 'create card' }))
    const select = await screen.findByLabelText('Board')
    await waitFor(() =>
      expect(within(select).getAllByRole('option').length).toBeGreaterThanOrEqual(2)
    )
    await user.selectOptions(select, 'b2')
    await user.click(screen.getByRole('button', { name: 'create' }))
    await waitFor(() => expect(f.of('POST', HANDOFF_RE)).toHaveLength(1))
    expect(f.of('POST', HANDOFF_RE)[0].body).toEqual({ kind: 'card_create', boardId: 'b2' })
    expect(await screen.findByRole('link', { name: 'open card →' })).toHaveAttribute(
      'href',
      '/board/b2?card=c-new'
    )
  })

  it('an unmapped failure renders the server message in an alert and keeps the buttons usable', async () => {
    const user = userEvent.setup()
    installFetch(() => ({
      status: 502,
      json: { error: 'Slack rejected the message', slackError: 'channel_not_found' },
    }))
    renderBar(slackItem(), draftDTO({ itemId: 'it-slack' }))
    await user.click(screen.getByRole('button', { name: 'post to slack' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack rejected the message')
    expect(screen.getByRole('button', { name: 'post to slack' })).toBeEnabled()
  })

  it('a handed-off draft shows its record and link without re-posting', () => {
    const handoff = {
      kind: 'gdoc',
      ref: 'doc-1',
      url: 'https://docs.google.com/document/d/doc-1/edit',
      at: T0,
    }
    renderBar(emailItem(), draftDTO({ status: 'handed_off', handoff }))
    expect(screen.getByText(/handed off · gdoc · \d{2}:\d{2}/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'open doc →' })).toHaveAttribute('href', handoff.url)
  })
})
