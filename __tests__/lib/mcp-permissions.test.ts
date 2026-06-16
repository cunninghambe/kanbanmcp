import { describe, it, expect } from 'vitest'
import { isToolAllowed } from '../../src/lib/mcp-server'

describe('isToolAllowed (ApiKey permission scoping)', () => {
  it('treats an empty permission set as legacy full access (back-compat)', () => {
    expect(isToolAllowed('create_card', [])).toBe(true)
    expect(isToolAllowed('move_card', [])).toBe(true)
    expect(isToolAllowed('propose_changeset', [])).toBe(true)
    expect(isToolAllowed('get_board', [])).toBe(true)
  })

  it('a read+propose key can read and propose but NOT mutate', () => {
    const perms = ['read', 'propose']
    expect(isToolAllowed('get_board', perms)).toBe(true)
    expect(isToolAllowed('list_pending_changesets', perms)).toBe(true)
    expect(isToolAllowed('propose_changeset', perms)).toBe(true)
    expect(isToolAllowed('create_card', perms)).toBe(false)
    expect(isToolAllowed('move_card', perms)).toBe(false)
    expect(isToolAllowed('update_card', perms)).toBe(false)
    expect(isToolAllowed('add_comment', perms)).toBe(false)
    expect(isToolAllowed('toggle_ai_review', perms)).toBe(false)
  })

  it('a read-only key cannot even propose', () => {
    expect(isToolAllowed('propose_changeset', ['read'])).toBe(false)
    expect(isToolAllowed('get_board', ['read'])).toBe(true)
  })

  it("the 'write' scope unlocks mutation and proposal", () => {
    expect(isToolAllowed('create_card', ['write'])).toBe(true)
    expect(isToolAllowed('propose_changeset', ['write'])).toBe(true)
  })

  it("a wildcard or 'admin' scope allows everything", () => {
    expect(isToolAllowed('move_card', ['*'])).toBe(true)
    expect(isToolAllowed('move_card', ['admin'])).toBe(true)
  })
})
