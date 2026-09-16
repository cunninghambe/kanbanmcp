// @vitest-environment jsdom
/**
 * Composer — spec §7.3 "Composer" and §7.4: drafts list, new draft, autosave
 * debounce → PATCH, preview toggle, and the ask-claude ordering rule (flush
 * the pending autosave first, send the typed body as currentBody, disable
 * the editor while generating, replace the body, undo). (WI-5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { Composer } from '../../src/components/planner/Composer'
import {
  draftDTO,
  emailItem,
  slackItem,
  rankedItem,
  installFetch,
  deferred,
  sleep,
} from './_helpers/planner-fixtures'
import type { FetchCall, FetchReply } from './_helpers/planner-fixtures'

vi.mock('../../src/components/planner/HandoffBar', () => ({
  HandoffBar: () => <div data-testid="handoff-bar" />,
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

const DRAFTS_RE = /\/api\/planner\/drafts\?itemId=it-email$/
const PATCH_RE = /\/api\/planner\/drafts\/d1$/
const GENERATE_RE = /\/api\/planner\/drafts\/d1\/generate$/

/** Default router: one draft, PATCH echoes, generate returns a fixed body. */
function defaultHandler(
  over: Partial<
    Record<'patch' | 'generate', (c: FetchCall) => FetchReply | Promise<FetchReply>>
  > = {}
) {
  return (c: FetchCall): FetchReply | Promise<FetchReply> => {
    if (c.method === 'GET' && DRAFTS_RE.test(c.url)) return { json: { drafts: [draftDTO()] } }
    if (c.method === 'PATCH' && PATCH_RE.test(c.url)) {
      if (over.patch) return over.patch(c)
      return { json: { draft: draftDTO({ ...(c.body as object) }) } }
    }
    if (c.method === 'POST' && GENERATE_RE.test(c.url)) {
      if (over.generate) return over.generate(c)
      const currentBody = (c.body as { currentBody?: string }).currentBody ?? draftDTO().body
      return {
        json: {
          draft: draftDTO({ body: 'Generated text' }),
          previousBody: currentBody,
          model: 'claude-sonnet-4-6',
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    }
    return { json: {} }
  }
}

describe('Composer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the drafts, shows the selected one, and defaults the mode by source', async () => {
    installFetch(defaultHandler())
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    expect(body).toHaveValue('Hello Jane,\n\nDone.')
    expect(screen.getByLabelText('Draft title')).toHaveValue('Re: Contract renewal — Jane')
    expect(body).toHaveAttribute('rows')
    expect(Number(body.getAttribute('rows'))).toBeGreaterThanOrEqual(12)
    const select = screen.getByLabelText('Draft') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['d1'])
    expect(screen.getByLabelText('Mode')).toHaveValue('reply_email')
    expect(screen.getByTestId('handoff-bar')).toBeInTheDocument()
  })

  it('mode defaults: slack → slack_message, everything else → document', async () => {
    installFetch((c) =>
      c.method === 'GET' ? { json: { drafts: [draftDTO({ itemId: 'x' })] } } : { json: {} }
    )
    const a = render(<Composer item={slackItem()} orgId="org-1" />, { wrapper })
    expect(await screen.findByLabelText('Mode')).toHaveValue('slack_message')
    a.unmount()
    render(<Composer item={rankedItem()} orgId="org-1" />, { wrapper })
    expect(await screen.findByLabelText('Mode')).toHaveValue('document')
  })

  it('with no drafts only "new draft" shows; it creates one titled after the item and selects it', async () => {
    const user = userEvent.setup()
    const state = { drafts: [] as ReturnType<typeof draftDTO>[] }
    const f = installFetch((c) => {
      if (c.method === 'GET' && DRAFTS_RE.test(c.url)) return { json: { drafts: state.drafts } }
      if (c.method === 'POST' && /\/api\/planner\/drafts$/.test(c.url)) {
        const created = draftDTO({
          id: 'd-new',
          title: (c.body as { title: string }).title,
          body: '',
        })
        state.drafts = [created]
        return { status: 201, json: { draft: created } }
      }
      return { json: {} }
    })
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const btn = await screen.findByRole('button', { name: 'new draft' })
    expect(screen.queryByLabelText('Draft body')).toBeNull()
    await user.click(btn)
    expect(f.of('POST', /\/api\/planner\/drafts$/)[0].body).toEqual({
      itemId: 'it-email',
      title: 'Re: Contract renewal — Jane',
    })
    expect(await screen.findByLabelText('Draft body')).toHaveValue('')
    expect(screen.getByLabelText('Draft title')).toHaveValue('Re: Contract renewal — Jane')
  })

  it('a non-email item titles the new draft after the item without "Re:"', async () => {
    const user = userEvent.setup()
    const f = installFetch((c) => {
      if (c.method === 'POST' && /\/api\/planner\/drafts$/.test(c.url)) {
        return {
          status: 201,
          json: {
            draft: draftDTO({
              id: 'd2',
              itemId: 'it-1',
              title: (c.body as { title: string }).title,
              body: '',
            }),
          },
        }
      }
      return { json: { drafts: [] } }
    })
    render(<Composer item={rankedItem()} orgId="org-1" />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'new draft' }))
    expect(f.of('POST', /\/api\/planner\/drafts$/)[0].body).toEqual({
      itemId: 'it-1',
      title: 'Ship the release notes',
    })
  })

  it('autosaves the body 800 ms after the last keystroke with one PATCH and shows the saved time', async () => {
    const user = userEvent.setup()
    const f = installFetch(defaultHandler())
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    await user.type(body, ' More.')
    expect(f.of('PATCH', PATCH_RE)).toHaveLength(0)
    await screen.findByText('saving…')
    await waitFor(() => expect(f.of('PATCH', PATCH_RE)).toHaveLength(1), { timeout: 3000 })
    expect(f.of('PATCH', PATCH_RE)[0].body).toEqual({ body: 'Hello Jane,\n\nDone. More.' })
    await waitFor(() =>
      expect(screen.getByTestId('save-status').textContent).toMatch(/^saved · \d{2}:\d{2}$/)
    )
    await sleep(900)
    expect(f.of('PATCH', PATCH_RE)).toHaveLength(1)
  })

  it('autosaves title edits and reports a failed save', async () => {
    const user = userEvent.setup()
    const f = installFetch(
      defaultHandler({ patch: () => ({ status: 500, json: { error: 'nope' } }) })
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const title = await screen.findByLabelText('Draft title')
    await user.type(title, '!')
    await waitFor(() => expect(f.of('PATCH', PATCH_RE)).toHaveLength(1), { timeout: 3000 })
    expect(f.of('PATCH', PATCH_RE)[0].body).toEqual(
      expect.objectContaining({ title: 'Re: Contract renewal — Jane!' })
    )
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('save failed'))
  })

  it('preview renders the body as markdown and hides the textarea until toggled back', async () => {
    const user = userEvent.setup()
    installFetch((c) =>
      c.method === 'GET'
        ? {
            json: {
              drafts: [
                draftDTO({
                  body: '# Hello\n\n[site](https://example.com) and [bad](javascript:alert(1))',
                }),
              ],
            },
          }
        : { json: {} }
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    const toggle = screen.getByRole('button', { name: 'preview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    const preview = screen.getByTestId('composer-preview')
    expect(within(preview).getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
    expect(within(preview).getByRole('link', { name: 'site' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
    const bad = within(preview).queryByRole('link', { name: 'bad' })
    if (bad) expect(bad.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    expect(screen.queryByLabelText('Draft body')).toBeNull()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)
    expect(screen.getByLabelText('Draft body')).toBeInTheDocument()
  })

  it('ask claude flushes the pending autosave first, then generates with the typed body, disables the editor meanwhile, replaces the body and offers undo', async () => {
    const user = userEvent.setup()
    const patch = deferred<FetchReply>()
    const generate = deferred<FetchReply>()
    const f = installFetch(
      defaultHandler({ patch: () => patch.promise, generate: () => generate.promise })
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    await user.type(body, 'X')
    await user.type(screen.getByLabelText('Instructions'), 'make it shorter')
    await user.click(screen.getByRole('button', { name: 'ask claude' }))

    // 1. the autosave PATCH goes out immediately (debounce cancelled) with the typed value
    await waitFor(() => expect(f.of('PATCH', PATCH_RE)).toHaveLength(1))
    expect(f.of('PATCH', PATCH_RE)[0].body).toEqual({ body: 'Hello Jane,\n\nDone.X' })
    // 2. generate waits for it
    await sleep(50)
    expect(f.of('POST', GENERATE_RE)).toHaveLength(0)
    patch.resolve({ json: { draft: draftDTO({ body: 'Hello Jane,\n\nDone.X' }) } })
    await waitFor(() => expect(f.of('POST', GENERATE_RE)).toHaveLength(1))
    expect(f.of('POST', GENERATE_RE)[0].body).toEqual({
      instructions: 'make it shorter',
      mode: 'reply_email',
      currentBody: 'Hello Jane,\n\nDone.X',
    })
    // 3. the editor is disabled while generating
    expect(screen.getByLabelText('Draft body')).toBeDisabled()
    expect(screen.getByLabelText('Draft title')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'generating…' })).toBeDisabled()

    generate.resolve({
      json: {
        draft: draftDTO({ body: 'Generated text' }),
        previousBody: 'Hello Jane,\n\nDone.X',
        model: 'claude-sonnet-4-6',
        inputTokens: 10,
        outputTokens: 5,
      },
    })
    // 4. the response body is authoritative and does not trigger an autosave
    await waitFor(() => expect(screen.getByLabelText('Draft body')).toHaveValue('Generated text'))
    expect(screen.getByLabelText('Draft body')).toBeEnabled()
    await sleep(1000)
    expect(f.of('PATCH', PATCH_RE)).toHaveLength(1)

    // 5. undo restores the previous body and persists it
    await user.click(screen.getByRole('button', { name: 'undo' }))
    expect(screen.getByLabelText('Draft body')).toHaveValue('Hello Jane,\n\nDone.X')
    await waitFor(() => expect(f.of('PATCH', PATCH_RE)).toHaveLength(2), { timeout: 3000 })
    expect(f.of('PATCH', PATCH_RE)[1].body).toEqual({ body: 'Hello Jane,\n\nDone.X' })
    expect(screen.queryByRole('button', { name: 'undo' })).toBeNull()
  })

  it('Cmd/Ctrl+Enter in the instructions submits ask claude', async () => {
    const user = userEvent.setup()
    const f = installFetch(defaultHandler())
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    const instructions = screen.getByLabelText('Instructions')
    await user.type(instructions, 'shorter')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(f.of('POST', GENERATE_RE)).toHaveLength(1))
    expect(f.of('POST', GENERATE_RE)[0].body).toEqual(
      expect.objectContaining({ instructions: 'shorter' })
    )
  })

  it('a failed generate re-enables the editor with the text unchanged and shows the error', async () => {
    const user = userEvent.setup()
    installFetch(
      defaultHandler({
        generate: () => ({ status: 502, json: { error: 'Draft generation failed' } }),
      })
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    const body = await screen.findByLabelText('Draft body')
    await user.type(body, 'Y')
    await user.type(screen.getByLabelText('Instructions'), 'fix')
    await user.click(screen.getByRole('button', { name: 'ask claude' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Draft generation failed')
    expect(screen.getByLabelText('Draft body')).toBeEnabled()
    expect(screen.getByLabelText('Draft body')).toHaveValue('Hello Jane,\n\nDone.Y')
    expect(screen.queryByRole('button', { name: 'undo' })).toBeNull()
  })

  it('switching drafts loads the other draft into the editor', async () => {
    const user = userEvent.setup()
    installFetch((c) =>
      c.method === 'GET'
        ? {
            json: {
              drafts: [draftDTO(), draftDTO({ id: 'd2', title: 'Second', body: 'Second body' })],
            },
          }
        : { json: {} }
    )
    render(<Composer item={emailItem()} orgId="org-1" />, { wrapper })
    await screen.findByLabelText('Draft body')
    await user.selectOptions(screen.getByLabelText('Draft'), 'd2')
    expect(screen.getByLabelText('Draft body')).toHaveValue('Second body')
    expect(screen.getByLabelText('Draft title')).toHaveValue('Second')
  })
})
