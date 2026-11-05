/**
 * 运行记录（过程文档持久化）
 *
 * 每次 see / summary 都落一份完整过程，放在 `~/.dsh/bili-fish/runs/<时间>-<BV>/`：
 *   see.json       本次盘点的原始结果
 *   material.json  喂给模型的素材快照（字幕/OCR/ASR 的行）
 *   prompt.txt     实际发给模型的完整 prompt
 *   summary.md     最终输出（含元数据头）
 *   run.json       结构化元数据（耗时/tokens/自检/会话）
 *
 * 同时向 `runs/index.jsonl` 追加一行摘要 —— 将来的统计页直接读这个文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'

export const RUNS_DIR = path.join(HOME, 'runs')
export const INDEX_FILE = path.join(RUNS_DIR, 'index.jsonl')

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function newRun(bvid, kind) {
  const d = new Date()
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const id = `${stamp}-${bvid}`
  const dir = path.join(RUNS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  return { id, dir, kind, bvid, startedAt: d.toISOString() }
}

export function writeArtifact(dir, name, content) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return file
}

/** 追加一条索引（一行 JSON，永不重写整个文件） */
export function appendIndex(record) {
  fs.mkdirSync(RUNS_DIR, { recursive: true })
  fs.appendFileSync(INDEX_FILE, JSON.stringify(record) + '\n')
}

/** 读全部索引（给统计用） */
export function readIndex() {
  try {
    return fs.readFileSync(INDEX_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

/** 统计：一共问了几次、按天/按素材类型分布 */
export function stats() {
  const all = readIndex()
  const byDay = {}
  const byTier = {}
  let chars = 0
  let tokens = 0
  for (const r of all) {
    const day = String(r.at ?? '').slice(0, 10)
    byDay[day] = (byDay[day] ?? 0) + 1
    byTier[r.tier ?? '?'] = (byTier[r.tier ?? '?'] ?? 0) + 1
    chars += Number(r.chars ?? 0)
    tokens += Number(r.tokens ?? 0)
  }
  return { total: all.length, byDay, byTier, chars, tokens, runs: all }
}

/**
 * 列出所有产物，**同时扫两处**：
 *   · runs/         —— 现在的布局，一次运行一个目录（summary/transcript/prompt/material/see/run 六个文件）
 *   · cache/<BV>/   —— 早期布局（runs.mjs 之前），只有 summary-*.md + prompt + material
 *
 * 为什么要扫两处：2026-11-04 中途换过布局，老产物留在 cache 下，
 * 结果"明明写过的东西找不到"（用户实测反馈）。宁可多扫一处，也别让人翻目录。
 */
export function listRuns({ bvid = null } = {}) {
  const out = []
  const cacheRoot = path.join(HOME, 'cache')

  try {
    for (const d of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = path.join(RUNS_DIR, d.name)
      const hasSummary = fs.existsSync(path.join(dir, 'summary.md'))
      const hasTranscript = fs.existsSync(path.join(dir, 'transcript.txt'))
      if (!hasSummary && !hasTranscript) continue
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) } catch { /* 无 meta */ }
      const bv = meta.bvid || d.name.split('-').pop()
      if (bvid && bv !== bvid) continue
      out.push({
        layout: 'runs',
        bvid: bv,
        at: meta.at ?? null,
        kind: hasSummary ? 'summary' : 'transcript',
        title: meta.title ?? '',
        dir,
        files: fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()),
      })
    }
  } catch { /* 没有 runs 目录 */ }

  try {
    for (const d of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = path.join(cacheRoot, d.name)
      const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
      const summaries = files.filter((f) => /^summary-.*\.md$/.test(f))
      if (!summaries.length) continue
      if (bvid && d.name !== bvid) continue
      for (const s of summaries) {
        const st = fs.statSync(path.join(dir, s))
        out.push({
          layout: 'cache(旧)',
          bvid: d.name,
          at: st.mtime.toISOString(),
          kind: 'summary',
          title: '',
          dir,
          file: path.join(dir, s),
          files,
        })
      }
    }
  } catch { /* 没有 cache 目录 */ }

  return out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
}
