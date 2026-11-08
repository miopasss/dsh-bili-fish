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
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { CREDS_FILE, pkgRoot } from './paths.mjs'
import { creds } from './config.mjs'
import { cookieHeader } from './bili.mjs'

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
      headers: { ...passportHeaders(), Cookie: cookieOf() },
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

/**
 * B站 的 cookie 名**大小写敏感**：`SESSDATA` 大写才认，`sessdata` 直接 -101。
 * 之前这里原样拼 key（creds() 返回的是小写），导致 nav 一直报未登录。
 * 现在统一走 bili.mjs 的 cookieHeader()，只此一处定义。
 */
function cookieOf() {
  return cookieHeader()
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
  // ★ 续期的关键：poll 响应里带 refresh_token，之前漏存了（导致只能等失效再扫码）
  if (j?.data?.refresh_token) merged.refresh_token = j.data.refresh_token

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

/* ─────────────────── cookie 静默续期（2026-11-08） ───────────────────
 *
 * B站 的 cookie 是「**不推不动**」：不主动调刷新接口，它就一直是旧的，
 * 直到某天硬失效（-101）。失效后再想救只能重新扫码。
 *
 * 完整链路（4 步，可全自动）：
 *   ① GET  cookie/info            → { refresh: bool, timestamp }
 *   ② 算 CorrespondPath           → RSA-OAEP 加密 "refresh_{timestamp}"，取小写 hex
 *      GET  www.bilibili.com/correspond/1/{path} → HTML 里 id="1-name" 的文本 = refresh_csrf
 *   ③ POST cookie/refresh         → 带 refresh_csrf + csrf + 旧 refresh_token，返回**新 cookie**
 *   ④ POST confirm/refresh        → 用**旧** refresh_token 确认，旧的立即作废
 *
 * 前提：本地要有 refresh_token（扫码时从 poll 响应的 data.refresh_token 存下来）。
 */

/** B站 网页端用于计算 CorrespondPath 的公钥（固定值，不是密钥） */
const CORRESPOND_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`

/** refresh_<timestamp> → RSA-OAEP → 小写 hex */
export function correspondPath(timestamp) {
  const buf = Buffer.from('refresh_' + timestamp)
  const enc = crypto.publicEncrypt(
    { key: CORRESPOND_PUB_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    buf,
  )
  return enc.toString('hex')
}

function readCredsFile() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) } catch { return {} }
}

/** 问 B站 现在要不要刷新 */
export async function cookieInfo() {
  const c = readCredsFile()
  const url = 'https://passport.bilibili.com/x/passport-login/web/cookie/info?csrf=' + encodeURIComponent(c.bili_jct || '')
  const r = await fetch(url, {
    headers: { ...passportHeaders(), Cookie: cookieHeader() },
    signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json()
  if (j?.code !== 0) throw new Error(`cookie/info 失败：${j?.message || j?.code}`)
  return j.data || {}
}

/** 从 correspond 页面里抠 refresh_csrf */
export function parseRefreshCsrf(html) {
  const m = String(html).match(/id="1-name"[^>]*>([^<]*)</)
  return m ? m[1].trim() : null
}

/**
 * 执行一次续期。返回：
 *   { ok:true, skipped:'不需要刷新' } —— cookie/info 说不用刷
 *   { ok:true, refreshed:true, fields:[…] } —— 刷成功，已写盘
 *   { ok:false, reason:'no_refresh_token' } —— 本地没有 refresh_token（要重新扫码一次）
 *   { ok:false, reason:'…', message:'…' }
 */
export async function refreshCookie({ force = false } = {}) {
  const c = readCredsFile()
  if (!c.refresh_token) {
    return { ok: false, reason: 'no_refresh_token', message: '本地没有 refresh_token（下次扫码会自动存下来）' }
  }

  let info
  try {
    info = await cookieInfo()
  } catch (e) {
    return { ok: false, reason: 'cookie_info_failed', message: e?.message ?? String(e) }
  }
  if (!info.refresh && !force) return { ok: true, skipped: '不需要刷新' }

  // ② CorrespondPath → refresh_csrf
  let refreshCsrf
  try {
    const path = correspondPath(info.timestamp)
    const r = await fetch('https://www.bilibili.com/correspond/1/' + path, {
      headers: { ...passportHeaders(), Cookie: cookieHeader() },
      signal: AbortSignal.timeout(20_000),
    })
    refreshCsrf = parseRefreshCsrf(await r.text())
  } catch (e) {
    return { ok: false, reason: 'correspond_failed', message: e?.message ?? String(e) }
  }
  if (!refreshCsrf) {
    return { ok: false, reason: 'no_refresh_csrf', message: 'correspond 页面里没找到 refresh_csrf' }
  }

  // ③ cookie/refresh：换新 cookie（旧 refresh_token 放这里）
  const oldToken = c.refresh_token
  let setCookies = []
  let newToken = null
  try {
    const body = new URLSearchParams({
      csrf: c.bili_jct || '',
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: oldToken,
    })
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', {
      method: 'POST',
      headers: {
        ...passportHeaders(),
        Cookie: cookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    })
    setCookies = r.headers.getSetCookie?.() || []
    const j = await r.json()
    if (j?.code !== 0) {
      return { ok: false, reason: 'refresh_rejected', message: `${j?.message || j?.code}（86095 = refresh_csrf 不对或 refresh_token 不匹配）` }
    }
    newToken = j?.data?.refresh_token || null
  } catch (e) {
    return { ok: false, reason: 'refresh_failed', message: e?.message ?? String(e) }
  }

  const fresh = parseSetCookie(setCookies)
  if (!fresh.sessdata) {
    return { ok: false, reason: 'no_new_sessdata', message: 'cookie/refresh 成功但没拿到新 SESSDATA' }
  }
  const saved = saveCreds({ ...fresh, ...(newToken ? { refresh_token: newToken } : {}) })

  // ④ confirm：用**旧** refresh_token 收尾，旧 token 立即作废
  let confirmed = false
  try {
    const body = new URLSearchParams({ csrf: c.bili_jct || '', refresh_token: oldToken })
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/confirm/refresh', {
      method: 'POST',
      headers: {
        ...passportHeaders(),
        Cookie: cookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const j = await r.json()
    confirmed = j?.code === 0
  } catch { /* 确认失败不影响新 cookie 已生效 */ }

  return { ok: true, refreshed: true, confirmed, fields: saved.fields }
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
