/**
 * 纯函数出口（v1.59）：回归脚本从这里拿 host 侧的纯逻辑。
 *
 * 为什么不直接 import `src/**`：node 的类型剥离不支持**无扩展名**的相对 import
 * （host 源码里是 `./consistency`），直接 import 会在 node 里解析失败。
 * lib/index.js 是构建产物、已经把这些函数导出，也不会执行 `apply()`（apply 要 ctx）。
 */
export {
  coverageReport,
  orderShots,
  planLockOperations,
  planUnlockOperations,
  shotNumberFromTitle,
  buildCopilotSuggestions,
  copilotSummary,
  // v1.69（P3）：摄影参数 / 定向查询 / 创作进度
  applyCameraToPrompt,
  buildCameraClause,
  cameraSummary,
  describeAperture,
  describeFocalLength,
  normalizeCameraInput,
  stripCameraClause,
  queryCanvas,
  formatProgressForPrompt,
  nextPhase,
  PHASES,
} from '../../lib/index.js';
