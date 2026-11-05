import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'

const FILE = path.join(HOME, 'sessions.json')

/**
 * 每个 bvid 一个 DSH 会话（`--session-id` 只能采用已存在的会话，所以首次跑完要记下 id）。
 * 这样做的好处：追问天然共享上下文，不同视频互不污染。
 */
export function loadSessions() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} }
}

export function getSession(bvid) {
  return loadSessions()[bvid] || null
}

export function rememberSession(bvid, sessionId) {
  if (!bvid || !sessionId) return
  const all = loadSessions()
  if (all[bvid] === sessionId) return
  all[bvid] = sessionId
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2))
}
