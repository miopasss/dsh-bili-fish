/**
 * dsh-bili-fish — DSH 宿主适配器（cordis 入口）
 *
 * 形状与 hezhaochao/dsh-video-comments 一致（MIT）：
 * 把本包的 MCP stdio 服务器通过 DSH 内置的 @deepseek-ai/dsh-mcp-client 桥接挂进宿主，
 * 模型看到 mcp__fish__<tool> 这一组工具。
 */
import { fileURLToPath } from 'node:url'

export const name = 'bili-fish'

/** MCP 工具要注册进宿主工具注册表，必须等 tools 服务就绪 */
export const inject = ['tools']

export function bridgeConfig() {
  return {
    serverName: 'fish',
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    // ⚠️ 桌面版 DSH 里 process.execPath 是 DeepSeek Harness.exe，不是 node —— 这个环境变量不能省
    env: { ELECTRON_RUN_AS_NODE: '1' },
    toolCallTimeoutMs: 300_000,
    failOnStartupError: false,
  }
}

export async function apply(ctx) {
  const bridge = await import('@deepseek-ai/dsh-mcp-client')
  const connection = ctx.plugin(bridge, bridgeConfig())
  await connection
}
