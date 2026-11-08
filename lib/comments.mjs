/**
 * 评论素材层（2026-11-08）
 *
 * 支撑两种新分析对象：
 *   · comments —— 整个视频评论区（热评 + 最新）
 *   · thread   —— 某一个楼（root 评论 + 楼中楼回复，按时间正序）
 *
 * 和视频素材层（lib/media.mjs）的区别：这里不下载任何东西，全是接口。
 * 所以没有 OCR/ASR 那种降级链，只有「拉得到」和「拉不到」。
 */
import { biliGet } from './bili.mjs'

/** 楼层里每条评论归一成这个形状 */
const pick = (r) => ({
  rpid: String(r.rpid),
  uname: String(r.member?.uname ?? '匿名'),
  mid: String(r.mid ?? r.member?.mid ?? ''),
  level: r.member?.level_info?.current_level ?? null,
  like: Number(r.like ?? 0),
  ctime: Number(r.ctime ?? 0),
  replyCount: Number(r.rcount ?? 0),
  content: String(r.content?.message ?? '').trim(),
})

/**
 * 拉主评论列表的一页。
 * @param {'hot'|'time'} sort
 * @returns {Promise<{list:Array, next:string|null, total:number}>}
 */
export async function fetchCommentPage(aid, { sort = 'hot', next = null, pn = 1, ps = 20 } = {}) {
  if (sort === 'hot') {
    // ⚠️ 这个接口的 pn 是**无效的**（传 1/2/3 都返回同一页），必须用 pagination_str 传偏移量：
    //    pagination_str={"offset":"<上一页 cursor.pagination_reply.next_offset>"}（URL 编码）
    const q = new URLSearchParams({ oid: String(aid), type: '1', mode: '3', ps: String(ps) })
    if (next) q.set('pagination_str', JSON.stringify({ offset: next }))
    const d = await biliGet(`https://api.bilibili.com/x/v2/reply/main?${q}`)
    // 主评论接口的 code 有时是 undefined（字段缺失），用 replies 数组判断成败
    const list = (d.replies || []).map(pick)
    return {
      list,
      next: d.cursor?.pagination_reply?.next_offset ?? null,
      total: Number(d.cursor?.all_count ?? list.length),
    }
  }
  // 旧接口 pn 有效（实测 pn=1/2/3 返回不同数据），最新的在上，正好适合"取最新 N 条"
  const q = new URLSearchParams({ oid: String(aid), type: '1', sort: '0', ps: String(ps), pn: String(pn) })
  const d = await biliGet(`https://api.bilibili.com/x/v2/reply?${q}`)
  const list = (d.replies || []).map(pick)
  return {
    list,
    next: pn * ps < Number(d.page?.acount ?? 0) ? String(pn + 1) : null,
    total: Number(d.page?.acount ?? list.length),
  }
}

/** 拉够 N 条主评论（自动翻页，最多翻 maxPages 页，防跑飞） */
export async function fetchTopComments(aid, { sort = 'hot', want = 50, maxPages = 5 } = {}) {
  const out = []
  let next = null
  let pn = 1
  let total = 0
  for (let i = 0; i < maxPages && out.length < want; i += 1) {
    const page = await fetchCommentPage(aid, { sort, next, pn })
    total = page.total || total
    if (!page.list.length) break
    out.push(...page.list)
    if (!page.next) break
    if (sort === 'hot') next = page.next
    else pn += 1
  }
  return { list: out.slice(0, want), total }
}

/**
 * 拉一个楼（root 评论 + 楼中楼回复）
 *
 * B站的楼中楼是**一层压平**：回复的回复也挂在同一个 root 下面，
 * 所以这里只需要 root 一层的列表，不需要递归。
 */
export async function fetchThread(aid, rootRpid, { maxPages = 10 } = {}) {
  // 先拿 root 本身（可能不在前几页热评里，所以直接按 rpid 查）
  let root = null
  try {
    const d = await biliGet(`https://api.bilibili.com/x/v2/reply/detail?oid=${aid}&type=1&root=${rootRpid}`)
    const r = d.root ?? d.reply ?? null
    if (r) root = pick(r)
  } catch { /* detail 接口不稳定，下面用回复数兜底 */ }

  const replies = []
  for (let pn = 1; pn <= maxPages; pn += 1) {
    const d = await biliGet(
      `https://api.bilibili.com/x/v2/reply/reply?oid=${aid}&type=1&root=${rootRpid}&ps=20&pn=${pn}`,
    )
    const list = (d.replies || []).map(pick)
    if (!list.length) break
    replies.push(...list)
    if (list.length < 20) break
  }

  // 时间正序：楼中楼是对话，顺序错了就读不懂
  replies.sort((a, b) => a.ctime - b.ctime)

  return { root, replies, total: replies.length }
}

/** 一条评论渲染成一行素材 */
export function renderComment(c, i) {
  const when = c.ctime ? new Date(c.ctime * 1000).toISOString().slice(0, 10) : ''
  const lv = c.level == null ? '' : ` Lv${c.level}`
  return `[${i}] ${c.uname}${lv} · 赞${c.like}${c.replyCount ? ` · 回${c.replyCount}` : ''}${when ? ` · ${when}` : ''}\n${c.content}`
}

/**
 * 按字数截断（楼中楼用）
 *
 * 为什么要按字数而不是条数：一个楼可能是 2 条长回复，也可能是 80 条短回复，
 * 按条数截对前者浪费预算、对后者撑爆上下文。
 */
export function truncateByChars(list, maxChars, render = renderComment) {
  const kept = []
  let used = 0
  for (let i = 0; i < list.length; i += 1) {
    const line = render(list[i], i)
    if (used + line.length > maxChars && kept.length > 0) break
    kept.push(list[i])
    used += line.length + 1
  }
  return { kept, used, dropped: list.length - kept.length }
}
