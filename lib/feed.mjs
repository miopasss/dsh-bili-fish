/**
 * @ 消息：拉取与归一化
 *
 * 端点：GET /x/msgfeed/at（需登录）
 * 实测结论（2026-11-04）：
 *   · 回复后消息**不会消失**，已读状态也不可靠 → 幂等必须靠 rpid，见 lib/store.mjs
 *   · `item.subject_id` 是 **aid**（整个稿件），不带分P信息
 *   · `item.source_id` 是那条评论的 **rpid**
 *   · `item.root_id`/`target_id` 为 0 表示被 @ 的是**顶层评论**
 */
import { biliGet } from './bili.mjs'

/** 只关心视频评论区的 @（business_id=1）；私信/动态等其他业务一律忽略 */
export function normalizeAt(it) {
  const item = it?.item || {}
  if (item.business_id !== 1) return null
  const bvid = (String(item.uri || '').match(/BV[0-9A-Za-z]{10}/) || [null])[0]
  if (!bvid || !item.source_id) return null
  return {
    atId: it.id,
    atTime: it.at_time,
    mid: it.user?.mid,
    nickname: it.user?.nickname,
    bvid,
    aid: item.subject_id,
    rpid: item.source_id,
    rootId: item.root_id ?? 0,
    targetId: item.target_id ?? 0,
    text: item.source_content ?? '',
    title: item.title ?? '',
  }
}

/** 拉取 @ 列表（新的在前） */
export async function fetchAtMessages() {
  const d = await biliGet('https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web')
  return (d.items || []).map(normalizeAt).filter(Boolean)
}

/** 未读计数（只用于日志展示，不可作为"处理过没有"的依据） */
export async function fetchUnread() {
  try { return await biliGet('https://api.bilibili.com/x/msgfeed/unread') } catch { return null }
}
