#!/usr/bin/env node
/**
 * MCP stdio 服务器（零依赖裸 JSON-RPC，协议 2024-11-05，换行分隔）
 *
 * M0 只暴露一个工具：
 *   fish_see  —— 盘点一条视频的全部素材并给出「该走 OCR 还是 ASR」的判定（只读）
 */
import { see, renderReport } from '../lib/media.mjs'
import { config } from '../lib/config.mjs'

const SERVER = { name: 'bili-fish', version: '0.0.1' }
const PROTOCOL = '2024-11-05'

const TOOLS = [
  {
    name: 'fish_see',
    description:
      '盘点一条 B 站视频的全部素材（元信息 / 字幕 / 雪碧图 / 弹幕 / 播放地址）并用 OCR 探针判定内容主要在「声音」还是「画面」。只读，不产生任何写操作。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'BV 号或视频链接' },
        probe: { type: 'boolean', description: '是否跑 OCR 探针（默认 true）' },
      },
      required: ['target'],
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function callTool(name, args) {
  if (name !== 'fish_see') throw new Error(`未知工具：${name}`)
  const r = await see(args?.target, { probe: args?.probe !== false })
  return {
    content: [{ type: 'text', text: renderReport(r) }],
    isError: r.verdict?.tier === 'error',
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {})
      return reply(id, result)
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '失败：' + String(e?.message ?? e) }], isError: true })
    }
  }
  if (method === 'ping') return reply(id, {})
  if (id !== undefined) return replyError(id, -32601, `未实现的方法：${method}`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg).catch((e) => {
      if (msg?.id !== undefined) replyError(msg.id, -32603, String(e?.message ?? e))
    })
  }
})

// 启动时把配置摘要打到 stderr（不污染 stdout 的 JSON-RPC 流）
process.stderr.write(`[bili-fish] M0 就绪 · probe=${JSON.stringify(config().probe)}\n`)
