#!/usr/bin/env node
/**
 * survey.mjs —— 统计"字幕到底有多少"
 *
 * 为什么需要它：匿名下 `/x/player/wbi/v2` 永远返回空，区分不了"真没字幕"和"没登录不给"。
 * 只有带登录态采样，才知道字幕这条腿值不值得当默认。
 *
 *   node tools/survey.mjs --n 20 [--source popular|search|mix] [--gap 1500]
 */
import { getView, getSubtitleTracks } from '../lib/bili.mjs'
import { biliGet } from '../lib/bili.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') === false ? argv[++i] : true
}
const N = Number(opt.n ?? 20)
const GAP = Number(opt.gap ?? 1500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function collect() {
  const out = []
  for (let pn = 1; pn <= Math.ceil(N / 20) + 1 && out.length < N; pn += 1) {
    const d = await biliGet(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`)
    for (const v of d.list ?? []) {
      out.push({ bvid: v.bvid, aid: v.aid, cid: v.cid, duration: v.duration, title: v.title, tname: v.tname, tid: v.tid })
      if (out.length >= N) break
    }
    await sleep(GAP)
  }
  return out
}

const list = await collect()
process.stderr.write(`取到 ${list.length} 条视频，开始逐条查字幕…\n`)

const rows = []
for (const v of list) {
  await sleep(GAP)
  let tracks = []
  let aiStatus = null
  let err = ''
  try {
    const r = await getSubtitleTracks(v.bvid, v.cid)
    tracks = r.tracks
    aiStatus = r.aiStatus
  } catch (e) {
    err = e.message
  }
  const manual = tracks.filter((t) => !t.ai)
  const ai = tracks.filter((t) => t.ai)
  rows.push({ ...v, tracks: tracks.length, manual: manual.length, ai: ai.length, aiStatus, err, lans: tracks.map((t) => t.lan).join(',') })
  const mark = tracks.length ? (manual.length ? '人工字幕' : 'AI字幕') : '无字幕'
  process.stderr.write(
    `${String(rows.length).padStart(2)}. ${mark.padEnd(4)} tracks=${tracks.length} [${rows.at(-1).lans}] ${(v.title || '').slice(0, 26)}\n`,
  )
}

const withSub = rows.filter((r) => r.tracks > 0)
const manual = rows.filter((r) => r.manual > 0)
const ai = rows.filter((r) => r.ai > 0)
const pct = (a, b) => ((a / b) * 100).toFixed(0) + '%'

console.log('\n================ 字幕覆盖率 ================')
console.log(`样本            ${rows.length} 条（热门榜）`)
console.log(`有任何字幕      ${withSub.length} 条  ${pct(withSub.length, rows.length)}`)
console.log(`  其中人工字幕  ${manual.length} 条  ${pct(manual.length, rows.length)}`)
console.log(`  其中 AI 字幕  ${ai.length} 条  ${pct(ai.length, rows.length)}`)
console.log(`完全无字幕      ${rows.length - withSub.length} 条  ${pct(rows.length - withSub.length, rows.length)}`)
console.log(`查询失败        ${rows.filter((r) => r.err).length} 条`)

const byDur = (lo, hi) => {
  const s = rows.filter((r) => r.duration >= lo && r.duration < hi)
  if (!s.length) return
  const w = s.filter((r) => r.tracks > 0).length
  console.log(`  ${lo}s-${hi}s: ${w}/${s.length} 有字幕`)
}
console.log('\n按时长：')
byDur(0, 60); byDur(60, 300); byDur(300, 900); byDur(900, 3600); byDur(3600, 1e9)

console.log('\n明细（无字幕的那些）：')
for (const r of rows.filter((x) => x.tracks === 0)) {
  console.log(`  ${r.bvid}  ${String(Math.round(r.duration / 60)).padStart(3)}min  tid=${r.tid} ${r.tname ?? ''}  ${(r.title || '').slice(0, 40)}`)
}

import fs from 'node:fs'
import path from 'node:path'
import { cacheDir } from '../lib/paths.mjs'
const f = cacheDir('survey-subtitles.json')
fs.mkdirSync(path.dirname(f), { recursive: true })
fs.writeFileSync(f, JSON.stringify(rows, null, 2))
console.log(`\n明细已写入 ${f}`)
