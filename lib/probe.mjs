/**
 * 雪碧图探针：下载雪碧图 → 逐帧 OCR → 数「平均每帧多少字」
 *
 * 这是第五级阶梯里最关键的一环：花 7.5MB 换「少跑一次 2-5 分钟的 ASR」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config } from './config.mjs'
import { cacheDir, probeScript } from './paths.mjs'

function runPython(payload, timeoutMs = 300000) {
  const py = process.env.BILI_FISH_PYTHON || 'python'
  return new Promise((resolve, reject) => {
    const child = execFile(
      py,
      [probeScript],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`probe.py 失败：${String(stderr || err.message).slice(0, 300)}`))
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').pop())
          if (j.error) return reject(new Error(j.error))
          resolve(j)
        } catch {
          reject(new Error(`probe.py 输出无法解析：${String(stdout).slice(0, 200)}`))
        }
      },
    )
    child.stdin.end(JSON.stringify(payload))
  })
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`下载雪碧图失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
  return dest
}

/**
 * @param {{bvid:string, shot:{cols:number,rows:number,images:string[],times:number[]}, totalFrames:number}} p
 * @returns {Promise<{avg:number, charsPerFrame:number[], perFrameMs:number, spriteCount:number, bytes:number}>}
 */
export async function probeSprites({ bvid, shot, totalFrames }) {
  const cfg = config()
  const samples = Math.max(1, Number(cfg.probe.samples) || 3)
  // 探针只需要前 1-2 张图（够取样了），不必为探针下全片
  const need = Math.min(shot.images.length, Math.max(1, Math.ceil(samples / (shot.cols * shot.rows)) + 1))
  const picked = shot.images.slice(0, need)

  const dir = cacheDir(bvid, 'sprite')
  let bytes = 0
  const sprites = []
  for (let i = 0; i < picked.length; i += 1) {
    const file = path.join(dir, `${bvid}-${String(i + 1).padStart(4, '0')}.jpg`)
    await download(picked[i], file)
    bytes += fs.statSync(file).size
    sprites.push({ path: file, cols: shot.cols, rows: shot.rows })
  }

  const out = await runPython({ sprites, totalFrames, samples, upscale: cfg.probe.upscale })
  return { ...out, spriteCount: sprites.length, bytes }
}

/**
 * 探针结果 → 决策（《设计定稿》§3.2）
 *
 * ⚠️ 2026-11-04 改：原来用「平均字/帧」判，实测会抖——
 *    同一条知乎截图视频，抽到文字帧时平均 168（判 OCR），
 *    抽到含图像帧的 3 帧时平均 48（误判 ASR），重新生成就换了条腿。
 *
 * 现在改成**看比例**：抽 N 帧里有多少帧"字很多"（≥ ocrCharsThreshold）。
 * 比例够高就说明这条视频主要靠画面文字，不该被单个图像帧拉低。
 */
export function decideTier(probe, cfg = config()) {
  const chars = Array.isArray(probe?.charsPerFrame) ? probe.charsPerFrame.map(Number) : []
  const avg = Number(probe?.avg ?? 0)
  const hi = Number(cfg.probe.ocrCharsThreshold) || 60
  const strong = chars.filter((c) => c >= hi).length
  const ratio = chars.length ? strong / chars.length : 0
  const strongRatio = Math.round(ratio * 100)

  if (ratio >= 0.4) {
    return {
      tier: 'ocr',
      why: `${chars.length} 帧里 ${strong} 帧字很多（${strongRatio}% ≥ ${hi}）→ 文字屏，OCR 是主粮`,
      strongRatio,
    }
  }
  if (avg >= 5) {
    return {
      tier: 'asr',
      why: `只有 ${strong}/${chars.length} 帧字多（${strongRatio}%），平均 ${avg} 字/帧 → 有字幕/标题，ASR 更划算`,
      strongRatio,
    }
  }
  return { tier: 'asr', why: `${avg} 字/帧 < 5、${strongRatio}% 帧有字 → 画面无字，走 ASR`, strongRatio }
}
