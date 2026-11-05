/**
 * 回复层：正文拆分（纯函数，不发任何请求）
 *
 * 2026-11-06：字数不设限 → 超 1000 不再重写，而是在句子边界拆成 2 条（最多 3 条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitForBili } from '../lib/reply.mjs'
import { BILI_REPLY_LIMIT } from '../lib/config.mjs'

const SENT = '这句话用来测试拆分逻辑是否可靠。' // 16 字，以句号结尾
const make = (n) => SENT.repeat(n)

test('拆分：≤1000 不拆，原样一条', () => {
  const t = make(60) // 960 字
  const r = splitForBili(t)
  assert.equal(r.parts.length, 1)
  assert.equal(r.parts[0], t)
  assert.equal(r.truncated, false)
})

test('拆分：恰好 1000 不拆', () => {
  const t = '字'.repeat(BILI_REPLY_LIMIT)
  const r = splitForBili(t)
  assert.equal(r.parts.length, 1)
  assert.equal(r.parts[0].length, BILI_REPLY_LIMIT)
})

test('拆分：超 1000 按句号切成两条，每条 ≤1000', () => {
  const t = make(67) // 1072 字
  const r = splitForBili(t)
  assert.equal(r.parts.length, 2)
  assert.equal(r.truncated, false)
  for (const p of r.parts) assert.ok(p.length <= BILI_REPLY_LIMIT, `单条 ${p.length} > 1000`)
  assert.ok(r.parts[0].endsWith('。'), '第一条应在句号后结束')
  assert.ok(r.parts[1].endsWith('。'), '第二条应在句号后结束')
})

test('拆分：两条尽量均分，不出现"第二条只剩几个字"', () => {
  const t = make(67)
  const r = splitForBili(t)
  const [a, b] = r.parts.map((p) => p.length)
  assert.ok(Math.abs(a - b) <= SENT.length, `两条长度差 ${Math.abs(a - b)} 超过一句`)
  assert.ok(Math.min(a, b) >= t.length * 0.4, `较短一条只有 ${Math.min(a, b)} 字，切得太偏`)
})

test('拆分：拼接后内容无丢失（逐字相等）', () => {
  for (const n of [67, 100, 120, 150]) {
    const t = make(n)
    const r = splitForBili(t)
    assert.equal(r.parts.join(''), t, `n=${n} 拼接后与原文不一致`)
    assert.equal(r.truncated, false, `n=${n} 不该截断`)
  }
})

test('拆分：2400 字均分成三条，每条 ≤1000', () => {
  const t = make(150) // 2400 字
  const r = splitForBili(t)
  assert.equal(r.parts.length, 3)
  assert.equal(r.parts.join(''), t)
  for (const p of r.parts) assert.ok(p.length <= BILI_REPLY_LIMIT)
  const lens = r.parts.map((p) => p.length)
  assert.ok(Math.max(...lens) - Math.min(...lens) <= SENT.length, `三条不均匀：${lens.join('/')}`)
})

test('拆分：换行也是句子边界', () => {
  const t = '甲'.repeat(600) + '\n' + '乙'.repeat(600)
  const r = splitForBili(t)
  assert.equal(r.parts.length, 2)
  assert.equal(r.parts.join(''), t)
  assert.ok(r.parts[0].endsWith('\n'), '应在换行处切开')
  for (const p of r.parts) assert.ok(p.length <= BILI_REPLY_LIMIT)
})

test('拆分：问号/感叹号/分号同样可切', () => {
  const t = ('真的吗？'.repeat(260)) + ('太好了！'.repeat(30))
  const r = splitForBili(t)
  assert.equal(r.parts.length, 2)
  assert.equal(r.parts.join(''), t)
  assert.match(r.parts[0].slice(-1), /[？!！。；;]/)
})

test('拆分：无标点长文只能硬切，但也要均分且不超限', () => {
  const t = '字'.repeat(1500)
  const r = splitForBili(t)
  assert.equal(r.parts.length, 2)
  assert.equal(r.parts.join(''), t)
  for (const p of r.parts) assert.ok(p.length <= BILI_REPLY_LIMIT)
  assert.ok(Math.abs(r.parts[0].length - r.parts[1].length) <= 1, '硬切也应均分')
})

test('拆分：极端长文最多 3 条，超出截断并标记 truncated', () => {
  const t = '字'.repeat(3500)
  const r = splitForBili(t)
  assert.equal(r.parts.length, 3)
  assert.equal(r.truncated, true)
  for (const p of r.parts) assert.ok(p.length <= BILI_REPLY_LIMIT)
  assert.ok(r.parts[2].endsWith('…'), '截断的末条应有省略号')
})

test('拆分：空正文返回空数组', () => {
  const r = splitForBili('')
  assert.deepEqual(r.parts, [])
  assert.equal(r.truncated, false)
})

test('拆分：limit 可覆盖（便于单测），maxParts 生效', () => {
  const t = make(10) // 160 字
  const r = splitForBili(t, 50, { maxParts: 2 })
  assert.equal(r.parts.length, 2)
  assert.equal(r.truncated, true)
  for (const p of r.parts) assert.ok(p.length <= 50)
})

/* ── 平台适配：markdown → B站纯文本 ── */
import { toBiliPlainText } from '../lib/reply.mjs'

test('适配：## 标题去井号，保留文字', () => {
  const out = toBiliPlainText('## 一、结论\n正文')
  assert.ok(!out.includes('##'))
  assert.ok(out.includes('一、结论'))
  assert.ok(out.includes('正文'))
})

test('适配：加粗/斜体/删除线去掉标记', () => {
  const out = toBiliPlainText('这是**重点**和*强调*还有~~废弃~~')
  assert.equal(out, '这是重点和强调还有废弃')
})

test('适配：链接只留文字，整个 URL 丢掉', () => {
  const out = toBiliPlainText('数据见[经济观察网](https://m.eeo.com.cn/2025/1108/765383.shtml)')
  assert.equal(out, '数据见经济观察网')
  assert.ok(!out.includes('http'))
})

test('适配：行内代码去反引号，围栏整行删掉', () => {
  const out = toBiliPlainText('跑 `node bin.js` 即可\n```\ncode\n```')
  assert.ok(out.includes('跑 node bin.js 即可'))
  assert.ok(!out.includes('`'))
})

test('适配：行首 - * + 换成中文顿点，数字编号保留', () => {
  const out = toBiliPlainText('- 甲\n* 乙\n+ 丙\n1. 丁')
  assert.equal(out, '· 甲\n· 乙\n· 丙\n1. 丁')
})

test('适配：引用符号与分割线被清掉', () => {
  const out = toBiliPlainText('> 引用一句\n---\n正文')
  assert.ok(!out.includes('>'))
  assert.ok(!out.includes('---'))
  assert.ok(out.includes('引用一句'))
})

test('适配：连续空行压成两行，首尾不留空行', () => {
  const out = toBiliPlainText('\n\n甲\n\n\n\n乙\n\n')
  assert.equal(out, '甲\n\n乙')
})

test('适配：幂等 —— 纯文本再跑一次不变', () => {
  const src = '## 标题\n这是**粗**体，见[某站](https://x.com)\n- 项目\n'
  const once = toBiliPlainText(src)
  assert.equal(toBiliPlainText(once), once)
})

test('适配：空输入返回空串', () => {
  assert.equal(toBiliPlainText(''), '')
  assert.equal(toBiliPlainText(null), '')
})

test('适配：真实场景 —— markdown 全文处理后无残留标记', () => {
  const md = '## 一、判断\n\n先说结论：**该搞**。\n\n- 理由一\n- 理由二\n\n详见[链接](https://a.b/c)。'
  const out = toBiliPlainText(md)
  assert.ok(!/^#{1,6}\s/m.test(out), '不该有标题标记')
  assert.ok(!out.includes('**'), '不该有加粗标记')
  assert.ok(!out.includes(']('), '不该有 markdown 链接')
  assert.ok(!out.includes('https://'), '不该有裸链接')
  assert.ok(out.includes('该搞'))
})

/* ── 拆分不切断数字/单词 ── */
test('拆分：硬切时不把数字切成两半', () => {
  // 构造没有标点的长串，里面有一个关键数字
  const text = '甲'.repeat(400) + '1.3万颗' + '乙'.repeat(400) + '丙'.repeat(400)
  const r = splitForBili(text, 1000)
  assert.ok(r.parts.length >= 2)
  for (const p of r.parts) assert.ok(p.length <= 1000)
  // 拼接完整
  assert.equal(r.parts.join(''), text)
  // 不允许出现 "1." / ".3" 这种切口
  const joined = r.parts.join('|')
  assert.ok(!/1\||1\.\||\.\|3/.test(joined), '切点不该落在数字内部')
})
