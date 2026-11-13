/**
 * 插件版本号的**唯一来源**（v1.97.3 修）。
 *
 * 为什么要有这个文件：设置页左下角那个「v1.85.0」是 `CanvasSettings.ts` 里手写的常量
 * （`export const CANVAS_UI_VERSION = '1.85.0'`），发版时没人记得改它，于是 package.json
 * 已经走到 1.97.2，页面上还挂着 1.85.0 —— 用户 2026-11-13 报的就是这个：
 * 「画布设置左下角的版本号没有随着版本更新」。同类手抄的地方还有调色合成器启动时的那行
 * 控制台版本戳（bridge.ts），也一起改成读这里。
 *
 * 做法：直接 `import { version } from '../package.json'`，由 rolldown 在**构建时**把字段
 * 内联成字符串常量（vendor 上游画布本来就是这么干的，`canvasComponents.ts` 读的是
 * vendor/aifisher/package.json 的 version，所以打包链一定支持 JSON 具名导入）。
 * 包体积只多这一个字段，运行时零开销，也不需要再造一个生成脚本或 define 占位符。
 *
 * 也就是说：**发版只改 package.json 的 version，重新 build 一次，页面上就跟着变了。**
 * `scripts/test-canvas-pages.mjs` 会拿页面上的版本号和 package.json 对账，再有人写死
 * 版本号（或者改了版本忘了重新构建）回归就会红。
 */
import { version } from '../package.json';

/** 与 package.json 的 `version` 永远一致；页面显示时自己补 `v` 前缀。 */
export const PLUGIN_VERSION: string = version;
