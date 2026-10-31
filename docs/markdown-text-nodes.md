# 文本节点与 Markdown（v1.87）

> 对象：`dsh-aifisher-canvas` v1.87.0
> 用户原话（2026-11-01）：「现在画布里的文本节点不兼容 .md 格式的文件，导入 .md 文件内容
> 格式完全不正确。可以做一个能直接拖入 .md 文件到画布生成文本节点」。

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
  （`drops` / `created` / `skipped` / `lastFile` / `lastKind` / `lastChars` / `lastError` / `lastPoint`）。

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

## 五、vendor 补丁清单（`scripts/vendor-aifisher.mjs` 3.13 段，11 处锚点 + 1 段追加）

| 文件 | 改什么 |
|---|---|
| `stable/text/textDocument.ts` | 末尾追加 `textDocumentFromMarkdown()` / `isMarkdownFileName()` |
| `stable/text/textNodeImport.ts` | 补 import；返回值加 `document?: unknown`；`.md` 走本机 FileReader + 转换器 |
| `stable/text/CanvasTextNodeContent.tsx` | `pendingImport` 带 `document`；`importText(text, mode, rich?)`；三处调用点把富文档带上（含确认框的「替换正文 / 追加到末尾」） |
| `stable/nodes/canvasNodeState.ts` | `fisherai:add-canvas-node` 的 detail 接受 `textPatch`，建完立即 `updateCanvasNode` |

每条锚点都断言「命中 1 次」，上游改了写法就地构建失败，不会静默失效。

## 六、回归

`scripts/test-canvas-markdown.mjs`（48 项，已进 `pnpm test` 与 `run-all-regressions.mjs`）：

- **A 转换器**：块类型、标题层级、行内 marks、两级清单、`attrs.start`、引用、围栏代码、
  表格、整篇镜像文案、front matter、CRLF、硬换行、空单元格/空标题/四层嵌套不炸 schema、
  扩展名判定、空文档。
- **B 真画布（jsdom）**：拖到画布外不接管；拖 `.md` 进画布 → 文本节点出现且富文档正确、
  镜像里没有记号、以指针为中心；空文件给提示且不建节点；空文本节点上「导入文本」按
  Markdown 解析（heading + bulletList）。
- **C 补丁与产物**：四处 vendor 改动仍在、`lib/canvas/canvas-app.js` 里带模块标记。
