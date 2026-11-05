import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectStyle, toTimedText, mergeSentences, fitMaterial, buildPrompt,
  extractStamps, stampToSec, selfCheck, splitParts,
} from '../lib/compose.mjs'
import { BILI_REPLY_LIMIT } from '../lib/config.mjs'

const video = (over = {}) => ({
  bvid: 'BV1234567890', aid: 1, cid: 2, title: '测试视频标题',
  owner: '某UP', duration: 600, stat: { view: 1, danmaku: 1, reply: 1 }, ...over,
})

/* ── 体裁 ── */
test('体裁：音乐优先于教学', () => {
  assert.equal(detectStyle(video({ title: '钢琴教学：翻唱某歌' })).key, 'music')
  assert.equal(detectStyle(video({ title: '从零开始学 MySQL 索引原理' })).key, 'teaching')
  assert.equal(detectStyle(video({ title: '今天吃了碗面' })).key, 'talk')
})

/* ── 时间戳 ── */
test('时间戳：只认行首纯文本', () => {
  const t = '开头\n03:52 这里\n**05:14** 加粗不算\n[08:51] 方括号不算\n12:34:56 超过一小时\n结尾'
  assert.deepEqual(extractStamps(t), ['03:52', '12:34:56'])
})

test('时间戳：秒数换算', () => {
  assert.equal(stampToSec('03:52'), 232)
  assert.equal(stampToSec('01:00:00'), 3600)
})

/* ── prompt（2026-11-06 砍到三块）── */
const videoFix = video({ title: '测试视频标题', owner: '某UP', duration: 92, stat: { view: 12, danmaku: 3, reply: 4 } })
const timedFix = [{ t: 0, c: '第一句。' }, { t: 65, c: '第二句。' }]
const promptFor = (over = {}) => buildPrompt({
  video: videoFix, timed: timedFix, coverage: 0.5, tier: 'subtitle', ...over,
})

test('prompt：只有【视频】【文字稿】【目标】三块', () => {
  const p = promptFor()
  assert.deepEqual(p.match(/^【[^】]+】$/gm), ['【视频】', '【文字稿】', '【目标】'])
})

test('prompt：不含字数 / 两段 / 分点 / 禁用词这类约束', () => {
  const p = promptFor()
  assert.doesNotMatch(p, /字数|600|800|两段|分点|小标题|【总结】|我的看法|不要用|禁止|怎么写/)
})

test('prompt：视频 / 文字稿 / 目标三块的内容正确', () => {
  const p = promptFor()
  assert.match(p, /^【视频】\n标题：测试视频标题\nUP主：某UP\n时长：01:32\n数据：播放 12 · 弹幕 3 · 评论 4\n\n【文字稿】/)
  assert.match(p, /来源：B站官方 AI 字幕；覆盖 00:00 到 01:05（占全片约 50%）/)
  assert.match(p, /\[00:00\] 第一句。\n\[01:05\] 第二句。/)
  assert.match(p, /\n\n【目标】\n说说你怎么看$/)
})

test('prompt：--ask 在【目标】下面单独一行', () => {
  const p = promptFor({ ask: '重点讲 PTC 那段' })
  assert.match(p, /【目标】\n说说你怎么看\n另外：重点讲 PTC 那段$/)
})

test('prompt：素材被裁时保留抽样提示（放在来源下面）', () => {
  const timed = Array.from({ length: 500 }, (_, i) => ({ t: i * 5, c: '字'.repeat(60) }))
  const p = buildPrompt({ video: videoFix, timed, coverage: 0.9, tier: 'ocr' })
  assert.match(p, /来源：画面 OCR[^\n]*\n⚠️ 文字稿过长已按时间抽样/)
  assert.match(p, /此处省略/)
})

/* ── 自检（2026-11-06 放宽：只拦空正文；超 1000 是拆分信号）── */
const okText = '这条视频主张，把复杂任务拆成小步可以降低出错率，并举了一个团队协作的例子。' +
  '它的论证从任务拆解讲到责任划分，最后落到执行节奏。\n\n' +
  '我更认同它对任务拆解那部分的判断，但责任划分那一段缺少反例支撑，实际团队里边界往往比它说的模糊。'

test('自检：正常文本通过', () => {
  const r = selfCheck(okText, { tier: 'subtitle' })
  assert.equal(r.ok, true, r.issues.join(';'))
  assert.equal(r.needSplit, false)
  assert.equal(r.stamps.length, 0)
})

test('自检：空正文 → 不通过', () => {
  const r = selfCheck('   ', { tier: 'subtitle' })
  assert.equal(r.ok, false)
  assert.ok(r.issues.includes('空正文'))
})

test('自检：超 1000 只标记 needSplit，不打回重写', () => {
  const r = selfCheck('字'.repeat(1200), { tier: 'subtitle' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.issues, [])
  assert.equal(r.needSplit, true)
  assert.equal(r.limit, BILI_REPLY_LIMIT)
  assert.equal(r.chars, 1200)
  assert.ok(r.warnings.some((w) => /拆成多条/.test(w)))
})

test('自检：没分两段 / 总结夹评价 / 感悟没判断 都不再判不通过', () => {
  for (const txt of [
    '这段把总结和看法混在一起了，我觉得不行。',
    '这条视频讲了A，但我觉得A站不住。\n\n我的看法是它不成立。',
    '这条视频讲了A和B，还举了两个例子。\n\n属实。',
  ]) {
    const r = selfCheck(txt, { tier: 'subtitle' })
    assert.equal(r.ok, true, r.issues.join('；'))
  }
})

test('自检：复读标题不再判不通过', () => {
  const title = '从零开始学MySQL索引原理与优化实战'
  const r = selfCheck(`关于${title}这件事说两句\n` + okText, { tier: 'subtitle' })
  assert.equal(r.ok, true, r.issues.join('；'))
})

test('自检：AI 腔 / 假装看过 降级为提醒，不拦生成', () => {
  const ai = selfCheck('本期视频干货满满，值得一看。' + okText, { tier: 'subtitle' })
  assert.equal(ai.ok, true)
  assert.ok(ai.warnings.some((w) => /AI 腔/.test(w)))

  const fake = selfCheck(okText + '\n我看了这期视频，画面里有个表格。', { tier: 'subtitle' })
  assert.equal(fake.ok, true)
  assert.ok(fake.warnings.some((w) => /假装看过/.test(w)))
})

test('自检：时间戳只提醒', () => {
  const r = selfCheck(okText + '\n10:01 结尾', { tier: 'subtitle' })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => /时间戳/.test(w)))
})

test('自检：parts 兼容保留（拆不出来时全文当第一段）', () => {
  const r = selfCheck('全都混在一起了。', { tier: 'subtitle' })
  assert.equal(r.parts.summary, '全都混在一起了。')
  assert.equal(r.parts.view, '')
})

/* ── 总结 / 感悟 必须分开 ── */
test('分两段：空行分隔', () => {
  const p = splitParts('总结内容。\n\n我的看法是不同的。')
  assert.equal(p.summary, '总结内容。')
  assert.equal(p.view, '我的看法是不同的。')
})

test('分两段：多段时第二段起都算感悟', () => {
  const p = splitParts('总结。\n\n看法一。\n\n看法二。')
  assert.equal(p.view, '看法一。\n\n看法二。')
})

test('分两段：label 模式下同一段里的「总结：/看法：」也能切开', () => {
  const p = splitParts('总结：讲了A和B。看法：我觉得B有问题。', 'label')
  assert.equal(p.summary, '讲了A和B。')
  assert.equal(p.view, '我觉得B有问题。')
})

test('分两段：拆不出来时全文当第一段、第二段为空，不抛错', () => {
  const p = splitParts('全都混在一起了。')
  assert.equal(p.summary, '全都混在一起了。')
  assert.equal(p.view, '')
  assert.equal(p.splitBy, 'none')
})

test('自检：正常两段（总结客观 + 感悟有判断）→ 通过', () => {
  const txt = '这条视频认为A会导致B，并给了两个例子。\n\n我更认同它的第一点，但第二点的反例很多，比如C。'
  const r = selfCheck(txt, { tier: 'subtitle' })
  assert.equal(r.ok, true, r.issues.join('；'))
})
test('素材：三种来源都归一成同构格式', () => {
  const fromSub = toTimedText([{ from: 5, to: 8, content: 'A' }])
  const fromAsr = toTimedText([{ t: 5, text: 'A' }])
  assert.deepEqual(fromSub, fromAsr)
})

test('素材：超预算时抽样但保留头尾', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => ({ t: i, c: '字'.repeat(20) }))
  const r = fitMaterial(lines, 2000)
  assert.equal(r.truncated, true)
  assert.ok(r.lines.length >= 20)
  assert.equal(r.lines[0].t, 0)
  assert.equal(r.lines.at(-1).t, 999)
})

test('素材：超预算时中段整段丢弃，并标出缺口位置', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => ({ t: i, c: '字'.repeat(20) }))
  const r = fitMaterial(lines, 2000)
  assert.ok(r.skipped.length > 0, '应该有被省略的中段')
  assert.ok(Number.isFinite(r.gapAt) && r.gapAt > 0 && r.gapAt < 999, 'gapAt 应在头尾之间')
  assert.equal(r.headCount + r.skipped.length + r.tailCount, 1000, '头+中+尾要等于总数，不重不漏')
})

test('素材：不超预算时原样返回，不截断', () => {
  const lines = [{ t: 0, c: '短' }, { t: 5, c: '也短' }]
  const r = fitMaterial(lines, 10000)
  assert.equal(r.truncated, false)
  assert.equal(r.lines.length, 2)
  assert.equal(r.gapAt, null)
})

test('素材：预算极小时也至少留下开头，不返回空', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ t: i, c: '长'.repeat(50) }))
  const r = fitMaterial(lines, 10)
  assert.ok(r.lines.length > 0, '不能返回空数组')
})

/* ── 逐句字幕拼段 ── */
const sub = (t, c) => ({ t, c })

test('拼段：没有句末标点的短句接上，时间锚点保留第一句', () => {
  const raw = [
    sub(0, '试用期做什么'),
    sub(2, '才能更顺利地通过'),
    sub(4, '作为一个提前通过答辩的人。'),
    sub(9, '我想分享一个标准答案'),
  ]
  const m = mergeSentences(raw)
  assert.equal(m.length, 2)
  assert.equal(m[0].t, 0)
  assert.equal(m[0].c, '试用期做什么才能更顺利地通过作为一个提前通过答辩的人。')
  assert.equal(m[1].c, '我想分享一个标准答案')
})

test('拼段：间隔过大的不合并', () => {
  const m = mergeSentences([sub(0, '前半句'), sub(10, '后半句')], { maxGapSec: 2 })
  assert.equal(m.length, 2)
})

test('拼段：合并后不超长', () => {
  const m = mergeSentences([sub(0, '甲'.repeat(70)), sub(1, '乙'.repeat(70))], { maxLen: 120 })
  assert.equal(m.length, 2)
})

test('拼段：原文不受影响（不可变）', () => {
  const raw = [sub(0, '甲'), sub(1, '乙')]
  const copy = JSON.parse(JSON.stringify(raw))
  mergeSentences(raw)
  assert.deepEqual(raw, copy)
})
