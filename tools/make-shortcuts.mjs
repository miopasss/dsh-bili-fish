#!/usr/bin/env node
/**
 * 在当前机器的桌面上生成两个启动快捷方式。换机器后跑一次即可。
 *
 *   node tools/make-shortcuts.mjs
 *
 * 为什么要有它：桌面那两个 .cmd 里必须写**仓库的绝对路径**（桌面脚本没法用 %~dp0
 * 找到仓库），所以它们不能进仓库、换机器必然失效。让脚本按当前仓库位置重新生成，
 * 就不用每次手改路径。
 *
 * 编码坑（踩过）：cmd.exe 按系统编码读脚本。UTF-8 内容必须配 **CRLF 换行**，
 * 并且第二行 `chcp 65001`；只写 LF 会让中文把换行吃掉，整份脚本被拆乱。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pkgRoot } from '../lib/paths.mjs'

const desktop = (() => {
  // 优先用系统的桌面目录（兼容 OneDrive 重定向）
  const home = os.homedir()
  const cands = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]
  const hit = cands.find((p) => { try { return fs.statSync(p).isDirectory() } catch { return false } })
  return hit ?? cands[0]
})()

/** 写一个 .cmd：UTF-8 无 BOM + CRLF，且 chcp 65001 放在第二行 */
function writeCmd(file, lines) {
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
}

function launcher(title, banner, target, extra = '') {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `title ${title}`,
    'echo.',
    'echo ============================================================',
    ...banner.map((b) => `echo   ${b}`),
    'echo ============================================================',
    'echo.',
    `call "${target}"${extra}`,
    '',
  ]
}

const serve = path.join(pkgRoot, 'fish-serve.cmd')
const web = path.join(pkgRoot, 'fish-web.cmd')

for (const f of [serve, web]) {
  if (!fs.existsSync(f)) {
    console.error(`✗ 找不到 ${f}，仓库不完整？`)
    process.exit(1)
  }
}

const files = [
  [path.join(desktop, 'bili-fish 常驻.cmd'), launcher('bili-fish 常驻进程', [
    'bili-fish 常驻进程',
    '每 30 秒拉一次 @ 消息  ->  生成  ->  回复到楼中楼',
    '关掉这个窗口或按 Ctrl+C 停止',
  ], serve)],
  [path.join(desktop, 'bili-fish 控制台.cmd'), launcher('bili-fish 本地控制台', [
    'bili-fish 本地控制台',
    '配置 + 回复历史 + 召唤指令 + 架构图',
    '浏览器会自动打开；关掉这个窗口即停止服务',
  ], web)],
]

for (const [file, lines] of files) {
  writeCmd(file, lines)
  console.log(`✓ ${file}  (${fs.statSync(file).size} B)`)
}
console.log(`\n桌面目录：${desktop}`)
console.log('双击即可启动。换机器或移动仓库后重跑本脚本即可。')
