/**
 * 源码护栏（2026-11-08）
 *
 * 这两个 bug 都属于「代码不报错、行为静默降级」，光靠单测测不出来
 * （要真发评论才能暴露），所以这里直接对**源码文本**设护栏：
 * 以后再有人把某个返回码当成成功，测试会立刻红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

/** 扫所有业务源码（lib + bin），不含 test 自己 */
function sources() {
  const out = []
  for (const dir of ['lib', 'bin']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.mjs')) out.push({ name: `${dir}/${name}`, text: read(dir, name) })
    }
  }
  return out
}

test('护栏：任何地方都不许把 12051 当成发送成功', () => {
  // 12051 是「重复评论，请勿刷屏」= 拒绝。写成 `code === 0 || code === DUPLICATE_CODE`
  // 会让一条被判重复的回复被当成发成功了。
  const bad = []
  for (const { name, text } of sources()) {
    text.split('\n').forEach((line, i) => {
      if (/DUPLICATE_CODE/.test(line) && /code\s*===\s*0\s*\|\|/.test(line)) bad.push(`${name}:${i + 1}  ${line.trim()}`)
      if (/12051/.test(line) && /code\s*===\s*0\s*\|\|/.test(line)) bad.push(`${name}:${i + 1}  ${line.trim()}`)
    })
  }
  assert.deepEqual(bad, [], `发现把 12051 当成功的写法：\n${bad.join('\n')}`)
})

test('护栏：回读验证必须有一次不带 Cookie 的匿名请求', () => {
  // state=17（阿瓦隆「仅自己可见」）的定义是「自己看得见、别人看不见」，
  // 只带自己 cookie 查一定命中，等于没验。必须再发一次匿名请求。
  const text = read('lib', 'reply.mjs')
  assert.ok(text.includes('匿名复查'), 'reply.mjs 里应该留着「匿名复查」的说明')

  // 找到 verifyReply 函数体，确认里面直接用了 fetch( 而不是全部走 biliGet(（biliGet 会自动加 Cookie）
  const start = text.indexOf('export async function verifyReply')
  assert.ok(start > 0, '找不到 verifyReply')
  const body = text.slice(start, start + 3000)
  assert.ok(/await\s+fetch\(/.test(body), 'verifyReply 里应该有一次裸 fetch（匿名）')
  assert.ok(/visible/.test(body), 'verifyReply 应该返回 visible（别人看不看得见）')
})

test('护栏：-352 不许躺在熔断集合里', () => {
  // -352 有自救链路（v_voucher → gaia），一律熔断 24h 等于放弃恢复
  const text = read('lib', 'reply.mjs')
  assert.equal(/BLOCKING_CODES\s*=\s*new Set\(\[[^\]]*-352/.test(text), false, '-352 不该在 BLOCKING_CODES 里')
  assert.ok(/RISK_CODES\s*=\s*new Set\(\[-352\]\)/.test(text), '-352 应该在 RISK_CODES 里')
})
