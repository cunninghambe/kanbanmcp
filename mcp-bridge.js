#!/usr/bin/env node
/**
 * KanbanMCP stdio bridge — translates MCP stdio protocol to the KanbanMCP HTTP JSON-RPC API.
 * Configured as an MCP server in ~/.hermes/config.yaml
 */

const http = require('http')

// uh-oh crash reporting (self-hosted, github.com/cunninghambe/uh-oh). This
// bridge is a standalone CommonJS script with no Next.js/webpack build step,
// so the vendored TypeScript client (src/lib/uh-oh-client.ts) is loaded via
// ts-node's transpile-only require hook. ts-node is already a devDependency
// here (see .npmrc's `include=dev`, which keeps devDependencies installed
// even under NODE_ENV=production, same convention the `db:seed` npm script
// relies on). If ts-node or the client fail to load for any reason, crash
// reporting is skipped rather than breaking the bridge.
let uhOhClient = null
try {
  // skipProject: true - do not inherit the repo's tsconfig.json (its
  // moduleResolution: "bundler" is for Next.js's own bundler and is
  // incompatible with a plain CommonJS require() here).
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { module: 'CommonJS', target: 'es2019', moduleResolution: 'node' },
  })
  uhOhClient = require('./src/lib/uh-oh-client.ts')
  const pkg = require('./package.json')
  uhOhClient.init({
    dsn: process.env.UH_OH_DSN,
    release: `${pkg.version}+0`,
    environment: process.env.NODE_ENV,
    // debug MUST stay false/undefined: Node's console.debug writes to
    // stdout, and stdout is the MCP JSON-RPC wire for this bridge - any
    // stray write would corrupt the protocol stream.
  })
} catch (err) {
  process.stderr.write(`[mcp-bridge] uh-oh init skipped: ${err && err.message}\n`)
}

/** Never throws; safely no-ops if uh-oh failed to load above. */
function captureException(err, opts) {
  if (!uhOhClient) return
  try {
    uhOhClient.captureException(err, opts)
  } catch {
    // crash reporting must never crash the bridge
  }
}

const API_URL = process.env.KANBAN_API_URL || 'http://localhost:3002/api/mcp'
const API_KEY = process.env.KANBAN_API_KEY || ''

let buffer = ''

function postRpc(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const url = new URL(API_URL)
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${API_KEY}`,
      },
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch (e) { reject(new Error(`Invalid JSON response: ${body}`)) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function getToolManifest() {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL)
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'GET',
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch (e) { reject(new Error(`Invalid JSON: ${body}`)) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function handleMessage(msg) {
  // MCP initialize
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'kanban-mcp', version: '0.1.0' },
      },
    }
  }

  // MCP initialized notification — no response
  if (msg.method === 'notifications/initialized') return null

  // tools/list
  if (msg.method === 'tools/list') {
    const manifest = await getToolManifest()
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: manifest.tools },
    }
  }

  // tools/call — forward to HTTP API
  if (msg.method === 'tools/call') {
    const result = await postRpc({
      jsonrpc: '2.0',
      id: msg.id ?? 1,
      method: 'tools/call',
      params: msg.params,
    })
    // Wrap result in MCP content format
    const content = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2)
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: result.error
          ? `Error: ${result.error.message}`
          : content
        }],
      },
    }
  }

  // Unknown method
  return {
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() // keep incomplete line

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const msg = JSON.parse(trimmed)
      const response = await handleMessage(msg)
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n')
      }
    } catch (err) {
      // Covers both malformed input (JSON.parse) and unexpected failures from
      // handleMessage (e.g. postRpc/getToolManifest network errors) - the
      // response label below predates this wiring and is left unchanged.
      captureException(err, { mechanism: 'js-manual' })
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      }) + '\n')
    }
  }
})

process.stdin.on('end', () => {
  if (uhOhClient) {
    uhOhClient.flush(2000).finally(() => process.exit(0))
  } else {
    process.exit(0)
  }
})
