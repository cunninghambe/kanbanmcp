#!/usr/bin/env node
/**
 * KanbanMCP stdio bridge — translates MCP stdio protocol to the KanbanMCP HTTP JSON-RPC API.
 * Configured as an MCP server in ~/.hermes/config.yaml
 */

const http = require('http')

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
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      }) + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
