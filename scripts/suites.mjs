/**
 * **唯一的套件清单**：本机全量、`pnpm test`、CI 都从这里读。
 *
 * 为什么要有这个文件（2026-11-04）：此前门禁散在三处——`package.json` 的 test 链 52 套、
 * `run-all-regressions.mjs` 55 项、CI 只跑 4 套——结果 v1.88 新加的 `test-canvas-skin`
 * 谁都没跑（写的时候没登记，之后的"全绿"也就没覆盖它）。现在只有这一份：
 * 漏登记 = 本机与 CI 同时漏，加套件只改一处。
 *
 * 字段：
 *   - `file`：相对仓库根。
 *   - `ci`：公开 CI（ubuntu，无上游源码树、无 Chrome）能跑吗。默认 false —— 只把已经
 *     在 CI 里跑绿过的标 true，别凭感觉加（会红在别人机器上）。
 *   - `note`：哪一版加的 / 守什么，方便下次判断能不能动。
 */
export const SUITES = [
  { file: 'scripts/smoke-contract.mjs', note: '产物契约（client 半能被 ModuleLoader 加载、面板出口还在）' },
  { file: 'scripts/test-canvas-backend.mjs' },
  { file: 'scripts/test-canvas-render.mjs' },
  { file: 'scripts/test-panel-exit.mjs' },
  { file: 'scripts/test-canvas-chat-dock.mjs' },
  { file: 'scripts/test-canvas-agent.mjs' },
  { file: 'scripts/test-canvas-agent-chat.mjs' },
  { file: 'scripts/test-canvas-agent-speed.mjs' },
  { file: 'scripts/test-canvas-agent-tools.mjs', ci: true, note: 'canvas_control 动作面（CI 核心回归）' },
  { file: 'scripts/test-canvas-placement.mjs' },
  { file: 'scripts/test-canvas-digest.mjs', ci: true, note: 'digest 摘要（CI 核心回归）' },
  { file: 'scripts/test-canvas-recipe.mjs' },
  { file: 'scripts/test-canvas-save.mjs' },
  { file: 'scripts/test-canvas-preview.mjs' },
  { file: 'scripts/test-canvas-events.mjs' },
  { file: 'scripts/test-canvas-memory.mjs', ci: true, note: '项目记忆（CI 核心回归）' },
  { file: 'scripts/test-canvas-consistency.mjs' },
  { file: 'scripts/test-canvas-copilot.mjs' },
  { file: 'scripts/test-canvas-job.mjs' },
  { file: 'scripts/test-canvas-storyboard.mjs' },
  { file: 'scripts/test-canvas-references.mjs', ci: true, note: '@ 画布节点引用（CI 核心回归）' },
  { file: 'scripts/test-canvas-generation.mjs' },
  { file: 'scripts/test-canvas-generation-concurrency.mjs', note: 'v1.90 批量生成并发 1–3 路（并发池 + 真画布集成）' },
  { file: 'scripts/test-media-editing.mjs' },
  { file: 'scripts/test-canvas-library.mjs' },
  { file: 'scripts/test-custom-workflows.mjs' },
  { file: 'scripts/test-canvas-workflow-config.mjs' },
  { file: 'scripts/test-canvas-local-workflows.mjs' },
  { file: 'scripts/test-cloud-generation.mjs' },
  { file: 'scripts/test-ark-generation.mjs' },
  { file: 'scripts/test-ark-video.mjs' },
  { file: 'scripts/test-cloud-channels.mjs' },
  { file: 'scripts/test-cloud-channels-dashscope.mjs', note: 'v1.92 百炼 DashScope 方言（可灵 v3-omni 图像）' },
  { file: 'scripts/test-cloud-channels-midjourney.mjs', note: 'v1.93 Midjourney 方言（/v1/midjourney/*）' },
  { file: 'scripts/test-canvas-cloud-generation.mjs' },
  { file: 'scripts/test-canvas-ui-services.mjs' },
  { file: 'scripts/test-canvas-grid.mjs' },
  { file: 'scripts/test-canvas-node-search.mjs' },
  { file: 'scripts/test-canvas-stack.mjs' },
  { file: 'scripts/test-canvas-video-history.mjs' },
  { file: 'scripts/test-canvas-video-references.mjs' },
  { file: 'scripts/test-canvas-video-frames.mjs' },
  { file: 'scripts/test-canvas-video-seek.mjs', note: 'v1.68 进度条拖拽' },
  { file: 'scripts/test-canvas-knife.mjs' },
  { file: 'scripts/test-canvas-compositor.mjs', note: 'v1.70 调色节点 + 全屏合成器' },
  { file: 'scripts/test-canvas-reroute.mjs', note: 'v1.71 Shift+右键划选合并' },
  { file: 'scripts/test-canvas-outpaint.mjs' },
  { file: 'scripts/test-canvas-last-model.mjs' },
  { file: 'scripts/test-project-archive.mjs' },
  { file: 'scripts/test-canvas-data-dir.mjs' },
  { file: 'scripts/test-canvas-task-queue.mjs' },
  { file: 'scripts/test-canvas-pages.mjs', note: 'v1.84 页面层（项目库 / 设置）' },
  { file: 'scripts/test-canvas-skin.mjs', note: 'v1.81 皮肤 + v1.88 生成中噪波点阵（此前没进清单）' },
  { file: 'scripts/test-canvas-home.mjs', note: 'v1.86 首屏点一次就进画布' },
  { file: 'scripts/test-canvas-markdown.mjs', note: 'v1.87 拖入 .md / Markdown 富文档' },
  { file: 'scripts/test-canvas-workflow-library.mjs' },
  { file: 'scripts/test-canvas-shadcn-ui.mjs' },
  { file: 'scripts/verify-canvas-ui.mjs' },
  { file: 'scripts/test-canvas-p2.mjs' },
  { file: 'scripts/test-canvas-crew.mjs' },
];

/**
 * 真机（headless Chromium）套件：`browser-check.mjs` 自带 41 场场景，**不进 jsdom 全量**
 * （要 Chrome、要 8 分钟）。收口流程里由 `pnpm test:full` 串起来跑。
 */
export const BROWSER_CHECK = 'scripts/browser-check.mjs';
