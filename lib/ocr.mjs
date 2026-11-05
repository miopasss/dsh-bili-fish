/**
 * OCR 层（M5-lite）：下载 1080P → 抽帧 → 批量 OCR → 行级去重 → 同构时间轴
 *
 * 关键取舍（都来自实测）：
 *   · 抽帧密度 5s/帧就够 —— 文字屏是**慢速滚动/翻页**，5 秒的重叠非常充分
 *   · 雪碧图（480×270）不行：行高 8px，读不出正文。必须自己抽 1080P
 *   · 去重不用像素拼接：滚动是单调的，文本出现顺序就是阅读顺序，**行级前缀对齐**即可
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { config } from './config.mjs'
import { cacheDir, pkgRoot } from './paths.mjs'
import { getPlayurl } from './bili.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function ffmpegPath() {
  return process.env.BILI_FISH_FFMPEG || 'ffmpeg'
}

/* ───────────────── ① 下载 ───────────────── */

async function fetchRange(url, range, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Range: range },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res
}

/** PCDN 节点会假死：先用 1KB Range 探活，再决定要不要整段下 */
async function probeUrl(url) {
  try {
    const r = await fetchRange(url, 'bytes=0-1023', 8000)
    return r.ok || r.status === 206
  } catch {
    return false
  }
}

export async function downloadVideo({ bvid, cid, outDir, maxMB = 300 }) {
  const pu = await getPlayurl(bvid, cid)
  if (!pu?.durl?.url) throw new Error('拿不到播放直链（可能需要登录或只有 dash 流）')
  const sizeMB = (pu.durl.size || 0) / 1048576
  if (sizeMB > maxMB) throw new Error(`视频 ${sizeMB.toFixed(0)}MB 超过上限 ${maxMB}MB，拒绝下载`)

  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${bvid}.mp4`)
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    return { file, sizeMB: fs.statSync(file).size / 1048576, quality: pu.quality, cached: true }
  }

  // 探活失败就重新取一次 playurl（能换节点）
  let url = pu.durl.url
  if (!(await probeUrl(url))) {
    const pu2 = await getPlayurl(bvid, cid)
    if (pu2?.durl?.url && (await probeUrl(pu2.durl.url))) url = pu2.durl.url
    else throw new Error('所有 PCDN 节点都不可用（探活超时）')
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(600_000),
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const { pipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
  return { file, sizeMB: fs.statSync(file).size / 1048576, quality: pu.quality, cached: false }
}

/* ───────────────── ② 抽帧 ───────────────── */

export function extractFrames({ mp4, outDir, intervalSec = 5, maxFrames = 900 }) {
  fs.mkdirSync(outDir, { recursive: true })
  const existing = fs.readdirSync(outDir).filter((f) => /^f\d+\.jpg$/.test(f))
  if (existing.length) {
    return Promise.resolve(
      existing.sort().map((f, i) => ({ path: path.join(outDir, f), t: i * intervalSec })),
    )
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', mp4,
      '-vf', `fps=1/${intervalSec}`,
      '-frames:v', String(maxFrames),
      '-q:v', '3',
      '-start_number', '0',
      path.join(outDir, `f%05d_t%{}.jpg`),
    ]
    // ffmpeg 不支持在文件名里写时间，所以先按序号出图，再自己算时间
    args[args.length - 1] = path.join(outDir, 'f%05d.jpg')
    const child = spawn(ffmpegPath(), args, { shell: false, windowsHide: true })
    let err = ''
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (e) => reject(new Error('起不来 ffmpeg：' + e.message)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 抽帧失败 code=${code}：${err.slice(0, 300)}`))
      const files = fs.readdirSync(outDir).filter((f) => /^f\d+\.jpg$/.test(f)).sort()
      resolve(files.map((f, i) => ({ path: path.join(outDir, f), t: i * intervalSec })))
    })
  })
}

/* ───────────────── ③ 批量 OCR ───────────────── */

export function ocrFrames(frames, { timeoutMs = 900_000 } = {}) {
  const py = process.env.BILI_FISH_PYTHON || 'python'
  const script = path.join(pkgRoot, 'python', 'ocr.py')
  return new Promise((resolve, reject) => {
    const child = execFile(
      py, [script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) return reject(new Error('ocr.py 失败：' + String(stderr || error.message).slice(0, 300)))
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').pop())
          if (j.error) return reject(new Error(j.error))
          resolve(j)
        } catch {
          reject(new Error('ocr.py 输出无法解析：' + String(stdout).slice(0, 200)))
        }
      },
    )
    child.stdin.end(JSON.stringify({ frames, minScore: 0.5 }))
  })
}

/* ───────────────── ④ 行级去重 ───────────────── */

const norm = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

function sim(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.9
  // 二元组 Dice
  const big = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i += 1) {
      const k = s.slice(i, i + 2)
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }
  const A = big(x)
  const B = big(y)
  let inter = 0
  let tot = 0
  for (const [k, v] of A) { tot += v; if (B.has(k)) inter += Math.min(v, B.get(k)) }
  for (const v of B.values()) tot += v
  return tot ? (2 * inter) / tot : 0
}

/**
 * 相邻帧对齐：找"上一段的尾巴"和"这一段的头"的最长重合，把重合部分丢掉。
 * 这样滚动/翻页产生的重复行不会进正文。
 */
export function dedupeFrames(frameResults, { simThreshold = 0.75 } = {}) {
  const out = []
  for (const fr of frameResults) {
    const lines = (fr.lines || []).filter((l) => norm(l).length >= 2)
    if (!lines.length) continue
    let best = 0
    const maxK = Math.min(out.length, lines.length)
    for (let k = 1; k <= maxK; k += 1) {
      let ok = true
      for (let i = 0; i < k; i += 1) {
        if (sim(out[out.length - k + i].text, lines[i]) < simThreshold) { ok = false; break }
      }
      if (ok) best = k
    }
    for (let i = best; i < lines.length; i += 1) out.push({ t: Number(fr.t) || 0, text: lines[i] })
  }
  return out
}

/**
 * 同一帧内被换行切断的句子拼回去。
 * 判据：上一行没有句末标点、且够长（≥6 字），才把下一行接上——避免把并列条目也粘一起。
 */
const SENT_END = /[。！？；：!?;:…」』"”）)]$/
export function joinWrapped(lines, { maxLen = 400 } = {}) {
  const out = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    const joinable =
      prev &&
      prev.t === l.t &&
      !SENT_END.test(prev.text) &&
      norm(prev.text).length >= 6 &&
      prev.text.length + l.text.length <= maxLen
    if (joinable) prev.text += l.text
    else out.push({ t: l.t, text: l.text })
  }
  return out
}

/**
 * OCR 噪声行：屏幕上的界面元素被当成正文读进来了。
 * 实测来源（知乎截图类视频）：`509人听过`、`6243人赞同了该回答>`、`广口`、`_口`
 *
 * 只丢**明确是界面/碎片**的行，保守为上 —— 宁可留噪声，也别误删正文。
 */
const NOISE_PATTERNS = [
  /^[\s\d,.]+人\s*(赞同|听过|看过|正在看|在看|收藏|喜欢|关注|评论|浏览|阅读|粉丝)/, // 6243人赞同了该回答
  /^\s*[>＞»▸▶]+\s*$/, // 单独的光标/箭头
  /^[_\-—=~·.。,，、|\\/<>《》「」]+$/, // 纯符号
  /^(关注|点赞|收藏|投币|转发|分享|评论|弹幕|举报)\s*\d*$/, // 纯按钮文字
  /^\d{1,3}$/, // 单行的纯数字（弹幕数/页码）
]

export function isNoiseLine(text) {
  const t = String(text || '').trim()
  if (!t) return true
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  if (t.replace(/[^\p{L}\p{N}]/gu, '').length === 0) return true // 全是符号
  if (t.length <= 1) return true // 单字碎片
  if (t.length <= 2 && cjk === 0) return true // 两个字符且没中文（"_口" 有中文，保留）
  return NOISE_PATTERNS.some((re) => re.test(t))
}

/** 过滤噪声行；不改动入参 */
export function denoise(lines) {
  return lines.filter((l) => !isNoiseLine(l.text))
}

/* ───────────────── ⑤ 一条龙 ───────────────── */

export async function ocrVideo({ bvid, cid, duration }) {
  const cfg = config()
  let interval = Number(cfg.ocr.frameIntervalSec) || 5
  // 长视频放宽密度，保住时间预算
  if (Number(duration) > 3600) interval = Math.max(interval, Number(cfg.ocr.maxFrameIntervalSec) || 8)

  const dir = cacheDir(bvid, 'ocr')
  const dl = await downloadVideo({ bvid, cid, outDir: path.join(dir, 'video') })
  const frames = await extractFrames({ mp4: dl.file, outDir: path.join(dir, 'frames'), intervalSec: interval })
  if (!frames.length) throw new Error('抽帧结果为空（ffmpeg 没出图）')
  const { frames: ocrFramesData, perFrameMs } = await ocrFrames(frames)
  const deduped = denoise(dedupeFrames(ocrFramesData))
  const merged = joinWrapped(deduped)
  return {
    intervalSec: interval,
    frameCount: frames.length,
    perFrameMs,
    downloadedMB: Math.round(dl.sizeMB * 10) / 10,
    quality: dl.quality,
    /** 原文：去重 + 去噪后的逐行，未做断行拼接 */
    raw: deduped.map((l) => ({ from: l.t, to: l.t + interval, content: l.text })),
    /** 喂模型用：断行已拼回段落 */
    lines: merged.map((l) => ({ from: l.t, to: l.t + interval, content: l.text })),
    rawFrames: ocrFramesData.length,
    /** 去噪前/后的行数，便于观察过滤强度 */
    beforeDenoise: ocrFramesData.reduce((n, f) => n + (f.lines?.length ?? 0), 0),
    afterDenoise: deduped.length,
  }
}
