# Task 07 — MCP tool registration for M1 features

**Agent type:** coder
**Depends on:** 01-schema, 02-card-api, 03-tree-endpoints, 04-artifacts, 05-ai-review-worker, 06-signoffs
**Spec sections:** §4.7, §7 AC-13, AC-14

---

## Goal

Add six new tools to the existing MCP JSON-RPC dispatcher at `src/lib/mcp-server.ts`: `create_subcard`, `set_card_reviewers`, `toggle_ai_review`, `list_card_tree`, `record_signoff`, `list_artifacts`. Each tool reuses the API-layer logic added in earlier tasks where possible — do not duplicate business rules.

## Inputs — files to read first

- `/root/kanbanmcp/src/lib/mcp-server.ts` — full file. Follow its style verbatim (tool manifest entries, dispatch table, JSON-RPC error codes, webhook/activity logging on writes).
- `/root/kanbanmcp/src/app/api/mcp/route.ts` — entry point. Already dispatches via `handleMcpRequest`. No changes needed.
- `/root/kanbanmcp/src/lib/cards.ts` — `aiReviewParamsSchema`, `computeChildPathAndDepth`, `MAX_NESTING_DEPTH`, `roleMembershipCheck`, `decodeAiReviewParams`
- `/root/kanbanmcp/src/lib/tree.ts` — `fetchSubtree`, `wouldFormCycle`
- `/root/kanbanmcp/src/lib/ai-review/queue.ts` (post Task 05) — `enqueueAiReview`
- M1 spec §4.7, §7 AC-13/AC-14, the §4 endpoint contracts each tool mirrors

## Files to modify

- `/root/kanbanmcp/src/lib/mcp-server.ts` — add manifest entries and handlers
- `/root/kanbanmcp/__tests__/mcp-priority.test.ts` (existing) — leave; add new test file for the new tools

## Files to create

- `/root/kanbanmcp/__tests__/mcp/tools.test.ts` — tests for all new tools (AC-13, AC-14)

## Interface contract

### Tool manifest entries (additions to `MCP_TOOLS`)

```ts
{
  name: 'create_subcard',
  description: 'Create a child card under an existing parent card.',
  inputSchema: {
    type: 'object',
    properties: {
      parentCardId: { type: 'string', description: 'ID of the parent card. The new card inherits the parent\'s board and column unless columnId is provided.' },
      title: { type: 'string' },
      description: { type: 'string' },
      assigneeId: { type: 'string', description: 'Required org member id.' },
      reviewerId: { type: 'string', description: 'Optional org member id.' },
      approverId: { type: 'string', description: 'Optional org member id.' },
      columnId: { type: 'string', description: 'Optional override; defaults to the parent card\'s column.' },
      priority: { type: 'string', enum: ['none','low','medium','high','critical'] },
      dueDate: { type: 'string', description: 'Optional ISO 8601 datetime.' },
    },
    required: ['parentCardId', 'title', 'assigneeId'],
  },
},
{
  name: 'set_card_reviewers',
  description: 'Update the reviewerId and/or approverId on a card. Pass null to clear; omit to leave unchanged.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string' },
      reviewerId: { type: ['string', 'null'] },
      approverId: { type: ['string', 'null'] },
    },
    required: ['cardId'],
  },
},
{
  name: 'toggle_ai_review',
  description: 'Toggle aiAutoReview on a card and optionally set aiReviewParams.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string' },
      enabled: { type: 'boolean' },
      params: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          rubric: { type: 'string' },
          customInstructions: { type: 'string' },
        },
        required: ['model', 'rubric'],
      },
    },
    required: ['cardId', 'enabled'],
  },
},
{
  name: 'list_card_tree',
  description: 'List the subtree rooted at a card up to `depth` levels (max 5).',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string' },
      depth: { type: 'number', description: 'Default 1, max 5.' },
    },
    required: ['cardId'],
  },
},
{
  name: 'record_signoff',
  description: 'Record a signoff decision as the calling user. Requires the caller to be the assigned reviewer or approver — API-key auth cannot use this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string' },
      role: { type: 'string', enum: ['REVIEWER', 'APPROVER'] },
      decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'REQUESTED_CHANGES'] },
      comment: { type: 'string' },
    },
    required: ['cardId', 'role', 'decision'],
  },
},
{
  name: 'list_artifacts',
  description: 'List artifacts for a card with their AI reviews.',
  inputSchema: {
    type: 'object',
    properties: {
      cardId: { type: 'string' },
    },
    required: ['cardId'],
  },
},
```

### Handler signatures

All handlers follow the existing pattern:
```ts
async function toolCreateSubcard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown>
```

### `toolCreateSubcard`

- Validate `parentCardId`, `title`, `assigneeId` are non-empty strings; else throw `{ code: -32602, message: '<field> is required' }`
- Verify parent card exists in `agentCtx.orgId`
- Resolve `columnId` (use `params.columnId` if provided; else parent's `columnId`)
- Validate `assigneeId`, `reviewerId`, `approverId` are org members via shared helper (`roleMembershipCheck` from `src/lib/cards.ts`)
- Depth check: `parent.depth + 1 > MAX_NESTING_DEPTH` → throw `{ code: -32602, message: 'Maximum nesting depth (50) reached' }`
- Position: max sibling position in target column + 1 (existing pattern)
- `createdById`: existing API-key-fallback pattern (first org admin)
- Create the card with `parentCardId`, `path`, `depth` computed via `computeChildPathAndDepth(parent)`
- Log activity + dispatch webhook (existing pattern)

### `toolSetCardReviewers`

- Verify card in org
- Validate `reviewerId` / `approverId` if provided (null is allowed → clears; string → must be org member)
- Update only the supplied fields

### `toolToggleAiReview`

- Verify card in org
- If `params.params` provided: validate with `aiReviewParamsSchema`; serialise to JSON string
- Update `aiAutoReview` and (if provided) `aiReviewParams`
- Return the updated card with `aiReviewParams` parsed back via `decodeAiReviewParams`

### `toolListCardTree`

- Verify card in org
- Clamp `depth` to [0, 5]; default 1
- Return `{ root, descendants }` matching the shape of `GET /api/cards/[cardId]/children` (AC-14)

### `toolRecordSignoff`

- **Throws `{ code: -32602, message: 'API key cannot record signoffs (human reviewer/approver only)' }` when `agentCtx` is from an API key.** (Per Task 06: signoffs require a real user id; API keys lack one.)
- Otherwise wire to the same logic as Task 06's POST endpoint, mapped to JSON-RPC errors:
  - Card not found → `-32602`
  - Card not in org → `-32602`
  - role=REVIEWER and card.reviewerId === null → `-32602` "No reviewer assigned"
  - role=REVIEWER and card.reviewerId !== caller's userId → `-32603` (use `-32603` for forbidden? No — use `-32602` per existing tool conventions; the existing dispatcher uses `-32602` for invalid params / forbidden access uniformly. Pick `-32602` for both for consistency.)
- **Note:** the existing dispatcher does not expose `session.userId` for human callers — `AgentContext` only has `orgId` and `agentName`. Today MCP is API-key-only. **Outcome:** `record_signoff` ALWAYS throws "API key cannot record signoffs". The tool exists as a documented surface so future cookie-MCP can use it, but in M1 it is a stub that always errors with a clear message. **This is acceptable per spec** (§4.7 lists the tool; signoff semantics in §4.6 require a human user). Document in the tool description.

### `toolListArtifacts`

- Verify card in org
- `findMany` artifacts with `include: { uploader, reviews }`, ordered `createdAt DESC`

## Implementation notes

1. **No code duplication** between MCP handlers and HTTP routes for business logic. The MCP handlers should call the same helpers (`computeChildPathAndDepth`, `roleMembershipCheck`, `fetchSubtree`, `aiReviewParamsSchema`, `decodeAiReviewParams`). For now, the validation and update happen inline in each tool — but the helpers must be shared. If a refactor is needed to extract a route's inner logic into a callable function, **do not do it in this task**; just duplicate the 5–10 lines. The shared helpers handle the high-leverage parts.
2. **Activity + webhook dispatch.** Every write tool calls `logActivity(...)` and `dispatchWebhook(...)` per the existing pattern. Webhook events: `card.created` for `create_subcard`, `card.updated` for `set_card_reviewers` and `toggle_ai_review`, `card.signoff` (new event name) for `record_signoff` (currently always error — emit nothing on the stub path).
3. **`enqueueAiReview` is NOT called from `toggle_ai_review`.** Toggling on auto-review does not retroactively review historical artifacts (per E7). Document this in the tool description.
4. **JSON-RPC error code usage.** Follow existing conventions in `mcp-server.ts`: `-32602` for "invalid params / not found / forbidden access" (used uniformly), `-32603` for internal errors. Do NOT introduce new codes.
5. **Tool description must mention `record_signoff`'s API-key restriction**, so agents know not to try it.

## Acceptance criteria

- **AC-13:** `POST /api/mcp` with `method: "create_subcard"` (or `tools/call` with `name: "create_subcard"`) and a valid `parentCardId` + required fields creates a card whose `parentCardId`, `path`, and `depth` are correct.
- **AC-14:** `POST /api/mcp` with `method: "list_card_tree"` returns the same shape as `GET /api/cards/X/children?depth=N`. The exact field set is identical.
- `record_signoff` on M1 always returns the documented API-key error (no real signoff occurs).
- `toggle_ai_review` with invalid `params` shape (e.g. missing `rubric`) returns -32602 with a Zod-derived message.
- `list_artifacts` returns artifacts ordered `createdAt DESC` with reviews included.
- All new tools appear in `GET /api/mcp` manifest.
- `npx tsc --noEmit` passes; existing MCP tests pass.

## Tests to write

- `/root/kanbanmcp/__tests__/mcp/tools.test.ts`
  - For each new tool: a happy-path test + at least one error case
  - AC-13: `create_subcard` produces correct `parentCardId`, `path`, `depth`
  - AC-14: `list_card_tree` shape matches the `/children` response shape (snapshot-compare key sets)
  - `record_signoff` always returns the API-key error in M1
  - `toggle_ai_review` with invalid params shape returns -32602
  - `set_card_reviewers` with `reviewerId: null` clears the field
  - Manifest GET includes all six new tool names

Mock prisma per the existing `mcp-priority.test.ts` pattern. Mock `@/lib/ai-review/queue` so `enqueueAiReview` is a spy.

## Out of scope for this task

- Cookie-based MCP auth (would unblock `record_signoff` real path) — separate effort
- Streaming / async tool results
- Per-tool rate limiting
- Refactoring HTTP routes to expose their inner logic as callable functions (premature)

## Done when

- All six tools appear in the manifest and the dispatch table.
- All tests pass; `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
