# Kanban MCP UI System

_Started 2026-05-20 20:13 UTC_

---

## User

here is the repo i want the UI design system for https://github.com/cunninghambe/kanbanmcp

## Assistant

_[tool: github_get_tree]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_get_tree]_

_[tool: github_get_tree]_

_[tool: github_get_tree]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: questions_v2]_

I've read through the kanbanmcp repo. It's an AI-first Kanban with sub-issue trees, AI review (Claude), artifacts, signoffs, helpdesk, MCP — a dense product surface for builder/agent workflows. The Autogeny design system you've attached (cyber-brutalist, dark, signal red, mono labels) is a strong aesthetic match for that. A few quick scoping questions before I build:

## User

Questions answered:
- deliverable_shape: Full screen mockups (board, card modal, dashboard, helpdesk)
- visual_direction: Autogeny-inspired but lighter/more approachable (still keep red accent)
- screens_priority: Kanban board (columns, cards, drag), Card detail modal (sub-issues, artifacts, AI review, signoffs)
- ai_treatment: Quiet — looks like any other reviewer, just labeled 'AI'
- variations: Priority/status indicators (chip vs bar vs glyph), Sub-issue tree (indent vs path-graph vs outline), AI review comment styles
- icons_glyphs: Decide for me
- rename_brand: Decide for me
- tweaks: No, just ship a fixed canonical version

## Assistant

_[tool: update_todos]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: copy_starter_component]_

_[tool: copy_files]_

Got it. Now I'll build a design system mockup for KanbanMCP — light-paper Autogeny variant, hairlines + mono labels + signal red. Let me start.

_[tool: write_file]_

_[tool: write_file]_

Now the main HTML shell and shared components:

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: grep]_

_[tool: write_file]_

_[tool: show_html]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built a KanbanMCP design system as a single canvas with 4 screen mockups + 9 variation artboards.

**Visual direction** — light-paper Autogeny: warm off-white canvas, hairline borders, sharp corners, mono labels in `UPPERCASE TRACKED-OUT`, signal red as the only chromatic accent. The Autogeny token set is light-mode-inverted in `styles/tokens.css`; everything else uses the same variable names.

**Screens section** (each 1440×900):
- `01 · board` — full kanban with sidebar, filter bar, 4 columns (todo / in-progress / in-review / done), WIP-limit row on in-progress, signoff pips visible on review cards, AI-queue status in the meta strip
- `02 · card detail` — full takeover with description, sub-issue tree, artifacts (with per-row AI review status), comments thread, right rail for status/roles/signoffs/AI auto-review/activity
- `03 · dashboard` — assignee/reviewer/approver/overdue stats, three queue tables, sprint burndown, live AI-review queue, agent activity log
- `04 · helpdesk` — ticket list + selected-ticket preview, status tabs, promote-to-board CTAs

**Variation sections**:
- Priority: edge bar / mono pill `[P1]` / tally bars
- Sub-issue tree: indent guides / numeric outline / path-graph schematic
- AI review comments: inline / hairline-bordered / structured findings — all stay "quiet" per your spec

**Brand decisions I made for you** (call out anything to change):
- Wordmark: `kanban·mcp` lowercase, accent dot, paired with a square mark (kanban-bar glyph + red corner stamp, lifted from Autogeny's mark conventions)
- Icons: Lucide line set for functional UI; ASCII glyphs (`///`, `→`, `[ok]`, `[•••]`, `✗`/`✓`) for brand moments + system status
- AI Reviewer avatar: signal-red square with sparkle glyph — quiet but identifiable

Drag-reorder, inline-rename, focus-mode (click any artboard) are live in the canvas. Let me know which screens to push deeper or which variations to mix and match.

## User

Love it. For priority indicators - let's go with option A. 
Sub-issues A
AI review comments option C

## Assistant

_[tool: str_replace_edit]_

Locking in A/A/C. Updating the card detail to use the structured-findings AI comment as canonical.

_[tool: str_replace_edit]_

_[tool: done]_

Locked in:
- **Priority:** edge bar
- **Sub-issues:** indent + vertical guide
- **AI review comments:** structured findings — now wired into the card detail modal as the canonical AI Reviewer comment (pass status, summary banner, three findings with severity pips)

Variation artboards are still in the canvas for reference — relabeled so the chosen one is marked `canonical`. Let me know what to refine next: copy in screens, brand mark, additional screens (login / activity / settings), or tightening any of the four canonical screens.

