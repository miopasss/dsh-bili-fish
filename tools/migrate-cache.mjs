#!/usr/bin/env node
/**
 * migrate-cache.mjs —— 把早期 `cache/<BV>/summary-*.md` 统一搬进 `runs/<时间>-<BV>/`
 *
 * 背景：2026-11-04 中途把产物布局从 `cache/` 改成 `runs/`，导致"写过的东西找不到"。
 * 本脚本做一次迁移，让 `fish runs` / `stats` 只面对一种布局；之后 `cache/` 可以整体清掉。
 *
 *   node tools/migrate-cache.mjs --dry     # 只看会做什么，不动文件
 *   node tools/migrate-cache.mjs           # 真的搬
 *   node tools/migrate-cache.mjs --clean    # 搬完顺手清掉 cache 下的临时素材（视频/帧/雪碧图）
 *
 * 安全约定：
 *   · 只读 cache 里的 `summary-*.md` / `*.prompt.txt` / `material-*.json` / `see.json`
 *   · 迁移过来的一律写 `run.json`，并标 `migratedFrom`，可追溯
 *   · `--clean` 不删 `survey-*.json`（那是 75% 字幕覆盖率的证据）
 */
import fs from 'node:fs'
import path from 'node:path'
import { RUNS_DIR, INDEX_FILE } from '../lib/runs.mjs'
import { HOME } from '../lib/paths.mjs'

const CACHE = path.join(HOME, 'cache')
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)

/** `summary-2026-11-04T05-36-16-119Z.md` → { ts, at } */
function parseStamp(file) {
  const m = file.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/)
  if (!m) return null
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return { ts, at: d.toISOString() }
}

const plan = []
if (fs.existsSync(CACHE)) {
  for (const d of fs.readdirSync(CACHE, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = path.join(CACHE, d.name)
    const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    for (const s of files.filter((f) => /^summary-.*\.md$/.test(f))) {
      const st = parseStamp(s) ?? { ts: 'unknown', at: new Date(0).toISOString() }
      const base = s.replace(/^summary-/, '').replace(/\.md$/, '')
      plan.push({
        bvid: d.name,
        cacheDir: dir,
        summary: path.join(dir, s),
        prompt: files.includes(`summary-${base}.prompt.txt`) ? path.join(dir, `summary-${base}.prompt.txt`) : null,
        material: files.includes(`material-${base}.json`) ? path.join(dir, `material-${base}.json`) : null,
        see: files.includes('see.json') ? path.join(dir, 'see.json') : null,
        ts: st.ts,
        at: st.at,
        target: path.join(RUNS_DIR, `${st.ts}-${d.name}`),
      })
    }
  }
}

if (!plan.length) {
  console.log('cache 下没有需要迁移的 summary，什么也没做。')
} else {
  console.log(`${has('dry') ? '[DRY RUN] ' : ''}准备迁移 ${plan.length} 份产物：\n`)
  for (const p of plan) {
    const exists = fs.existsSync(p.target)
    console.log(`  ${p.bvid}  ${p.ts}${exists ? '  ⚠ 目标已存在，跳过' : ''}`)
    console.log(`     ← ${p.summary}`)
    console.log(`     → ${p.target}`)
    if (!has('dry') && !exists) {
      fs.mkdirSync(p.target, { recursive: true })
      fs.copyFileSync(p.summary, path.join(p.target, 'summary.md'))
      if (p.prompt) fs.copyFileSync(p.prompt, path.join(p.target, 'prompt.txt'))
      if (p.material) fs.copyFileSync(p.material, path.join(p.target, 'material.json'))
      if (p.see) fs.copyFileSync(p.see, path.join(p.target, 'see.json'))

      // 从 summary.md 里抠出元数据（早期文件头就是这么写的）
      const md = fs.readFileSync(p.summary, 'utf8')
      const grab = (re) => (md.match(re) || [])[1]?.trim() ?? ''
      const title = (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() ?? ''
      const body = md.split(/\n---\n/).slice(1).join('\n---\n').trim()
      let tier = 'subtitle'
      try {
        const mj = JSON.parse(fs.readFileSync(path.join(p.target, 'material.json'), 'utf8').replace(/^\uFEFF/, ''))
        if (mj?.tier) tier = mj.tier
      } catch { /* 没 material 就用默认 */ }

      const rec = {
        at: p.at,
        runId: path.basename(p.target),
        kind: 'summary',
        bvid: p.bvid,
        title,
        duration: Number(grab(/小时：?([\d:]+)/)) || 0,
        tier,
        chars: body.length,
        stamps: 0,
        ok: true,
        ms: 0,
        tokens: 0,
        migratedFrom: p.cacheDir,
      }
      fs.writeFileSync(path.join(p.target, 'run.json'), JSON.stringify(rec, null, 2) + '\n')
      fs.appendFileSync(INDEX_FILE, JSON.stringify(rec) + '\n')
      console.log('     ✓ 已迁移')
    }
  }
}

if (has('clean') && !has('dry')) {
  console.log('\n清理 cache 下的临时素材…')
  let removed = 0
  let kept = []
  for (const d of fs.readdirSync(CACHE, { withFileTypes: true })) {
    const dir = path.join(CACHE, d.name)
    if (d.isFile()) {
      if (/^survey-.*\.json$/.test(d.name)) { kept.push(d.name); continue }
      fs.rmSync(dir, { force: true }); removed += 1; continue
    }
    // 目录：里面的 summary/prompt/material 已迁移 → 整个删
    fs.rmSync(dir, { recursive: true, force: true })
    removed += 1
  }
  console.log(`  删掉 ${removed} 项${kept.length ? `；保留 ${kept.join(', ')}` : ''}`)
}

console.log(`\n现在用 \`node bin/fish.mjs runs\` 查看统一后的产物。`)
