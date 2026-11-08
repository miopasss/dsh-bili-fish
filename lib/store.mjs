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

/* ─────────────── 并发保护（2026-11-06 加） ───────────────
 *
 * 事故：同一条 @ 被回复两次。
 * 根因是**两个 serve 实例同时轮询**——A 还在生成（45s），B 也开始生成，
 * 两边都在自己这一侧看到「未处理」，于是各发一条。
 *
 * 两道防线：
 *   ① 单实例锁：一个 HOME 只允许一个 serve 常驻进程
 *   ② rpid 抢占文件：跨进程互斥，`--once` 和常驻同时跑也不会撞
 */

const LOCK_FILE = path.join(HOME, 'serve.lock')
const CLAIM_DIR = path.join(HOME, 'claims')

/** 进程是否还活着（Windows / POSIX 通用） */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 抢常驻锁。成功返回 true；已有活跃实例返回 false（并把对方 pid 带回来）。
 * 陈旧锁（pid 已死）自动接管。
 */
export function acquireServeLock() {
  fs.mkdirSync(HOME, { recursive: true })
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (old?.pid && old.pid !== process.pid && alive(old.pid)) {
      return { ok: false, pid: old.pid, startedAt: old.startedAt }
    }
  } catch { /* 没锁 / 锁坏了 → 直接接管 */ }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(),
  }, null, 2))
  return { ok: true }
}

export function releaseServeLock() {
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (old?.pid === process.pid) fs.unlinkSync(LOCK_FILE)
  } catch { /* 已经没了 */ }
}

/**
 * 抢占一条 @ 的处理权（跨进程原子）。
 *
 * 用 `wx` 打开：文件已存在就抛 EEXIST —— 这是操作系统级的原子操作，
 * 两个进程同时抢只有一个能成功，比"先检查再写"可靠。
 */
export function claimJob(rpid) {
  fs.mkdirSync(CLAIM_DIR, { recursive: true })
  try {
    fs.writeFileSync(path.join(CLAIM_DIR, String(rpid) + '.lock'), String(process.pid), { flag: 'wx' })
    return true
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e
    return false
  }
}

/**
 * 清理「主人的进程已经死了」的抢占文件（2026-11-08）
 *
 * 抢占文件里写的是 pid。进程被强杀 / 崩溃时不会走到 releaseClaim，
 * 这些文件会永久占着那个 rpid——新进程起来只会说"已被另一个进程处理中"，
 * 于是那条 @ 永远没人处理。启动时扫一遍，pid 死掉的直接清掉。
 *
 * @returns {number} 清掉了几个
 */
export function clearStaleClaims() {
  let n = 0
  let names = []
  try { names = fs.readdirSync(CLAIM_DIR) } catch { return 0 }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    const file = path.join(CLAIM_DIR, name)
    let pid = 0
    try { pid = Number(fs.readFileSync(file, 'utf8').trim()) } catch { pid = 0 }
    // pid 读不出来 / 进程已死 → 都是陈旧抢占
    if (!pid || pid === process.pid || !alive(pid)) {
      try { fs.unlinkSync(file); n += 1 } catch { /* 别人先删了 */ }
    }
  }
  return n
}

/** 释放处理权（失败要还回去，否则这条 @ 就永远没人再试了） */
export function releaseClaim(rpid) {
  try { fs.unlinkSync(path.join(CLAIM_DIR, String(rpid) + '.lock')) } catch { /* 已经没了 */ }
}
