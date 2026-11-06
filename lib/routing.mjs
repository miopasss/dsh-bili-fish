/**
 * 召唤指令：从 @ 正文里解析关键词，**强制**改变素材源与输出形态
 *
 * 设计（2026-11-06）：
 *   · 只解析**传进来的这一段文本**（调用方只传被 @ 的那条评论正文），
 *     绝不把整条消息流 / 视频标题 / 字幕喂进来 —— 否则"你怎么看"这种词会乱撞。
 *   · 归一化后再匹配：转小写、全角转半角（ＯＣＲ → OCR）、去掉所有空白。
 *     用户手打「用 OCR」「用ocr」「用ＯＣＲ」应该等价。
 *   · **长词优先**：按长度降序匹配，命中后把那段文本"吃掉"，
 *     避免「总结加看法」被拆成两个短词。
 *   · 同一组多个词都命中 → 取**最后出现**的那个（用户后说的算）。
 *   · 素材源：forceSubtitle / forceOcr 谁最后命中取谁；都没中 → auto
 *   · 输出形态：archive / summaryOnly / viewOnly / both 谁最后命中取谁；都没中 → view
 *
 * 词表放在 lib/config.mjs 的 `DEFAULTS.routing.keywords`，用户可以在 config.json 里覆盖；
 * 本模块不写死任何词。
 */
import { config } from './config.mjs'

/** 可选的素材源（与 --source 取值一致） */
export const SOURCES = ['auto', 'subtitle', 'ocr', 'asr']
/** 可选的输出形态（与 --mode 取值一致） */
export const MODES = ['archive', 'summary', 'view', 'both']

/** mode → prompt 里的【目标】那行。archive 不走模型，所以没有目标句。 */
export const TARGET_BY_MODE = {
  summary: '总结这条视频讲了什么',
  view: '说说你怎么看',
  both: '先总结这条视频讲了什么，再说说你怎么看',
}

/** 中文名：给日志用 */
export const MODE_LABEL = {
  archive: '归档（只拉文字稿，不调模型）',
  summary: '只总结',
  view: '说看法',
  both: '总结 + 看法',
}

/** 状态行里用的形态短名（必须和 MODES 一一对应） */
export const MODE_SHORT_LABEL = {
  archive: '归档模式',
  summary: '只总结',
  view: '说看法',
  both: '总结+看法',
}

export const SOURCE_LABEL = {
  auto: '自动判定',
  subtitle: '强制字幕',
  ocr: '强制画面 OCR',
}

/** 素材源关键词组：命中它们才算"跳过了自动检验"（字幕闸门 / 探针） */
const SOURCE_GROUPS = new Set(['forceSubtitle', 'forceOcr', 'forceAsr'])

/**
 * 生成并入第 1 条回复开头的状态行 —— **纯函数，不碰网络也不读配置**。
 *
 * 为什么要按关键词组分开写（2026-11-06）：
 *   · 命中「用OCR」这类**素材源**关键词 → 确实跳过了字幕闸门 / 探针，说"跳过自动检验"成立；
 *   · 只命中「只要总结」这类**输出形态**关键词 → 一个检验都没跳过，
 *     旧文案「跳过自动检验」是假的；这时改成说清按什么形态输出。
 *
 * 末尾的形态后果：
 *   · 素材源分支：补一句「本条按「X」输出。」（它上面只说清了"跳过了检验"）；
 *   · 归档：再额外报清楚拉到了哪种素材、几句、约多少字（`info.tier/rawLines/chars`）。
 *   只命中输出形态的分支，形态已经写在第一句里，不重复。
 *
 * @param {{hits?:Array<{group:string, word:string}>, mode?:string}} cmd parseCommand() 的结果
 * @param {{tier?:string, rawLines?:number, chars?:number}} [info] 本次素材信息（归档模式用）
 * @returns {string} 没命中任何关键词 → 空串
 */
export function buildStatusLine(cmd, info = {}) {
  const hits = Array.isArray(cmd?.hits) ? cmd.hits : []
  if (!hits.length) return ''

  const words = hits.map((h) => h.word).join('、')
  const mode = MODE_SHORT_LABEL[cmd?.mode] ? cmd.mode : 'view'
  const modeName = MODE_SHORT_LABEL[mode]
  const fromSource = hits.some((h) => SOURCE_GROUPS.has(h.group))

  let line = fromSource
    ? `命中「${words}」关键词，跳过自动检验。`
    : `命中「${words}」关键词，本条按「${modeName}」输出。`

  // 素材源分支只说清了"跳过了检验"，还得说清这次按什么形态输出
  // （输出形态分支上面那句已经写了形态，不重复）
  if (fromSource) line += `本条按「${modeName}」输出。`

  if (mode === 'archive') {
    const tierName = { subtitle: '字幕', ocr: '画面OCR', asr: '语音转写' }[info.tier] ?? '素材'
    const sentences = Number(info.rawLines ?? 0)
    // chars 是新名字；materialChars 是 CLI --json payload 的旧字段，兼容一下
    const chars = Number(info.chars ?? info.materialChars ?? 0)
    line += `已拉取完整文字稿：${tierName} ${sentences} 句 / 约 ${chars} 字，已存本地。`
  }

  return line
}

/** 关键词组 → 影响哪一维 */
const GROUP_KIND = {
  forceSubtitle: 'source',
  forceOcr: 'source',
  forceAsr: 'source',
  archive: 'mode',
  summaryOnly: 'mode',
  viewOnly: 'mode',
  both: 'mode',
  /** 静默：独立维度，和素材源 / 输出形态正交 */
  quiet: 'quiet',
}

const GROUP_SOURCE = { forceSubtitle: 'subtitle', forceOcr: 'ocr', forceAsr: 'asr' }
const GROUP_MODE = { archive: 'archive', summaryOnly: 'summary', viewOnly: 'view', both: 'both' }

/**
 * 归一化：全角 → 半角、小写、去掉所有空白。
 *
 * 匹配用的文本必须和关键词走同一套归一化，否则 `用 OCR` / `用ＯＣＲ` 就匹配不上。
 * 只在归一化后的文本上找位置；输出给用户的仍是词表里的**原始写法**。
 */
export function normalizeText(text) {
  return String(text ?? '')
    // 全角 ASCII（！ … ～）→ 半角；对应关系是固定的 -0xFEE0
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * 解析一段 @ 正文里的召唤指令（**纯函数**，除了默认词表走 config）
 *
 * @param {string} text 被 @ 的那条评论正文
 * @param {object|null} [keywords] 词表；省略则用 config().routing.keywords
 * @returns {{source:'auto'|'subtitle'|'ocr', mode:'archive'|'summary'|'view'|'both',
 *            hits:Array<{group:string, word:string}>}}
 */
export function parseCommand(text, keywords = null) {
  const empty = { source: 'auto', mode: 'view', quiet: false, hits: [] }
  const table = keywords ?? config().routing?.keywords ?? {}
  const norm = normalizeText(text)
  if (!norm) return empty

  // ① 把词表摊平 → 归一化 → 按长度降序（长词优先）
  const entries = []
  for (const [group, words] of Object.entries(table ?? {})) {
    if (!GROUP_KIND[group] || !Array.isArray(words)) continue
    for (const word of words) {
      const n = normalizeText(word)
      if (n) entries.push({ group, word: String(word), norm: n })
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length)

  // ② 逐词找出现位置；已"吃掉"的区间不再参与匹配
  const taken = new Array(norm.length).fill(false)
  const lastByGroup = new Map()
  for (const e of entries) {
    for (let from = 0; ; ) {
      const at = norm.indexOf(e.norm, from)
      if (at < 0) break
      const end = at + e.norm.length
      let free = true
      for (let i = at; i < end; i += 1) if (taken[i]) { free = false; break }
      if (free) {
        for (let i = at; i < end; i += 1) taken[i] = true
        const prev = lastByGroup.get(e.group)
        // 同组多个词命中 → 取最后出现的那个
        if (!prev || at > prev.at) lastByGroup.set(e.group, { group: e.group, word: e.word, at })
      }
      from = at + 1
    }
  }

  if (!lastByGroup.size) return empty

  // ③ 按出现位置排序（读起来是原文顺序），再定 source / mode / quiet
  const found = [...lastByGroup.values()].sort((a, b) => a.at - b.at)
  let srcHit = null
  let modeHit = null
  let quietHit = null
  for (const h of found) {
    const kind = GROUP_KIND[h.group]
    if (kind === 'source') {
      if (!srcHit || h.at > srcHit.at) srcHit = h
    } else if (kind === 'quiet') {
      quietHit = h
    } else if (!modeHit || h.at > modeHit.at) {
      modeHit = h
    }
  }

  return {
    source: srcHit ? GROUP_SOURCE[srcHit.group] : 'auto',
    mode: modeHit ? GROUP_MODE[modeHit.group] : 'view',
    /** 静默：只落本地/网页历史，不在评论区回复 */
    quiet: Boolean(quietHit),
    // 对外只暴露 group / word（位置是实现细节，状态行也用不到）
    hits: found.map(({ group, word }) => ({ group, word })),
  }
}

/**
 * 把召唤指令从 @ 正文里剃掉，留下**提问者真正说的话**（纯函数）
 *
 * 为什么要它：2026-11-06 之前，评论正文只被 parseCommand 用来提关键词，然后就丢了——
 * 提问者在评论里问的问题从来没进过模型。剃掉 `@昵称` 和命中的关键词后，
 * 剩下的就是该原样交给模型的部分。
 *
 * 只剃三样（和用户定的口径一致）：
 *   ① `@昵称`
 *   ② 命中的关键词原词
 *   ③ 剃完留下的连续空白 / 孤立标点
 * **不剃**「看看」「帮我」这类语气词 —— 那是提问者语气的一部分。
 *
 * @param {string} text 被 @ 的那条评论正文
 * @param {Array<{word:string}>} [hits] parseCommand 的命中词；省略则现算
 * @returns {string}
 */
export function stripAsk(text, hits = null) {
  let t = String(text ?? '')
  if (!t.trim()) return ''

  // ① @昵称（中文昵称里可能带空格，但 B 站的 @ 是一串非空白字符）
  t = t.replace(/@[^\s@]+/g, ' ')

  // ② 命中的关键词（原文写法 + 归一化写法都可能出现，逐个去掉）
  const list = Array.isArray(hits) ? hits : parseCommand(t).hits
  for (const h of list) {
    const word = String(h?.word ?? '')
    if (!word) continue
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(esc, 'gi'), ' ')
  }

  // ③ 收拾残局：行内空白压成一个空格，行首行尾标点去掉，连续空行压成一个
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/^[ \t，。、；：,.;:!?！？]+/, '').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
