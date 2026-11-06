import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanAsrText } from '../lib/asr.mjs'

test('ASR 清洗：去句首标点、折叠重复标点', () => {
  // 故意不删"嗯/呃"这类语气词 —— B站 官方 AI 字幕本身也保留它们
  assert.equal(cleanAsrText('，开头就是逗号'), '开头就是逗号')
  assert.equal(cleanAsrText('好的。。。我们继续'), '好的。我们继续')
  assert.equal(cleanAsrText('甲，，，乙'), '甲，乙')
})

test('ASR 清洗：空值与纯空白', () => {
  assert.equal(cleanAsrText(''), '')
  assert.equal(cleanAsrText(null), '')
  assert.equal(cleanAsrText('   '), '')
})

test('ASR 清洗：折叠多空格但不吞中文', () => {
  assert.equal(cleanAsrText('甲   乙'), '甲 乙')
})

test('ASR 清洗：语气词保留（不误删语义）', () => {
  assert.equal(cleanAsrText('嗯，这个啊，问题'), '嗯，这个啊，问题')
})
