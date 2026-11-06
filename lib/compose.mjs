/**
 * 生成层：prompt → 自检
 *
 * 2026-11-06 改：prompt 砍到「视频 / 文字稿 / 目标」三块，
 * **不写体裁、不写字数、不规定两段式、不列禁用词** —— 用户原话是"限制太死"。
 * 相应地，自检也不再因为"没分两段 / 字数不达标 / 复读标题"而打回重写；
 * 超过 B 站单条硬限只作为「需要拆分」的信号，交给回复层拆成多条。
 */
import { BILI_REPLY_LIMIT, config } from './config.mjs'
import { TARGET_BY_MODE } from './routing.mjs'

export const fmt = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const sec = n % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/* ───────────────────────── ① 体裁 ───────────────────────── */

const MUSIC = /音乐|歌曲|翻唱|纯音乐|MV|演奏|钢琴|吉他|BGM|歌|旋律|原声/i
const TEACH = /教学|教程|讲解|课程|入门|详解|原理|分析|复习|考研|备考|科普|教你|从零|手把手|总结|攻略|面试|笔记|为什么|揭秘|真相|解读|全集|精讲|讲座|公开课|习题|真题|第[一二三四五六七八九十\d]{1,3}讲|有必要.{0,12}吗|该不该|是不是|如何看待|凭什么|有必要吗/i

export function detectStyle(video) {
  const t = String(video.title || '')
  if (MUSIC.test(t)) return { key: 'music', label: '音乐 / 情绪类' }
  if (TEACH.test(t)) return { key: 'teaching', label: '知识 / 观点类' }
  return { key: 'talk', label: '杂谈 / 叙事类' }
}

/* ───────────────────────── ② 素材 → 同构文本 ───────────────────────── */

/** 三种来源（字幕 / ASR / OCR）都产出这一种格式 */
export function toTimedText(lines) {
  return (lines || [])
    .map((l) => ({ t: Number(l.from ?? l.t ?? 0), c: String(l.content ?? l.text ?? '').trim() }))
    .filter((l) => l.c)
    .sort((a, b) => a.t - b.t)
}

const SENT_END = /[。！？；：!?;:…」』"”）)]$/

/**
 * 把**逐句字幕**拼回段落 —— 只用于「喂给模型」的版本。
 *
 * 字幕是按语音停顿切句的，一句话常被切成两三行，直接给模型是碎片。
 * 规则：上一行没有句末标点、与下一行间隔 ≤ maxGapSec、拼起来不超过 maxLen → 接上。
 * 时间锚点保留**这一段的起始时间**。
 *
 * ⚠️ 原文（逐句）必须另外保留，不能只存拼过的版本。
 */
export function mergeSentences(timed, { maxGapSec = 2, maxLen = 120 } = {}) {
  const out = []
  for (const l of timed) {
    const p = out[out.length - 1]
    const joinable =
      p &&
      l.t - p.endT <= maxGapSec &&
      !SENT_END.test(p.content) &&
      p.content.length + l.c.length <= maxLen
    if (joinable) {
      p.content += l.c
      p.endT = l.t
    } else {
      out.push({ t: l.t, endT: l.t, content: l.c })
    }
  }
  return out.map(({ t, content }) => ({ t, c: content }))
}

/**
 * 按字数预算裁素材。
 *
 * 2026-11-04 改：从"全篇等间隔抽样"改成**保头保尾 + 中段整段丢弃**。
 * 为什么：等间隔抽会把一句话拆成两截再拼上，模型读着跳；而首尾恰恰最重要
 * （开场定调、结尾结论）。现在留「前 60% 预算 + 后 30% 预算」，中段整段省略并标出缺口位置。
 *
 * @returns {{lines:Array, truncated:boolean, totalChars:number, skipped:Array, gapAt:number|null}}
 */
export function fitMaterial(timed, budgetChars = 12000, { headRatio = 0.6, tailRatio = 0.3 } = {}) {
  const total = timed.reduce((n, l) => n + l.c.length, 0)
  if (total <= budgetChars) return { lines: timed, truncated: false, totalChars: total, skipped: [], gapAt: null }

  const n = timed.length
  const headBudget = budgetChars * headRatio
  const tailBudget = budgetChars * tailRatio

  let headEnd = 0
  let hc = 0
  while (headEnd < n && hc + timed[headEnd].c.length <= headBudget) { hc += timed[headEnd].c.length; headEnd += 1 }

  let tailStart = n
  let tc = 0
  while (tailStart > headEnd && tc + timed[tailStart - 1].c.length <= tailBudget) { tc += timed[tailStart - 1].c.length; tailStart -= 1 }

  // 极端情况：预算小到连头都放不下 → 至少留前 20 行，别返回空
  if (headEnd === 0) headEnd = Math.min(n, 20)
  if (tailStart < headEnd) tailStart = headEnd

  return {
    lines: [...timed.slice(0, headEnd), ...timed.slice(tailStart)],
    truncated: true,
    totalChars: total,
    skipped: timed.slice(headEnd, tailStart),
    gapAt: tailStart < n ? timed[tailStart].t : null,
    headCount: headEnd,
    tailCount: n - tailStart,
  }
}

/* ───────────────────────── ③ prompt ───────────────────────── */

/**
 * 两段拆分：**兼容保留**（2026-11-06 改）。
 *
 * 新 prompt 不再要求两段，所以"拆不出来"是正常情况：
 * 既没有小标题行、也没有空行时，**全文当第一段、第二段为空**（不抛错）。
 * 仍被自检/统计引用，行为保持向后兼容。
 */
/** 把小标题行归一化：去掉 # * 【 】 ： 和空白 */
const normHead = (s) => String(s)
  .replace(/^[\s#*>\-–—【\[\(（]+/, '')
  .replace(/[\s】\]\)）：:*#]+$/, '')
  .trim()

const isSummaryHead = (s) => /^(总结|核心观点|主要观点|观点梳理|内容总结)$/.test(normHead(s))
const isViewHead = (s) => /^(我的看法|看法|感悟|我的判断|点评|我的观点|小结)$/.test(normHead(s))

export function splitParts(text, mode = 'blank') {
  const t = String(text || '').trim()
  const lines = t.split('\n')

  // ① 优先按小标题行切（最可靠；按行扫，避免正则把换行吃进去）
  let iS = -1
  let iV = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (iS < 0) { if (isSummaryHead(lines[i])) iS = i; continue }
    if (isViewHead(lines[i])) { iV = i; break }
  }
  if (iS >= 0 && iV > iS) {
    const summary = lines.slice(iS + 1, iV).join('\n').trim()
    const view = lines.slice(iV + 1).join('\n').trim()
    if (summary && view) return { summary, view, paras: [summary, view], splitBy: 'header' }
  }

  // ② 退回空行切
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paras.length >= 2) return { summary: paras[0], view: paras.slice(1).join('\n\n'), paras, splitBy: 'blank' }
  if (mode === 'label') {
    const m = t.match(/总结[：:]\s*([\s\S]*?)\s*看法[：:]\s*([\s\S]*)$/)
    if (m) return { summary: m[1].trim(), view: m[2].trim(), paras: [m[1].trim(), m[2].trim()], splitBy: 'label' }
  }
  return { summary: t, view: '', paras, splitBy: 'none' }
}

/**
 * 极简 prompt：只有【视频】【文字稿】【目标】三块。
 *
 * 刻意**不写**：体裁、两段式、数字分点、字数上下限、禁用词、输出格式。
 * 用户要的是"像把视频原文直接扔给 DeepSeek"，所以这里只给事实 + 一句话目标。
 *
 * `mode` 只改【目标】那行（召唤指令的 --mode）：
 *   summary / view / both —— 三种形态见 lib/routing.mjs 的 TARGET_BY_MODE。
 *   缺省 view，与 2026-11-06 之前的行为一致。
 *
 * @param {{video:object, timed:Array, coverage:number, tier:string, ask?:string, mode?:string}} p
 */
export function buildPrompt({ video, timed, coverage, tier, ask, mode = 'view' }) {
  const cfg = config()
  const budget = Math.min(20000, Number(cfg.generate.materialBudgetTokens) || 20000)
  const fit = fitMaterial(timed, budget)
  const { lines, truncated } = fit
  const srcLabel =
    tier === 'subtitle' ? 'B站官方 AI 字幕' :
    tier === 'asr' ? '本地语音转写（faster-whisper）' :
    tier === 'ocr' ? '画面 OCR' : '素材'

  const line = (l) => `[${fmt(l.t)}] ${l.c}`
  let material
  if (!truncated) {
    material = lines.map(line).join('\n')
  } else {
    // 中段整段省掉，标出**省略区间** —— 不要给模型一段"接不上"的文本
    const head = lines.slice(0, fit.headCount).map(line).join('\n')
    const tail = lines.slice(fit.headCount).map(line).join('\n')
    const skippedChars = fit.skipped.reduce((n, l) => n + l.c.length, 0)
    const from = fit.skipped[0]?.t
    const to = fit.skipped[fit.skipped.length - 1]?.t
    const range = Number.isFinite(from) && Number.isFinite(to) ? `${fmt(from)} – ${fmt(to)}` : '中段'
    material = `${head}\n…（此处省略 ${fit.skipped.length} 段 / 约 ${skippedChars} 字，时间范围 ${range}，内容未提供）…\n${tail}`
  }

  const coveragePct = Math.round((Number(coverage) || 0) * 100)

  return [
    '【视频】',
    `标题：${video.title ?? ''}`,
    `UP主：${video.owner ?? ''}`,
    `时长：${fmt(video.duration)}`,
    `数据：播放 ${video.stat?.view ?? '?'} · 弹幕 ${video.stat?.danmaku ?? '?'} · 评论 ${video.stat?.reply ?? '?'}`,
    '',
    '【文字稿】',
    `来源：${srcLabel}；覆盖 ${fmt(timed[0]?.t ?? 0)} 到 ${fmt(timed.at(-1)?.t ?? 0)}（占全片约 ${coveragePct}%）`,
    ...(truncated ? ['⚠️ 文字稿过长已按时间抽样，中间有跳跃；不要声称覆盖了每一分钟'] : []),
    material,
    '',
    // 【提问者的话】放在【目标】**前面**（2026-11-06 A/B 实测结论）：
    // 最后一句仍然是「说说你怎么看」，输出形态不会被"问题清单"带走。
    // 放到后面会变成逐条答题；把问题揉成陈述句又会答得不完整 —— 保持原话、放前面最好。
    ...(ask ? ['【提问者的话】', ask, ''] : []),
    '【目标】',
    TARGET_BY_MODE[mode] ?? TARGET_BY_MODE.view,
  ].join('\n')
}

/* ───────────────────────── ④ 自检 ───────────────────────── */

const AI_SMELL = /本期视频|UP主|up主|干货满满|值得一看|不容错过|让我们一起|希望对你有帮助|总的来说|综上所述|简直了|绝绝子|不得不说|作为一个AI|作为AI/
const FAKE_WATCH = /我看了|看(?:了|过)(?:这|该)?(?:条|个)?视频|视频里(?:能|可以)?看到|画面|镜头|亲眼/

const STAMP_RE = /(?:^|\n)[ \t]*((?:\d{1,2}:)?\d{1,2}:\d{2})(?=[ \t]|$)/g

export function extractStamps(text) {
  return [...String(text).matchAll(STAMP_RE)].map((m) => m[1])
}

export function stampToSec(s) {
  const p = String(s).split(':').map(Number)
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0
}

/**
 * 自检（2026-11-06 放宽）
 *
 * **硬性不通过只剩一条：空正文。**
 * 结构（两段 / 分点 / 总结夹评价 / 感悟没判断）、字数上下限、复读标题都不再打回重写。
 *
 * 超过 B 站单条硬限（1000）不再是"重写"信号，而是 `needSplit`：
 * 由回复层（lib/serve.mjs → splitForBili）拆成多条发。
 *
 * AI 腔 / 假装看过 / 时间戳：降级为 warnings（照旧记进 run.json 和日志，
 * 但不再触发重试）。"假装看过"是线上红线，删掉会看不见，留着又不该拦生成。
 *
 * @returns {{ok:boolean, issues:string[], warnings:string[], stamps:string[], chars:number,
 *            parts:{summary:string, view:string}, needSplit:boolean, limit:number}}
 */
export function selfCheck(text, { tier } = {}) {
  const issues = []
  const warnings = []
  const t = String(text || '').trim()
  const cfg = config()
  const mode = cfg.generate?.separator === 'label' ? 'label' : 'blank'
  // 兼容保留：新 prompt 不保证两段，拆不出来时 summary=全文、view=''
  const parts = splitParts(t, mode)

  if (!t) issues.push('空正文')

  const needSplit = t.length > BILI_REPLY_LIMIT
  if (needSplit) warnings.push(`超 B 站单条硬限：${t.length} > ${BILI_REPLY_LIMIT}，回复层会拆成多条发送`)

  const stamps = extractStamps(t)
  if (stamps.length) warnings.push(`出现了 ${stamps.length} 个时间戳（现在不要求，仅提示）`)

  const ai = t.match(AI_SMELL)
  if (ai) warnings.push(`命中 AI 腔词表："${ai[0]}"`)

  // 红线提示：我们只给文字稿，没给任何画面
  const fakeWatch = t.match(FAKE_WATCH)
  if (fakeWatch) warnings.push(`可能假装看过画面："${fakeWatch[0]}"（实际只读了${tier === 'subtitle' ? '字幕' : '文字稿'}）`)

  return { ok: issues.length === 0, issues, warnings, stamps, chars: t.length, parts, needSplit, limit: BILI_REPLY_LIMIT }
}
