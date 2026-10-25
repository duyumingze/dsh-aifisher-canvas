# 服务端合成渲染 · 分镜 contact sheet

把画布项目里**已经出图**的节点，按画布阅读顺序排成一张分镜拼版（contact sheet），直接在 Node 里渲染成 PNG。

## 为什么不用浏览器截图

画布自带的「导出」走的是 DOM 截图（`html-to-image` → `capture: toPng`）。这条路有三个天花板：

1. **DOM 序列化**：`foreignObject` 方案要重新摆一遍布局，节点一多就慢，视频元素截不出像素；
2. **跨域图**：素材来自远端时 canvas 会被污染，`toDataURL` 直接抛错；
3. **尺寸上限**：浏览器 canvas 单边约 8192–16384px，几十张 4K 图拼一版就超了。

本工具反过来做：读 `canvas.json` 的数据 → 用 [LeaferJS](https://github.com/leaferjs/leafer-ui)（MIT）在服务端重画场景 → 导出 PNG。尺寸与倍率只受内存限制，与浏览器无关。

## 安装

独立安装，不参与插件构建，产物不会进 `lib/`：

```bash
cd tools/contact-sheet
pnpm install --config.node-linker=hoisted --config.enableGlobalVirtualStore=false
```

> 为什么要带这两个参数：pnpm 11 默认的全局虚拟存储会把包放成软链/junction 布局，而 `@leafer-ui/node` 的 dist 裸引用了 `@leafer/core` 却没在 `package.json` 里声明，导致 Node 解析不到兄弟包。同一个目录的 `.npmrc` 也写了两项，但 workspace 根目录的存在会让它偶发不生效，命令行显式传最稳。

原生 canvas 后端是 `@napi-rs/canvas`，它的平台二进制是 `optionalDependencies`。pnpm 有时不装，报错时手动补一条：

```bash
pnpm add @napi-rs/canvas-win32-x64-msvc      # Windows x64
# pnpm add @napi-rs/canvas-darwin-arm64      # macOS Apple Silicon
# pnpm add @napi-rs/canvas-linux-x64-gnu     # Linux x64
```

## 用法

```bash
# 数据目录默认取 $DSH_HOME/storages/dsh-aifisher-canvas
node render.mjs

# 指定项目（id 或标题片段）
node render.mjs --project 显影 --out D:\sheet.png

# 6 列、单元格 320、3 倍图
node render.mjs --cols 6 --cell-width 320 --scale 3

# 只看看有哪些项目
node render.mjs --list
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--storage` | `$DSH_HOME/storages/dsh-aifisher-canvas` | 画布数据目录（含 `canvas.json` 与 `media/`） |
| `--project` | 已出图节点最多的项目 | 项目 id 或标题片段 |
| `--out` | `<storage>/exports/contact-sheet-<projectId>.png` | 输出 PNG |
| `--cols` | `4` | 列数 |
| `--cell-width` | `360` | 单元格宽（逻辑像素，其余尺寸按它等比推导） |
| `--scale` | `2` | 像素倍率，最终 PNG = 逻辑尺寸 × scale |
| `--title` | 项目标题 | 覆盖拼版标题 |
| `--list` | — | 只列项目，不渲染 |

输出示例（1642×1602 逻辑像素，@2x 后 3284×3204 px，13 张图约 330ms / 1.4MB）：

```
[contact-sheet] 《显影》
  版式 1642x1602 @2x（3284x3204 px）
  13 张图，耗时 331 ms，输出 1404 KB
  → …\exports\contact-sheet-a8b5f9be-….png
  跳过：未出图 40
```

## 版式约定

- **顺序**：按节点坐标先上后下、先左后右，和画布上的阅读顺序一致，不按生成时间排。
- **裁切**：`contain`（完整显示整幅图，不改构图）——这样锚点角色/道具的构图信息不会被裁掉。要 `cover` 填满可以把 `Image` 那段的 `Math.min` 换成 `Math.max`。
- **标题**：`node.title` → 整段 `prompt` → 「（无标题）」，最多两行，超出省略。两处都是原始文件名时（上传节点常见）显示「上传素材」。折行/截断用 `measureText` 自己量，**不依赖 Leafer 的 `maxLines`** —— 后者在 node 渲染里不裁行，长标题会压到元信息上。
- **元信息**：`model · aspectRatio · resolution` 一行，跟在标题实际行数之后。
- **页脚**：项目 id，方便对回原项目。

## 已知限制

- 只拼 `Image` / `Upload Image` 节点；`Video` / `Upload Video` 只计数、不参与（视频封面得先截帧成图节点）。
- 节点没有 `resultUrl`/`url`（从没生成过）或素材文件已丢，会被跳过并在末尾汇总「未出图 N / 素材缺失 N」。
- 中文字体写死 `Microsoft YaHei`（`render.mjs` 顶部 `FONT`）。换机器没有该字体时，改成系统里有的中文字体；napi 侧不会按 fallback 自动挑。
- 图片元素是异步解码的，导出前固定等 80ms。单张素材极大时若出现空白格，把这个等待调大。
- 不做去重：同一节点多次生成的「历史」只按节点当前 `resultUrl` 取一张。

## 依赖与许可

- [leafer-ui](https://github.com/leaferjs/leafer-ui) 2.3.1 —— MIT，70KB gzip、零运行时依赖
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) 1.0.13 —— MIT，Skia 原生绑定
- 本目录自己声明 `package.json`，**不进主插件依赖**，也不影响 `pnpm build` 与回归脚本
