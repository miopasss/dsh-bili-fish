import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 家目录：配置 / 凭证 / 缓存 / 日志 都在这下面 */
export const HOME =
  process.env.BILI_FISH_HOME ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bili-fish')

export const CONFIG_FILE = path.join(HOME, 'config.json')
export const CREDS_FILE = path.join(HOME, 'credentials.json')
export const CACHE_DIR = path.join(HOME, 'cache')
export const LOG_DIR = path.join(HOME, 'log')

export const cacheDir = (...parts) => path.join(CACHE_DIR, ...parts)
export const pkgRoot = path.resolve(import.meta.dirname, '..')

/**
 * 会话的「工作区」（2026-11-06）：DSH 按会话的 **cwd** 归组，
 * 想让静默 / 非静默分成两组，就得让两次 headless 用不同的 cwd。
 *
 *   非静默 → 项目目录（历史会话天然已经在这里）
 *   静默   → HOME/ws-quiet（用户在 GUI 里追问时一眼能找到）
 */
export const WS_PUBLIC = pkgRoot
/** HOME 可能是 junction（F:\bili-fish-data），DSH 会把 cwd 解析成真实路径再分桶，
 *  所以这里也要给真实路径，否则会话会落到另一个桶里。 */
const realPath = (p) => { try { return fs.realpathSync.native(p) } catch { return p } }
export const WS_QUIET = realPath(path.join(HOME, 'ws-quiet'))
export const probeScript = path.join(pkgRoot, 'python', 'probe.py')
