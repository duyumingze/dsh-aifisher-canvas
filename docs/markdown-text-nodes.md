# 文本节点与 Markdown（v1.87，v1.89 补预览与去重）

> 对象：`dsh-aifisher-canvas` v1.89.0
> 用户原话（2026-11-01）：「现在画布里的文本节点不兼容 .md 格式的文件，导入 .md 文件内容
> 格式完全不正确。可以做一个能直接拖入 .md 文件到画布生成文本节点」。
> 后续（同日）：「现在能直接拖入.md文件了，但是会生成两个一样的节点；还有做一个文本节点
> 全屏预览的功能」。

## 一、两份数据，一条铁律

文本节点落库时永远成对写两个字段（见 `vendor/.../text/textDocument.ts`）：

| 字段 | 内容 | 谁在用 |
|---|---|---|
| `textContent` | **纯文本镜像**：块之间 `\n`、表格列 `\t`、没有 `#` `**` `|` 这些记号 | 生成请求的提示词、`canvas_control` 的 read、摘要/合规检查 |
| `textRichContent` | `{ version: 1, sourceText, document }`，`document` 是 tiptap/ProseMirror JSON | 画布编辑器与节点卡上的渲染 |

铁律：**两者必须由 `createTextDocumentPatch(document)` 一起产出**。它先过 `safeDocument()`
做 schema 校验，再用 `plainText()` 算出镜像，所以 `sourceText` 与 `textContent` 天然一致；
只要手工拼其中一半，`resolveTextDocument()` 就会判定「富文档与正文对不上」并退回纯段落 ——
表现出来就是「格式又丢了」。

`document` 允许的节点（`safeDocument` 白名单，改动前先看它）：
`paragraph` `heading(1–3)` `bulletList` `orderedList(attr.start)` `listItem` `blockquote`
`codeBlock` `horizontalRule` `table` `tableRow` `tableCell` `tableHeader` `text` `hardBreak`；
marks 只有 `bold` `italic` `underline` `strike` `code`。没有 link、没有 image。

## 二、拖入（新增行为）

`src/client/canvas/textDrop.ts`，由 `bootstrap.ts` 的 `installCanvasTextFileDrop` 装配。

- **在 window 捕获阶段**接 `dragover` / `drop`。画布的 `onDrop` 走 React 冒泡，捕获先到，
  所以能先 `preventDefault + stopPropagation`，不会先弹一句「无法识别的文件类型」
  （`classifyMedia()` 只认图片/视频/音频）。
- **只接管画布范围内**的拖入：`target.closest('#canvas-background, .af-canvas-mount')`，
  且**躲开别人的拖放区**（`[data-fisherai-workflow-manager]` 工作流库面板 —— 那里拖 `.json`
  是导入 ComfyUI 工作流；以及任何 `<dialog>` / `role="dialog"` 浮层）。拖到会话栏 / 设置页 /
  系统别处一律放行。
- **扩展名**：`md markdown mdown mkd mkdn mdx mdwn mdtxt mdtext` 走 Markdown 解析；
  `txt text log csv tsv json jsonl yaml yml srt vtt` 按纯文本逐行成段。其它文件不接管。
- **单份上限 2 MB**；空文件给一条底部提示（`[data-fisherai-text-drop-toast]`），不建空节点；
  一次拖多份时按 36px 斜向错开；同一次拖里混了图片/视频则文本照建、另给一句「非文本文件
  请单独拖一次」（那几份不能上传——事件已经被我们 stopPropagation 了，明说比静默吞掉好）。
- **落点换算与节点搜索同一套**：`#canvas-viewport-content` 的 `translate3d(x,y,0) scale(z)`
  就是屏幕 → 世界的映射，`#canvas-background` 的 rect 是原点。节点以指针为**中心**
  （画布侧建节点桥统一按 `nodeWidth/nodeHeight` 反推左上角）。
- **建节点走 `fisherai:add-canvas-node`**（与 Shift+A 搜索同一个出口），detail 上额外带
  `textPatch: { textContent, textRichContent }`；vendor 的建节点桥先 `createCanvasNode`，
  再走同一个 `updateCanvasNode` 把正文贴上去 —— 与节点里手改是同一条写路径。
- 排查读数：`window.__FISHERAI_CANVAS_TEXT_DROP__`
  （`drops` / `created` / `skipped` / `duplicateEvents` / `duplicateFiles` / `repeatGestures` /
  `lastFileCount` / `lastFile` / `lastKind` / `lastChars` / `lastError` / `lastPoint`）。

### 一个手势只落一个节点（v1.89）

用户 2026-11-01 报「拖一次生成两个一样的节点」。三条可能的路，各挡一层；判重容器一律挂在
**window** 上（`__FISHERAI_CANVAS_TEXT_DROP_GUARD__` / `__FISHERAI_CANVAS_TEXT_DROP_REPEATS__`），
不是模块变量 —— 万一产物被加载了两份，两边看到的也是同一份记录：

| 病灶 | 挡法 | 读数 |
|---|---|---|
| 同一个 `drop` 事件被两个监听器各处理一遍 | 事件级 `WeakSet` 认领，第二个人直接退出 | `duplicateEvents` |
| `dataTransfer.files` 里同一份文件出现两次（压缩包视图 / 带虚拟文件的拖放源） | 按 `名字+大小+lastModified` 折叠 | `duplicateFiles` |
| 同一个手势派发出两个 `drop` 事件（对象不同、内容一样） | 600ms 内「文件身份 + 落点(8px)」同签名跳过 | `repeatGestures` |

最后一层在 vendor 的建节点桥里（v1.89 补丁）：detail 可以带 `createKey`，**只有带它的调用**
才参与去重（10s 窗口，`__FISHERAI_CANVAS_CREATE_DUPES__` 计数）—— Shift+A、`canvas_control`
批量建节点这些入口不带它，仍然允许「同一位置、同样内容建两个」。

## 三、全屏预览（v1.89）

`src/client/canvas/textPreview.ts`，由 `bootstrap.ts` 的 `installCanvasTextPreview` 装配；
样式在 `styles.ts` 里随画布那份 `<style>` 一起注入（`canvasTextPreviewStyleText()`）。

- **入口**：文本节点头部的按钮条（`.af-text-primary-tools`，与「导入文本」并排）里注入一个
  只放图标的 `.af-text-header-button`（`aria-label` / `title` = 「全屏预览正文」）—— 文本卡
  默认 252px 宽，那条按钮条只有 76% 宽度，放不下第四个带字按钮。上游只在**单选这个节点**
  时才渲染那一条（`canvasScene.tsx` 的 `showControls`），与「导入文本」同一个前提，所以不
  额外做常驻入口。
- **内容**：打开时 `cloneNode` 节点里已经渲染好的 `.af-text-editor-document`（tiptap 的
  `editorProps.attributes.class`），洗掉 `contenteditable` / `spellcheck` / `data-pm-slice` /
  `.ProseMirror-trailingbreak` / `.is-empty` 之后塞进浮层 —— 不新建 tiptap 实例、不改节点数据、
  不进编辑态，所以排版与卡片逐像素同源。拿不到编辑器 DOM 时退回 `textContent` 逐行成段。
- **浮层**：`.af-text-preview`（fixed inset 0，z 12100）＝ 顶部一条（标题 / `N 字 · 只读` /
  `A−` `A+`（13–30px，默认 16）/ 复制全文 / 关闭）+ 正文（沿用 `.af-text-editor-document`
  那套排版，居中一栏，`max-width: 900px`，`line-height: 1.85`）。Esc / 点空白 / 关闭按钮退出；
  浮层内的 `pointerdown` / `wheel` / `contextmenu` / `dblclick` 全部 stopPropagation，不漏给画布。
- **React 重渲染会带走注入的按钮**：MutationObserver（rAF 节流）扫 `[data-node-id]`，
  缺按钮就补回去；与 `canvasGrid` / `knife` 同一路数，不碰 vendor 树。
- 排查读数：`window.__FISHERAI_CANVAS_TEXT_PREVIEW__`
  （`opened` / `closed` / `buttons` / `lastChars` / `lastTitle` / `lastFont` / `open` / `lastError`）。

## 三、节点自己的「导入文本」

老路径：`readTextNodeFile()` → `readAgentDocument()` → **host** 的
`POST /api/aifisher/canvas/agent/drama/script` 解析 → 拿回**纯文本** → 逐行成段。
`.md` 走这条路，`##`、`-`、`**` 全都是字面量，这就是「格式完全不正确」。

现在：`.md/.markdown`（`isMarkdownFileName()`）在**本机**用 `FileReader` 读原文，
直接 `createTextDocumentPatch(textDocumentFromMarkdown(source))`；其它文档
（docx / xml …）原路不变。`CanvasTextNodeContent` 的 `importText(text, mode, rich?)`
多收一个富文档，替换与追加都带着它（有正文时那个「替换 / 追加」确认框也带）。

注：本机读取刻意用 `FileReader` 而不是 `Blob.text()` —— 回归用的 jsdom 没有 `File.text()`，
而这条路径必须能在回归里跑到。

## 四、Markdown → 文档：转换器

源码单独存在 `scripts/vendor-patches/text-document-markdown.ts`，构建时由
`scripts/vendor-aifisher.mjs` 的 **3.13 段**整段追加到 `vendor/.../text/textDocument.ts` 末尾。
为什么不直接写在 `vendor-aifisher.mjs` 的模板字符串里：转换器里到处是正则（`\s`、`\d`），
塞进模板字符串会被 JS 吃掉一层反斜杠；单独成文件才能原样追加、也方便单独读与检索。
vendor 里也不能新增文件（3.9 段的覆盖机制要求目标文件已存在），所以只能「追加到已有文件末尾」。

支持：

| 写法 | 结果 |
|---|---|
| `#`…`######` | `heading`（4–6 级压到 3 级：tiptap 只到这里） |
| `- * +` / `1.` `2.` | `bulletList` / `orderedList`（`3.` 起头写 `attrs.start`），缩进第二级 = 子清单（可多层） |
| `- [x] 任务` | 去掉勾选框，留文字 |
| `>` 引用 | `blockquote`（内含段落/清单，可递归） |
| ```` ``` ```` / `~~~` | `codeBlock`（内容里 `#` 不当标题） |
| `---` `***` `___` | `horizontalRule` |
| `\| 表格 \|` | `table`（首行 `tableHeader`，其余 `tableCell`；列数按表头补齐/截断，上限 40×200） |
| `**b**` `__b__` `*i*` `_i_` `***bi***` `~~s~~` | marks：bold / italic / bold+italic / strike |
| `` `code` `` | mark `code` |
| `[文字](url)` `![说明](url)` | 只留文字（schema 没有链接与图片节点） |
| `<br>`、行尾两个空格或 `\` | `hardBreak` |
| `\<字符>` | 字面量（转义） |
| 段内软换行 | 两侧都是 ASCII 词字符才补空格（中文直接接上，避免中文正文里到处是空格） |
| 开头 `---` 包起来的 YAML front matter | 整段丢掉 |
| CRLF / CR | 都按换行切 |

不支持（按普通文字处理，不会报错）：HTML 块与行内标签（`<br>` 除外）、脚注、数学公式、
setext 标题（`===` 下划线式）、表格单元格内换行、嵌套表格。

## 六、vendor 补丁清单（`scripts/vendor-aifisher.mjs` 3.13 段，13 处锚点 + 1 段追加）

| 文件 | 改什么 |
|---|---|
| `stable/text/textDocument.ts` | 末尾追加 `textDocumentFromMarkdown()` / `isMarkdownFileName()` |
| `stable/text/textNodeImport.ts` | 补 import；返回值加 `document?: unknown`；`.md` 走本机 FileReader + 转换器 |
| `stable/text/CanvasTextNodeContent.tsx` | `pendingImport` 带 `document`；`importText(text, mode, rich?)`；三处调用点把富文档带上（含确认框的「替换正文 / 追加到末尾」） |
| `stable/nodes/canvasNodeState.ts` | detail 接受 `textPatch`（建完立即 `updateCanvasNode`）与 `createKey`（同一次手势只建一个节点） |

每条锚点都断言「命中 1 次」，上游改了写法就地构建失败，不会静默失效。

## 七、回归

`scripts/test-canvas-markdown.mjs`（70 项，已进 `pnpm test` 与 `run-all-regressions.mjs`）：

- **A 转换器**：块类型、标题层级、行内 marks、两级清单、`attrs.start`、引用、围栏代码、
  表格、整篇镜像文案、front matter、CRLF、硬换行、空单元格/空标题/四层嵌套不炸 schema、
  扩展名判定、空文档。
- **B 真画布（jsdom）**：拖到画布外不接管；拖 `.md` 进画布 → 文本节点出现且富文档正确、
  镜像里没有记号、以指针为中心；空文件给提示且不建节点；空文本节点上「导入文本」按
  Markdown 解析（heading + bulletList）。
- **B6 去重**：同一个事件派发两次、同一份文件出现两次、两个事件同文件同落点 → 都只建一个；
  带同一个 `createKey` 的两次建节点请求只落一个，而不带的照旧建两个。
- **B7 预览**：选中文本节点 → 头部出现入口 → 点开浮层 → 正文/富格式/标题字数都在 →
  `A+` 调字号 → Esc 关闭且不留残壳。
- **C 补丁与产物**：四处 vendor 改动仍在、`lib/canvas/canvas-app.js` 里带模块标记。
