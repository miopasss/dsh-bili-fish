/**
 * B站扫码登录（2026-11-07）
 *
 * 为什么需要它：SESSDATA 会失效（被踢 / 风控 / 过期），而 B站**没有 refresh token**，
 * 失效后只能重新登录。密码登录要过极验验证码、且极易触发风控，所以只做**扫码**：
 *
 *   ① generate → 拿到 qrcode_key + 一个 url（二维码内容就是它）
 *   ② 手机 App 扫码
 *   ③ poll 轮询 → code 0 时 B站 把 cookie 放在 data.url 的查询串里
 *   ④ 写进 credentials.json
 *
 * 全程不需要密码，也不需要碰验证码。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { CREDS_FILE, pkgRoot } from './paths.mjs'
import { creds } from './config.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const passportHeaders = () => ({
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  ...(creds()?.buvid3 ? { Cookie: `buvid3=${creds().buvid3}` } : {}),
})

/** poll 的四种状态 */
export const LOGIN_STATE = {
  0: { key: 'ok', label: '登录成功' },
  86101: { key: 'waiting', label: '等待扫码' },
  86090: { key: 'scanned', label: '已扫码，请在手机上确认' },
  86038: { key: 'expired', label: '二维码已过期' },
}

/**
 * 当前登录态（拿 nav 探一次）
 * @returns {Promise<{loggedIn:boolean, uname?:string, mid?:number, level?:number, error?:string}>}
 */
export async function loginStatus() {
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { ...passportHeaders(), Cookie: cookieOf(creds()) },
      signal: AbortSignal.timeout(15_000),
    })
    const j = await res.json()
    if (j?.code === 0 && j?.data?.isLogin) {
      return {
        loggedIn: true,
        uname: j.data.uname,
        mid: j.data.mid,
        level: j.data.level_info?.current_level ?? null,
      }
    }
    return { loggedIn: false, error: j?.message || '-101 账号未登录' }
  } catch (e) {
    return { loggedIn: false, error: e?.message ?? String(e) }
  }
}

function cookieOf(c) {
  if (!c) return ''
  return Object.entries(c)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/**
 * 申请二维码
 * @returns {Promise<{qrcodeKey:string, url:string, svg:string}>}
 */
export async function startLogin() {
  const res = await fetch(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
    { headers: passportHeaders(), signal: AbortSignal.timeout(15_000) },
  )
  const j = await res.json()
  if (j?.code !== 0 || !j?.data?.qrcode_key) {
    throw new Error(`申请二维码失败：${j?.message || j?.code}`)
  }
  const { qrcode_key: qrcodeKey, url } = j.data
  return { qrcodeKey, url, svg: renderQr(url) }
}

/** 用 python/qr.py 渲染 SVG（项目零 npm 依赖，二维码放 Python 侧） */
export function renderQr(text) {
  const py = process.env.BILI_FISH_PYTHON || 'python'
  const script = path.join(pkgRoot, 'python', 'qr.py')
  try {
    return execFileSync(py, [script], {
      input: JSON.stringify({ text, scale: 6, border: 2 }),
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error(`二维码渲染失败（需要 python qrcode 库）：${e?.message ?? e}`)
  }
}

/**
 * 轮询扫码结果。成功时**顺手写 credentials.json**。
 * @returns {Promise<{state:'waiting'|'scanned'|'expired'|'ok'|'error', message?:string, saved?:object}>}
 */
export async function pollLogin(qrcodeKey) {
  if (!qrcodeKey) return { state: 'error', message: '缺少 qrcode_key' }
  let res
  try {
    res = await fetch(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
        encodeURIComponent(qrcodeKey) + '&source=main-fe-header',
      { headers: passportHeaders(), signal: AbortSignal.timeout(15_000) },
    )
  } catch (e) {
    return { state: 'error', message: e?.message ?? String(e) }
  }

  const j = await res.json().catch(() => null)
  const code = j?.data?.code
  const meta = LOGIN_STATE[code]
  if (!meta) return { state: 'error', message: j?.message || `未知状态 ${code}` }
  if (meta.key !== 'ok') return { state: meta.key, message: j?.data?.message || meta.label }

  // 登录成功：cookie 在 data.url 的查询串里（也兼容 Set-Cookie）
  const fromUrl = parseAuthUrl(j?.data?.url || '')
  const fromCookie = parseSetCookie(res.headers.getSetCookie?.() || [])
  const merged = { ...fromCookie, ...fromUrl }

  if (!merged.sessdata) {
    return { state: 'error', message: '登录成功但没解析到 SESSDATA' }
  }
  const saved = saveCreds(merged)
  return { state: 'ok', message: '登录成功，已更新 credentials.json', saved }
}

/** data.url 形如 https://www.bilibili.com?DedeUserID=…&SESSDATA=…&bili_jct=… */
export function parseAuthUrl(url) {
  const out = {}
  if (!url) return out
  let qs = ''
  try {
    qs = new URL(url).search
  } catch {
    const i = url.indexOf('?')
    qs = i >= 0 ? url.slice(i) : ''
  }
  const sp = new URLSearchParams(qs)
  const map = {
    SESSDATA: 'sessdata',
    bili_jct: 'bili_jct',
    DedeUserID: 'dedeuserid',
    DedeUserID__ckMd5: 'dedeuserid_ckmd5',
    sid: 'sid',
  }
  for (const [from, to] of Object.entries(map)) {
    const v = sp.get(from)
    if (v) out[to] = v
  }
  return out
}

/** Set-Cookie 兜底解析 */
export function parseSetCookie(list) {
  const out = {}
  const map = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', DedeUserID__ckMd5: 'dedeuserid_ckmd5' }
  for (const line of list) {
    const [pair] = String(line).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (map[k] && v) out[map[k]] = decodeURIComponent(v)
  }
  return out
}

/** 合并写入：不覆盖本地已有的 buvid3 等字段 */
export function saveCreds(fresh) {
  let old = {}
  try { old = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) } catch { /* 没有就新建 */ }
  const next = { ...old, ...fresh }
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  // 只回传字段名，不回传值（值不进日志/前端）
  return { fields: Object.keys(fresh) }
}
