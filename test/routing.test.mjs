/**
 * 召唤指令：@ 正文 → {source, mode, hits}（纯函数，不发任何请求）
 *
 * 2026-11-06：关键词强制素材源（字幕/画面 OCR）与四种输出形态
 * （归档 / 只总结 / 说看法 / 总结+看法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, normalizeText, buildStatusLine } from '../lib/routing.mjs'
import { config, DEFAULTS } from '../lib/config.mjs'
import { splitForBili, cutAtBoundary } from '../lib/reply.mjs'
import { truncateArchiveBody, failureReplyText, cleanErrorText } from '../lib/serve.mjs'

// 测试里显式传默认词表：用户 config.json 改过 routing.keywords 也不该把单测搞挂。
const KW = DEFAULTS.routing.keywords
const parseCmd = parseCommand
const parse = (text, kw = KW) => parseCmd(text, kw)

/* ── ① 无关键词 ── */

test('无关键词：auto / view，hits 为空', () => {
  const r = parse('肥鱼看看这条视频')
  assert.equal(r.source, 'auto')
  assert.equal(r.mode, 'view')
  assert.deepEqual(r.hits, [])
})

test('空文本 / null / 纯空白：auto / view', () => {
  for (const t of ['', null, undefined, '   ', '\n\t\u3000']) {
    const r = parse(t)
    assert.equal(r.source, 'auto', `输入 ${JSON.stringify(t)}`)
    assert.equal(r.mode, 'view')
    assert.deepEqual(r.hits, [])
  }
})

/* ── ② 六组关键词各一条 ── */

const SIX = [
  ['用字幕', 'forceSubtitle', 'subtitle', 'view'],
  ['用OCR', 'forceOcr', 'ocr', 'view'],
  ['只拉文字版', 'archive', 'auto', 'archive'],
  ['只要总结', 'summaryOnly', 'auto', 'summary'],
  ['说说看法', 'viewOnly', 'auto', 'view'],
  ['总结加看法', 'both', 'auto', 'both'],
]

for (const [text, group, source, mode] of SIX) {
  test(`单关键词「${text}」→ ${group} / source=${source} mode=${mode}`, () => {
    const r = parse(text)
    assert.equal(r.source, source)
    assert.equal(r.mode, mode)
    assert.equal(r.hits.length, 1)
    assert.equal(r.hits[0].group, group)
    assert.equal(r.hits[0].word, text)
  })
}

test('多词同句：hits 按原文顺序，source/mode 各取最后命中（用自定义词表）', () => {
  const kw = {
    forceSubtitle: ['用字幕'], forceOcr: ['用OCR', '看画面'],
    archive: ['只拉文字版'], summaryOnly: ['只总结'], viewOnly: ['说说看法'], both: ['总结和看法'],
  }
  const r = parseCommand('用字幕 用OCR 看画面，只总结，总结和看法', kw)
  assert.equal(r.source, 'ocr')
  assert.equal(r.mode, 'both')
  assert.deepEqual(r.hits.map((h) => h.word), ['用字幕', '看画面', '只总结', '总结和看法'])
})

/* ── ③ 长词优先：总结加看法 不能被拆成 只总结 ── */

test('长词优先：「总结加看法」只算 both，不会被拆成更短的词', () => {
  const r = parse('总结加看法')
  assert.equal(r.mode, 'both')
  assert.deepEqual(r.hits, [{ group: 'both', word: '总结加看法' }])
})

test('长词优先（自定义词表里有包含关系）：命中长词后短词不再重复命中', () => {
  const kw = { summaryOnly: ['总结'], both: ['总结加看法'] }
  const r = parse('总结加看法', kw)
  assert.equal(r.mode, 'both')
  assert.deepEqual(r.hits, [{ group: 'both', word: '总结加看法' }])
})

test('长词优先：「总结和看法」不会被拆成更短的词（自定义词表）', () => {
  const kw = { summaryOnly: ['总结'], both: ['总结和看法'] }
  const r = parseCommand('总结和看法', kw)
  assert.equal(r.mode, 'both')
  assert.deepEqual(r.hits.map((h) => h.group), ['both'])
})

/* ── ④ 同一组多个词命中 → 取最后出现的 ── */

test('同组多词：取最后出现的那个（自定义词表）', () => {
  const kw = { forceSubtitle: ['用字幕', '文字稿'] }
  const r = parseCommand('先别说用字幕，我还是要文字稿', kw)
  assert.equal(r.source, 'subtitle')
  assert.deepEqual(r.hits, [{ group: 'forceSubtitle', word: '文字稿' }])
})

test('同组多词：forceOcr 同样取最后（自定义词表）', () => {
  const kw = { forceOcr: ['用OCR', '强制OCR'] }
  const r = parseCommand('用OCR吧，还是强制OCR吧', kw)
  assert.equal(r.source, 'ocr')
  assert.deepEqual(r.hits, [{ group: 'forceOcr', word: '强制OCR' }])
})

test('跨组取最后：source 组谁后说听谁的', () => {
  const r = parse('用OCR，然后改口说用字幕')
  assert.equal(r.source, 'subtitle')
})

test('跨组取最后：mode 组谁后说听谁的', () => {
  const r = parse('只要总结，不过还是总结加看法吧')
  assert.equal(r.mode, 'both')
})

/* ── ⑤ 全角 / 大小写 / 空格容错 ── */

test('归一化：全角 ＯＣＲ → OCR', () => {
  assert.equal(normalizeText('用ＯＣＲ'), '用ocr')
  assert.equal(parse('用ＯＣＲ').source, 'ocr')
})

test('归一化：大小写不敏感（用ocr / 用Ocr / 用OCr）', () => {
  for (const t of ['用ocr', '用Ocr', '用OCr', '用oCr']) {
    assert.equal(parse(t).source, 'ocr', t)
  }
})

test('归一化：任意空白（用 OCR / 用\tO C R / 用　OCR）', () => {
  for (const t of ['用 OCR', '用\tO C R', '用\u3000OCR', ' 用 OCR ']) {
    assert.equal(parse(t).source, 'ocr', JSON.stringify(t))
  }
})

test('归一化：全角 + 空格 + 大小写混合仍然命中', () => {
  const r = parse('请 用 Ｏ Ｃ Ｒ 看 一下')
  assert.equal(r.source, 'ocr')
  assert.equal(r.hits[0].word, '用OCR') // 对外回词表里的原始写法
})

/* ── ⑥ 自定义词表覆盖默认 ── */

test('自定义词表：覆盖默认，默认词不再生效', () => {
  const kw = { archive: ['用字幕'] }
  const r = parse('用字幕', kw)
  assert.equal(r.mode, 'archive')
  assert.equal(r.source, 'auto')
  assert.deepEqual(r.hits, [{ group: 'archive', word: '用字幕' }])
})

test('自定义词表：空对象 = 什么指令都不认', () => {
  const r = parse('用字幕 只拉文字版', {})
  assert.equal(r.source, 'auto')
  assert.equal(r.mode, 'view')
  assert.deepEqual(r.hits, [])
})

/* ── ⑦ 归档正文截断：必须落在句子边界 ── */

const SENTENCE = '这是一句测试用的句子。' // 11 字，句号结尾

test('归档截断：3500 字稿子在句子边界截到 3000 以内，不硬切', () => {
  const text = SENTENCE.repeat(320) // 3520 字
  assert.ok(text.length > 3000)

  const r = splitForBili(text, 1000, { maxParts: 3, truncateAtBoundary: true })
  assert.equal(r.parts.length, 3)
  assert.equal(r.truncated, true)
  for (const p of r.parts) assert.ok(p.length <= 1000, `单条 ${p.length} > 1000`)

  const joined = r.parts.join('')
  assert.ok(joined.length <= 3000, `三条合计 ${joined.length} > 3000`)
  // 末条是「整句 + 省略号」，不是「半句 + 省略号」
  assert.ok(joined.endsWith('。…'), `截断点不在句号上：…${joined.slice(-12)}`)
  const body = joined.slice(0, -1)
  assert.equal(body, text.slice(0, body.length), '截断点之后的内容不该被混进来')
  assert.equal(body.length % SENTENCE.length, 0, '截断点必须在整句边界上')
})

test('归档截断：不开启时仍是老的硬切（对照）', () => {
  const text = SENTENCE.repeat(320)
  const hard = splitForBili(text, 1000, { maxParts: 3 })
  assert.equal(hard.parts.length, 3)
  const body = hard.parts.join('').slice(0, -1)
  assert.ok(!body.endsWith('。'), '硬切本来就不保证落在句号上（这个断言防止实现被悄悄改回去）')
})

test('归档截断：没超 3000 就一个字都不动', () => {
  const text = SENTENCE.repeat(100) // 1100 字
  const r = splitForBili(text, 1000, { maxParts: 3, truncateAtBoundary: true })
  assert.equal(r.truncated, false)
  assert.equal(r.parts.join(''), text)
})

/* ── ⑧ serve 接线：状态行 / 归档正文截断 / 失败原文清洗 ── */

test('状态行：没命中关键词就完全不出现', () => {
  assert.equal(buildStatusLine({ hits: [], mode: 'view' }, {}), '')
})

test('状态行（只输出形态）：不再谎称跳过检验，改说按什么形态输出', () => {
  const s = buildStatusLine({ hits: [{ group: 'summaryOnly', word: '只要总结' }], mode: 'summary' }, {})
  assert.equal(s, '命中「只要总结」关键词，本条按「只总结」输出。')
})

test('状态行（只输出形态）：说看法 / 总结+看法 / 归档模式的形态名', () => {
  assert.equal(
    buildStatusLine({ hits: [{ group: 'viewOnly', word: '说说看法' }], mode: 'view' }, {}),
    '命中「说说看法」关键词，本条按「说看法」输出。',
  )
  assert.equal(
    buildStatusLine({ hits: [{ group: 'both', word: '总结加看法' }], mode: 'both' }, {}),
    '命中「总结加看法」关键词，本条按「总结+看法」输出。',
  )
  assert.equal(
    buildStatusLine({ hits: [{ group: 'archive', word: '只拉文字版' }], mode: 'archive' }, { tier: 'subtitle', rawLines: 45, chars: 812 }),
    '命中「只拉文字版」关键词，本条按「归档模式」输出。已拉取完整文字稿：字幕 45 句 / 约 812 字，已存本地。',
  )
})

test('状态行（强制素材源）：保留「跳过自动检验」，再补一句按什么形态输出', () => {
  const s = buildStatusLine({ hits: [{ group: 'forceOcr', word: '用OCR' }], mode: 'summary' }, {})
  assert.equal(s, '命中「用OCR」关键词，跳过自动检验。本条按「只总结」输出。')
})

test('状态行（强制素材源 + 归档）：报输出形态 / 素材来源 / 句数 / 字数', () => {
  const s = buildStatusLine(
    { hits: [{ group: 'forceSubtitle', word: '用字幕' }], mode: 'archive' },
    { tier: 'subtitle', rawLines: 20, chars: 300 },
  )
  assert.equal(
    s,
    '命中「用字幕」关键词，跳过自动检验。本条按「归档模式」输出。已拉取完整文字稿：字幕 20 句 / 约 300 字，已存本地。',
  )
})

test('状态行（素材源 + 输出形态都命中）：两个词都列出来，判定按素材源分支', () => {
  const s = buildStatusLine(
    { hits: [{ group: 'forceOcr', word: '用OCR' }, { group: 'both', word: '总结加看法' }], mode: 'both' },
    {},
  )
  assert.equal(s, '命中「用OCR、总结加看法」关键词，跳过自动检验。本条按「总结+看法」输出。')
})

test('状态行：归档 mode 的语音转写来源显示「语音转写」', () => {
  const s = buildStatusLine(
    { hits: [{ group: 'archive', word: '归档模式' }], mode: 'archive' },
    { tier: 'asr', rawLines: 88, chars: 1200 },
  )
  assert.match(s, /完整文字稿：语音转写 88 句 \/ 约 1200 字/)
})

/* ── ⑨ 三级截断退化（纯函数） ── */

test('cutAtBoundary ①：有句末标点 → 落在最后一个句号上', () => {
  const text = '句子。'.repeat(1660) // 3320 字，3 字一句
  const cut = cutAtBoundary(text, 2999)
  assert.equal(cut, 2997) // 最后一句结束在 2997
  assert.equal(text[cut - 1], '。')
})

test('cutAtBoundary ②：一个句号都没有但有换行 → 落在换行上', () => {
  const line = '甲'.repeat(50)
  const text = Array.from({ length: 80 }, () => line).join('\n') // 每行 50 + 换行
  const cut = cutAtBoundary(text, 3000)
  assert.equal(cut, 51 * 58) // 2958 ≤ 3000，下一行换行结束在 3009 超了
  assert.equal(text[cut - 1], '\n')
  assert.ok(cut >= 3000 - 50, `换行边界离上限太远：${cut}`)
})

test('cutAtBoundary ③：标点稀疏且没有换行 → 离上限 50 字内硬切', () => {
  const text = '句。'.repeat(100) + '甲'.repeat(3100) // 句号只到 200，之后 3100 字没有边界
  const cut = cutAtBoundary(text, 3000)
  assert.equal(cut, 3000)
})

test('cutAtBoundary：边界离上限太远时宁可硬切，也不截在很早的位置', () => {
  const text = '第一句。'.repeat(50) + '乙'.repeat(4000) // 最后句号在 200
  assert.equal(cutAtBoundary(text, 3000), 3000)
})

test('cutAtBoundary：不超上限原样返回', () => {
  const text = '短稿。'
  assert.equal(cutAtBoundary(text, 3000), text.length)
})

/* ── ⑩ 归档正文：三级退化后仍带同一句后缀 ── */

test('归档正文：超 3000 在句号处截断，末尾加「全文已存本地」', () => {
  const body = `命中「只拉文字版」关键词，本条按「归档模式」输出。已拉取完整文字稿：字幕 300 句 / 约 3300 字，已存本地。\n${SENTENCE.repeat(300)}`
  const out = truncateArchiveBody(body)
  assert.ok(out.length <= 3000, `截断后 ${out.length} > 3000`)
  assert.match(out, /\n…（全文已存本地，评论区只贴前 \d+ 字）$/)
  const pasted = out.slice(0, out.indexOf('\n…（全文已存本地'))
  assert.ok(pasted.trimEnd().endsWith('。'), `截断点不在句号上：…${pasted.slice(-10)}`)
})

test('归档正文：标点稀疏时退到换行，仍贴满 3000 附近并带同一句后缀', () => {
  const line = '丙'.repeat(50)
  const body = Array.from({ length: 90 }, () => line).join('\n') // 无句号，只有换行
  assert.ok(body.length > 3000)
  const out = truncateArchiveBody(body)
  assert.ok(out.length <= 3000, `截断后 ${out.length} > 3000`)
  assert.match(out, /\n…（全文已存本地，评论区只贴前 \d+ 字）$/)
  const pasted = out.slice(0, out.indexOf('\n…（全文已存本地'))
  assert.ok(pasted.trimEnd().endsWith(line), '截断点必须落在完整一行的末尾')
  assert.ok(pasted.trimEnd().length >= 3000 - 50 - 30, `贴得太少：${pasted.trimEnd().length}`)
})

test('归档正文：标点稀疏且无换行 → 3000 附近硬切，后缀照加', () => {
  const body = `命中「只拉文字版」关键词，本条按「归档模式」输出。\n${'丁'.repeat(4000)}`
  const out = truncateArchiveBody(body)
  assert.ok(out.length <= 3000, `截断后 ${out.length} > 3000`)
  assert.match(out, /\n…（全文已存本地，评论区只贴前 \d+ 字）$/)
  const pasted = out.slice(0, out.indexOf('\n…（全文已存本地'))
  assert.ok(pasted.length >= 3000 - 50, `硬切位置离 3000 太远：${pasted.length}`)
})

test('归档正文：没超 3000 原样返回', () => {
  const body = '命中「只拉文字版」关键词，本条按「归档模式」输出。'
  assert.equal(truncateArchiveBody(body), body)
})

/* ── ⑪ 失败回复：去掉 ✗ / BV 号机器味前缀 ── */

test('失败回复：去掉行首 ✗ 和 BV 号，只留原因', () => {
  const r = { err: '\n[第 1 次生成…]\n✗ BV1QjuQ6REcS 这条视频没有字幕轨（你要求用字幕）\n' }
  assert.equal(
    failureReplyText(r, '生成失败 code=4'),
    '这条视频没有字幕轨（你要求用字幕）',
  )
})

test('cleanErrorText：✗ 与 BV 号之间没空格也清洗', () => {
  assert.equal(cleanErrorText('✗BV1QjuQ6REcS 画面里没读到文字'), '画面里没读到文字')
  assert.equal(cleanErrorText('  ✗   ✗ BV1Nixm65EVE 拿不到视频元信息'), '拿不到视频元信息')
})

test('cleanErrorText：没有机器味前缀的原样保留', () => {
  assert.equal(cleanErrorText('失败：拿不到播放直链'), '失败：拿不到播放直链')
  assert.equal(cleanErrorText('这条视频没有字幕轨（你要求用字幕）'), '这条视频没有字幕轨（你要求用字幕）')
})

test('cleanErrorText：清洗后为空则回原文（绝不回空评论）', () => {
  assert.equal(cleanErrorText('✗ '), '✗')
})

test('失败回复：子进程没给错误原文时用 why（超时），同样去掉 ✗', () => {
  assert.equal(failureReplyText({ err: '[第 1 次生成…]\n', out: '' }, '超时 20 分钟'), '超时 20 分钟')
})

/* ── 剃掉召唤指令，留下提问者的话 ── */
import { stripAsk } from '../lib/routing.mjs'

test('stripAsk：剃掉 @昵称', () => {
  const t = stripAsk('@今天要做什么 这个视频说得对吗', [])
  assert.equal(t.includes('@'), false)
  assert.ok(t.includes('这个视频说得对吗'))
})

test('stripAsk：剃掉命中的关键词', () => {
  const raw = '@某人 用OCR看看这个视频说的对吗'
  const cmd = parseCommand(raw)
  const t = stripAsk(raw, cmd.hits)
  assert.equal(/用ocr/i.test(t), false)
  assert.ok(t.includes('看看这个视频说的对吗'))
})

test('stripAsk：保留多个问题和换行', () => {
  const raw = '@某人 用OCR这个说的对吗\n\n面试会更有效吗\n另外护城河是钱吗'
  const t = stripAsk(raw, parseCommand(raw).hits)
  assert.ok(t.includes('面试会更有效吗'))
  assert.ok(t.includes('护城河是钱吗'))
  assert.ok(t.includes('\n'))
})

test('stripAsk：纯召唤语剃完很短', () => {
  const raw = '@今天要做什么 看看这个'
  const t = stripAsk(raw, parseCommand(raw).hits)
  assert.equal(t, '看看这个')
  assert.ok(t.length < 15)
})

test('stripAsk：不剃语气词与礼貌语', () => {
  const raw = '@某人 帮我看看这个视频说得对吗，我感觉有点奇怪'
  const t = stripAsk(raw, parseCommand(raw).hits)
  assert.ok(t.includes('帮我看看'))
  assert.ok(t.includes('我感觉有点奇怪'))
})

test('stripAsk：空输入 / 只有 @', () => {
  assert.equal(stripAsk(''), '')
  assert.equal(stripAsk('@某人'), '')
  assert.equal(stripAsk(null), '')
})

test('stripAsk：不传 hits 时自己算', () => {
  const raw = '@某人 用字幕这段讲得对吗'
  const t = stripAsk(raw)
  assert.equal(t.includes('用字幕'), false)
  assert.ok(t.includes('这段讲得对吗'))
})

/* ── 静默（悄悄）── */
test('quiet：命中悄悄 → quiet=true，且不影响 source/mode', () => {
  const c = parseCommand('@它 悄悄看看这个')
  assert.equal(c.quiet, true)
  assert.equal(c.source, 'auto')
  assert.equal(c.mode, 'view')
})

test('quiet：可和其它维度叠加', () => {
  const c = parseCommand('@它 悄悄 用OCR 只要总结 这个说得对吗')
  assert.equal(c.quiet, true)
  assert.equal(c.source, 'ocr')
  assert.equal(c.mode, 'summary')
})

test('quiet：没写悄悄就是 false（不是 undefined）', () => {
  assert.equal(parseCommand('@它 看看这个').quiet, false)
  assert.equal(parseCommand('').quiet, false)
})

test('词表：除静默外每组只留一个词（收词后不该再有同义词）', () => {
  const k = DEFAULTS.routing.keywords
  for (const [g, ws] of Object.entries(k)) {
    if (g === 'quiet') continue // 静默有两个：悄悄 / 静默
    assert.equal(ws.length, 1, `${g} 应该只有一个词，实际 ${JSON.stringify(ws)}`)
  }
  assert.deepEqual(k.quiet, ['悄悄', '静默'])
  assert.deepEqual(Object.keys(k).sort(), ['archive', 'both', 'forceAsr', 'forceOcr', 'forceSubtitle', 'quiet', 'summaryOnly', 'viewOnly'])
})

test('词表：三级素材源都有词（用字幕 / 用OCR / 用ASR）', () => {
  // 断出厂默认值，不读用户的 config.json —— 用户随时可能自己加同义词
  const k = DEFAULTS.routing.keywords
  assert.deepEqual(k.forceSubtitle, ['用字幕'])
  assert.deepEqual(k.forceOcr, ['用OCR'])
  assert.deepEqual(k.forceAsr, ['用ASR'])
  assert.deepEqual(k.quiet, ['悄悄', '静默'])
})

test('forceAsr：解析成 source=asr', () => {
  assert.equal(parseCommand('@它 用ASR 看看这个').source, 'asr')
  assert.equal(parseCommand('@它 用asr').source, 'asr')
  assert.equal(parseCommand('@它 用 ASR').source, 'asr')
})

test('forceAsr：和静默 / 输出形态叠加', () => {
  const c = parseCommand('@它 悄悄 用ASR 只要总结 这个说得对吗')
  assert.equal(c.source, 'asr')
  assert.equal(c.mode, 'summary')
  assert.equal(c.quiet, true)
})

test('forceAsr：三个素材源互斥，取最后说的', () => {
  assert.equal(parseCommand('@它 用字幕 用ASR').source, 'asr')
  assert.equal(parseCommand('@它 用ASR 用字幕').source, 'subtitle')
  assert.equal(parseCommand('@它 用OCR 用ASR 用OCR').source, 'ocr')
})

/* ── 并发保护：抢占文件 + 单实例锁 ── */
import { claimJob, releaseClaim } from '../lib/store.mjs'

test('claimJob：第一次能抢到，第二次抢不到（跨进程互斥）', () => {
  const rpid = 'test-claim-' + Date.now()
  assert.equal(claimJob(rpid), true)
  assert.equal(claimJob(rpid), false, '同一 rpid 不能被抢第二次')
  releaseClaim(rpid)
  assert.equal(claimJob(rpid), true, '释放后能重新抢')
  releaseClaim(rpid)
})

test('releaseClaim：没抢过也能安全调用', () => {
  assert.doesNotThrow(() => releaseClaim('never-claimed-' + Date.now()))
})

/* ── 扫码登录的纯函数（2026-11-07）── */
import { parseAuthUrl, parseSetCookie } from '../lib/login.mjs'

test('parseAuthUrl：从登录成功后的 url 里取 cookie', () => {
  const u = 'https://www.bilibili.com?DedeUserID=12345&DedeUserID__ckMd5=abc123&SESSDATA=xyz%2Cdef&bili_jct=csrf456&gourl=https%3A%2F%2Fwww.bilibili.com'
  assert.deepEqual(parseAuthUrl(u), {
    sessdata: 'xyz,def',
    bili_jct: 'csrf456',
    dedeuserid: '12345',
    dedeuserid_ckmd5: 'abc123',
  })
})

test('parseAuthUrl：没有查询串时返回空对象', () => {
  assert.deepEqual(parseAuthUrl(''), {})
  assert.deepEqual(parseAuthUrl('https://www.bilibili.com'), {})
})

test('parseSetCookie：从 Set-Cookie 兜底解析', () => {
  const list = [
    'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; HttpOnly',
    'bili_jct=csrf789; Path=/',
    'DedeUserID=999; Path=/',
    'buvid3=ignored; Path=/',
  ]
  assert.deepEqual(parseSetCookie(list), {
    sessdata: 'abc,def', bili_jct: 'csrf789', dedeuserid: '999',
  })
})
