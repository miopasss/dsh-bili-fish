#!/usr/bin/env node
/**
 * fish —— 命令行入口
 *
 *   node bin/fish.mjs see <BV> [--no-probe] [--force-probe] [--json]
 *   node bin/fish.mjs summary <BV> [--out 目录] [--dry] [--force] [--source …] [--mode …]
 *
 * M1 阶段：summary 只把总结**写到本地文件**，绝不发到 B 站。
 *
 * 2026-11-06 召唤指令：`--source` 强制素材源、`--mode` 强制输出形态。
 * 两个参数通常由 lib/serve.mjs 从 @ 正文解析后传下来，也可以手动敲。
 */
import fs from 'node:fs'
import path from 'node:path'
import { see, renderReport } from '../lib/media.mjs'
import { ensureHome, config, BILI_REPLY_LIMIT } from '../lib/config.mjs'
import { HOME, cacheDir } from '../lib/paths.mjs'
import { detectStyle, toTimedText, mergeSentences, buildPrompt, selfCheck, fmt } from '../lib/compose.mjs'
import { askModel } from '../lib/model.mjs'
import { getSession, rememberSession } from '../lib/sessions.mjs'
import { ocrVideo } from '../lib/ocr.mjs'
import { asrVideo } from '../lib/asr.mjs'
import { newRun, writeArtifact, appendIndex, stats, listRuns } from '../lib/runs.mjs'
import { checkSubtitleQuality } from '../lib/subtitle-check.mjs'
import { SOURCES, MODES, MODE_LABEL, SOURCE_LABEL } from '../lib/routing.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const args = argv.slice(1).filter((a) => !a.startsWith('--'))
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '')))
/** 取带值的选项，例如 --p 3 / --ask "…" */
const optValue = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}
/** 分 P：--p N 优先，否则由 media.see 从链接里的 ?p=N 解析 */
const pageOf = () => {
  const n = Number(optValue('p'))
  return Number.isFinite(n) && n >= 1 ? n : null
}

function usage() {
  console.log(`
fish —— 召唤型 B 站视频总结工具

  node bin/fish.mjs see <BV号或链接> [--no-probe] [--force-probe] [--json] [--p N]
  node bin/fish.mjs transcript <BV号或链接> [--ocr] [--p N]
  node bin/fish.mjs summary <BV号或链接> [--dry] [--force] [--ask "额外要求"] [--p N]
                             [--source auto|subtitle|ocr] [--mode archive|summary|view|both]
  node bin/fish.mjs stats
  node bin/fish.mjs runs [BV号]
  node bin/fish.mjs serve [--dry] [--once] [--interval 30]

  see        盘点素材 + 判定走哪条腿（只读）
  transcript 打印完整带时间戳的文字稿（字幕；加 --ocr 走画面 OCR）
  summary    生成一条总结评论，**只写到本地文件**
  stats      一共有几次运行、按天/按素材分布
  runs       列出所有产物的**完整路径**（可按 BV 过滤）
  serve      常驻：每 30s 拉一次 @ → 生成 → 回复到楼中楼

  --p N       多 P 视频处理第 N P（默认第 1 P；链接里带 ?p=N 也认）
  --dry       只打印 prompt / 只打印将发送的回复，不真发
  --once      只跑一轮就退出（调试用）
  --force     自检不通过也保留结果
  --ask       追加一句额外要求（会拼进 prompt，并复用该视频的会话）
  --json      在输出末尾加一行 @@FISH@@{...} 机器可读结果（给 serve 用）
  --source    召唤指令：强制素材源
                auto      按探针/字幕自动判定（默认）
                subtitle  跳过 A+B 闸门直接用官方字幕；没有字幕轨就报错
                ocr       完全不看字幕、也不跑探针，直接抽 1080P 帧 OCR；OCR 跑完没字才报错
  --mode      召唤指令：强制输出形态
                archive  **完全不调模型**，把完整文字稿（带 [MM:SS]）写进 summary.md
                summary  【目标】总结这条视频讲了什么
                view     【目标】说说你怎么看（默认）
                both     【目标】先总结…再说说你怎么看

每次运行的完整过程都落在 ~/.dsh/bili-fish/runs/<时间>-<BV>/
（see.json / material.json / prompt.txt / summary.md / run.json）

家目录: ${HOME}
`)
}

function grabSubtitle(report) {
  const s = report.steps?.find((x) => x.name === 'subtitle-body')
  if (!s?.ok) return null
  return { lines: s.value, tracks: report.subtitle?.tracks ?? 0 }
}

/**
 * 素材获取的统一入口：字幕优先，没有就按判定的腿走
 *
 * 返回两份：
 *   raw    —— **完整原文**（逐句，一个字不合并），用于存档 / transcript
 *   merged —— **喂给模型**的版本（字幕断行拼回段落，OCR 段落已拼接）
 *
 * @returns {{tier:string, raw:Array, merged:Array, note:string}}
 */
/**
 * 素材缓存：按 `bvid + cid`（分P级）存，30 天过期。
 *
 * 为什么要它：常驻进程的策略是「每条 @ 都重新生成」，而 OCR 一条视频要
 * 下载 7MB + 跑 18 帧（约 50 秒）。视频内容不会天天变，所以素材可以复用，
 * **只有总结重新生成**。命中缓存时重跑从 200s 降到 50s。
 */
const MATERIAL_TTL_DAYS = 30

function materialCacheFile(bvid, cid) {
  return cacheDir(`${bvid}-${cid}`, 'material.json')
}

function readMaterialCache(bvid, cid) {
  try {
    const f = materialCacheFile(bvid, cid)
    const st = fs.statSync(f)
    if (Date.now() - st.mtimeMs > MATERIAL_TTL_DAYS * 864e5) return null
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
    if (!j?.merged?.length || !j?.raw?.length) return null
    return j
  } catch { return null }
}

function writeMaterialCache(bvid, cid, mat) {
  try {
    const f = materialCacheFile(bvid, cid)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ ...mat, cachedAt: new Date().toISOString() }))
    // 素材已落缓存 → 下载的视频/抽的帧/雪碧图就没用了，删掉省磁盘
    // （一条 90 分钟的 1080P 能占 500MB，C 盘紧的时候这点很关键）
    for (const sub of ['ocr/video', 'ocr/frames', 'sprite']) {
      try { fs.rmSync(cacheDir(bvid, sub), { recursive: true, force: true }) } catch { /* 没有就算了 */ }
    }
  } catch { /* 缓存写失败不影响主流程 */ }
}

async function computeMaterial(report, { source = 'auto' } = {}) {
  /* ── --source subtitle：跳过 A+B 闸门，直接用官方字幕 ── */
  if (source === 'subtitle') {
    const sub = grabSubtitle(report)
    if (!sub?.lines?.length) throw new Error('这条视频没有字幕轨（你要求用字幕）')
    const raw = toTimedText(sub.lines)
    const merged = mergeSentences(raw)
    return {
      tier: 'subtitle',
      raw,
      merged,
      note: `字幕 ${raw.length} 句 → 拼成 ${merged.length} 段（召唤指令强制用字幕）`,
    }
  }

  /* ── --source ocr：完全不看字幕，也**完全跳过探针** → 直接抽帧 OCR ── */
  if (source === 'ocr') {
    /**
     * 为什么不再看 `report.verdict`（2026-11-06 修）：
     * 竖屏视频在 see() 里必然把探针标成 skipped、verdict 记成 asr，
     * 但"探针跳过"只是雪碧图在竖屏无效，**不等于画面没字**。
     * 强制看画面时唯一可信的判据是 ocrVideo() 自己的结果：
     * 抽帧没问题（雪碧图才受竖屏影响），OCR 真的返回空才报错。
     */
    const r = await ocrVideo({ bvid: report.bvid, cid: report.video.cid, duration: report.video.duration })
    if (!r.raw.length) {
      throw new Error(
        `画面 OCR 跑完 ${r.frameCount} 帧（${r.intervalSec}s/帧，原始 ${r.beforeDenoise} 行）仍没读到文字`,
      )
    }
    return {
      tier: 'ocr',
      raw: toTimedText(r.raw),
      merged: toTimedText(r.lines),
      note: `画面 OCR ${r.frameCount} 帧（${r.intervalSec}s/帧）→ 去重 ${r.raw.length} 行 → 拼成 ${r.lines.length} 段 · 下载 ${r.downloadedMB}MB（召唤指令强制看画面）`,
    }
  }

  // 字幕被"可用性闸门"否决过（歌词 / 跟标题对不上）时，即使拉到了也不用
  const rejected = report.subtitleRejected
  const sub = rejected ? null : grabSubtitle(report)
  if (sub?.lines?.length) {
    const raw = toTimedText(sub.lines)
    const merged = mergeSentences(raw)
    return {
      tier: 'subtitle',
      raw,
      merged,
      note: `字幕 ${raw.length} 句 → 拼成 ${merged.length} 段`,
    }
  }

  const tier = report.verdict?.tier
  if (tier === 'ocr') {
    const r = await ocrVideo({ bvid: report.bvid, cid: report.video.cid, duration: report.video.duration })
    // ⚠️ ocrVideo 返回的是 B站字幕形状 {from,to,content}，要先过 toTimedText 才是 {t,c}
    const ocrLines = toTimedText(r.lines)
    const ocrChars = ocrLines.reduce((n, l) => n + l.c.length, 0)
    const minChars = Number(config().asr?.ocrFallbackMinChars) || 80

    /**
     * 自动模式的级联（2026-11-06）：OCR 读到的字太少 → 说明画面真的没什么字，
     * 该换"听"了。强制 OCR（--source ocr）不走这条兜底——用户点名要画面。
     */
    if (ocrChars < minChars) {
      try {
        const a = await asrVideo({ bvid: report.bvid, cid: report.video.cid, duration: report.video.duration })
        return {
          tier: 'asr',
          raw: toTimedText(a.raw),
          merged: toTimedText(a.lines),
          note: `画面只读到 ${ocrChars} 字（< ${minChars}）→ 改用语音转写 · ${a.model} 模型 · 音轨 ${a.audioMB}MB · `
            + `转写 ${a.raw.length} 句 → 拼成 ${a.lines.length} 段（${a.charsPerMinute} 字/分）`,
        }
      } catch (e) {
        // ASR 也不成，就把 OCR 那点东西留下（有总比没有强），并说明为什么没升级
        return {
          tier: 'ocr',
          raw: toTimedText(r.raw),
          merged: toTimedText(r.lines),
          note: `OCR ${r.frameCount} 帧 → 去重 ${r.raw.length} 行 → 拼成 ${r.lines.length} 段 · 下载 ${r.downloadedMB}MB`
            + `（画面只有 ${ocrChars} 字，语音转写也没成：${e.message}）`,
        }
      }
    }

    return {
      tier: 'ocr',
      raw: toTimedText(r.raw),
      merged: toTimedText(r.lines),
      note: `OCR ${r.frameCount} 帧（${r.intervalSec}s/帧）→ 去重 ${r.raw.length} 行 → 拼成 ${r.lines.length} 段 · 下载 ${r.downloadedMB}MB`,
    }
  }

  if (tier === 'asr') {
    const a = await asrVideo({ bvid: report.bvid, cid: report.video.cid, duration: report.video.duration })
    return {
      tier: 'asr',
      raw: toTimedText(a.raw),
      merged: toTimedText(a.lines),
      note: `语音转写 · ${a.model} 模型 · 音轨 ${a.audioMB}MB · 转写 ${a.raw.length} 句 → 拼成 ${a.lines.length} 段（${a.charsPerMinute} 字/分）`,
    }
  }

  throw new Error(
    `没有字幕，判定是 ${tier ?? '未知'}（${report.verdict?.why ?? '无判定'}），OCR 与语音转写都拿不到可用内容。`,
  )
}

async function acquireMaterial(report, { source = 'auto' } = {}) {
  const cid = report.video.cid
  const hit = readMaterialCache(report.bvid, cid)

  /**
   * 召唤指令强制素材源（2026-11-06 改）：
   *   · **只复用同 tier 缓存**：source=ocr 时缓存 tier 是 ocr 才用；缓存是字幕就不用。
   *     这样长视频的强制 OCR 不用每次重下重跑。
   *   · 不同 tier 一律不读：缓存里是另一种素材，读了就等于没听指令。
   *   · 仍然**不写**缓存：否则一次强制 OCR 会把字幕视频的缓存污染成 OCR，
   *     以后 auto 模式就再也用不上字幕了。
   */
  if (source !== 'auto') {
    if (hit && hit.tier === source) {
      return { ...hit, note: `${hit.note}（素材缓存命中）`, cached: true, forced: true }
    }
    return { ...(await computeMaterial(report, { source })), forced: true }
  }

  // 缓存里存的是「上次用的那份」；如果这次字幕被否决，而缓存正是字幕 —— 不认这份缓存
  const cacheUsable = hit && !(report.subtitleRejected && hit.tier === 'subtitle')
  if (cacheUsable) {
    return { ...hit, note: `${hit.note}（素材缓存命中）`, cached: true }
  }
  const fresh = await computeMaterial(report)
  if (report.subtitleRejected && fresh.tier === 'ocr') {
    fresh.note = `字幕被否决（${report.subtitleRejected.reasons.join('；')}）→ 改用画面文字 · ${fresh.note}`
  }
  writeMaterialCache(report.bvid, cid, fresh)
  return fresh
}

/** 完整原文，逐句一行，**保留 [MM:SS]** —— summary.md / transcript.txt 共用这一份 */
function transcriptText(material) {
  return material.raw.map((l) => `[${fmt(l.t)}] ${l.c}`).join('\n')
}

/**
 * 归档模式：**完全不调用模型**，把完整文字稿写进 summary.md 的正文区。
 *
 * run.json 里 tokens / ms 都记 0 —— 这不是"没统计到"，是"压根没花"。
 */
function writeArchive({ report, material, timed, coverage, style, source, dry }) {
  const transcript = transcriptText(material)
  const materialChars = material.raw.reduce((n, l) => n + l.c.length, 0)

  if (dry) {
    console.log(`\n归档模式：不调用模型（0 token）· 文字稿 ${material.raw.length} 句 / 约 ${materialChars} 字`)
    console.log('─'.repeat(60))
    console.log(transcript.split('\n').slice(0, 10).join('\n'))
    console.log(`…（共 ${material.raw.length} 行，完整内容会写进 summary.md）`)
    console.log('─'.repeat(60))
    return
  }

  const run = newRun(report.bvid, 'summary')
  const head = [
    `# ${report.video.title}`,
    '',
    `- BV：${report.bvid}`,
    `- UP：${report.video.owner}`,
    `- 时长：${fmt(report.video.duration)}`,
    `- 素材：${material.note}，覆盖 ${Math.round(coverage * 100)}%`,
    `- 体裁：${style.label}`,
    `- 模式：归档（只拉文字稿，不调用模型）`,
    `- 文字稿：${material.raw.length} 句 / 约 ${materialChars} 字`,
    `- 生成：0 ms，0 tokens`,
    '',
    '---',
    '',
  ].join('\n')

  writeArtifact(run.dir, 'summary.md', `${head}\n${transcript}\n`)
  // 与 transcript.txt 输出**完全一致**（同一份 transcript 字符串）
  writeArtifact(run.dir, 'transcript.txt',
    `${report.video.title}\n${report.bvid} · ${fmt(report.video.duration)} · ${material.tier}\n\n${transcript}`)
  writeArtifact(run.dir, 'material.json', {
    bvid: report.bvid,
    title: report.video.title,
    duration: report.video.duration,
    tier: material.tier,
    note: material.note,
    coverage,
    raw: material.raw,
    lines: timed,
  })
  writeArtifact(run.dir, 'see.json', report)

  const record = {
    at: new Date().toISOString(),
    runId: run.id,
    kind: 'summary',
    bvid: report.bvid,
    title: report.video.title,
    duration: report.video.duration,
    tier: material.tier,
    rawLines: material.raw.length,
    materialLines: timed.length,
    materialChars,
    coverage: Math.round(coverage * 100) / 100,
    style: style.key,
    chars: transcript.length,
    needSplit: transcript.length > BILI_REPLY_LIMIT,
    stamps: 0,
    ok: true,
    issues: [],
    attempts: 0,
    /** 归档模式不调模型：0 token / 0 ms 是事实，不是缺数据 */
    ms: 0,
    tokens: 0,
    sessionId: null,
    mode: 'archive',
    source,
  }
  writeArtifact(run.dir, 'run.json', record)
  appendIndex(record)

  if (flags.has('json')) {
    console.log('@@FISH@@' + JSON.stringify({
      ok: true, runId: run.id, runDir: run.dir, bvid: report.bvid,
      chars: transcript.length, needSplit: record.needSplit, issues: [], warnings: [],
      text: transcript, tier: material.tier, page: report.video.pageIndex,
      source, mode: 'archive', rawLines: material.raw.length, materialChars,
    }))
  }

  console.log('\n' + '─'.repeat(60))
  console.log(transcript)
  console.log('─'.repeat(60))
  console.log(`\n归档模式：不调用模型 · ${material.raw.length} 句 / ${transcript.length} 字（正文）`)
  console.log(`\n过程文档 ${run.dir}`)
}

async function cmdSummary(target, { dry = false, force = false, ask = '', source = 'auto', mode = 'view' } = {}) {
  ensureHome()
  let report = await see(target, { probe: true, page: pageOf() })
  if (!report.video) {
    console.error('拿不到视频元信息：' + (report.steps?.[0]?.error ?? '未知原因'))
    process.exit(3)
  }

  /* ── 字幕可用性闸门（A+B）──
     字幕拉到了不等于能用：可能是 BGM 歌词、也可能跟标题对不上。
     可疑时不短路，强制跑探针，让"画面有没有字"来决定换不换腿。
     ⚠️ 召唤指令强制了素材源时不跑这道闸门 —— 用户说了算。 */
  const sub0 = grabSubtitle(report)
  if (source !== 'auto') {
    console.log(`召唤指令：素材源 ${SOURCE_LABEL[source] ?? source} · 输出形态 ${MODE_LABEL[mode] ?? mode}（跳过自动检验）`)
  }
  if (source === 'auto' && sub0?.lines?.length) {
    // ⚠️ 必须是 toTimedText 之后的 {t,c} 形状；直接喂 B站 原始字幕会全是 undefined
    const q = checkSubtitleQuality({ lines: toTimedText(sub0.lines), title: report.video.title })
    if (q.suspicious) {
      console.log(`⚠ 字幕可疑：${q.reasons.join('；')}`)
      console.log('  → 不直接采用，强制跑探针看画面里有没有字…')
      const forced = await see(target, { probe: true, probeForce: true, page: pageOf() })
      if (forced.video) {
        // 保留"字幕被否决"的痕迹，写进 see.json 便于事后审计
        forced.subtitleRejected = { reasons: q.reasons, lyricRatio: Math.round(q.lyricRatio * 100) / 100, overlap: q.overlap }
        report = forced
        console.log(`  → 探针判定：${report.verdict?.tier}（${report.verdict?.why}）`)
      }
    }
  }

  let material
  try {
    material = await acquireMaterial(report, { source })
  } catch (e) {
    console.error(`✗ ${report.bvid} ${e.message}`)
    process.exit(4)
  }

  const timed = material.merged
  const style = detectStyle(report.video)
  const span = (timed.at(-1).t - timed[0].t) || 1
  const coverage = Math.min(1, span / Math.max(1, report.video.duration))

  // 头部信息放在 --dry 之前：dry 也要能看见"处理的是哪个分P / 多少素材"
  console.log(`\n视频   ${report.video.title}`)
  if (report.multiPart) {
    console.log(`分P    共 ${report.video.pageCount} 个 · 只处理第 ${report.video.pageIndex} P${report.video.pageTitle ? '：' + report.video.pageTitle : ''}（${fmt(report.video.duration)}）`)
  }
  console.log(`时长   ${fmt(report.video.duration)}   体裁 ${style.label}   字数 不设限（> ${BILI_REPLY_LIMIT} 由回复层拆条）`)
  console.log(`素材   ${material.note}，覆盖 ${fmt(timed[0].t)} → ${fmt(timed.at(-1).t)}（${Math.round(coverage * 100)}%）`)
  if (mode !== 'view') console.log(`形态   ${MODE_LABEL[mode] ?? mode}`)

  /* ── 归档模式：完全不调用模型（0 token）── */
  if (mode === 'archive') {
    writeArchive({ report, material, timed, coverage, style, source, dry })
    return
  }

  const prompt = buildPrompt({
    video: report.video, timed, coverage, tier: material.tier, ask, mode,
  })

  if (dry) {
    console.log('\n' + '─'.repeat(60) + '\n(prompt)\n' + '─'.repeat(60))
    console.log(prompt)
    console.log('─'.repeat(60))
    console.log(`\nprompt 共 ${prompt.length} 字符`)
    return
  }

  const run = newRun(report.bvid, 'summary')

  /**
   * 会话策略：
   *   · 带 --ask 或 --follow → 追问，复用该视频的会话（上下文天然共享）
   *   · 否则是新的/重跑的总结 → **开新会话**，避免上一次的输出污染这一次
   */
  const isFollowUp = Boolean(ask) || flags.has('follow')
  let sessionId = isFollowUp ? getSession(report.bvid) : null
  console.log(`对话   ${isFollowUp ? `追问，复用 ${sessionId ?? '（无，将新建）'}` : '新生成，开新会话'}`)

  let attempt = 0
  let text = ''
  let check = null
  let usage = null
  let ms = 0

  try {
    while (attempt < 2) {
      attempt += 1
      process.stderr.write(`\n[第 ${attempt} 次生成…]\n`)
      const r = await askModel({ prompt: attempt === 1 ? prompt : prompt + retryHint(check), sessionId })
      text = String(r.text || '').trim()
      sessionId = r.sessionId ?? sessionId
      usage = r.usage
      ms = r.ms
      rememberSession(report.bvid, sessionId)

      check = selfCheck(text, { tier: material.tier })
      if (check.ok || force) break
      process.stderr.write(`  自检不通过：${check.issues.join('；')}\n`)
    }
  } catch (e) {
    // 模型层失败（没凭据 / 超时 / 空正文）——**不要**把空结果当成"写完了"
    console.error(`✗ ${report.bvid} 生成失败：${e?.message ?? e}`)
    process.exit(5)
  }

  const body = [
    `# ${report.video.title}`,
    '',
    `- BV：${report.bvid}`,
    `- UP：${report.video.owner}`,
    `- 时长：${fmt(report.video.duration)}`,
    `- 素材：${material.note}，覆盖 ${Math.round(coverage * 100)}%`,
    `- 体裁：${style.label}`,
    `- 生成：${ms} ms，${usage?.totalTokens ?? '?'} tokens，会话 ${sessionId}`,
    `- 字数：${check.chars}${check.needSplit ? `（超 ${check.limit}，回复时拆成多条）` : ''}`,
    `- 自检：${check.ok ? '通过' : '不通过 — ' + check.issues.join('；')}`,
    check.warnings.length ? `- 提醒：${check.warnings.join('；')}` : '',
    '',
    '---',
    '',
    text,
    '',
  ].filter((l) => l !== undefined).join('\n')

  /* ── 过程文档：一次运行一个目录，全部落盘（见 lib/runs.mjs 头注释）── */
  writeArtifact(run.dir, 'summary.md', body)
  writeArtifact(run.dir, 'prompt.txt', prompt)
  // 原文单独一份，**不做任何合并**（逐句字幕 / 逐行 OCR）
  writeArtifact(run.dir, 'transcript.txt',
    `${report.video.title}\n${report.bvid} · ${fmt(report.video.duration)} · ${material.tier}\n\n${transcriptText(material)}`)
  writeArtifact(run.dir, 'material.json', {
    bvid: report.bvid,
    title: report.video.title,
    duration: report.video.duration,
    tier: material.tier,
    note: material.note,
    coverage,
    /** raw：完整原文，未合并 —— 存档用 */
    raw: material.raw,
    /** lines：实际喂给模型的（字幕断行已拼回段落） */
    lines: timed,
  })
  writeArtifact(run.dir, 'see.json', report)
  const record = {
    at: new Date().toISOString(),
    runId: run.id,
    kind: 'summary',
    bvid: report.bvid,
    title: report.video.title,
    duration: report.video.duration,
    tier: material.tier,
    rawLines: material.raw.length,
    materialLines: timed.length,
    materialChars: material.raw.reduce((n, l) => n + l.c.length, 0),
    coverage: Math.round(coverage * 100) / 100,
    style: style.key,
    chars: check.chars,
    needSplit: check.needSplit,
    stamps: check.stamps.length,
    ok: check.ok,
    issues: check.issues,
    attempts: attempt,
    ms,
    tokens: usage?.totalTokens ?? 0,
    sessionId,
    /** 召唤指令参数（auto/view 是缺省值，也记下来便于对账） */
    source,
    mode,
  }
  writeArtifact(run.dir, 'run.json', record)
  appendIndex(record)

  // --json：给常驻进程/脚本用的机器可读结果（人看的输出走上面，这里只加一行标记）
  if (flags.has('json')) {
    console.log('@@FISH@@' + JSON.stringify({
      ok: check.ok, runId: run.id, runDir: run.dir, bvid: report.bvid,
      chars: check.chars, needSplit: check.needSplit, issues: check.issues, warnings: check.warnings,
      text, tier: material.tier, page: report.video.pageIndex,
      source, mode, rawLines: material.raw.length,
      materialChars: material.raw.reduce((n, l) => n + l.c.length, 0),
    }))
  }

  console.log('\n' + '─'.repeat(60))
  console.log(text)
  console.log('─'.repeat(60))
  console.log(`\n字数 ${check.chars}   自检 ${check.ok ? '✓ 通过' : '✗ ' + check.issues.join('；')}`)
  if (check.warnings.length) console.log(`提醒 ${check.warnings.join('；')}`)
  console.log(`\n过程文档 ${run.dir}`)
}

function retryHint(check) {
  // 2026-11-06：自检只拦"空正文"，不再因为结构/字数打回；这里也不提字数、分段
  return `\n\n【上一次没有产出可用正文，请重写】问题：${check.issues.join('；')}。`
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return usage()

  if (cmd === 'serve') {
    ensureHome()
    const { runServe } = await import('../lib/serve.mjs')
    await runServe({ dry: flags.has('dry'), once: flags.has('once'), intervalSec: Number(optValue('interval')) || null })
    return
  }

  if (cmd === 'see') {
    const target = args[0]
    if (!target) { usage(); process.exit(2) }
    ensureHome()
    const r = await see(target, { probe: !flags.has('no-probe'), probeForce: flags.has('force-probe'), page: pageOf() })
    const run = newRun(r.bvid, 'see')
    writeArtifact(run.dir, 'see.json', r)
    const rec = {
      at: new Date().toISOString(),
      runId: run.id,
      kind: 'see',
      bvid: r.bvid,
      title: r.video?.title ?? '',
      duration: r.video?.duration ?? 0,
      tier: r.verdict?.tier ?? '?',
      vertical: Boolean(r.vertical),
      chars: 0,
      stamps: 0,
      ok: r.verdict?.tier !== 'error',
      ms: 0,
      tokens: 0,
    }
    writeArtifact(run.dir, 'run.json', rec)
    appendIndex(rec)

    if (flags.has('json')) {
      console.log(JSON.stringify(r, null, 2))
      console.error(`\n已写入 ${run.dir}`)
      return
    }

    console.log(renderReport(r))
    console.log(`  过程   ${run.dir}`)
    console.log('')
    return
  }

  if (cmd === 'transcript') {
    const target = args[0]
    if (!target) { usage(); process.exit(2) }
    ensureHome()
    const report = await see(target, { probe: flags.has('ocr'), page: pageOf() })
    if (!report.video) { console.error('拿不到视频元信息'); process.exit(3) }

    // transcript 一律给**完整原文**（逐句 / 逐行），不做任何合并
    let lines = grabSubtitle(report)?.lines ?? null
    let tier = lines ? 'subtitle' : null
    if (!lines && flags.has('ocr')) {
      const r = await ocrVideo({ bvid: report.bvid, cid: report.video.cid, duration: report.video.duration })
      lines = r.raw
      tier = 'ocr'
    }
    if (!lines?.length) {
      console.error(`✗ ${report.bvid} 没有字幕。加 --ocr 走画面 OCR（会下载视频）`)
      process.exit(4)
    }

    // OCR 的 raw 是 {from,content}，字幕的是 {from,to,content} —— toTimedText 都能吃
    const timed = toTimedText(lines)
    const run = newRun(report.bvid, 'transcript')
    const text = timed.map((l) => `[${fmt(l.t)}] ${l.c}`).join('\n')
    const head = `${report.video.title}\n${report.bvid} · ${fmt(report.video.duration)} · ${tier}\n\n`
    writeArtifact(run.dir, 'transcript.txt', head + text)
    writeArtifact(run.dir, 'see.json', report)
    writeArtifact(run.dir, 'run.json', {
      at: new Date().toISOString(), runId: run.id, kind: 'transcript',
      bvid: report.bvid, title: report.video.title, duration: report.video.duration,
      tier, chars: text.length, stamps: 0, ok: true, ms: 0, tokens: 0,
    })
    appendIndex({ at: new Date().toISOString(), runId: run.id, kind: 'transcript', bvid: report.bvid, title: report.video.title, duration: report.video.duration, tier, chars: text.length, stamps: 0, ok: true, ms: 0, tokens: 0 })

    console.log(head + text)
    console.error(`\n共 ${timed.length} 行 · 已保存 ${path.join(run.dir, 'transcript.txt')}`)
    return
  }

  if (cmd === 'runs') {
    const only = args[0] ?? null
    const list = listRuns({ bvid: only })
    if (!list.length) {
      console.log(`\n没有找到产物${only ? `（BV ${only}）` : ''}。`)
      console.log(`两个可能的位置：\n  ${path.join(HOME, 'runs')}\n  ${path.join(HOME, 'cache')}\n`)
      return
    }
    console.log(`\n共 ${list.length} 份产物\n`)
    for (const r of list) {
      const when = String(r.at ?? '').replace('T', ' ').slice(0, 16)
      console.log(`▸ ${when}  ${r.bvid}  [${r.kind} · ${r.layout}]`)
      if (r.title) console.log(`  ${r.title}`)
      console.log(`  目录 ${r.dir}`)
      console.log(`  文件 ${r.files.join(', ')}`)
      if (r.file) console.log(`  总结 ${r.file}`)
      console.log('')
    }
    return
  }

  if (cmd === 'stats') {
    const s = stats()
    console.log(`\n一共问了 ${s.total} 次\n`)
    if (s.total) {
      console.log('按天：')
      for (const [d, n] of Object.entries(s.byDay).sort()) console.log(`  ${d}  ${'█'.repeat(Math.min(40, n))} ${n}`)
      console.log('\n按素材：')
      for (const [t, n] of Object.entries(s.byTier).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(10)} ${n}`)
      console.log(`\n累计输出 ${s.chars} 字 · 累计 token ${s.tokens}`)
      console.log('\n最近 10 次：')
      for (const r of s.runs.slice(-10).reverse()) {
        console.log(`  ${String(r.at).slice(0, 16)}  ${String(r.bvid).padEnd(14)} ${String(r.tier).padEnd(9)} ${String(r.chars || '').padStart(4)}字  ${String(r.title || '').slice(0, 28)}`)
      }
    }
    console.log('')
    return
  }

  if (cmd === 'summary') {
    const target = args[0]
    if (!target) { usage(); process.exit(2) }
    const askIdx = argv.indexOf('--ask')
    const ask = askIdx >= 0 ? String(argv[askIdx + 1] ?? '') : ''
    // 召唤指令：--source / --mode（不写就是 auto / view，与以前完全一致）
    const source = (optValue('source') || 'auto').toLowerCase()
    const mode = (optValue('mode') || 'view').toLowerCase()
    if (!SOURCES.includes(source)) {
      console.error(`--source 只支持 ${SOURCES.join(' / ')}，收到：${source}`)
      process.exit(2)
    }
    if (!MODES.includes(mode)) {
      console.error(`--mode 只支持 ${MODES.join(' / ')}，收到：${mode}`)
      process.exit(2)
    }
    await cmdSummary(target, { dry: flags.has('dry'), force: flags.has('force'), ask, source, mode })
    return
  }

  usage()
  process.exit(2)
}

main().catch((e) => {
  console.error('失败：' + (e?.stack || e?.message || e))
  process.exit(1)
})
