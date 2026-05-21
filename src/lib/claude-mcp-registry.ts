import { readFile, writeFile, access } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export let PROJECTS_JSON_PATH = '/root/ClaudeMCP/projects.json'
export const CLAUDE_MCP_PROCESS_NAME = 'claude-mcp'

export interface ProjectEntry {
  path: string
  defaultBranch: string
}
export type Registry = Record<string, ProjectEntry>

/** Test seam: override the projects.json path during tests. */
export function __setProjectsJsonPathForTests(p: string): void {
  PROJECTS_JSON_PATH = p
}

export async function readRegistry(): Promise<Registry> {
  try {
    const contents = await readFile(PROJECTS_JSON_PATH, 'utf-8')
    return JSON.parse(contents) as Registry
  } catch {
    return {}
  }
}

export async function writeRegistry(reg: Registry): Promise<void> {
  await writeFile(PROJECTS_JSON_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf-8')
}

export async function upsertProject(slug: string, path: string, defaultBranch = 'main'): Promise<void> {
  const reg = await readRegistry()
  const existing = reg[slug]
  if (existing) {
    if (existing.path !== path) {
      throw new Error(
        `Project '${slug}' is already registered at '${existing.path}'; refusing to overwrite with '${path}'.`
      )
    }
    return
  }
  reg[slug] = { path, defaultBranch }
  await writeRegistry(reg)
}

export async function ensureProjectDirectory(path: string, branch = 'main'): Promise<void> {
  const gitDir = `${path}/.git`
  try {
    await access(gitDir)
    return
  } catch {
    // .git does not exist — initialise
  }
  await execAsync(`mkdir -p ${shellQuote(path)}`)
  await execAsync(`git init -b ${shellQuote(branch)} ${shellQuote(path)}`)
  await writeFile(`${path}/README.md`, `# ${path.split('/').pop() ?? 'project'}\n`, 'utf-8')
  await execAsync(`git -C ${shellQuote(path)} add README.md`)
  await execAsync(
    `git -C ${shellQuote(path)} -c user.email="kanban@localhost" -c user.name="Kanban" commit -m "Initial commit"`
  )
}

export async function reloadClaudeMcp(): Promise<void> {
  await execAsync(`pm2 sendSignal SIGHUP ${CLAUDE_MCP_PROCESS_NAME}`, { timeout: 10_000 })
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
