import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNoiseLine, denoise } from '../lib/ocr.mjs'

test('噪声：知乎/播放器的界面计数行', () => {
  assert.equal(isNoiseLine('509人听过'), true)
  assert.equal(isNoiseLine('6243人赞同了该回答>'), true)
  assert.equal(isNoiseLine('1234人正在看'), true)
})

test('噪声：纯符号与单字符碎片', () => {
  assert.equal(isNoiseLine('_口'), false, '「_口」有中文，不该当碎片丢掉') // 长度 2 但那是有字的
  assert.equal(isNoiseLine('广口'), false)
  assert.equal(isNoiseLine('>'), true)
  assert.equal(isNoiseLine('——'), true)
  assert.equal(isNoiseLine('   '), true)
  assert.equal(isNoiseLine(''), true)
})

test('噪声：纯数字行', () => {
  assert.equal(isNoiseLine('42'), true)
  assert.equal(isNoiseLine('1234'), false, '四位数可能是正文里的数字')
})

test('噪声：按钮文字', () => {
  assert.equal(isNoiseLine('关注'), true)
  assert.equal(isNoiseLine('点赞'), true)
  assert.equal(isNoiseLine('关注了这个问题'), false)
})

test('噪声：正文一律保留', () => {
  const keep = [
    '东大不需要星链，另外不要抄马斯克',
    '特斯拉电动车是马斯克为走向太阳能时代铺路的砖头',
    '第一',
    '3+3+3法则',
  ]
  for (const k of keep) assert.equal(isNoiseLine(k), false, `不该丢：${k}`)
})

test('去噪：不改动入参，只返回过滤后的数组', () => {
  const lines = [
    { t: 0, text: '509人听过' },
    { t: 0, text: '东大不需要星链' },
    { t: 5, text: '>' },
  ]
  const copy = JSON.parse(JSON.stringify(lines))
  const out = denoise(lines)
  assert.equal(out.length, 1)
  assert.equal(out[0].text, '东大不需要星链')
  assert.deepEqual(lines, copy)
})
