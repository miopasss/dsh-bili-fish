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
export const probeScript = path.join(pkgRoot, 'python', 'probe.py')
