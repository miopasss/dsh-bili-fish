/**
 * ASR 层：没有字幕、画面也没字时，转音频再转写（M4）
 *
 * 分工和 OCR 那条腿一致：
 *   Node 负责「拿到干净的音频文件」，Python（`python/asr.py`）负责「听出什么字」。
 *
 * 两条纪律：
 *   · **只要音轨**（DASH `fnval=16`），不下整片 —— 90 秒视频约 1-2MB
 *   · 模型首次使用会自动下载，所以第一次跑会慢；之后走本地缓存
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config } from './config.mjs'
import { cacheDir, pkgRoot } from './paths.mjs'
import { getAudioStream } from './bili.mjs'
import { joinWrapped } from './ocr.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 音频容器后缀：B 站音轨通常是 m4a；mime 不认就按 m4a 存 */
function extOf(mime) {
  if (!mime) return 'm4a'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('webm')) return 'webm'
  return 'm4a'
}

/** 下载音轨（带缓存：同一个 cid 只下一次） */
export async function downloadAudio({ bvid, cid, maxMB = 200 }) {
  const stream = await getAudioStream(bvid, cid)
  if (!stream) throw new Error('拿不到音轨（可能是登录态失效，或该稿件没有 DASH 音频）')

  const outDir = cacheDir(bvid, 'asr')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `audio-${cid}.${extOf(stream.mime)}`)

  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    return { file, sizeMB: fs.statSync(file).size / 1048576, cached: true }
  }
  const sizeMB = (stream.size || 0) / 1048576
  if (sizeMB > maxMB) throw new Error(`音轨 ${sizeMB.toFixed(0)}MB 超过上限 ${maxMB}MB`)

  const { pipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')

  const tryOnce = async (url) => {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(600_000),
    })
    if (!res.ok) throw new Error(`下载音轨失败 HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
  }

  try {
    await tryOnce(stream.url)
  } catch (e) {
    if (!stream.backup) throw e
    await tryOnce(stream.backup)
  }
  return { file, sizeMB: fs.statSync(file).size / 1048576, cached: false }
}

/** 调 python/asr.py */
export function transcribe({ audio, model, device, vad, language = null, timeoutMs = 1_800_000 }) {
  const py = process.env.BILI_FISH_PYTHON || 'python'
  const script = path.join(pkgRoot, 'python', 'asr.py')
  return new Promise((resolve, reject) => {
    const child = execFile(
      py, [script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // 首次跑模型会往 stderr 打下载进度，所以"有 stdout"时优先解析 stdout
        if (error && !stdout) {
          return reject(new Error('asr.py 失败：' + String(stderr || error.message).slice(0, 400)))
        }
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').pop())
          if (j.error) return reject(new Error(j.error))
          resolve(j)
        } catch {
          reject(new Error('asr.py 输出无法解析：' + String(stdout).slice(0, 200)))
        }
      },
    )
    child.stdin.end(JSON.stringify({ audio, model, device, vad, language }))
  })
}

/** 去掉 ASR 常见的口水词与重复标点 */
export function cleanAsrText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[，。、；：\s]+/, '')
    .replace(/([，。、；：])\1+/g, '$1')
    .trim()
}

/**
 * 整条腿：下载音轨 → 转写 → 归一成和 OCR 一样的 `{t, c}` 时间轴
 *
 * @returns {{raw:Array<{t:number,c:string}>, lines:Array, language:string|null,
 *            model:string, audioMB:number, elapsedMs:number, cached:boolean}}
 */
export async function asrVideo({ bvid, cid, duration }) {
  const cfg = config()
  const a = cfg.asr || {}
  const audio = await downloadAudio({ bvid, cid })

  const out = await transcribe({
    audio: audio.file,
    model: String(a.model || 'small'),
    device: String(a.device || 'cpu'),
    vad: a.vad !== false,
  })

  const raw = (out.segments || [])
    .map((s) => ({ t: Number(s.t) || 0, c: cleanAsrText(s.c) }))
    .filter((s) => s.c)

  // 合并被切碎的同句（whisper 常把一句话拆成两段）
  // ⚠️ joinWrapped 的入参是 `{t, text}`（OCR 那边的形状），这里转一次再转回来
  const lines = joinWrapped(raw.map((r) => ({ t: r.t, text: r.c })), { maxLen: 400 })
    .map((r) => ({ t: r.t, c: r.text }))

  // 语速体检：过低的字/分钟通常意味着"听见了但没听清"，宁可如实说读不了
  const minutes = Math.max(1 / 60, (Number(duration) || out.durationSec || 0) / 60)
  const charsPerMinute = Math.round(
    lines.reduce((n, l) => n + l.c.length, 0) / minutes,
  )
  const minCpm = Number(a.charsPerMinuteMin) || 30
  if (lines.length && charsPerMinute < minCpm) {
    throw new Error(
      `转写结果太稀（${charsPerMinute} 字/分钟 < 下限 ${minCpm}），可能没人声或音质太差`,
    )
  }

  return {
    raw,
    lines,
    language: out.language ?? null,
    model: out.model || a.model,
    audioMB: Math.round(audio.sizeMB * 10) / 10,
    elapsedMs: out.elapsedMs || 0,
    cached: audio.cached,
    charsPerMinute,
  }
}
