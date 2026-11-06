/**
 * 常驻进程：每 30 秒拉一次 @，白名单准入 → 排队 → 生成 → 回复
 *
 * 设计（2026-11-04 定稿）：
 *   · 轮询不停：处理视频期间照常拉 @，新任务进**内存队列**（最多 5 条）
 *   · 串行处理：一次只跑一个视频
 *   · 白名单闸门放在最前面：非白名单连 see 都不跑，只记 rejected.jsonl
 *   · 幂等：按 rpid（B站 回完不撤消息，见 lib/store.mjs）
 *   · 失败最多 3 次，然后写 ALERT 文件并标记 dead
 *   · 同视频每天最多 3 条、全局每天最多 50 条
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { config, BILI_REPLY_LIMIT } from './config.mjs'
import { HOME, pkgRoot, WS_PUBLIC, WS_QUIET } from './paths.mjs'
import { fetchAtMessages } from './feed.mjs'
import { parseCommand, buildStatusLine, stripAsk } from './routing.mjs'
import {
  postReply, verifyReply, splitForBili, toBiliPlainText, cutAtSentenceBoundary, cutAtBoundary,
  BLOCKING_CODES, DUPLICATE_CODE,
} from './reply.mjs'
import {
  ensureStore, isHandled, markHandled, reject, readHandled, readRejected,
  bumpAttempt, writeAlert, listAlerts, clearAlert, readAttempts,
} from './store.mjs'

/** 状态行的纯函数实现已挪到 lib/routing.mjs，这里保留旧导入路径的再导出 */
export { buildStatusLine } from './routing.mjs'

const MAX_ATTEMPTS = 3
const REPLY_GAP = [30, 60]                  // 两次回复之间的随机间隔（秒）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const today = () => new Date().toISOString().slice(0, 10)
const hhmmss = () => new Date().toTimeString().slice(0, 8)

/** 跑一次 `fish summary <bvid> --json`，带超时；source/mode 来自召唤指令解析 */
function runSummary(bvid, page, timeoutMs, { source = 'auto', mode = 'view', ask = '', quiet = false } = {}) {
  return new Promise((resolve) => {
    const args = [path.join(pkgRoot, 'bin', 'fish.mjs'), 'summary', bvid, '--json']
    if (page) args.push('--p', String(page))
    args.push('--source', source, '--mode', mode)
    // 提问者在评论里说的话（已剃掉 @ 与关键词）→ 进 prompt 的【提问者的话】
    if (ask) args.push('--ask', ask)
    // 静默的会话进独立工作区，便于在 GUI 里追问；非静默的留在项目目录
      const child = spawn(process.execPath, args, {
        cwd: pkgRoot,
        env: { ...process.env, BILI_FISH_MODEL_CWD: quiet ? WS_QUIET : WS_PUBLIC },
      })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退 */ }
      resolve({ ok: false, timeout: true, out, err })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.split('\n').reverse().find((l) => l.startsWith('@@FISH@@'))
      let payload = null
      if (line) { try { payload = JSON.parse(line.slice('@@FISH@@'.length)) } catch { /* 解析失败按失败处理 */ } }
      resolve({ ok: code === 0 && payload?.ok !== false, code, payload, out, err })
    })
  })
}

/** 归档正文最多贴 3 条（B 站单条硬限 × 3） */
const ARCHIVE_MAX_CHARS = BILI_REPLY_LIMIT * 3

/**
 * 归档正文超过 3 条容量时：找**离容量上限最近的可读边界**截断，末尾加说明。
 *
 * 不能硬切在第 3000 个字上 —— 那样最后一句一定是断的。
 * 但也不能只认句号：标点稀疏的稿子（OCR 表格、弹幕体、诗歌）可能 3000 字里
 * 一个句号都没有，只认句末标点会截在很靠前的地方，白白浪费 3 条容量。
 *
 * 所以交给 reply.mjs 的 cutAtBoundary 做三级退化：
 *   ① 句末标点 → ② 换行 → ③ 离上限 50 字内都没有可读边界就硬切。
 * 三种情况末尾都是同一句 `…（全文已存本地，评论区只贴前 N 字）`。
 *
 * 后缀本身也占容量，所以先按"后缀最长可能长度"预留。
 */
export function truncateArchiveBody(body, max = ARCHIVE_MAX_CHARS) {
  if (body.length <= max) return body
  const suffix = (n) => `\n…（全文已存本地，评论区只贴前 ${n} 字）`
  const cut = cutAtBoundary(body, max - suffix(9999).length)
  const shown = body.slice(0, cut).trimEnd()
  return shown + suffix(shown.length)
}

/**
 * 清洗子进程错误原文开头的机器味前缀：
 *   `✗ ` / `✗` / 紧跟其后的 BV 号。
 *
 * 例：`✗ BV1QjuQ6REcS 这条视频没有字幕轨（你要求用字幕）`
 *   → `这条视频没有字幕轨（你要求用字幕）`
 *
 * 清洗后为空（理论上不会发生）就回原文，绝不能回一条空评论。
 */
export function cleanErrorText(line) {
  const raw = String(line ?? '').trim()
  const cleaned = raw
    .replace(/^(?:✗\s*)+/, '')
    .replace(/^BV[0-9A-Za-z]{10}\s*/, '')
    .trim()
  return cleaned || raw
}

/**
 * 失败 3 次后回给用户的正文 = **控制台那句错误原文**（去掉 ✗ / BV 号前缀）。
 * 子进程的 stderr 里找 `✗ …` / `失败：…` / `拿不到…` 这类行；找不到就用 serve 自己的 why。
 */
export function failureReplyText(r, why) {
  const lines = (s) => String(s ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const pick = (s) => lines(s)
    .filter((l) => /^(✗|失败[:：]|拿不到|Error|TypeError|RangeError|SyntaxError)/.test(l))
    .pop()
  const line = cleanErrorText(pick(r?.err) || pick(r?.out) || `✗ ${why}`)
  const cut = cutAtSentenceBoundary(line, BILI_REPLY_LIMIT - 1)
  return cut < line.length ? `${line.slice(0, cut)}…` : line
}

/** 今天的额度用量 */
function usageToday() {
  const t = today()
  const all = readHandled().filter((r) => String(r.at || '').slice(0, 10) === t && r.result === 'replied')
  const byBvid = {}
  for (const r of all) byBvid[r.bvid] = (byBvid[r.bvid] ?? 0) + 1
  return { total: all.length, byBvid }
}

export async function runServe({ dry = false, once = false, intervalSec = null } = {}) {
  ensureStore()
  // 日志同时写文件和窗口：关掉窗口也能回看它在干什么
  const LOG_FILE = path.join(HOME, 'serve.log')
  const origLog = console.log.bind(console)
  try {
    const st = fs.statSync(LOG_FILE)
    if (st.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch { /* 没有就算了 */ }
  console.log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
    origLog(line)
    try { fs.appendFileSync(LOG_FILE, line + '\n') } catch { /* 写失败不影响运行 */ }
  }
  console.log(`\n===== 启动 ${new Date().toLocaleString('zh-CN')}${dry ? ' [DRY]' : ''} =====`)

  const cfg = config(true)
  const wl = new Set((cfg.whitelist || []).map(String))
  const interval = (intervalSec ?? Number(cfg.serve?.pollSec) ?? 30) * 1000
  const QUEUE_MAX = Number(cfg.limits?.queueMax) || 5
  const JOB_TIMEOUT_MS = (Number(cfg.limits?.taskTimeoutMin) || 20) * 60 * 1000

  const queue = []
  const enqueued = new Set()
  let processed = 0
  let lastHeartbeat = Date.now()

  /* ── 启动横幅：白名单、告警、历史拒绝数 ── */
  const alerts = listAlerts()
  console.log('═'.repeat(64))
  console.log(`  bili-fish 常驻进程${dry ? '  [DRY RUN 只打不发]' : ''}`)
  console.log(`  轮询间隔 ${interval / 1000}s · 队列上限 ${QUEUE_MAX} · 每条最多试 ${MAX_ATTEMPTS} 次`)
  console.log(`  白名单 mid：${[...wl].join(', ') || '（空！谁都不能召唤）'}`)
  console.log(`  家目录：${HOME}`)
  const rej = readRejected().length
  if (rej) console.log(`  已忽略的非白名单 @：${rej} 条（见 rejected.jsonl）`)
  if (alerts.length) {
    console.log('')
    console.log(`  ⚠ 有 ${alerts.length} 个未处理的失败告警：`)
    for (const a of alerts.slice(0, 10)) console.log(`     ${a}`)
    console.log('     （处理完删掉这些文件即可）')
  }
  console.log('═'.repeat(64))
  console.log('Ctrl+C 停止（会跑完手上这一条）\n')

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) { console.log('\n再按一次，立即退出'); process.exit(130) }
    stopping = true
    console.log('\n收到 Ctrl+C，处理完当前这条就退出…')
  })

  /* ── 拉一轮 @ ── */
  async function poll() {
    let list = []
    try {
      list = await fetchAtMessages()
    } catch (e) {
      console.log(`[${hhmmss()}] 拉取 @ 失败：${e?.message ?? e}`)
      return
    }
    // 旧的在前，保证按时间顺序处理
    for (const m of list.slice().reverse()) {
      const key = String(m.rpid)
      if (isHandled(key) || enqueued.has(key)) continue
      // 🔴 白名单闸门：在碰任何素材/模型之前
      if (!wl.has(String(m.mid))) {
        reject({ mid: m.mid, nickname: m.nickname, rpid: m.rpid, bvid: m.bvid, atId: m.atId, reason: 'not_whitelisted' })
        enqueued.add(key)
        continue
      }
      if (queue.length >= QUEUE_MAX) {
        reject({ mid: m.mid, nickname: m.nickname, rpid: m.rpid, bvid: m.bvid, atId: m.atId, reason: 'queue_full' })
        enqueued.add(key)
        continue
      }
      queue.push(m)
      enqueued.add(key)
      console.log(`[${hhmmss()}] 入队 ${m.bvid}  rpid=${m.rpid}  来自 ${m.nickname}：${JSON.stringify((m.text || '').slice(0, 40))}`)
    }
  }

  /* ── 处理一条 ── */
  async function processJob(job) {
    const tag = `[${hhmmss()}] ${job.bvid} rpid=${job.rpid}`
    // 召唤指令：只解析**这条 @ 的正文**
    const cmd = parseCommand(job.text)
    if (cmd.hits.length) {
      console.log(`${tag} 召唤指令：${cmd.hits.map((h) => h.word).join('、')} → source=${cmd.source} mode=${cmd.mode}`)
    }

    /**
     * 提问者的话（2026-11-06）：剃掉 @ 和命中的关键词，剩下的原样交给模型。
     * 剃完不足 askMinChars 字就当作纯召唤语（"看看这个"），不往 prompt 里塞。
     */
    const askMin = Number(cfg.routing?.askMinChars) || 15
    const askText = stripAsk(job.text, cmd.hits)
    const ask = askText.length >= askMin ? askText : ''
    if (ask) {
      console.log(`${tag} 提问者的话 ${ask.length} 字，进 prompt：${JSON.stringify(ask.slice(0, 40))}`)
    } else if (askText) {
      console.log(`${tag} 提问者的话只有 ${askText.length} 字（< ${askMin}），当纯召唤语，不传`)
    }

    // 额度
    const use = usageToday()
    const dailyMax = Number(cfg.limits?.dailyReplies) || 50
    if (use.total >= dailyMax) {
      console.log(`${tag} 跳过：今日已达上限 ${dailyMax}`)
      markHandled({ ...job, result: 'skipped_quota' })
      return
    }
    const perVideoMax = Number(cfg.limits?.perVideoPerDay) || 3
    if ((use.byBvid[job.bvid] ?? 0) >= perVideoMax) {
      console.log(`${tag} 跳过：同一视频今日已回 ${perVideoMax} 条`)
      markHandled({ ...job, result: 'skipped_per_video' })
      return
    }

    // 熔断
    if (serveState.blockedUntil && Date.now() < serveState.blockedUntil) {
      console.log(`${tag} 跳过：风控熔断中，解禁时间 ${new Date(serveState.blockedUntil).toLocaleString('zh-CN')}`)
      return
    }

    const n = dry ? 1 : bumpAttempt(job.rpid)
    if (n > MAX_ATTEMPTS) {
      console.log(`${tag} 跳过：已失败 ${MAX_ATTEMPTS} 次（见 alerts/）`)
      return
    }

    console.log(`${tag} 开始生成（第 ${n} 次尝试）…`)
    const t0 = Date.now()
    const r = await runSummary(job.bvid, null, JOB_TIMEOUT_MS, { source: cmd.source, mode: cmd.mode, ask, quiet: cmd.quiet })

    if (!r.ok) {
      const why = r.timeout ? `超时 ${JOB_TIMEOUT_MS / 60000} 分钟` : `生成失败 code=${r.code}`
      const detail = (r.err || r.out || '').slice(-2000)
      console.log(`${tag} ✗ ${why}`)
      if (n >= MAX_ATTEMPTS) {
        const f = writeAlert(job, why, detail)
        /* 失败 3 次：把**控制台那句错误原文**回给用户（不是让模型编一句道歉）。
           只在"该回"的时候发 —— 白名单/额度跳过在函数开头就 return 了，走不到这里。 */
        const failText = failureReplyText(r, why)
        console.log(`${tag} 错误原文：${failText}`)
        if (dry) {
          console.log(`${tag} [DRY] 将回复上面这句错误原文（演练不落库）`)
        } else {
          try {
            const sent = await postReply({
              aid: job.aid, bvid: job.bvid,
              root: job.rootId || job.rpid,
              parent: job.rpid,
              message: failText,
            })
            if (sent.code === 0 || sent.code === DUPLICATE_CODE) {
              console.log(`${tag} 已回复错误原文 rpid=${sent.rpid ?? '（无）'}`)
            } else {
              console.log(`${tag} ✗ 错误原文没发出去 code=${sent.code} ${sent.message ?? ''}`)
              if (BLOCKING_CODES.has(sent.code)) {
                serveState.blockedUntil = Date.now() + 24 * 3600 * 1000
                console.log('  → 今日停止一切写操作（熔断 24h）')
              }
            }
          } catch (e) {
            console.log(`${tag} ✗ 错误原文没发出去：${e?.message ?? e}`)
          }
        }
        markHandled({ ...job, result: 'dead', reason: why, failReply: failText, alert: f })
        console.log(`${tag} 已写告警：${f}`)
      }
      return
    }

    const text = r.payload?.text ?? ''
    if (!text.trim()) {
      console.log(`${tag} ✗ 生成结果为空`)
      return
    }

    /* ── 召唤指令：状态行并进第 1 条回复的开头，算进 1000 字额度 ── */
    const status = buildStatusLine(cmd, {
      tier: r.payload?.tier,
      rawLines: r.payload?.rawLines,
      chars: r.payload?.materialChars,
    })
    const archive = cmd.mode === 'archive'

    /* ── 字数不设限（2026-11-06）：超 1000 不再重写，而是在句子边界拆成多条 ── */
    let body
    if (archive) {
      // 归档：正文 = 状态行 + 换行 + 文字稿全文（文字稿带 [MM:SS]，不做 markdown 洗白）
      const full = [status, text].filter(Boolean).join('\n')
      body = truncateArchiveBody(full)
      if (body.length !== full.length) {
        console.log(`${tag} 归档正文 ${full.length} 字超过 ${ARCHIVE_MAX_CHARS}，已在可读边界截到 ${body.length} 字`)
      }
    } else {
      // 先做平台适配：模型爱写 markdown 和外链，B站 不渲染，链接还未必可靠
      const plain = toBiliPlainText(text)
      if (plain.length !== text.length) {
        console.log(`${tag} 已去 markdown/链接：${text.length} → ${plain.length} 字`)
      }
      body = [status, plain].filter(Boolean).join('\n')
    }
    if (status) console.log(`${tag} 状态行 ${status.length} 字，并入第 1 条`)

    /* ── 静默（悄悄）：只落本地与网页历史，**一个字都不发到评论区** ──
       连归档的状态行也不发。失败时同样不回（那是上方 dead 分支的事）。
       额度照算 —— 否则静默就成了绕过每日上限的后门。 */
    if (cmd.quiet) {
      markHandled({
        ...job, result: 'quiet', runId: r.payload?.runId,
        chars: text.length, mode: cmd.mode, source: cmd.source,
      })
      processed += 1
      console.log(`${tag} 🤫 静默：${text.length} 字已落本地，未发评论（在网页历史里看）`)
      return
    }

    const { parts, truncated } = splitForBili(
      body,
      BILI_REPLY_LIMIT,
      archive ? { maxParts: 3, truncateAtBoundary: true } : {},
    )
    if (truncated) {
      console.log(`${tag} ⚠ 正文 ${body.length} 字超过 ${parts.length} 条容量，末条已截断（内容有损失）`)
    }

    if (dry) {
      const plan = parts.length > 1
        ? `拆成 ${parts.length} 条（${parts.map((p) => p.length).join(' / ')} 字）`
        : `${body.length} 字`
      console.log(`${tag} [DRY] 将回复 ${plan}（演练不落库、不占用额度）：`)
      console.log('─'.repeat(60))
      parts.forEach((p, i) => {
        if (parts.length > 1) console.log(`— 第 ${i + 1}/${parts.length} 条 —`)
        console.log(p)
      })
      console.log('─'.repeat(60))
      return
    }

    const rootId = job.rootId || job.rpid

    /**
     * 拆分后的第 2/3 条用**原评论 rpid** 当 parent（与第 1 条同一个 parent）。
     * 为什么不用第一条的 rpid：① 不依赖第一条返回的 rpid（解析不到也能继续）；
     * ② 两条是同一层的兄弟回复，不会形成"回复自己"的链，也不增加楼中楼层级；
     * ③ 第一条失败重试时，后面几条不受牵连。
     */
    const partGap = (() => {
      const g = cfg.reply?.partGapSec
      const a = Number(Array.isArray(g) ? g[0] : NaN)
      const b = Number(Array.isArray(g) ? g[1] : NaN)
      return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= a ? [Math.round(a), Math.round(b)] : [10, 20]
    })()

    const rpids = []
    let verified = null
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        const gap = randInt(partGap[0], partGap[1])
        console.log(`${tag} 发第 ${i + 1}/${parts.length} 条前等 ${gap}s`)
        await sleep(gap * 1000)
      }

      const sent = await postReply({
        aid: job.aid, bvid: job.bvid,
        root: rootId,
        parent: job.rpid,
        message: parts[i],
      })

      if (sent.code === DUPLICATE_CODE) {
        console.log(`${tag} 第 ${i + 1}/${parts.length} 条已是重复评论（12051），视为完成`)
        if (sent.rpid) rpids.push(sent.rpid)
        continue
      }
      if (sent.code !== 0) {
        const blocking = BLOCKING_CODES.has(sent.code)
        console.log(`${tag} ✗ 第 ${i + 1}/${parts.length} 条发送失败 code=${sent.code} ${sent.message ?? ''}${blocking ? '（触发风控）' : ''}`)
        if (blocking) {
          serveState.blockedUntil = Date.now() + 24 * 3600 * 1000
          console.log('  → 今日停止一切写操作（熔断 24h）')
          markHandled({ ...job, result: 'blocked', code: sent.code, parts: i })
        } else if (n >= MAX_ATTEMPTS) {
          writeAlert(job, `发送失败 code=${sent.code}`, JSON.stringify(sent.raw).slice(0, 2000))
          markHandled({ ...job, result: 'dead', reason: `send ${sent.code}` })
        }
        return
      }

      rpids.push(sent.rpid)
      const v = await verifyReply({ aid: job.aid, root: rootId, rpid: sent.rpid })
      verified = v
      if (!v.found) console.log(`${tag} ⚠ 第 ${i + 1} 条发送返回成功（rpid=${sent.rpid}），但回读没找到，可能还在审核`)
      if (v.state === 17) console.log(`${tag} ⚠ 第 ${i + 1} 条 state=17：仅自己可见，检查 Referer/风控`)
    }

    const ms = Date.now() - t0
    clearAlert(job.rpid)
    markHandled({
      ...job, result: 'replied', replyRpid: rpids[0] ?? null, replyRpids: rpids,
      parts: parts.length, runId: r.payload?.runId,
      chars: body.length, ms, verified: verified?.found ?? false, state: verified?.state ?? null,
      source: cmd.source, mode: cmd.mode, hits: cmd.hits.map((h) => h.word),
    })
    processed += 1
    console.log(`${tag} ✓ 已回复 ${parts.length > 1 ? `${parts.length} 条 ` : ''}rpid=${rpids.join(',')}  ${body.length} 字  用时 ${(ms / 1000).toFixed(0)}s${verified?.found ? '  回读可见' : ''}`)
  }

  const serveState = { blockedUntil: 0 }

  /* ── 主循环 ── */
  for (;;) {
    await poll()
    while (queue.length) {
      const job = queue.shift()
      try {
        await processJob(job)
      } catch (e) {
        console.log(`[${hhmmss()}] 处理异常：${e?.message ?? e}`)
      }
      // 失败/跳过的不算"做完"：从 enqueued 里放出来，下一轮还能再试
      // （否则一次失败就会被永久挡住，"最多试 3 次"永远到不了 —— 2026-11-05 修）
      if (!isHandled(String(job.rpid))) enqueued.delete(String(job.rpid))
      if (queue.length) {
        const gap = randInt(REPLY_GAP[0], REPLY_GAP[1])
        console.log(`[${hhmmss()}] 等下一条，间隔 ${gap}s`)
        await sleep(gap * 1000)
      }
      if (stopping) break
    }
    if (once) break
    if (stopping) break
    if (Date.now() - lastHeartbeat > 10 * 60 * 1000) {
      lastHeartbeat = Date.now()
      const use = usageToday()
      console.log(`[${hhmmss()}] 心跳：本次已回复 ${processed} 条 · 今日 ${use.total} 条 · 队列 ${queue.length}`)
    }
    await sleep(interval)
  }
  console.log(`\n退出。本次共回复 ${processed} 条。`)
}
