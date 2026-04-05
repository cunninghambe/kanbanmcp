# KanbanMCP — Agent Workflow Guide

KanbanMCP provides a Kanban board and helpdesk ticketing system for coordinating work between AI agents and humans. Agents track tasks on the board, manage support tickets, and post updates back to NexusMCP chat.

**Base URL:** `http://localhost:3002`
**Board UI:** `http://localhost:3002` (Next.js)

---

## Authentication

All API requests require a Bearer API key in the `Authorization` header:

```bash
curl http://localhost:3002/api/tickets \
  -H "Authorization: Bearer <api-key>"
```

Keys are verified by SHA-256 hash stored in the `ApiKey` table. The raw key is never persisted.

### Known API keys

| Org | Key |
|---|---|
| A1 | `9cb481a9c5abd54e45a6b3396814780caa34e0c8d54e829fc77e98e6d0066d51` |
| Autogeny | `9508504220de2bb65084146423f116ec5e50388597ada4f813b6b71fd358c658` |

For CLI tools on this server, the active key is `kanban-claude-agent-key-for-cli-tools-persistent` (resolves to the A1 org).

---

## Board API

### Board and Column IDs

| Name | ID |
|---|---|
| Board: Slack-for-AI | `cmnkvo2rv000jtb9tbgbn10ym` |
| Column: Backlog | `cmnkvo2rw000ltb9tbsddtbjg` |
| Column: In Progress | `cmnkvo2rw000ntb9tvhvyz3e2` |
| Column: Review | `cmnkvo2rw000ptb9to4z5397u` |
| Column: Done | `cmnkvo2rw000rtb9ts5yeu2xa` |

### Get board (columns + cards)

```bash
# Via MCP endpoint (recommended for agents)
curl -X POST http://localhost:3002/api/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"get_board","params":{"boardId":"cmnkvo2rv000jtb9tbgbn10ym"}}'
```

Response: `{ result: { id, name, columns: [{ id, name, cards: [...] }] } }`

### Create a card

```bash
curl -X POST http://localhost:3002/api/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"create_card",
    "params":{
      "boardId": "cmnkvo2rv000jtb9tbgbn10ym",
      "columnId": "cmnkvo2rw000ltb9tbsddtbjg",
      "title": "Implement feature X",
      "description": "Details here"
    }
  }'
```

Optional card fields: `dueDate` (ISO 8601), `priority` (`low` | `medium` | `high` | `urgent` | `none`), `sprintId`, `assigneeId`.

### Move a card

```bash
curl -X POST http://localhost:3002/api/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"move_card",
    "params":{
      "cardId": "<card-id>",
      "columnId": "cmnkvo2rw000ntb9tvhvyz3e2",
      "position": 1
    }
  }'
```

`position` is 1-indexed within the target column.

### Update a card

```bash
curl -X POST http://localhost:3002/api/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"update_card",
    "params":{
      "cardId": "<card-id>",
      "title": "Updated title",
      "description": "New details",
      "priority": "high"
    }
  }'
```

### Add a comment to a card

```bash
curl -X POST http://localhost:3002/api/mcp \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"add_comment",
    "params":{"cardId":"<card-id>","content":"Progress update: done with step 1"}
  }'
```

### MCP Tool manifest

```bash
curl http://localhost:3002/api/mcp
```

Returns the full tool list with parameter schemas. No auth required for this endpoint.

---

## Helpdesk / Tickets API

Tickets use standard REST (not MCP JSON-RPC). Auth is the same Bearer key.

### Status transitions

```
open -> in_progress -> waiting -> resolved -> closed
```

Valid statuses: `open`, `in_progress`, `waiting`, `resolved`, `closed`
Valid priorities: `low`, `medium`, `high`, `urgent`

### List tickets

```bash
curl "http://localhost:3002/api/tickets" \
  -H "Authorization: Bearer <api-key>"

# With filters
curl "http://localhost:3002/api/tickets?status=open&priority=high&assigneeId=<id>&q=login+bug" \
  -H "Authorization: Bearer <api-key>"
```

Query params: `status`, `priority`, `assigneeId`, `q` (full-text), `page`, `limit`

Response: `{ tickets: [...], pagination: { page, limit, total, pages } }`

### Get a ticket

```bash
curl http://localhost:3002/api/tickets/<ticketId> \
  -H "Authorization: Bearer <api-key>"
```

Includes full ticket, comments, and reporter/assignee details.

### Create a ticket

```bash
curl -X POST http://localhost:3002/api/tickets \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Agent loop not terminating",
    "description": "Steps to reproduce...",
    "priority": "high",
    "assigneeId": "<user-id>"
  }'
```

### Update a ticket

```bash
curl -X PATCH http://localhost:3002/api/tickets/<ticketId> \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "priority": "urgent"}'
```

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeId`

### Add a comment

```bash
curl -X POST http://localhost:3002/api/tickets/<ticketId>/comments \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Investigated. Root cause is X.", "internal": false}'
```

`internal: true` marks a comment as an internal note (not shown to end users in some views).

### Get ticket activity log

```bash
curl http://localhost:3002/api/tickets/<ticketId>/activity \
  -H "Authorization: Bearer <api-key>"
```

Returns a chronological log of all status changes, comments, and field updates.

---

## Agent Workflow

The standard lifecycle for an agent task:

### 1. Wake up

The agent wakes up from a Paperclip heartbeat or a NexusMCP @mention. On wake, check for assigned work:

```bash
# Check cards assigned in-progress columns
kanban-update list --column progress

# Or list all tickets open/in-progress for this org
curl "http://localhost:3002/api/tickets?status=open" \
  -H "Authorization: Bearer <api-key>"
```

### 2. Claim work

Move the card to In Progress to signal ownership:

```bash
kanban-update move <card-id> progress
```

Or update ticket status:

```bash
curl -X PATCH http://localhost:3002/api/tickets/<ticketId> \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress"}'
```

### 3. Do the work

Perform the task. Post incremental updates as card comments if the work takes multiple steps:

```bash
kanban-update move <card-id> review   # if human review needed
```

### 4. Complete

Move card to Done:

```bash
kanban-update move <card-id> done
```

Resolve the ticket:

```bash
curl -X PATCH http://localhost:3002/api/tickets/<ticketId> \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved"}'
```

### 5. Report back in NexusMCP

Post a completion message to the relevant channel:

```bash
nexus-send general "@lead Card <id> is done — deployed to staging"
nexus-send general "Ticket #<id> resolved: root cause was X, fix in commit abc123"
```

---

## CLI Tools

These scripts are available at `/root/tools/` on the server.

### kanban-update

```bash
# List all cards
kanban-update list

# List cards in a specific column
kanban-update list --column backlog
kanban-update list --column progress
kanban-update list --column review
kanban-update list --column done

# Move a card
kanban-update move <card-id> done
kanban-update move <card-id> progress

# Create a card (defaults to Backlog)
kanban-update create "Fix the login bug"
kanban-update create "Write tests" --column progress --description "Cover edge cases"
```

Uses the API key `kanban-claude-agent-key-for-cli-tools-persistent` and the MCP JSON-RPC endpoint internally.

### agent-status

```bash
# List all Paperclip agents with heartbeat and run status
agent-status

# Filter by name (case-insensitive partial match)
agent-status CEO
agent-status engineer
```

Reads the Paperclip API key from `/root/.claude.json` and queries `http://localhost:3100/api/companies/91d80478-1fd3-4025-8ec1-5bf3aed65665/agents`.

---

## Reference

### Column IDs (quick copy)

```
Backlog:     cmnkvo2rw000ltb9tbsddtbjg
In Progress: cmnkvo2rw000ntb9tvhvyz3e2
Review:      cmnkvo2rw000ptb9to4z5397u
Done:        cmnkvo2rw000rtb9ts5yeu2xa
```

### MCP endpoint summary

All MCP calls go to `POST /api/mcp` with:
```json
{"jsonrpc": "2.0", "id": 1, "method": "<tool>", "params": {...}}
```

Available tools: `list_boards`, `get_board`, `create_card`, `update_card`, `move_card`, `list_sprints`, `add_comment`, `get_activity`

Check `GET /api/mcp` for the full schema of each tool.
