/**
 * 回复层：把一段正文发到某条评论的楼中楼，并回读校验
 *
 * 纪律（《设计定稿》§10）：
 *   · 只回「@我」那条评论的楼中楼；不发顶层、不发私信
 *   · Referer 必须是**那条视频的页面**，否则 B站 返回 state=17（仅自己可见）
 *   · 发出后立刻回读，确认真的在列表里
 *   · 风控码要能区分：12051=重复评论（算成功）、-352/-412=被拦（当天熔断）
 */
import { biliGet, browserHeaders, cookieHeader } from './bili.mjs'
import { creds, BILI_REPLY_LIMIT } from './config.mjs'

const REPLY_API = 'https://api.bilibili.com/x/v2/reply/add'
const REPLY_LIST_API = 'https://api.bilibili.com/x/v2/reply/reply'

/** 这些错误码意味着"别再试了，今天就收手" */
/** 一律当日熔断的码：WAF 拦截 / 封禁 / 权限 */
export const BLOCKING_CODES = new Set([-412, -509, -799])

/**
 * 风控码（2026-11-08 从 BLOCKING_CODES 里拆出来）：
 * -352 有完整自救链路（v_voucher → gaia-vgate → 极验 → gaia_vtoken），
 * 一律熔断等于放弃恢复。现在单独标记，交给上层决定退避而不是熔断 24 小时。
 */
export const RISK_CODES = new Set([-352])
/** 重复评论：内容已经在了，视为成功 */
/**
 * 12051 = 「重复评论，请勿刷屏」——**是拒绝，不是成功**（2026-11-08 修）。
 * 之前当成功处理，导致一条被判重复就被永久标记完成，以后再也不重发。
 */
export const DUPLICATE_CODE = 12051

/**
 * 平台适配：把模型写的 markdown 变成 B 站能看的纯文本（**纯函数，不碰网络**）
 *
 * 为什么要有这一层（2026-11-06）：
 *   prompt 已经砍到极简（【视频】【文字稿】【目标】说说你怎么看），模型自然会用
 *   `## 小标题`、`**加粗**`、`[文字](链接)` 来组织内容。可 B 站评论区**不渲染 markdown**，
 *   用户看到的是一堆裸符号；而且模型会补素材里根本没有的外链（实测补过一篇经济观察网）。
 *   → 不改 prompt（用户要极简），改在这里做**输出适配**。
 *
 * 幂等：对已经处理过的纯文本再跑一次，结果不变。
 */
export function toBiliPlainText(text) {
  let t = String(text ?? '')
  if (!t) return ''

  // 代码块围栏：只去围栏，保留内容
  t = t.replace(/^[ \t]*```.*$/gm, '')
  // 行首标题：## 标题 → 标题（标题前后各留一个空行，保证仍分段）
  t = t.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '\n$1\n')
  // 行首引用
  t = t.replace(/^[ \t]*>[ \t]?/gm, '')
  // 分割线整行删掉
  t = t.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')
  // 行首列表标记 → 中文顿点（数字编号 1. 保留）
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1· ')
  // 链接：只留文字，链接整个丢掉
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内代码 / 加粗 / 斜体 / 删除线
  t = t.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/~~([^~]+)~~/g, '$1')
  // 收尾清理
  t = t.replace(/[ \t]+$/gm, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  t = t.replace(/^\n+/, '').replace(/\n+$/, '')
  return t
}

/** 句末标点（含随后的右引号/右括号/空白）—— 截断只认这个，**不拿换行凑数** */
const SENTENCE_END = /(?:[。！？；!?;…]+[」』"'”’）)\]】》〉*_`\s]*)/g
/** 切条可用的边界：句末标点或换行（换行切出来至少是完整一行，不会半句） */
const SENTENCE_BOUNDARY = /(?:[。！？；!?;…]+[」』"'”’）)\]】》〉*_`\s]*|\n+)/g

/**
 * 找到「≤ max 处最后一个句子边界」的**切点下标**（含标点）。
 *
 * 找不到任何句子边界时退回 max（硬切），保证返回的下标一定 ≤ max。
 * 归档模式（serve.mjs）和 splitForBili 的 truncateAtBoundary 共用这一份逻辑。
 *
 * @param {string} text
 * @param {number} max 最多保留多少字符
 * @returns {number} 切点（text.slice(0, 返回值)）
 */
export function cutAtSentenceBoundary(text, max) {
  const t = String(text ?? '')
  const cap = Math.max(0, Math.floor(Number(max) || 0))
  if (t.length <= cap) return t.length
  let best = 0
  for (const m of t.matchAll(SENTENCE_END)) {
    const p = m.index + m[0].length
    if (p > cap) break
    if (p > best) best = p
  }
  return best > 0 ? best : cap
}

/** 换行边界（把连续的 \r\n 一起算作一个边界） */
const NEWLINE_END = /\r?\n+/g

/**
 * 归档截断的**三级退化**切点（纯函数）。
 *
 * 2026-11-06：只认句末标点会在"标点稀疏"的稿子上贴不满 3000 字 ——
 * OCR 表格、弹幕体、诗歌里可能连续几百字没有一个句号，旧逻辑会截在很靠前的位置。
 * 现在按优先级找**离上限最近、且不超过上限**的边界：
 *
 *   ① 句末标点（。！？；…）
 *   ② 换行（至少是完整一行）
 *   ③ 都离上限超过 tolerance 字 → 直接在上限处硬切（"3000 附近就硬切"）
 *
 * 为什么要求边界 ≥ cap - tolerance：否则会为了"不硬切"而丢掉大段容量；
 * 宁可硬切，也要保证评论区贴出来的内容尽量满。
 *
 * 返回值一定 ≤ cap（调用方可以安全 slice）。
 *
 * @param {string} text
 * @param {number} max 最多保留多少字符
 * @param {{tolerance?:number}} [opts] 边界离上限多远还可以接受，默认 50 字
 * @returns {number} 切点（text.slice(0, 返回值)）
 */
export function cutAtBoundary(text, max, { tolerance = 50 } = {}) {
  const t = String(text ?? '')
  const cap = Math.max(0, Math.floor(Number(max) || 0))
  if (t.length <= cap) return t.length

  const slack = Math.max(0, Math.floor(Number(tolerance) || 0))
  const floor = Math.max(0, cap - slack)

  /** 该正则最后一个"结束位置 ≤ cap"的匹配终点；没有则 -1 */
  const lastEndAtOrBefore = (re) => {
    let end = -1
    for (const m of t.matchAll(re)) {
      const p = m.index + m[0].length
      if (p > cap) break
      end = p
    }
    return end
  }

  // ① 句末标点
  const sentence = lastEndAtOrBefore(SENTENCE_END)
  if (sentence >= floor) return sentence
  // ② 换行
  const newline = lastEndAtOrBefore(NEWLINE_END)
  if (newline >= floor) return newline
  // ③ 附近没有可读边界 → 硬切在上限
  return cap
}

/**
 * 把正文切成 B 站能发的一条或多条（**纯函数，不碰网络**）
 *
 * 规则（2026-11-06 定，配合"字数不设限"）：
 *   · 长度 ≤ limit → 原样一条
 *   · 超过 → 尽量均分，条数 = ceil(长度/limit)（2000 字两条、3000 字三条）
 *   · 切点优先落在**句子边界**，其次逗号/空格，最后才硬切
 *   · 硬切时**不许切在数字或英文单词中间**（"1.3|万颗" 这种最难看）
 *
 * `truncateAtBoundary`（召唤指令 —— 归档模式用）：
 *   正文超过 maxParts*limit 时，交给 cutAtBoundary 做三级退化（句末标点 → 换行 →
 *   离上限 50 字内硬切），而不是正好切在第 3000 个字上（那一下往往把一句话劈成两半）。
 *
 * @param {string} text
 * @param {number} [limit=BILI_REPLY_LIMIT] 单条上限（B 站硬限 1000）
 * @param {{maxParts?:number, truncateAtBoundary?:boolean}} [opts]
 * @returns {{parts:string[], truncated:boolean, limit:number, maxParts:number}}
 */
export function splitForBili(text, limit = BILI_REPLY_LIMIT, { maxParts = 3, truncateAtBoundary = false } = {}) {
  const t = String(text ?? '')
  const cap = Math.max(1, Math.floor(Number(limit) || BILI_REPLY_LIMIT))
  const max = Math.max(1, Math.floor(Number(maxParts) || 3))
  if (!t) return { parts: [], truncated: false, limit: cap, maxParts: max }
  if (t.length <= cap) return { parts: [t], truncated: false, limit: cap, maxParts: max }

  // 超过 maxParts 条的总容量：只保留能装下的部分，末条打省略号
  let work = t
  let truncated = false
  if (work.length > max * cap) {
    // 留 1 个字给末尾的省略号，否则截断点算上 "…" 会超容量。
    // truncateAtBoundary：三级退化（句末标点 → 换行 → 离上限 50 字内硬切）
    work = work.slice(0, truncateAtBoundary
      ? cutAtBoundary(work, max * cap - 1)
      : max * cap)
    truncated = true
  }

  const n = Math.min(max, Math.max(2, Math.ceil(work.length / cap)))
  const primary = cutPositions(work, SENTENCE_BOUNDARY)
  const secondary = cutPositions(work, /[，、,]\s*|\s+/g)

  const parts = []
  let start = 0
  for (let k = 1; k < n; k += 1) {
    const target = Math.round((work.length * k) / n)
    // 这一段必须 ≤ cap，同时给后面每条留够 cap
    const lo = Math.max(start + 1, work.length - (n - k) * cap)
    const hi = Math.min(start + cap, work.length - 1)
    let cut = pickCut(target, lo, hi, primary, secondary)
    cut = avoidMidToken(work, cut, lo, hi)
    parts.push(work.slice(start, cut))
    start = cut
  }
  parts.push(work.slice(start))

  if (truncated) {
    const last = parts[parts.length - 1]
    parts[parts.length - 1] = last.length >= cap ? `${last.slice(0, cap - 1)}…` : `${last}…`
  }

  return { parts, truncated, limit: cap, maxParts: max }
}

/**
 * 别把数字或英文单词切两半。
 *   "…规划约 1.3 万颗" 在 1.3 后面切是能接受的，切在 "1.3" 中间就难看。
 * 做法：切点两侧同时是数字（或同时是 ASCII 字母）时，在 [lo,hi] 里左右挪一挪。
 */
function avoidMidToken(text, cut, lo, hi) {
  const isDigit = (ch) => ch >= '0' && ch <= '9'
  const isLatin = (ch) => /[A-Za-z]/.test(ch || '')
  const bad = (p) => {
    if (p <= 0 || p >= text.length) return false
    const a = text[p - 1]
    const b = text[p]
    return (isDigit(a) && isDigit(b)) || (isLatin(a) && isLatin(b))
  }
  if (!bad(cut)) return cut
  for (let d = 1; d <= 12; d += 1) {
    for (const p of [cut - d, cut + d]) {
      if (p > lo && p < hi && p > 0 && p < text.length && !bad(p)) return p
    }
  }
  return cut
}

/** 找出所有可切位置（切在该下标之前）：句末标点/换行之后 */
function cutPositions(text, re) {
  const out = new Set()
  for (const m of text.matchAll(re)) out.add(m.index + m[0].length)
  return out
}

/** 在 [lo,hi] 里挑离 target 最近的切点：优先句子边界，其次逗号，最后硬切 */
function pickCut(target, lo, hi, primary, secondary) {
  for (const set of [primary, secondary]) {
    let best = null
    for (const p of set) {
      if (p < lo) continue
      if (p > hi) break
      if (best === null || Math.abs(p - target) < Math.abs(best - target)) best = p
    }
    if (best !== null) return best
  }
  return Math.min(hi, Math.max(lo, target))
}

export async function postReply({ aid, bvid, root, parent, message }) {
  const c = creds()
  if (!c.bili_jct) throw new Error('缺 bili_jct，无法发评论（需要重新登录）')
  if (!message || !String(message).trim()) throw new Error('正文为空')
  if (String(message).length > BILI_REPLY_LIMIT) throw new Error(`正文 ${String(message).length} 字符 > ${BILI_REPLY_LIMIT}`)

  const form = new URLSearchParams({
    oid: String(aid),
    type: '1',
    root: String(root),
    parent: String(parent),
    message: String(message),
    plat: '1',
    csrf: c.bili_jct,
  })

  const res = await fetch(REPLY_API, {
    method: 'POST',
    headers: {
      ...browserHeaders(`https://www.bilibili.com/video/${bvid}/`),
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(),
    },
    body: form.toString(),
  })
  const json = await res.json().catch(() => ({}))
  return {
    http: res.status,
    code: json.code,
    message: json.message,
    rpid: json.data?.rpid ?? json.data?.reply?.rpid ?? null,
    state: json.data?.reply?.state ?? json.data?.state ?? null,
    raw: json,
  }
}

/** 回读：确认这条 rpid 真的出现在该楼的回复列表里 */
/**
 * 回读验证（2026-11-08 重写，修三个问题）
 *
 * ① **带自己的 cookie 查 = 假阳性**。`state=17`（阿瓦隆「仅自己可见」）的定义
 *    就是「自己看得见、别人看不见」，所以带 cookie 查一定命中 —— 影子封禁会被
 *    100% 判成成功。这里再发一次**不带 cookie** 的匿名请求，看得见才算真发出去。
 * ② 楼中楼单页**最多返回 20 条**（传 ps=30/49 也只回 20），热门楼里新回复不在
 *    前 20 条就会误判「没发出去」。改成翻页找。
 * ③ 只判 state 不够，还要看 invisible。
 */
export async function verifyReply({ aid, root, rpid, tries = 4, gapMs = 1500, pages = 3 }) {
  const findIn = (list) => (list || []).find((r) => String(r.rpid) === String(rpid))

  for (let i = 0; i < tries; i += 1) {
    let hit = null
    try {
      for (let pn = 1; pn <= pages; pn += 1) {
        const d = await biliGet(
          `${REPLY_LIST_API}?oid=${aid}&type=1&root=${root}&ps=20&pn=${pn}`,
          { headers: { Referer: 'https://www.bilibili.com/' } },
        )
        hit = findIn(d.replies)
        if (hit) break
        if ((d.replies || []).length < 20) break // 没有下一页了
      }
    } catch { /* 网抖，再试 */ }

    if (hit) {
      // 匿名复查：别人能不能看到（这一步才是真正的"发出去了吗"）
      let visible = null
      try {
        const res = await fetch(
          `${REPLY_LIST_API}?oid=${aid}&type=1&root=${root}&ps=20&pn=1`,
          { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } },
        )
        const anon = await res.json()
        visible = Boolean(findIn(anon?.data?.replies))
      } catch { visible = null }

      return {
        found: true,
        visible,
        state: hit.state,
        invisible: Boolean(hit.invisible),
        shadowBanned: visible === false || Boolean(hit.invisible) || hit.state === 17,
        like: hit.like ?? 0,
      }
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  return { found: false, visible: null }
}
