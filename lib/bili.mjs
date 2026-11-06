/**
 * B 站 Web API 客户端（零依赖，原生 fetch）
 *
 * 端点与签名算法来自社区整理的 bilibili-API-collect 文档，
 * 代码结构参考 MIT 许可的 hezhaochao/dsh-video-comments（mcp/bili.mjs）。
 *
 * 写操作纪律：本文件只做「读」。
 */
import { createHash } from 'node:crypto'
import { creds } from './config.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 风控要求「像浏览器」：缺 sec-ch-ua / Sec-Fetch 系列头会被 412 劫持到验证页 */
export function browserHeaders(referer = 'https://www.bilibili.com/') {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: referer,
    Origin: 'https://www.bilibili.com',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  }
}

export function cookieHeader() {
  const c = creds()
  const parts = []
  if (c.sessdata) parts.push(`SESSDATA=${c.sessdata}`)
  if (c.bili_jct) parts.push(`bili_jct=${c.bili_jct}`)
  if (c.buvid3) parts.push(`buvid3=${c.buvid3}`)
  return parts.join('; ')
}

/* ────────────────────────── wbi 签名 ────────────────────────── */

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiCache = { key: '', at: 0 }

async function wbiKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600_000) return wbiCache.key
  const data = await biliGet('https://api.bilibili.com/x/web-interface/nav')
  const keyOf = (u) => String(u || '').split('/').pop().split('.')[0]
  const raw = keyOf(data?.wbi_img?.img_url) + keyOf(data?.wbi_img?.sub_url)
  if (raw.length < 32) throw new Error('wbi key 获取失败（nav 未返回 wbi_img）')
  const mixin = WBI_MIXIN_TAB.map((i) => raw[i]).filter(Boolean).join('').slice(0, 32)
  wbiCache = { key: mixin, at: Date.now() }
  return mixin
}

/** 返回已签名的 query 串（含 wts 与 w_rid） */
export async function wbiSign(params) {
  const key = await wbiKey()
  const merged = { ...params, wts: Math.floor(Date.now() / 1000) }
  const entries = Object.entries(merged)
    .map(([k, v]) => [k, String(v).replace(/[!'()*]/g, '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const w_rid = createHash('md5').update(query + key).digest('hex')
  return `${query}&w_rid=${w_rid}`
}

/* ────────────────────────── 基础请求 ────────────────────────── */

function withCookie(headers) {
  const ck = cookieHeader()
  if (ck) return { ...headers, Cookie: ck }
  return headers
}

/** 统一返回 { code, message, data }，不因非 0 而抛异常 —— 调用方按语义处理 */
export async function biliRaw(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    headers: withCookie({ ...browserHeaders(), ...headers }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { http: res.status, ok: res.ok, json, text }
}

export async function biliGet(url, opts) {
  const r = await biliRaw(url, opts)
  if (r.json && r.json.code === 0) return r.json.data
  const code = r.json?.code ?? r.http
  const msg = r.json?.message ?? (r.text || '').slice(0, 120)
  const err = new Error(`B站 API ${code}: ${msg}`)
  err.biliCode = code
  err.http = r.http
  throw err
}

/* ────────────────────────── 读接口 ────────────────────────── */

export const parseBvid = (input) => (String(input || '').match(/BV[0-9A-Za-z]{10}/) || [null])[0]
/** 从 URL 里解析分 P（?p=3）；没有就是 1 */
export const parsePage = (input) => {
  const m = String(input || '').match(/[?&]p=(\d+)/)
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * 视频元信息。
 *
 * ⚠️ 多 P 视频的坑（2026-11-04 修正）：
 *   `view` 返回的 `cid` 是**第 1P** 的，而 `duration` 是**所有分 P 的总和**。
 *   直接拿来用会让字幕/OCR 只覆盖第 1P、却按总时长算覆盖率
 *   （实测 320P 的课覆盖率被算成 0.29%，而第 1P 实际是 100%），定标也会错到最大档。
 *   → 这里按 `p` 取**那一个分 P** 的 cid 与 duration，总时长另存 `totalDuration`。
 */
export async function getView(bvid, { p = 1 } = {}) {
  const d = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { Referer: `https://www.bilibili.com/video/${bvid}/` },
  })
  const pageList = Array.isArray(d.pages) ? d.pages : []
  const pageCount = Math.max(1, Number(d.videos) || pageList.length || 1)
  const idx = Math.min(Math.max(1, p), pageCount) - 1
  const page = pageList[idx]

  return {
    bvid: d.bvid, aid: d.aid,
    cid: page?.cid ?? d.cid,
    title: d.title, desc: d.desc, owner: d.owner?.name, ownerMid: d.owner?.mid,
    duration: page?.duration ?? d.duration,        // ← 被处理的那一个分 P
    totalDuration: d.duration,                     // ← 全片（所有分 P 总和）
    pageIndex: idx + 1, pageCount,
    pageTitle: page?.part ?? null,
    tid: d.tid, tname: d.tname,
    width: d.dimension?.width ?? 0, height: d.dimension?.height ?? 0,
    isStory: Boolean(d.is_story),
    stat: d.stat,
    pic: d.pic,
  }
}

/** 雪碧图：一次拿全片帧 + 时间轴 */
export async function getVideoshot(aid, cid) {
  const d = await biliGet(
    `https://api.bilibili.com/x/player/videoshot?index=1&aid=${aid}&cid=${cid}`,
    { headers: { Referer: 'https://www.bilibili.com/' } },
  )
  return {
    cols: Number(d.img_x_len) || 10,
    rows: Number(d.img_y_len) || 10,
    cellW: Number(d.img_x_size) || 0,
    cellH: Number(d.img_y_size) || 0,
    images: (d.image || []).map((p) => (p.startsWith('//') ? 'https:' + p : p)),
    /** index[0] 是哨兵，第 k 帧时间 = index[k+1] */
    times: Array.isArray(d.index) ? d.index : [],
  }
}

export async function getPlayurl(bvid, cid) {
  const url =
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}` +
    `&qn=80&fnval=1&platform=pc&high_quality=1`
  const d = await biliGet(url, { headers: { Referer: `https://www.bilibili.com/video/${bvid}/` } })
  return {
    quality: d.quality,
    acceptQuality: d.accept_quality,
    durl: d.durl?.[0] ? { size: d.durl[0].size, url: d.durl[0].url } : null,
  }
}

/**
 * 单独的音轨（DASH，`fnval=16`）。
 *
 * 为什么要它：ASR 只需要声音。整片 mp4 动辄几十上百 MB，而纯音轨通常只有
 * 一两 MB —— 对"画面没字只能靠听"的视频，这一条能省掉绝大部分下载量。
 */
export async function getAudioStream(bvid, cid) {
  const url =
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}` +
    `&fnval=16&fourk=1&platform=pc&high_quality=1`
  const d = await biliGet(url, { headers: { Referer: `https://www.bilibili.com/video/${bvid}/` } })
  const list = d?.dash?.audio || []
  if (!list.length) return null
  // 码率最高的那条；backupUrl 用于 PCDN 探活失败时兜底
  const best = [...list].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
  const pick = best.baseUrl || best.base_url
  const backup = (best.backupUrl || best.backup_url || [])[0] || null
  if (!pick) return null
  return { url: pick, backup, size: best.size || 0, mime: best.mimeType || best.mime_type || '' }
}

/** 字幕轨道：必须登录 + WBI 签名，否则 subtitle_url 缺 auth_key（CDN 403） */
export async function getSubtitleTracks(bvid, cid) {
  const q = await wbiSign({ bvid, cid })
  const d = await biliGet(`https://api.bilibili.com/x/player/wbi/v2?${q}`, {
    headers: { Referer: `https://www.bilibili.com/video/${bvid}/` },
  })
  const sub = d?.subtitle ?? {}
  return {
    aiStatus: sub.ai_status,
    tracks: (sub.subtitles ?? []).map((s) => ({
      lan: s.lan, lanDoc: s.lan_doc, url: s.subtitle_url, ai: String(s.lan).startsWith('ai-'),
    })),
  }
}

/** 字幕 JSON：auth_key 分钟级过期，拿到就得马上下载，URL 不能截断 */
export async function fetchSubtitleBody(trackUrl, bvid) {
  const url = trackUrl.startsWith('http') ? trackUrl : 'https:' + trackUrl
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${bvid}/` },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`下载字幕失败 HTTP ${res.status}（auth_key 可能已过期）`)
  const text = await res.text()
  let body
  try { body = JSON.parse(text).body ?? [] } catch { throw new Error('字幕不是 JSON：' + text.slice(0, 80)) }
  return body.map((l) => ({ from: l.from, to: l.to ?? l.from, content: String(l.content ?? '') }))
}

/** 弹幕 XML：即使不发 Accept-Encoding 也返回裸 deflate，必须手动解压 */
export async function getDanmakuXml(cid) {
  const res = await fetch(`https://comment.bilibili.com/${cid}.xml`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`弹幕 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  let xml = buf.toString('utf8')
  if (!xml.includes('<d ') && !xml.includes('<i>')) {
    const { inflateRawSync, inflateSync, gunzipSync } = await import('node:zlib')
    for (const fn of [inflateRawSync, inflateSync, gunzipSync]) {
      try {
        const out = fn(buf).toString('utf8')
        if (out.includes('<d ') || out.includes('<i>')) { xml = out; break }
      } catch { /* 试下一个 */ }
    }
  }
  const items = [...xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)].map((m) => ({
    t: Number(m[1].split(',')[0]),
    text: m[2]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
  }))
  return { rawBytes: buf.length, items }
}
