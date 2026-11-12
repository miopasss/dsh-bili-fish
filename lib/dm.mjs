/**
 * 私信（2026-11-12）
 *
 * 为什么需要：评论会被影子封禁（自己看得到、别人看不到），这时候内容其实生成了、
 * 只是送不到人眼前。私信是唯一还能用的送达通道——不占评论区、不进推荐、也不容易被折叠。
 *
 * 只在**评论确认被吞之后**兜底用，不拿它当日常回复渠道。
 *
 * 接口：POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg
 * 需要 cookie（SESSDATA 认人）+ csrf（bili_jct）+ 一个稳定的 dev_id（设备指纹）。
 * dev_id 生成一次后落盘复用——每次换一个等于每次都换一台新设备，容易触发风控。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME } from './paths.mjs'
import { creds } from './config.mjs'
import { cookieHeader, browserHeaders } from './bili.mjs'

const SEND_API = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg'
const DEVICE_FILE = path.join(HOME, 'dm-device.json')

/** 单条私信的字数上限（实测 786 字被 21007 拒，保守取 300） */
export const DM_CHUNK = 300
/**
 * 一次最多发几条。
 *
 * ⚠️ B站 有硬限制：**对方没回复/没互关之前，只能发 1 条**（21047）。
 * 所以私信只能当"通知"，不能当"正文通道"——正文留在控制台历史里。
 */
export const DM_MAX_PARTS = 1

/** 设备指纹：生成一次就存下来，之后一直用同一个 */
export function deviceId() {
  try {
    const j = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'))
    if (j?.dev_id) return j.dev_id
  } catch { /* 没有就生成 */ }
  const devId = crypto.randomUUID().toUpperCase()
  try {
    fs.mkdirSync(HOME, { recursive: true })
    fs.writeFileSync(DEVICE_FILE, JSON.stringify({ dev_id: devId, createdAt: new Date().toISOString() }, null, 2))
  } catch { /* 写不了也照用 */ }
  return devId
}

/** 自己的 mid（从 cookie 里解不出来，靠 nav 或调用方给） */
let selfMid = null
export function setSelfMid(mid) {
  selfMid = Number(mid) || null
}

/**
 * 按句子边界切分长文本
 * 私信没有评论那种楼中楼拆分需求，但一条几千字也不合适，切开发更稳。
 */
export function splitMessage(text, limit = DM_CHUNK) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.length <= limit) return [t]
  const out = []
  let rest = t
  while (rest.length > limit && out.length < 19) {
    // 先找 limit 之前最后一个句末标点
    const cut = rest.slice(0, limit)
    const m = cut.match(/[。！？!?\n][^。！？!?\n]*$/)
    const at = m ? cut.length - m[0].length + 1 : limit
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  // 段数用完了但还有剩：截断并说明，别让最后一条又变成长文
  if (rest) out.push(rest)
  return out.slice(0, 20) // 纯切分：安全上限 20 段，条数限制交给 sendDM
}

/**
 * 发私信。
 * @param {number|string} toMid 收件人
 * @param {string} text 内容（超长会自动拆条）
 * @param {{dry?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, parts:number, keys:string[], error?:string}>}
 */
/** 把 B站 的错误码翻成人话（这几个都是私信特有的坑） */
export const DM_ERRORS = {
  21007: '消息过长（实测 786 字被拒，单条约 300 字以内安全）',
  21047: '对方还没回复或关注我，最多只能发 1 条',
  21026: '不能给自己发',
  '-101': '登录已失效',
}

export async function sendDM(toMid, text, { dry = false } = {}) {
  const c = creds()
  if (!c?.sessdata || !c?.bili_jct) return { ok: false, parts: 0, keys: [], error: '缺少 cookie 或 csrf' }
  const to = Number(toMid)
  if (!to) return { ok: false, parts: 0, keys: [], error: '收件人 mid 无效' }
  if (!selfMid) return { ok: false, parts: 0, keys: [], error: '还不知道自己的 mid（先调 setSelfMid）' }
  if (to === selfMid) return { ok: false, parts: 0, keys: [], error: '不能给自己发' }

  let chunks = splitMessage(text)
  if (!chunks.length) return { ok: false, parts: 0, keys: [], error: '内容为空' }
  const dropped = Math.max(0, chunks.length - DM_MAX_PARTS)
  chunks = chunks.slice(0, DM_MAX_PARTS)
  if (dropped > 0) {
    chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, DM_CHUNK) +
      `\n…（还有 ${dropped} 段没发：对方没回复前只能发 ${DM_MAX_PARTS} 条，全文在控制台历史里）`
  }
  if (dry) return { ok: true, parts: chunks.length, keys: [], dry: true }

  const devId = deviceId()
  const keys = []
  for (let i = 0; i < chunks.length; i += 1) {
    const form = new URLSearchParams({
      'msg[sender_uid]': String(selfMid),
      'msg[receiver_id]': String(to),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[dev_id]': devId,
      'msg[new_face_version]': '0',
      'msg[content]': JSON.stringify({ content: chunks[i] }),
      csrf: c.bili_jct,
      csrf_token: c.bili_jct,
    })

    let json = null
    try {
      const res = await fetch(SEND_API, {
        method: 'POST',
        headers: {
          ...browserHeaders('https://message.bilibili.com/'),
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader(),
          Origin: 'https://message.bilibili.com',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      })
      json = await res.json().catch(() => null)
    } catch (e) {
      return { ok: false, parts: i, keys, error: e?.message ?? String(e) }
    }

    if (json?.code !== 0) {
      const hint = DM_ERRORS[json?.code]
      return { ok: false, parts: i, keys, error: `code=${json?.code} ${hint ?? json?.message ?? ''}`.trim(), code: json?.code }
    }
    keys.push(String(json?.data?.msg_key ?? ''))
    // 多条之间停一下，别把自己送进风控
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 1200))
  }
  return { ok: true, parts: chunks.length, keys }
}
