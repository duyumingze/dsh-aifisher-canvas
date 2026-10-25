# 品牌标识：渡雨鸣泽

画布界面上露出的标识都是**渡雨鸣泽**的视觉标识（v1.0，2026-10）。
一句话：一块黑，一刀红，一个「渡」。

## 文件

| 文件 | 用途 |
|---|---|
| `duyumingze-mark-reversed.svg` | 反白版（白块挖黑字），**深底 UI 用**，画布/看板头部就是它 |
| `duyumingze-mark.svg` | 标准版（黑块 + 白字 + 红刀），浅底用 |
| `duyumingze-icon.svg` | 满版图标版（黑块画满画布），头像 / favicon / ≤32px 用 |
| `duyumingze-mark-mono.svg` | 单色版（刀并入黑），单色印刷、烫印、雕刻用 |
| `duyumingze-watermark.svg` | 水印版（无块，白字红刀），压在照片/渲染图/视频上 |
| `duyumingze-lockup-h.svg` | 横排组合（符号在左，四字在右） |
| `duyumingze-lockup-v.svg` | 竖排组合（符号在上，四字在下） |
| `aifisher-mark-white.svg` | **兼容壳**：内容 = `duyumingze-icon.svg`（深底 UI 的 24–36px 位置就是这个） |
| `aifisher-mark-black.svg` | **兼容壳**：内容 = `duyumingze-mark.svg` |

## 为什么有两个「aifisher-mark-*.svg」

上游把品牌图写死成**根路径 URL**（`vendor/aifisher/src/stable/**` 里十几个
`<img src="/aifisher-mark-white.svg">`、`/brand/aifisher-mark-white.svg`），
宿主半 `src/host/staticAssets.ts` 按这两个文件名挂在根路径上，回归脚本
（`test-panel-exit` / `smoke-contract` / `browser-check`）也按这两个名字断言。

所以**文件名保持不动、换文件内容**：vendor 一行不用改、回归不用改，
界面上看到的就是渡雨鸣泽。要用别的版本（例如浅底用标准版），
把对应 SVG 覆盖到这两个文件里即可。

## 用法约束（来自标识规范）

- 浅底用标准版；深底用反白版；压在照片、渲染图、视频上用「水印版」。
- 清空区：四周至少留出黑块边长的 1/4，不放任何东西。
- 最小尺寸：标准版不小于 32px；更小用满版图标版（`duyumingze-icon.svg`）。
- 不要拉伸、旋转、加投影或描边；不要改刀的角度/粗细/位置；
  不要把「渡」换成别的字或把刀换成别的颜色；不要把黑块、字、刀拆开单独用。

## 颜色

| 名称 | HEX |
|---|---|
| 墨黑 | `#111111` |
| 朱红 | `#C0392B` |
| 纸白 | `#FFFFFF` |

（墨黑正好等于画布主题的 `--af-surface: #111111`，所以深色画布上「一块黑」是隐形的。
画布里所有露出标识的位置（24–36px）都小于标准版的 32px 下限，按规范用**满版图标版**：
深底上看到的是白字 + 红刀，浅底上才显出黑块。反白版留给 ≥64px 的位置。）
