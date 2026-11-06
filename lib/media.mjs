/**
 * 素材层（M0：只读盘点，不做 ASR / OCR / 抽帧）
 *
 * 输出一个 report 对象，回答 5 个问题：
 *   ① 这是什么视频（时长/清晰度/竖屏？）
 *   ② 有没有字幕
 *   ③ 有没有更便宜的"全片帧"（雪碧图）
 *   ④ 画面里有字吗（探针 → 决定走 OCR 还是 ASR）
 *   ⑤ 声音里大概有没有话（弹幕密度 + 时长，仅参考）
 */
import {
  getView, getVideoshot, getPlayurl, getSubtitleTracks, fetchSubtitleBody, getDanmakuXml, parseBvid, parsePage,
} from './bili.mjs'
import { probeSprites, decideTier } from './probe.mjs'

const fmt = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const sec = n % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

async function step(name, fn) {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { name, ok: true, ms: Date.now() - t0, value }
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e), code: e?.biliCode }
  }
}

export async function see(input, { probe = true, probeForce = false, page = null } = {}) {
  const bvid = parseBvid(input)
  if (!bvid) throw new Error('无法从输入解析 BV 号')
  const p = page ?? parsePage(input)

  const r = { bvid, page: p, steps: [], fetchedAt: new Date().toISOString() }

  const viewStep = await step('view', () => getView(bvid, { p }))
  r.steps.push(viewStep)
  if (!viewStep.ok) {
    r.verdict = { tier: 'error', why: '拿不到视频元信息，后面全都免谈' }
    return r
  }
  const v = viewStep.value
  r.video = v
  r.vertical = v.height > v.width || v.isStory
  r.multiPart = (v.pageCount ?? 1) > 1

  r.steps.push(await step('danmaku', () => getDanmakuXml(v.cid)))
  r.steps.push(await step('playurl', () => getPlayurl(bvid, v.cid)))
  r.steps.push(await step('subtitle', () => getSubtitleTracks(bvid, v.cid)))

  const subStep = r.steps.find((s) => s.name === 'subtitle')
  const tracks = subStep?.ok ? subStep.value.tracks : []
  if (tracks.length) {
    // 拿到轨道就立刻下载（auth_key 分钟级过期）
    const pick = tracks.find((t) => t.lan === 'zh-CN') || tracks.find((t) => /^zh/.test(t.lan)) || tracks[0]
    r.steps.push(await step('subtitle-body', () => fetchSubtitleBody(pick.url, bvid)))
  }

  const subBodyStep = r.steps.find((s) => s.name === 'subtitle-body')
  const subBody = subBodyStep?.ok ? subBodyStep.value : null
  r.subtitle = tracks.length
    ? { tracks: tracks.length, manual: tracks.filter((t) => !t.ai).length, ai: tracks.filter((t) => t.ai).length, lines: subBody?.length ?? 0 }
    : { tracks: 0 }

  // ① 有字幕就直接 L0 —— 不必再花 7.5MB 和几秒跑探针（实测 75% 的视频有 AI 字幕）
  if (subBody?.length) {
    r.verdict = {
      tier: 'subtitle',
      why: `有 ${tracks.length} 轨字幕（${tracks.filter((t) => t.ai).length ? 'AI' : '人工'}），正文 ${subBody.length} 行，覆盖 ${fmt(subBody[0]?.from ?? 0)} → ${fmt(subBody.at(-1)?.to ?? 0)} → 直接 L0`,
    }
    if (!probeForce) return r
  } else if (tracks.length && !subBody) {
    r.verdict = { tier: 'asr', why: '有字幕轨但正文下载失败（auth_key 可能过期）→ 退 ASR' }
    if (!probeForce) return r
  }

  const shotStep = await step('videoshot', () => getVideoshot(v.aid, v.cid))
  r.steps.push(shotStep)

  const dm = r.steps.find((s) => s.name === 'danmaku')
  r.danmaku = dm?.ok
    ? { count: dm.value.items.length, rawBytes: dm.value.rawBytes, claimed: v.stat?.danmaku ?? null }
    : { error: dm?.error }

  const pu = r.steps.find((s) => s.name === 'playurl')
  r.playurl = pu?.ok ? pu.value : { error: pu?.error }

  // 竖屏：雪碧图探针无效（有效宽度只有 1/4），但**抽帧 OCR 照样能用**。
  //
  // 2026-11-06 改：原来这里判 `asr`，而 ASR 还没实现（M4）——于是每条竖屏无字幕的视频
  // 都必然失败。实测三条（BV1QjuQ6REcS / BV1gqJ26AEJs / BV1isxQ6MEHH）全部栽在这，
  // 而强制 OCR 跑同一条视频能拿到 115 段真内容。竖屏内容又多是图文/截图卡，正文本来就在画面里。
  // 所以改成：竖屏无字幕 → 直接抽帧 OCR。
  if (r.vertical) {
    r.probe = { skipped: true, why: `竖屏 ${v.width}x${v.height}：雪碧图探针无效（有效宽度约 1/4），直接走抽帧 OCR` }
    r.verdict = { tier: 'ocr', why: '竖屏 → 跳过雪碧图探针，直接抽帧 OCR（正文通常就在画面里）' }
    return r
  }
  if (!shotStep.ok) {
    r.probe = { skipped: true, why: '拿不到雪碧图：' + shotStep.error }
    r.verdict = { tier: 'ocr', why: '无探针可依据 → 按设计定稿的保底规则默认 OCR' }
    return r
  }

  const shot = shotStep.value
  const totalFrames = Math.max(0, shot.times.length - 1) || shot.images.length * shot.cols * shot.rows
  r.videoshot = {
    sheets: shot.images.length, totalFrames, cell: `${shot.cellW}x${shot.cellH}`,
    grid: `${shot.cols}x${shot.rows}`,
    spanSec: shot.times.length > 1 ? shot.times[shot.times.length - 1] : null,
    intervalSec: totalFrames > 1 && shot.times.length > 1 ? Math.round(shot.times[shot.times.length - 1] / (totalFrames - 1)) : null,
  }

  if (probe) {
    const p = await step('probe', () => probeSprites({ bvid, shot, totalFrames }))
    r.steps.push(p)
    if (p.ok) {
      r.probe = { avg: p.value.avg, charsPerFrame: p.value.charsPerFrame, perFrameMs: p.value.perFrameMs, bytes: p.value.bytes, texts: p.value.texts }
      r.verdict = decideTier(p.value)
    } else {
      r.probe = { skipped: true, why: p.error }
      r.verdict = { tier: 'ocr', why: '探针失败 → 保底默认 OCR' }
    }
  }

  return r
}

export function renderReport(r) {
  const L = []
  const v = r.video
  L.push('')
  L.push(`BV ${r.bvid}`)
  if (v) {
    L.push(`  标题   ${v.title}`)
    L.push(`  UP     ${v.owner}（mid ${v.ownerMid}）`)
    L.push(`  时长   ${fmt(v.duration)}   ${v.width}x${v.height}${r.vertical ? '  ⚠ 竖屏' : ''}`)
    if (r.multiPart) {
      L.push(`  ⚠ 分P   共 ${v.pageCount} 个分P，本工具只处理第 ${v.pageIndex} P（${fmt(v.totalDuration)} 里的 ${fmt(v.duration)}）`)
      if (v.pageTitle) L.push(`         第 ${v.pageIndex} P：${v.pageTitle}　（要换一 P：加 --p N 或在链接里带 ?p=N）`)
    }
    L.push(`  分区   tid=${v.tid}  tname=${JSON.stringify(v.tname)}${v.tname ? '' : '  ← 实测常为空，不可用于筛选'}`)
    L.push(`  互动   播放 ${v.stat?.view ?? '?'} · 弹幕 ${v.stat?.danmaku ?? '?'} · 评论 ${v.stat?.reply ?? '?'}`)
  }
  L.push('')
  for (const s of r.steps) {
    if (['view'].includes(s.name)) continue
    const okk = s.ok ? '✓' : '✗'
    let detail = ''
    if (s.ok) {
      if (s.name === 'danmaku') detail = `${s.value.items.length} 条（标称 ${v?.stat?.danmaku ?? '?'}）${s.value.rawBytes} B 原始`
      else if (s.name === 'playurl') detail = `quality=${s.value.quality} · durl ${s.value.durl ? (s.value.durl.size / 1048576).toFixed(1) + ' MB' : '无'}`
      else if (s.name === 'subtitle') detail = `${s.value.tracks.length} 轨 · ai_status=${s.value.aiStatus ?? '-'}`
      else if (s.name === 'subtitle-body') detail = `${s.value.length} 行，覆盖 ${fmt(s.value[0]?.from ?? 0)} → ${fmt(s.value.at(-1)?.to ?? 0)}`
      else if (s.name === 'videoshot') detail = `${s.value.images.length} 张/${s.value.cols * s.value.rows} 格 · ${s.value.cellW}x${s.value.cellH}`
      else if (s.name === 'probe') detail = `平均 ${s.value.avg} 字/帧 · ${s.value.perFrameMs} ms/帧`
    } else detail = s.error
    L.push(`  ${okk} ${s.name.padEnd(14)} ${s.ms}ms  ${detail}`)
  }
  L.push('')
  if (r.videoshot) {
    L.push(`  雪碧图  ${r.videoshot.sheets} 张 · 共 ${r.videoshot.totalFrames} 帧 · 覆盖 ${fmt(r.videoshot.spanSec)} · 约 ${r.videoshot.intervalSec}s/帧`)
  }
  if (r.probe && !r.probe.skipped) {
    L.push(`  探针    每帧字数 ${JSON.stringify(r.probe.charsPerFrame)} → 平均 ${r.probe.avg}（${(r.probe.bytes / 1048576).toFixed(1)} MB）`)
    for (const t of r.probe.texts || []) if (t) L.push(`          · ${t.slice(0, 60)}`)
  } else if (r.probe?.skipped) {
    L.push(`  探针    跳过：${r.probe.why}`)
  }
  if (r.verdict) {
    L.push('')
    L.push(`  ▶ 判定   ${r.verdict.tier.toUpperCase()}   ${r.verdict.why}`)
  }
  L.push('')
  return L.join('\n')
}
