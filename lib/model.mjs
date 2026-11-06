/**
 * 模型调用层：`dsh --profile headless --json`
 *
 * 三条踩过的坑，都在这里处理了：
 *   ① PATH 上的 `dsh` 是个 .ps1 外壳（Windows），`spawn(shell:false)` 起不来
 *      → 直接调真正的入口 `<node_modules>/@deepseek-ai/dsh/lib/bin.js`
 *   ② **prompt 走 stdin，绝不走 argv** —— 多行 prompt 经 cmd.exe 会被截成第一行，而且不报错
 *   ③ `--session-id` 只能"采用已存在的会话"，不能自建 → 首次跑完从 `type:session` 事件里收 id
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CANDIDATES = [
  process.env.BILI_FISH_DSH_BIN,
  path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join('C:\\', 'Program Files', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].filter(Boolean)

export function dshBin() {
  for (const p of CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* 下一个 */ }
  }
  throw new Error('找不到 dsh 入口（lib/bin.js）。请设 BILI_FISH_DSH_BIN 指向它')
}

/**
 * 兜底解析 API key（2026-11-06）
 *
 * 背景：新版 dsh 的 headless 只从 credentials service 的 `records` 段取 key，
 * 而本机的 key 在 `~/.dsh/.credentials.yaml` 的 `refs` 段里（老格式），
 * 于是每次生成都报 `MISSING_CREDENTIAL ... no API key for provider route`，
 * 最终产出空正文。
 *
 * 这里只做一件事：env 没有就从那个文件的 `refs.DEEPSEEK_API_KEY` 读一个，
 * **通过子进程环境变量传进去，绝不打印、绝不落盘、绝不进日志**。
 */
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')
  try {
    const text = fs.readFileSync(file, 'utf8')
    // 只认 refs 段下那一行，避免误抓别的字段
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m)
    if (m && m[1].length > 10 && !m[1].includes('…')) return m[1]
  } catch { /* 没有就算了，让 dsh 自己报错 */ }
  return null
}

/**
 * @param {{prompt:string, sessionId?:string, timeoutMs?:number, profile?:string}} p
 * @returns {Promise<{text:string, sessionId:string|null, usage:object|null, ms:number, stderr:string}>}
 */
export function askModel({ prompt, sessionId, timeoutMs = 300_000, profile = 'headless' }) {
  const args = [dshBin(), '--profile', profile, '--json']
  if (sessionId) args.push('--session-id', sessionId)

  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const key = resolveApiKey()
    const env = key ? { ...process.env, DEEPSEEK_API_KEY: key } : { ...process.env }
    // cwd 决定这个 DSH 会话归到哪个工作区（静默 / 非静默分开）
    const cwd = process.env.BILI_FISH_MODEL_CWD || undefined
    const child = spawn(process.execPath, args, { shell: false, windowsHide: true, env, cwd })
    let out = ''
    let err = ''
    let finalText = null
    let finalError = null
    let sid = sessionId ?? null
    let usage = null
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`模型调用超时（${Math.round(timeoutMs / 1000)}s）`)) }
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      let i
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim()
        out = out.slice(i + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId
        else if (ev.type === 'final') {
          if (typeof ev.text === 'string') finalText = ev.text
          // ⚠️ final 事件带 reason 时可能是**报错**（例如没 key）——text 会是空串。
          // 早期版本只看 text，于是"没凭据"被当成"模型返回空"，白跑两次自检。
          if (ev.reason?.kind === 'error') {
            finalError = ev.reason.error?.message || '模型报错（final.reason=error）'
          }
        } else if (ev.type === 'status' && ev.usage) usage = ev.usage
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { err += c })

    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ms = Date.now() - t0
      // 报错优先：final 带了 reason=error 就是失败，不管 text 是不是空
      if (finalError) return reject(new Error(`模型调用失败：${finalError.slice(0, 400)}`))
      if (finalText !== null && finalText.trim()) return resolve({ text: finalText, sessionId: sid, usage, ms, stderr: err })
      if (finalText !== null) {
        return reject(new Error(`模型返回空正文${err ? `（stderr: ${err.slice(0, 300)}）` : ''}`))
      }

      // 会话不存在 → 自动脱掉 session-id 重来一次（设计定稿：追问会话丢了不能变成"永久失败"）
      if (sessionId && /does not exist/i.test(err)) {
        return askModel({ prompt, sessionId: null, timeoutMs, profile }).then(resolve, reject)
      }
      reject(new Error(`模型调用失败 code=${code}：${(err || '(无 stderr)').slice(0, 400)}`))
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}
