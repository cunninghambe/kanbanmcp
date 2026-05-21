import path from 'node:path'
import * as fsp from 'node:fs/promises'
import { MAX_ARTIFACT_BYTES } from '@/lib/artifacts'

// ─── Parser ──────────────────────────────────────────────────────────────────

export type ParsedDeliverableOutput = {
  deliverables: string[]
  summary: string | null
  finalCommit: string | null
  reviewUnconverged: boolean
}

const ABSENT: ParsedDeliverableOutput = {
  deliverables: [],
  summary: null,
  finalCommit: null,
  reviewUnconverged: false,
}

const FINAL_COMMIT_RE = /^FINAL COMMIT:[ \t]*(\S+)[ \t]*$/
const DELIVERABLES_RE = /^DELIVERABLES:[ \t]*(.*)$/
const SUMMARY_PREFIX = 'SUMMARY: '
const SUMMARY_CONT = 'SUMMARY:'

export function parseDeliverableOutput(output: string): ParsedDeliverableOutput {
  const lines = output.trimEnd().split('\n')

  // Scan backwards to find the FINAL COMMIT line.
  let fcIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FINAL_COMMIT_RE.test(lines[i].trimEnd())) { fcIdx = i; break }
  }
  if (fcIdx < 0) return ABSENT

  const finalCommit = (FINAL_COMMIT_RE.exec(lines[fcIdx].trimEnd()) as RegExpExecArray)[1]

  // Find SUMMARY: line before FINAL COMMIT.
  let summaryIdx = -1
  for (let i = fcIdx - 1; i >= 0; i--) {
    if (lines[i].startsWith(SUMMARY_CONT)) { summaryIdx = i; break }
  }
  if (summaryIdx < 0) return ABSENT

  // Collect multi-line summary: from summaryIdx up to (but not including) fcIdx.
  const firstSummaryLine = lines[summaryIdx].slice(SUMMARY_PREFIX.length)
  const summaryLines = [firstSummaryLine, ...lines.slice(summaryIdx + 1, fcIdx)]
  const summary = summaryLines.join('\n').trimEnd()

  // Find DELIVERABLES: line before SUMMARY.
  let delIdx = -1
  for (let i = summaryIdx - 1; i >= 0; i--) {
    if (DELIVERABLES_RE.test(lines[i])) { delIdx = i; break }
  }
  if (delIdx < 0) return ABSENT

  const rawPaths = (DELIVERABLES_RE.exec(lines[delIdx]) as RegExpExecArray)[1].trim()
  const deliverables = rawPaths === ''
    ? []
    : rawPaths.split(',').map((p) => p.trim()).filter(Boolean)

  const reviewUnconverged = summary.startsWith('[REVIEW UNCONVERGED]')

  return { deliverables, summary, finalCommit, reviewUnconverged }
}

// ─── Path safety ─────────────────────────────────────────────────────────────

export function assertSafeDeliverablePath(p: string): void {
  if (!p || p.includes('\0') || !p.startsWith('/deliverables/') || p.includes('..')) {
    throw new Error(`Unsafe deliverable path: ${p}`)
  }
  const normalized = path.posix.normalize(p)
  if (!normalized.startsWith('/deliverables/')) {
    throw new Error(`Unsafe deliverable path (normalized escape): ${p}`)
  }
}

// ─── Project path resolver (60s cache) ───────────────────────────────────────

type ProjectsJson = Record<string, { path: string }>

const CACHE_TTL_MS = 60_000
const PROJECTS_JSON_PATH = '/root/ClaudeMCP/projects.json'

let cachedProjects: ProjectsJson | null = null
let cacheExpiresAt = 0
let testReader: (() => Promise<string>) | null = null

function defaultReader(): Promise<string> {
  return fsp.readFile(PROJECTS_JSON_PATH, 'utf8')
}

export async function resolveProjectPath(projectName: string): Promise<string | null> {
  if (cachedProjects === null || Date.now() >= cacheExpiresAt) {
    const reader = testReader ?? defaultReader
    const raw = await reader()
    cachedProjects = JSON.parse(raw) as ProjectsJson
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
  }
  return cachedProjects[projectName]?.path ?? null
}

export function __setProjectsJsonReaderForTests(fn: (() => Promise<string>) | null): void {
  testReader = fn
}

export function resetDeliverablesCacheForTests(): void {
  cachedProjects = null
  cacheExpiresAt = 0
}

// ─── MIME map ─────────────────────────────────────────────────────────────────

const DELIVERABLE_MIME_MAP: Record<string, string> = {
  md:   'text/markdown',
  html: 'text/html',
  csv:  'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

// ─── Artifact attach ─────────────────────────────────────────────────────────

export async function attachDeliverableArtifact(
  cardId: string,
  projectPath: string,
  deliverableRepoPath: string,
): Promise<{ artifactId: string; filename: string } | { skipped: string }> {
  const fullPath = path.join(projectPath, deliverableRepoPath)

  let stats: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stats = await fsp.stat(fullPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skipped: 'missing' }
    throw err
  }

  if (stats.size === 0) return { skipped: 'empty' }
  if (stats.size > MAX_ARTIFACT_BYTES) return { skipped: 'too_large' }

  const ext = path.extname(deliverableRepoPath).slice(1).toLowerCase()
  const mimeType = DELIVERABLE_MIME_MAP[ext]
  if (!mimeType) return { skipped: 'mime_rejected' }

  const filename = path.basename(deliverableRepoPath)

  const { prisma } = await import('@/lib/db')
  const { getStorageDriver } = await import('@/lib/storage')

  const artifact = await prisma.artifact.create({
    data: {
      cardId,
      uploaderId: 'agent-claude-code',
      filename,
      mimeType,
      sizeBytes: stats.size,
      storageKey: 'pending',
      source: 'UPLOAD',
    },
  })

  const bytes = await fsp.readFile(fullPath)
  const storage = getStorageDriver()

  try {
    await storage.put(artifact.id, bytes, mimeType)
  } catch (storageErr) {
    await prisma.artifact.delete({ where: { id: artifact.id } })
    throw storageErr
  }

  await prisma.artifact.update({
    where: { id: artifact.id },
    data: { storageKey: artifact.id },
  })

  return { artifactId: artifact.id, filename }
}

// ─── Spec preamble ────────────────────────────────────────────────────────────

export const DELIVERABLE_SPEC_PREAMBLE = `DELIVERABLE REQUIREMENTS

This task is the work product, not the code. Produce one or more deliverable
files in the format(s) most appropriate to the task:

- markdown (.md): plans, research, strategy, write-ups
- html (.html): web content, landing pages
- xlsx (.xlsx): data, models, financial work — use openpyxl
- pptx (.pptx): slide decks — use python-pptx
- docx (.docx): formatted documents, contracts — use python-docx
- csv (.csv): tabular data
- json (.json): structured machine-readable output

Write every deliverable into the \`/deliverables/\` directory at the repo root.
Use descriptive kebab-case filenames. Multiple deliverables are allowed when
the task naturally produces several artifacts (e.g., model + slides + summary).

If you need Python libraries for binary formats, install them into a venv at
\`.venv-agent/\` at the repo root: \`uv venv .venv-agent && uv pip install --python .venv-agent/bin/python python-docx openpyxl python-pptx\`.
Do not commit the venv. Do not modify the project's existing Python or Node
dependencies — your work is isolated.

PRE-COMMIT REVIEW GATE

Before committing your deliverables, you MUST self-review:

1. Spawn a reviewer subagent via the Agent tool. Provide it: the spec above,
   the list of deliverable files you produced, and the contents of each
   deliverable. Ask the reviewer to evaluate whether the deliverable fully
   addresses the spec, has internal logic, names sources where applicable,
   and is concrete enough to act on. The reviewer must output a JSON object
   on its final line:
   \`{"verdict":"PASS"|"REVISE","notes":"..."}\`

2. If verdict is PASS → proceed to commit and to the OUTPUT PROTOCOL below.

3. If verdict is REVISE → discard or rewrite the deliverable based on the
   notes. Then re-run the reviewer. Maximum 3 review rounds. If the third
   review still says REVISE, commit what you have anyway and note the
   unresolved feedback in your final SUMMARY.

OUTPUT PROTOCOL

After committing, output exactly three lines at the very end of your final
message (these will be parsed by the kanban worker — be precise):

DELIVERABLES: /deliverables/<file1>, /deliverables/<file2>, ...
SUMMARY: <≤300 words describing what you produced, key decisions, and
         (if applicable) unresolved reviewer notes>
FINAL COMMIT: <sha>

If review never converged (3 REVISE rounds), prepend "[REVIEW UNCONVERGED] "
to the SUMMARY content.`

export function buildEnrichedSpec(title: string, description: string): string {
  return `${title}\n\n${description}\n\n---\n${DELIVERABLE_SPEC_PREAMBLE}`
}
