import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lyricRatio, titleBigrams, titleOverlap, checkSubtitleQuality } from '../lib/subtitle-check.mjs'

const line = (t, c) => ({ t, c })
const LYRICS = [
  line(3, '♪ 我走在长街中听戏子唱 ♪'),
  line(6, '♪ 京城人杂乱戏小丑叶黄 ♪'),
  line(10, '♪ 退入长秋悠悠的古城中 ♪'),
]
const NORMAL = [
  line(0, '我们高等数学是微积分学'),
  line(3, '我们研究的对象就是函数'),
  line(6, '极限是所有研究微分积分的基础'),
  line(9, '集合的运算有并交差余四种'),
  line(12, '高等数学这门课先从集合讲起'),
]

test('歌词占比：♫ 记号能算出来', () => {
  assert.equal(lyricRatio(LYRICS), 1)
  assert.equal(lyricRatio(NORMAL), 0)
  assert.equal(lyricRatio([]), 0)
})

test('歌词占比：空行/无 c 的行不影响', () => {
  assert.equal(lyricRatio([line(0, '♪ 啊 ♪'), null, line(1, '')]), 1)
})

test('标题双字词：去标点空格', () => {
  const g = titleBigrams('斗地主，为什么？')
  assert.ok(g.has('斗地'))
  assert.ok(g.has('地主'))
  assert.ok(!g.has('，为'))
})

test('标题重合：歌词视频命中 0', () => {
  const ov = titleOverlap(LYRICS, '斗地主中，为什么地主只有三张牌的优势就可以一打二了？')
  assert.equal(ov.hit, 0)
  assert.ok(ov.total >= 8)
})

test('标题重合：正常视频有命中', () => {
  const ov = titleOverlap(NORMAL, '【樊顺厚】《高等数学》全集 | 全320讲')
  assert.ok(ov.hit > 0, `应该命中，实际 ${ov.hit}/${ov.total}`)
})

test('综合判定：纯歌词字幕判可疑（两个理由都命中）', () => {
  const r = checkSubtitleQuality({ lines: LYRICS.concat(LYRICS), title: '斗地主中，为什么地主只有三张牌的优势就可以一打二了？' })
  assert.equal(r.suspicious, true)
  assert.ok(r.reasons.some((x) => x.includes('歌词')))
})

test('综合判定：正常字幕不误判', () => {
  const r = checkSubtitleQuality({ lines: NORMAL, title: '【樊顺厚】《高等数学》全集 | 建议收藏 | 全320讲' })
  assert.equal(r.suspicious, false, r.reasons.join('；'))
})

test('综合判定：标题太短就不做「零重合」判断', () => {
  const r = checkSubtitleQuality({ lines: LYRICS, title: '啊' })
  assert.equal(r.overlap.total <= 1, true)
  assert.ok(!r.reasons.some((x) => x.includes('标题的')))
})

test('综合判定：字幕太短就不做「零重合」判断（避免误杀短视频）', () => {
  const short = [line(0, '♪ 一句话 ♪')]
  const r = checkSubtitleQuality({ lines: short, title: '斗地主中，为什么地主只有三张牌的优势就可以一打二了？' })
  // 歌词占比 100% 仍会命中 A，但 B 不该命中
  assert.ok(!r.reasons.some((x) => x.includes('标题的')))
  assert.equal(r.suspicious, true)
})

test('综合判定：规则可覆盖', () => {
  const r = checkSubtitleQuality({ lines: LYRICS, title: '斗地主中，为什么地主只有三张牌的优势', rules: { lyricRatioMax: 1.1 } })
  assert.ok(!r.reasons.some((x) => x.includes('歌词记号')))
})
