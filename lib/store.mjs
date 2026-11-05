/**
 * 持久化：已处理 / 已拒绝 / 告警 / 尝试次数
 *
 * 为什么必须有 handled：B站 的 `/x/msgfeed/at` **回复后不会把消息移走**
 * （2026-11-04 实测：回完再拉还是同一条），已读状态也不可靠（unread.at 一直是 0）。
 * 所以幂等只能靠自己记 **rpid**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'

export const HANDLED_FILE = path.join(HOME, 'handled.jsonl')
export const REJECTED_FILE = path.join(HOME, 'rejected.jsonl')
export const ATTEMPTS_FILE = path.join(HOME, 'attempts.json')
export const ALERT_DIR = path.join(HOME, 'alerts')

export function ensureStore() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ALERT_DIR, { recursive: true })
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

export function appendJsonl(file, obj) {
  ensureStore()
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}

/* ── 已处理 ── */

const handledCache = { at: 0, set: new Set() }

export function isHandled(rpid) {
  // 缓存 10 秒，避免每轮都全量读文件；进程内新记录的会即时 insert
  if (Date.now() - handledCache.at > 10_000) {
    handledCache.set = new Set(readJsonl(HANDLED_FILE).map((r) => String(r.rpid)))
    handledCache.at = Date.now()
  }
  return handledCache.set.has(String(rpid))
}

export function markHandled(rec) {
  appendJsonl(HANDLED_FILE, { at: new Date().toISOString(), ...rec })
  handledCache.set.add(String(rec.rpid))
  handledCache.at = Date.now()
}

export function readHandled() {
  return readJsonl(HANDLED_FILE)
}

/* ── 已拒绝（非白名单 / 队列满） ── */

export function reject(rec) {
  appendJsonl(REJECTED_FILE, { at: new Date().toISOString(), ...rec })
}

export function readRejected() {
  return readJsonl(REJECTED_FILE)
}

/* ── 尝试次数（跨进程重启累计） ── */

export function readAttempts() {
  try { return JSON.parse(fs.readFileSync(ATTEMPTS_FILE, 'utf8')) } catch { return {} }
}

export function bumpAttempt(rpid) {
  const all = readAttempts()
  const k = String(rpid)
  all[k] = { n: (all[k]?.n ?? 0) + 1, lastAt: new Date().toISOString() }
  ensureStore()
  fs.writeFileSync(ATTEMPTS_FILE, JSON.stringify(all, null, 2) + '\n')
  return all[k].n
}

/* ── 告警文件 ── */

export function writeAlert(job, reason, detail = '') {
  ensureStore()
  const file = path.join(ALERT_DIR, `ALERT-${job.rpid}.md`)
  const body = [
    `# 处理失败：${job.bvid}`,
    '',
    `- 评论 rpid：${job.rpid}`,
    `- 视频：${job.title || '（未知标题）'}  https://www.bilibili.com/video/${job.bvid}`,
    `- 召唤人：${job.nickname}（mid ${job.mid}）`,
    `- 原话：${JSON.stringify(job.text || '')}`,
    `- 失败原因：${reason}`,
    detail ? `- 详情：\n\n\`\`\`\n${String(detail).slice(0, 4000)}\n\`\`\`` : '',
    `- 时间：${new Date().toISOString()}`,
    '',
    '处理完删掉这个文件即可（不会自动重试）。',
  ].filter(Boolean).join('\n')
  fs.writeFileSync(file, body + '\n')
  return file
}

export function listAlerts() {
  try {
    return fs.readdirSync(ALERT_DIR).filter((f) => f.startsWith('ALERT-')).map((f) => path.join(ALERT_DIR, f))
  } catch { return [] }
}

export function clearAlert(rpid) {
  try { fs.unlinkSync(path.join(ALERT_DIR, `ALERT-${rpid}.md`)) } catch { /* 没有就算了 */ }
}
