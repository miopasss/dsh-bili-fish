#!/usr/bin/env node
/**
 * bili-fish 本地 Web 控制台
 *
 *   node web/server.mjs [--port 8787] [--open]
 *
 * 只做三件事：
 *   ① 读写 HOME/config.json（表单 / 原始 JSON）
 *   ② 展示 HOME/handled.jsonl、rejected.jsonl 与 HOME/runs/<runId>/summary.md
 *   ③ 把 handled.jsonl 里 result === 'quiet'（静默：没发到评论区，只留本地）的记录单独挑出来
 *
 * 安全边界（只监听 127.0.0.1 远远不够：浏览器里任何网页都能向回环端口发请求）：
 *   · 启动时生成一次性 token，打印在控制台；
 *   · 只有带 `?token=` 的请求才会被发一张 HttpOnly + SameSite=Strict 的 cookie；
 *   · 之后所有请求都必须带这张 cookie 或 `x-token` 头，否则一律 403；
 *   · POST /api/config 额外要求 Content-Type: application/json，并校验 Origin；
 *   · 写配置前先备份 config.json.bak，读取时容忍 UTF-8 BOM，写入时不写 BOM。
 *
 * 这个入口刻意不 import bin/fish.mjs / lib/serve.mjs 等会被并行修改的文件，
 * 只借 lib/paths.mjs 的 HOME 定位数据目录，避免互相牵连。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { HOME } from '../lib/paths.mjs'

const WEB_DIR = import.meta.dirname
const INDEX_HTML = path.join(WEB_DIR, 'index.html')

const CONFIG_FILE = path.join(HOME, 'config.json')
const BACKUP_FILE = path.join(HOME, 'config.json.bak')
const HANDLED_FILE = path.join(HOME, 'handled.jsonl')
const REJECTED_FILE = path.join(HOME, 'rejected.jsonl')
const RUNS_DIR = path.join(HOME, 'runs')

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const MAX_BODY = 2 * 1024 * 1024
const COOKIE_NAME = 'fish_web_token'
const TOKEN = crypto.randomUUID()

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,160}$/
const SUMMARY_MAX = 400_000
const TRANSCRIPT_HEAD_MAX = 6_000

const RESULT_META = {
  replied: { label: '已回复', kind: 'ok' },
  dead: { label: '失败', kind: 'bad' },
  blocked: { label: '风控熔断', kind: 'bad' },
  quiet: { label: '静默', kind: 'quiet' },
  skipped_quota: { label: '跳过（额度）', kind: 'skip' },
  skipped_per_video: { label: '跳过（同视频）', kind: 'skip' },
}

/** 静默：@ 里带了「悄悄」，AI 不往评论区发任何东西，只写 runs/ 和 handled.jsonl */
const QUIET_RESULT = 'quiet'

const REASON_META = {
  not_whitelisted: { label: '不在白名单', kind: 'bad' },
  queue_full: { label: '队列已满', kind: 'warn' },
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/* ────────────────────────────── 小工具 ────────────────────────────── */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function stripBom(text) {
  return text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 读文本，顺手处理 UTF-8 BOM（也兼容 PowerShell 偶尔写出的 UTF-16 BOM） */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), bom: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), bom: 'utf-16le' }
  }
  return { text: buf.toString('utf8'), bom: null }
}

function readTextFile(file) {
  try {
    const buf = fs.readFileSync(file)
    const decoded = decodeBuffer(buf)
    return { exists: true, text: decoded.text, bom: decoded.bom, bytes: buf.length }
  } catch (e) {
    if (e?.code === 'ENOENT') return { exists: false, text: '', bom: null, bytes: 0 }
    return { exists: false, text: '', bom: null, bytes: 0, error: String(e?.message ?? e) }
  }
}

function localStamp(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function localDateKey(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function timeValue(record) {
  const t = Date.parse(String(record?.at ?? ''))
  return Number.isFinite(t) ? t : 0
}

const byTimeDesc = (a, b) => timeValue(b) - timeValue(a)

/* ────────────────────────────── 配置读写 ────────────────────────────── */

function loadConfig() {
  const file = readTextFile(CONFIG_FILE)
  const out = {
    exists: file.exists,
    path: CONFIG_FILE,
    raw: file.text,
    config: null,
    bom: file.bom,
    bytes: file.bytes,
    parseError: null,
  }
  if (file.error) {
    out.parseError = `读取失败：${file.error}`
    return out
  }
  if (!file.exists) {
    out.config = {}
    return out
  }
  try {
    const parsed = JSON.parse(file.text)
    if (!isPlainObject(parsed)) out.parseError = '配置文件顶层必须是一个 JSON 对象'
    else out.config = parsed
  } catch (e) {
    out.parseError = `JSON 解析失败：${e?.message ?? e}`
  }
  return out
}

/**
 * 只用 incoming 覆盖它自己出现的键，其余键（含界面没渲染的未知字段）从 base 原样带回。
 * 数组整体替换；对象递归。这样 POST 一个局部配置不会把整份文件写丢。
 */
function mergePreserve(base, incoming) {
  if (!isPlainObject(base) || !isPlainObject(incoming)) return incoming
  const out = {}
  for (const key of Object.keys(base)) {
    out[key] = Object.prototype.hasOwnProperty.call(incoming, key)
      ? mergePreserve(base[key], incoming[key])
      : base[key]
  }
  for (const key of Object.keys(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = incoming[key]
  }
  return out
}

/** 已知字段做轻量类型校验；未知字段完全不碰，留给人自己决定。 */
function validateConfig(cfg) {
  if (!isPlainObject(cfg)) return ['配置顶层必须是一个 JSON 对象']
  const errors = []

  const num = (label, value, { int = false, min = -Infinity, max = Infinity } = {}) => {
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${label} 必须是数字`)
      return
    }
    if (int && !Number.isInteger(value)) errors.push(`${label} 必须是整数`)
    if (value < min) errors.push(`${label} 不能小于 ${min}`)
    if (value > max) errors.push(`${label} 不能大于 ${max}`)
  }

  const numArray = (label, value, { length = null, min = -Infinity } = {}) => {
    if (value === undefined) return
    if (!Array.isArray(value)) {
      errors.push(`${label} 必须是数字数组`)
      return
    }
    if (length !== null && value.length !== length) {
      errors.push(`${label} 必须正好包含 ${length} 个数字`)
      return
    }
    value.forEach((item, i) => {
      if (typeof item !== 'number' || !Number.isFinite(item)) errors.push(`${label}[${i}] 必须是数字`)
      else if (item < min) errors.push(`${label}[${i}] 不能小于 ${min}`)
    })
  }

  if (cfg.whitelist !== undefined) {
    if (!Array.isArray(cfg.whitelist)) errors.push('whitelist 必须是字符串数组')
    else cfg.whitelist.forEach((item, i) => {
      if (typeof item !== 'string') errors.push(`whitelist[${i}] 必须是字符串`)
    })
  }

  if (cfg.owner !== undefined) {
    if (!isPlainObject(cfg.owner)) errors.push('owner 必须是对象')
    else {
      if (cfg.owner.mid !== undefined && typeof cfg.owner.mid !== 'string' && typeof cfg.owner.mid !== 'number') {
        errors.push('owner.mid 必须是字符串或数字')
      }
      if (cfg.owner.nickname !== undefined && typeof cfg.owner.nickname !== 'string') {
        errors.push('owner.nickname 必须是字符串')
      }
    }
  }

  if (cfg.probe !== undefined) {
    if (!isPlainObject(cfg.probe)) errors.push('probe 必须是对象')
    else {
      num('probe.samples', cfg.probe.samples, { int: true, min: 1 })
      num('probe.ocrCharsThreshold', cfg.probe.ocrCharsThreshold, { int: true, min: 0 })
      num('probe.subtitleBandMax', cfg.probe.subtitleBandMax, { int: true, min: 0 })
      num('probe.upscale', cfg.probe.upscale, { min: 0.1 })
    }
  }

  if (cfg.ocr !== undefined) {
    if (!isPlainObject(cfg.ocr)) errors.push('ocr 必须是对象')
    else {
      num('ocr.frameIntervalSec', cfg.ocr.frameIntervalSec, { min: 0.1 })
      num('ocr.maxFrameIntervalSec', cfg.ocr.maxFrameIntervalSec, { min: 0.1 })
      if (cfg.ocr.engine !== undefined && typeof cfg.ocr.engine !== 'string') errors.push('ocr.engine 必须是字符串')
    }
  }

  if (cfg.asr !== undefined) {
    if (!isPlainObject(cfg.asr)) errors.push('asr 必须是对象')
    else {
      if (cfg.asr.model !== undefined && typeof cfg.asr.model !== 'string') errors.push('asr.model 必须是字符串')
      if (cfg.asr.device !== undefined && typeof cfg.asr.device !== 'string') errors.push('asr.device 必须是字符串')
      if (cfg.asr.vad !== undefined && typeof cfg.asr.vad !== 'boolean') errors.push('asr.vad 必须是布尔值')
      num('asr.charsPerMinuteMin', cfg.asr.charsPerMinuteMin, { min: 0 })
    }
  }

  if (cfg.generate !== undefined) {
    if (!isPlainObject(cfg.generate)) errors.push('generate 必须是对象')
    else {
      num('generate.maxContextTokens', cfg.generate.maxContextTokens, { int: true, min: 1 })
      num('generate.materialBudgetTokens', cfg.generate.materialBudgetTokens, { int: true, min: 0 })
      num('generate.maxOutputChars', cfg.generate.maxOutputChars, { int: true, min: 1 })
      if (cfg.generate.separator !== undefined && typeof cfg.generate.separator !== 'string') {
        errors.push('generate.separator 必须是字符串')
      }
      if (cfg.generate.targetChars !== undefined) {
        const tc = cfg.generate.targetChars
        if (!isPlainObject(tc)) errors.push('generate.targetChars 必须是对象')
        else {
          num('generate.targetChars.min', tc.min, { int: true, min: 0 })
          num('generate.targetChars.max', tc.max, { int: true, min: 0 })
          num('generate.targetChars.points', tc.points, { int: true, min: 0 })
          if (typeof tc.min === 'number' && typeof tc.max === 'number' && tc.min > tc.max) {
            errors.push('generate.targetChars.min 不能大于 max')
          }
        }
      }
    }
  }

  if (cfg.reply !== undefined) {
    if (!isPlainObject(cfg.reply)) errors.push('reply 必须是对象')
    else {
      num('reply.splitOverChars', cfg.reply.splitOverChars, { int: true, min: 1 })
      num('reply.maxParts', cfg.reply.maxParts, { int: true, min: 1 })
      numArray('reply.partGapSec', cfg.reply.partGapSec, { length: 2, min: 0 })
      if (Array.isArray(cfg.reply.partGapSec) && cfg.reply.partGapSec.length === 2) {
        const [a, b] = cfg.reply.partGapSec
        if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && b < a) {
          errors.push('reply.partGapSec 的最大值不能小于最小值')
        }
      }
    }
  }

  if (cfg.limits !== undefined) {
    if (!isPlainObject(cfg.limits)) errors.push('limits 必须是对象')
    else {
      num('limits.dailyReplies', cfg.limits.dailyReplies, { int: true, min: 0 })
      num('limits.failRepliesPerDay', cfg.limits.failRepliesPerDay, { int: true, min: 0 })
      num('limits.queueMax', cfg.limits.queueMax, { int: true, min: 1 })
      num('limits.taskTimeoutMin', cfg.limits.taskTimeoutMin, { min: 1 })
      num('limits.perVideoPerDay', cfg.limits.perVideoPerDay, { int: true, min: 0 })
    }
  }

  if (cfg.risk !== undefined) {
    if (!isPlainObject(cfg.risk)) errors.push('risk 必须是对象')
    else {
      numArray('risk.backoffMinutes', cfg.risk.backoffMinutes, { min: 0 })
      num('risk.cacheTtlDays', cfg.risk.cacheTtlDays, { min: 0 })
    }
  }

  if (cfg.serve !== undefined) {
    if (!isPlainObject(cfg.serve)) errors.push('serve 必须是对象')
    else num('serve.pollSec', cfg.serve.pollSec, { min: 1 })
  }

  // 召唤指令词表（lib/config.mjs 的 DEFAULTS.routing.keywords）：只校验形状，不限制词数与词长。
  // 界面那边的「每组至少 1 个词 / 单条 ≤20 字」是输入体验，不是配置文件的硬约束。
  if (cfg.routing !== undefined) {
    if (!isPlainObject(cfg.routing)) errors.push('routing 必须是对象')
    else if (cfg.routing.keywords !== undefined) {
      if (!isPlainObject(cfg.routing.keywords)) errors.push('routing.keywords 必须是对象')
      else {
        for (const [name, list] of Object.entries(cfg.routing.keywords)) {
          if (!Array.isArray(list)) {
            errors.push(`routing.keywords.${name} 必须是字符串数组`)
            continue
          }
          list.forEach((item, i) => {
            if (typeof item !== 'string') errors.push(`routing.keywords.${name}[${i}] 必须是字符串`)
            else if (!item.trim()) errors.push(`routing.keywords.${name}[${i}] 不能是空字符串`)
          })
        }
      }
    }
  }

  return errors
}

/* ────────────────────────────── 历史 / 运行目录 ────────────────────────────── */

function readJsonl(file) {
  const textFile = readTextFile(file)
  if (!textFile.exists) return { records: [], bad: 0, exists: false, error: textFile.error ?? null }
  const records = []
  let bad = 0
  for (const line of textFile.text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isPlainObject(parsed)) records.push(parsed)
      else bad += 1
    } catch {
      bad += 1
    }
  }
  return { records, bad, exists: true, error: null }
}

function decorateHandled(record) {
  const result = typeof record.result === 'string' ? record.result : ''
  const meta = RESULT_META[result] ?? { label: result || '未知', kind: 'neutral' }
  const runId = typeof record.runId === 'string' && SAFE_RUN_ID.test(record.runId) ? record.runId : null
  let runDir = null
  let runExists = false
  let summaryExists = false
  if (runId) {
    runDir = path.join(RUNS_DIR, runId)
    try { runExists = fs.statSync(runDir).isDirectory() } catch { /* 目录不存在 */ }
    if (runExists) {
      try { summaryExists = fs.statSync(path.join(runDir, 'summary.md')).isFile() } catch { /* 没有 summary */ }
    }
  }
  return {
    ...record,
    timeLocal: localStamp(record.at),
    resultLabel: meta.label,
    resultKind: meta.kind,
    runId,
    runDir,
    runExists,
    summaryExists,
  }
}

function decorateRejected(record) {
  const reason = typeof record.reason === 'string' ? record.reason : ''
  const meta = REASON_META[reason] ?? { label: reason || '未知', kind: 'neutral' }
  return {
    ...record,
    timeLocal: localStamp(record.at),
    reasonLabel: meta.label,
    reasonKind: meta.kind,
  }
}

function buildHistory(limit) {
  const handledRead = readJsonl(HANDLED_FILE)
  const rejectedRead = readJsonl(REJECTED_FILE)
  const handledAll = handledRead.records.slice().sort(byTimeDesc)
  const rejectedAll = rejectedRead.records.slice().sort(byTimeDesc)
  // 静默记录是 handled 的子集：单独挑一份，不受 limit 影响（计数用），列表再截断
  const quietAll = handledAll.filter((record) => record.result === QUIET_RESULT)

  const today = localDateKey(new Date())
  const stats = {
    today,
    todayReplied: 0,
    totalReplied: 0,
    failed: 0,
    skipped: 0,
    totalQuiet: quietAll.length,
    totalHandled: handledAll.length,
    totalRejected: rejectedAll.length,
  }
  for (const record of handledAll) {
    if (record.result === 'replied') {
      stats.totalReplied += 1
      if (localDateKey(record.at) === today) stats.todayReplied += 1
    } else if (record.result === 'dead' || record.result === 'blocked') {
      stats.failed += 1
    } else if (String(record.result ?? '').startsWith('skipped')) {
      stats.skipped += 1
    }
  }

  return {
    ok: true,
    handled: handledAll.slice(0, limit).map(decorateHandled),
    rejected: rejectedAll.slice(0, limit).map(decorateRejected),
    quiet: quietAll.slice(0, limit).map(decorateHandled),
    stats,
    total: { handled: handledAll.length, rejected: rejectedAll.length, quiet: quietAll.length },
    limit,
    badLines: { handled: handledRead.bad, rejected: rejectedRead.bad },
    files: {
      handled: HANDLED_FILE,
      rejected: REJECTED_FILE,
      runs: RUNS_DIR,
    },
  }
}

function readRun(runId) {
  if (!SAFE_RUN_ID.test(runId)) return { error: { status: 400, message: 'runId 不合法' } }
  const dir = path.join(RUNS_DIR, runId)
  let stat = null
  try { stat = fs.statSync(dir) } catch { /* 不存在 */ }
  if (!stat || !stat.isDirectory()) return { error: { status: 404, message: '运行目录不存在' } }

  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { /* 权限问题按空目录 */ }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = fs.statSync(path.join(dir, entry.name))
      files.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() })
    } catch { /* 单个文件读不到就跳过 */ }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))

  const summaryFile = readTextFile(path.join(dir, 'summary.md'))
  const transcriptFile = readTextFile(path.join(dir, 'transcript.txt'))
  const metaFile = readTextFile(path.join(dir, 'run.json'))

  const summaryText = summaryFile.exists ? summaryFile.text : ''
  const transcriptText = transcriptFile.exists ? transcriptFile.text : ''
  let meta = null
  let metaError = null
  if (metaFile.exists) {
    try { meta = JSON.parse(metaFile.text) } catch (e) { metaError = String(e?.message ?? e) }
  }

  return {
    runId,
    path: dir,
    summary: summaryText.slice(0, SUMMARY_MAX),
    summaryChars: summaryText.length,
    summaryTruncated: summaryText.length > SUMMARY_MAX,
    transcriptHead: transcriptText.slice(0, TRANSCRIPT_HEAD_MAX),
    transcriptChars: transcriptText.length,
    transcriptTruncated: transcriptText.length > TRANSCRIPT_HEAD_MAX,
    files,
    meta,
    metaError,
  }
}

/* ────────────────────────────── HTTP 基础设施 ────────────────────────────── */

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
  res.writeHead(status, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...headers,
  })
  if (res._head) res.end()
  else res.end(buf)
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' })
}

function sendHtml(res, status, html) {
  send(res, status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  })
}

function errorPage(status, title, detail) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b1015; color: #e7eef5;
         font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 620px; padding: 36px 28px; }
  .code { color: #5eead4; font: 700 46px/1 "Cascadia Code", Consolas, monospace; }
  h1 { margin: 14px 0 8px; font-size: 22px; }
  p { margin: 0; color: #8fa1b3; }
  code { color: #38bdf8; font-family: "Cascadia Code", Consolas, monospace; }
</style>
</head>
<body><main>
  <div class="code">${status}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
</main></body>
</html>`
}

function parseCookies(header) {
  const out = {}
  for (const piece of String(header ?? '').split(';')) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const key = piece.slice(0, eq).trim()
    let value = piece.slice(eq + 1).trim()
    try { value = decodeURIComponent(value) } catch { /* 保持原样 */ }
    if (key) out[key] = value
  }
  return out
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function authenticate(req, url) {
  const queryToken = url.searchParams.get('token')
  if (queryToken && safeEqual(queryToken, TOKEN)) return { ok: true, via: 'query' }
  const headerToken = req.headers['x-token']
  if (typeof headerToken === 'string' && safeEqual(headerToken, TOKEN)) return { ok: true, via: 'header' }
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[COOKIE_NAME] && safeEqual(cookies[COOKIE_NAME], TOKEN)) return { ok: true, via: 'cookie' }
  return { ok: false }
}

function setAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
  )
}

function hostAllowed(req) {
  const raw = String(req.headers.host ?? '').toLowerCase()
  if (!raw) return false
  const hostname = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin) return true
  if (origin === 'null') return false
  try {
    const url = new URL(origin)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
    const originPort = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
    return originPort === Number(port)
  } catch {
    return false
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (status, message) => {
      if (done) return
      done = true
      reject(Object.assign(new Error(message), { status }))
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        fail(413, `请求体超过 ${(limit / 1024 / 1024).toFixed(1)}MB 上限`)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) => {
      if (done) return
      done = true
      reject(e)
    })
  })
}

function methodNotAllowed(res, allow) {
  send(res, 405, JSON.stringify({ ok: false, error: 'method_not_allowed', message: '不支持的请求方法' }), {
    'Content-Type': 'application/json; charset=utf-8',
    Allow: allow.join(', '),
  })
}

/* ────────────────────────────── 路由 ────────────────────────────── */

function serveIndex(res) {
  let html = ''
  try {
    html = fs.readFileSync(INDEX_HTML, 'utf8')
  } catch (e) {
    return sendHtml(res, 500, errorPage(500, '页面文件缺失', `读不到 web/index.html：${e?.message ?? e}`))
  }
  sendHtml(res, 200, stripBom(html))
}

async function handleSaveConfig(req, res) {
  const mime = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mime !== 'application/json') {
    return sendJson(res, 415, {
      ok: false,
      error: 'unsupported_media_type',
      message: '保存配置必须使用 Content-Type: application/json',
    })
  }
  if (!originAllowed(req, server.address()?.port)) {
    return sendJson(res, 403, {
      ok: false,
      error: 'bad_origin',
      message: '请求来源不是本机页面，已拒绝',
    })
  }

  const rawBody = await readBody(req)
  let body = null
  try {
    body = JSON.parse(stripBom(rawBody))
  } catch (e) {
    return sendJson(res, 400, {
      ok: false,
      error: 'invalid_json',
      message: `请求体不是合法 JSON：${e?.message ?? e}`,
    })
  }
  if (!isPlainObject(body)) {
    return sendJson(res, 400, { ok: false, error: 'invalid_body', message: '请求体必须是一个 JSON 对象' })
  }

  let incoming = null
  let mode = 'merge'
  if (isPlainObject(body.config)) {
    incoming = body.config
    mode = body.mode === 'replace' ? 'replace' : 'merge'
  } else if (typeof body.raw === 'string') {
    try {
      incoming = JSON.parse(stripBom(body.raw))
    } catch (e) {
      return sendJson(res, 400, {
        ok: false,
        error: 'invalid_json',
        message: `原始 JSON 不合法：${e?.message ?? e}`,
      })
    }
    mode = body.mode === 'merge' ? 'merge' : 'replace'
  } else if (body.config === undefined && body.raw === undefined) {
    // 宽容一点：直接把整个请求体当配置对象
    incoming = body
    mode = 'merge'
  } else {
    return sendJson(res, 400, {
      ok: false,
      error: 'invalid_body',
      message: '请求体需要包含 config 对象或 raw 字符串',
    })
  }

  if (!isPlainObject(incoming)) {
    return sendJson(res, 400, { ok: false, error: 'invalid_config', message: 'config 必须是 JSON 对象' })
  }

  const current = loadConfig()
  const merged = mode === 'merge' && current.config
    ? mergePreserve(current.config, incoming)
    : incoming

  const errors = validateConfig(merged)
  if (errors.length) {
    return sendJson(res, 400, {
      ok: false,
      error: 'invalid_config',
      message: '配置校验失败，未写入',
      errors,
    })
  }

  let backup = null
  if (current.exists) {
    try {
      fs.copyFileSync(CONFIG_FILE, BACKUP_FILE)
      backup = BACKUP_FILE
    } catch (e) {
      return sendJson(res, 500, {
        ok: false,
        error: 'backup_failed',
        message: `备份 config.json 失败，未写入：${e?.message ?? e}`,
      })
    }
  }

  // 写 UTF-8 无 BOM。先写临时文件再替换，避免写一半断电/被占用留下坏 JSON。
  const text = JSON.stringify(merged, null, 2) + '\n'
  const tempFile = path.join(HOME, `.config.json.tmp-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(tempFile, text, 'utf8')
    fs.renameSync(tempFile, CONFIG_FILE)
  } catch (renameError) {
    try {
      fs.writeFileSync(CONFIG_FILE, text, 'utf8')
      try { fs.unlinkSync(tempFile) } catch { /* 临时文件可能不存在 */ }
    } catch (writeError) {
      try { fs.unlinkSync(tempFile) } catch { /* 忽略 */ }
      return sendJson(res, 500, {
        ok: false,
        error: 'write_failed',
        message: `写入 config.json 失败：${writeError?.message ?? writeError}`,
      })
    }
    console.warn(`[web] 原子替换失败，已退化为直接写入：${renameError?.message ?? renameError}`)
  }

  const after = loadConfig()
  console.log(
    `[web] ${new Date().toLocaleString('zh-CN')} 已保存配置（${mode}）` +
    `${backup ? `，备份 ${path.basename(backup)}` : '，原文件不存在未备份'}`,
  )
  return sendJson(res, 200, { ok: true, ...after, backup, mode })
}

async function handler(req, res) {
  res._head = req.method === 'HEAD'
  try {
    if (!hostAllowed(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'bad_host',
        message: '只接受通过 127.0.0.1 或 localhost 访问',
      })
    }

    const url = new URL(req.url, `http://${HOST}`)
    const auth = authenticate(req, url)
    if (!auth.ok) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 403, {
          ok: false,
          error: 'unauthorized',
          message: '缺少或错误的访问令牌。请使用启动窗口里打印的带 token 的地址打开页面。',
        })
      }
      return sendHtml(res, 403, errorPage(
        403,
        '需要访问令牌',
        '这个本地服务只认启动时生成的 token。请回到启动窗口，打开那行带 ?token=... 的地址。',
      ))
    }
    if (auth.via === 'query') setAuthCookie(res)

    const method = req.method ?? 'GET'
    const isGet = method === 'GET' || method === 'HEAD'

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    if (url.pathname === '/' && isGet) return serveIndex(res)

    if (url.pathname === '/api/health' && isGet) {
      return sendJson(res, 200, {
        ok: true,
        home: HOME,
        config: CONFIG_FILE,
        runs: RUNS_DIR,
        time: new Date().toISOString(),
      })
    }

    if (url.pathname === '/api/config') {
      if (isGet) {
        return sendJson(res, 200, { ok: true, ...loadConfig(), backup: BACKUP_FILE })
      }
      if (method === 'POST') return await handleSaveConfig(req, res)
      return methodNotAllowed(res, ['GET', 'HEAD', 'POST'])
    }

    if (url.pathname === '/api/history' && isGet) {
      const rawLimit = Number(url.searchParams.get('limit') ?? 200)
      const limit = Number.isFinite(rawLimit)
        ? Math.min(2000, Math.max(1, Math.floor(rawLimit)))
        : 200
      return sendJson(res, 200, buildHistory(limit))
    }

    if (url.pathname.startsWith('/api/run/') && isGet) {
      const encodedId = url.pathname.slice('/api/run/'.length)
      let runId = ''
      try { runId = decodeURIComponent(encodedId) } catch {
        return sendJson(res, 400, { ok: false, error: 'bad_run_id', message: 'runId 编码不合法' })
      }
      if (!runId) {
        return sendJson(res, 400, { ok: false, error: 'bad_run_id', message: '缺少 runId' })
      }
      const result = readRun(runId)
      if (result.error) {
        return sendJson(res, result.error.status, {
          ok: false,
          error: 'run_not_found',
          message: result.error.message,
        })
      }
      return sendJson(res, 200, { ok: true, ...result })
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' })
    }

    if (isGet) {
      return sendHtml(res, 404, errorPage(404, '页面不存在', '这个地址没有对应的页面。'))
    }
    return methodNotAllowed(res, ['GET', 'HEAD'])
  } catch (e) {
    const status = Number(e?.status) || 500
    if (status >= 500) console.error('[web] 请求处理失败：', e)
    if (res.headersSent) {
      try { res.end() } catch { /* 已经断开 */ }
      return
    }
    return sendJson(res, status, {
      ok: false,
      error: status === 413 ? 'payload_too_large' : 'server_error',
      message: status >= 500
        ? `服务器内部错误：${e?.message ?? e}`
        : String(e?.message ?? e),
    })
  }
}

/* ────────────────────────────── 启动 ────────────────────────────── */

function usage() {
  console.log(`
bili-fish 本地 Web 控制台

  node web/server.mjs [--port 8787] [--open]

  --port <端口>   监听端口（默认 ${DEFAULT_PORT}）
  --open          启动后用默认浏览器打开带 token 的地址
  --help          显示这份帮助

只监听 ${HOST}。启动后会把带 token 的地址打印在控制台。
`)
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) {
    console.warn(`[web] 无法自动打开浏览器：${e?.message ?? e}`)
    console.warn('[web] 请手动复制上面那行带 token 的地址。')
  }
}

function parseArgs(argv) {
  let port = DEFAULT_PORT
  let open = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1]
      i += 1
      port = Number(value)
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length))
    } else if (arg === '--open') {
      open = true
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      usage()
      process.exit(2)
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`端口不合法：${port}（需要 1-65535 的整数）`)
    process.exit(2)
  }
  return { port, open }
}

const { port, open } = parseArgs(process.argv.slice(2))

try { fs.mkdirSync(HOME, { recursive: true }) } catch { /* 家目录不存在时保存会报错，启动不阻塞 */ }

const server = http.createServer((req, res) => { handler(req, res) })
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.keepAliveTimeout = 5_000

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。换一个端口：node web/server.mjs --port 8788`)
  } else {
    console.error(`启动失败：${e?.message ?? e}`)
  }
  process.exit(1)
})

server.listen(port, HOST, () => {
  const actualPort = server.address().port
  const url = `http://${HOST}:${actualPort}/?token=${TOKEN}`
  console.log('')
  console.log('═'.repeat(64))
  console.log('  bili-fish 本地控制台')
  console.log(`  配置：${CONFIG_FILE}`)
  console.log(`  历史：${HANDLED_FILE}`)
  console.log(`  运行：${RUNS_DIR}`)
  console.log('')
  console.log('  打开下面这条带 token 的地址（token 只打印这一次）：')
  console.log(`  ${url}`)
  console.log('')
  console.log('  浏览器会用 HttpOnly cookie 记住 token；之后直接访问根地址即可。')
  console.log('  按 Ctrl+C 停止。')
  console.log('═'.repeat(64))
  console.log('')
  if (open) openBrowser(url)
})

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`\n[web] 收到 ${signal}，正在停止…`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
