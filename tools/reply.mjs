#!/usr/bin/env node
/**
 * reply.mjs —— 把某次运行的总结，回复到指定的 @ 评论下面（楼中楼）
 *
 *   node tools/reply.mjs --latest                 # 找最新一条 @，打印将发送的内容（不真发）
 *   node tools/reply.mjs --latest --yes           # 真发
 *   node tools/reply.mjs --rpid 322928400736 --run <runId> --yes
 *
 * 写操作纪律（对齐《设计定稿》§10）：
 *   · 默认 dry-run，必须显式 --yes 才发
 *   · 只回「@我」的那条评论的楼中楼，不发顶层评论、不发私信
 *   · Referer 必须是**那条视频的页面**，否则 B站 返回 state=17（仅自己可见）
 *   · 发出后立刻回读校验，state!=0 视为失败
 */
import fs from 'node:fs'
import path from 'node:path'
import { biliGet, browserHeaders, cookieHeader } from '../lib/bili.mjs'
import { creds } from '../lib/config.mjs'
import { RUNS_DIR } from '../lib/runs.mjs'
import { splitForBili, toBiliPlainText } from '../lib/reply.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const val = (f) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : null }

const REPLY_API = 'https://api.bilibili.com/x/v2/reply/add'

/** 拉最近一条 @ 消息 */
async function latestAt() {
  const d = await biliGet('https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web')
  const it = (d.items || [])[0]
  if (!it) throw new Error('没有未读 @ 消息')
  const item = it.item || {}
  const uri = String(item.uri || '')
  const bvid = (uri.match(/BV[0-9A-Za-z]{10}/) || [null])[0]
  return {
    atId: it.id,
    atTime: it.at_time,
    fromMid: it.user?.mid,
    fromName: it.user?.nickname,
    bvid,
    aid: item.subject_id,
    rpid: item.source_id,
    rootId: item.root_id ?? 0,
    targetId: item.target_id ?? 0,
    text: item.source_content ?? '',
    title: item.title ?? '',
  }
}

/** 找某 BV 最新一次 summary 运行的正文 */
function latestSummary(bvid) {
  const dirs = fs.readdirSync(RUNS_DIR)
    .filter((d) => d.endsWith('-' + bvid))
    .sort()
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const f = path.join(RUNS_DIR, dirs[i], 'summary.md')
    if (!fs.existsSync(f)) continue
    const md = fs.readFileSync(f, 'utf8')
    const body = md.split(/\n---\n/).slice(1).join('\n---\n').trim()
    if (body) return { runId: dirs[i], body }
  }
  return null
}

async function postReply({ oid, root, parent, message, bvid }) {
  const c = creds()
  if (!c.bili_jct) throw new Error('缺 bili_jct，无法发评论（需要重新登录）')
  const form = new URLSearchParams({
    oid: String(oid),
    type: '1',
    root: String(root),
    parent: String(parent),
    message,
    plat: '1',
    csrf: c.bili_jct,
  })
  const res = await fetch(REPLY_API, {
    method: 'POST',
    headers: {
      ...browserHeaders(`https://www.bilibili.com/video/${bvid}/`),
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(),
    },
    body: form.toString(),
  })
  const json = await res.json().catch(() => ({}))
  return { http: res.status, ...json }
}

const main = async () => {
  const at = has('rpid')
    ? { ...(await latestAt()), rpid: Number(val('rpid')) }
    : await latestAt()

  console.log(`\n@ 来自   ${at.fromName}（mid ${at.fromMid}）`)
  console.log(`视频     ${at.bvid}  ${at.title}`)
  console.log(`评论     rpid=${at.rpid}  root=${at.rootId}  target=${at.targetId}`)
  console.log(`原文     ${JSON.stringify(at.text)}`)

  const run = val('run')
    ? { runId: val('run'), body: fs.readFileSync(path.join(RUNS_DIR, val('run'), 'summary.md'), 'utf8').split(/\n---\n/).slice(1).join('').trim() }
    : latestSummary(at.bvid)
  if (!run) throw new Error(`没有 ${at.bvid} 的 summary 产物，先跑 summary`)

  // 平台适配 + 字数不设限：先去 markdown/链接，超 1000 再拆条（与 lib/serve.mjs 同一套规则）
  const plain = toBiliPlainText(run.body)
  const { parts, truncated } = splitForBili(plain)
  console.log(`\n回复用   ${run.runId}（原文 ${run.body.length} 字 → 纯文本 ${plain.length} 字${parts.length > 1 ? `，拆成 ${parts.length} 条：${parts.map((p) => p.length).join(' / ')} 字` : ''}）`)
  if (truncated) console.log(`⚠ 超过 ${parts.length} 条容量，末条已截断（内容有损失）`)
  console.log('─'.repeat(64))
  parts.forEach((p, i) => {
    if (parts.length > 1) console.log(`— 第 ${i + 1}/${parts.length} 条 —`)
    console.log(p)
  })
  console.log('─'.repeat(64))

  if (!has('yes')) {
    console.log('\n[DRY RUN] 没真发。加 --yes 才发。')
    return
  }

  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      const gap = 10 + Math.floor(Math.random() * 11)   // 10-20s，别让两条挤在一起
      console.log(`\n等 ${gap}s 再发第 ${i + 1} 条…`)
      await new Promise((r) => setTimeout(r, gap * 1000))
    }
    const r = await postReply({
      oid: at.aid,
      root: at.rootId || at.rpid,     // 顶层评论：root 就是它自己
      parent: at.rpid,                // 拆条也用原评论 rpid：兄弟楼层，不嵌套、不依赖上一条 rpid
      message: parts[i],
      bvid: at.bvid,
    })
    console.log(`\n第 ${i + 1}/${parts.length} 条发送结果:`, JSON.stringify({ http: r.http, code: r.code, message: r.message }))
    if (r.code !== 0) {
      process.exitCode = 1
      return
    }
    const rp = r.data?.rpid ?? r.data?.reply?.rpid
    console.log(`rpid=${rp}  state=${r.data?.reply?.state ?? r.data?.state ?? '?'}`)
    if (r.data?.reply?.state === 17) console.log('⚠ state=17：仅自己可见，检查 Referer / 风控')
  }
}

main().catch((e) => {
  console.error('失败：', e?.message ?? e)
  process.exitCode = 1
})
