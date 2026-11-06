import fs from 'node:fs'
import path from 'node:path'
import { HOME, CONFIG_FILE, CREDS_FILE } from './paths.mjs'

/**
 * B 站单条评论硬限（字符）。
 *
 * 这是**平台约束**，不是写作目标：正文超过它就拆成多条发，
 * 不因此打回重写（2026-11-06 改）。compose 的自检和 reply 的拆分共用这一个值。
 */
export const BILI_REPLY_LIMIT = 1000

/** 与《设计定稿》§9 参数表一一对应 */
export const DEFAULTS = {
  whitelist: [],
  owner: { mid: '', nickname: '' },
  probe: { samples: 5, ocrCharsThreshold: 60, subtitleBandMax: 60, upscale: 2 },
  ocr: { frameIntervalSec: 5, maxFrameIntervalSec: 8, engine: 'rapidocr' },
  asr: { model: 'small', device: 'cpu', vad: true, charsPerMinuteMin: 30, ocrFallbackMinChars: 80 },
  generate: {
    maxContextTokens: 100000,
    materialBudgetTokens: 20000,
    separator: 'blank',
    // 字数/分点目标已删除（2026-11-06）：prompt 不再限制篇幅，长文由回复层拆分
  },
  /** 一条正文拆成多条时，两条之间的间隔（秒，随机取区间） */
  reply: { partGapSec: [10, 20] },
  /**
   * 召唤指令：从 @ 正文里解析关键词，强制改变处理方式（2026-11-06）
   *
   * 词表刻意都用 ≥3 字的词组 —— 单字/双字词（"字幕""看图""总结""归档"）
   * 太容易在正常叙述里误撞，已经砍掉。
   * 长词优先匹配（"总结加看法" 先于 "只总结"），同级冲突取最后出现的。
   */
  routing: {
    /** 剃掉 @ 和关键词后，剩余正文达到这么多字才作为【提问者的话】传给模型（2026-11-06） */
    askMinChars: 15,
    keywords: {
      // 2026-11-06 收词：每组只留**一个**词，用学习成本换精确性。
      // 同义词（强制字幕/文字稿/看画面/只总结/你怎么看…）全部删掉——
      // 词表越短越不容易误撞（"文字稿"是日常词，"你怎么看"是高频口语）。
      forceSubtitle: ['用字幕'],
      forceOcr: ['用OCR'],
      forceAsr: ['用ASR'],
      archive: ['只拉文字版'],
      summaryOnly: ['只要总结'],
      viewOnly: ['说说看法'],
      both: ['总结加看法'],
      /** 静默：只写本地/网页历史，不在评论区回复（失败也不回） */
      quiet: ['悄悄'],
    },
  },
  limits: { dailyReplies: 20, failRepliesPerDay: 3, queueMax: 5, taskTimeoutMin: 15 },
  risk: { backoffMinutes: [5, 10, 20, 30], cacheTtlDays: 7 },
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/**
 * 读 JSON 文件，**容忍 UTF-8 BOM**。
 * 为什么：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，Windows 记事本另存也会。
 * 带 BOM 时 `JSON.parse` 直接抛错 —— 如果不处理，用户改过的配置会静默失效、回落成默认值
 * （2026-11-04 实测踩到）。
 */
function readJsonFile(file) {
  let raw = fs.readFileSync(file, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  return JSON.parse(raw)
}

let cached = null
export function config(reload = false) {
  if (cached && !reload) return cached
  let raw = {}
  try { raw = readJsonFile(CONFIG_FILE) } catch { /* 没有或坏了就用默认值 */ }
  cached = deepMerge(DEFAULTS, raw)
  return cached
}

/** 配置读取状态（给 doctor / 排障用；不暴露内容） */
export function configStatus() {
  try {
    return { ok: true, keys: Object.keys(readJsonFile(CONFIG_FILE)).length, file: CONFIG_FILE }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), file: CONFIG_FILE }
  }
}

/** 凭证：只读 SESSDATA / bili_jct / buvid3，永不回显、永不进日志 */
export function creds() {
  try {
    const j = readJsonFile(CREDS_FILE)
    return {
      sessdata: String(j.sessdata ?? j.SESSDATA ?? ''),
      bili_jct: String(j.bili_jct ?? j.biliJct ?? ''),
      buvid3: String(j.buvid3 ?? ''),
    }
  } catch {
    return { sessdata: '', bili_jct: '', buvid3: '' }
  }
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true })
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n')
  }
  return path.dirname(CONFIG_FILE)
}
