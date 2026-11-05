/**
 * 字幕可用性校验（2026-11-05 加）
 *
 * 起因：实测 BV1xfxU67Ets（斗地主那期）的 B站 AI 字幕**全是 BGM 歌词**
 * （45 行 100% 带 ♪），而真正的分析内容在画面文字里（探针 100 字/帧）。
 * 只读字幕就会复述一套不存在的内容。
 *
 * 参照：`dsh-bili-watch` 有「反钓鱼自查」，但它用**语速**判，
 * 而这条视频语速 3.0 字/秒 —— 完全落在正常口播区间（2.0–8.5），抓不到。
 * 所以这里换成两个更直接的信号：
 *
 *   A. **歌词记号占比**：♪ ♫ 🎵 🎶 出现得够多 → 字幕就是歌词
 *   B. **标题词重合为 0**：标题拆成双字词，一个都没在字幕里出现 → 字幕和标题对不上
 *
 * 两个都是纯文本判断，不花任何网络/OCR 成本；命中之后才值得去跑探针。
 */

/** 歌词记号（B站 AI 字幕给 BGM 打的就是 ♪） */
const LYRIC_MARK = /[♪♫🎵🎶]/

export const DEFAULT_RULES = {
  /** A：歌词记号占比超过这个值就判可疑 */
  lyricRatioMax: 0.2,
  /** B：标题双字词少于这个数就不做判断（标题太短没有统计意义） */
  titleGramsMin: 8,
  /** B：字幕正文少于这个字数就不做判断 */
  minChars: 100,
}

/** 歌词记号占比 */
export function lyricRatio(lines) {
  const arr = (lines || []).filter((l) => l && l.c)
  if (!arr.length) return 0
  return arr.filter((l) => LYRIC_MARK.test(l.c)).length / arr.length
}

/** 标题 → 双字词集合（去掉标点空格，纯中文/字母/数字） */
export function titleBigrams(title) {
  const t = String(title || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2))
  return set
}

/** 标题双字词在字幕里出现了几个 */
export function titleOverlap(lines, title) {
  const grams = titleBigrams(title)
  const text = (lines || []).map((l) => l.c || '').join('').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  let hit = 0
  for (const g of grams) if (text.includes(g)) hit += 1
  return { hit, total: grams.size, ratio: grams.size ? hit / grams.size : 1 }
}

/**
 * @param {{lines:Array<{t:number,c:string}>, title:string, rules?:object}} args
 * @returns {{suspicious:boolean, reasons:string[], lyricRatio:number, overlap:object}}
 */
export function checkSubtitleQuality({ lines, title, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules }
  const arr = (lines || []).filter((l) => l && l.c)
  const chars = arr.reduce((n, l) => n + l.c.length, 0)
  const reasons = []

  const lr = lyricRatio(arr)
  if (lr > R.lyricRatioMax) {
    reasons.push(`歌词记号 ♪ 占 ${Math.round(lr * 100)}% —— 这份字幕是 BGM 歌词，不是台词`)
  }

  const ov = titleOverlap(arr, title)
  if (chars >= R.minChars && ov.total >= R.titleGramsMin && ov.hit === 0) {
    reasons.push(`标题的 ${ov.total} 个双字词在字幕里一个都没出现 —— 字幕和标题对不上`)
  }

  return { suspicious: reasons.length > 0, reasons, lyricRatio: lr, overlap: ov, chars }
}
