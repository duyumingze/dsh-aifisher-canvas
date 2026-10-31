/**
 * 画布「拖入 Markdown → 文本节点」回归（scripts/test-canvas-markdown.mjs）。
 *
 * 用户 2026-11-01 原话：「现在画布里的文本节点不兼容 .md 格式的文件，导入 .md 文件内容
 * 格式完全不正确。可以做一个能直接拖入 .md 文件到画布生成文本节点」。
 *
 * 三段验：
 *   A. Markdown 转换器（vendor 的 textDocument.ts 末尾，源码在 scripts/vendor-patches/）
 *      直接 import 源码跑断言 —— 标题/列表/引用/代码块/表格/行内强调/转义/front matter，
 *      外加「纯文本镜像」（textContent）必须由 createTextDocumentPatch 一起算出来。
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      往画布上 drop 一个 .md → 真的建出 Text 节点、格式真的进富文档；
 *      文本节点自己的「导入文本」也真的按 Markdown 解析（不是字面量）。
 *   C. 产物与 vendor 补丁
 *      上游文件一旦被重新 vendor 覆盖掉这些锚点，这里先红 —— 否则表现是「拖进去没反应」。
 *
 * 用法：node scripts/test-canvas-markdown.mjs   （需要先 build）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

// ---------------------------------------------------------------- A. 转换器（纯函数）

const textDocumentUrl = pathToFileURL(
  path.join(process.cwd(), 'vendor/aifisher/src/stable/text/textDocument.ts'),
).href;

const probeScript = `
import {
  createTextDocumentPatch,
  isMarkdownFileName,
  textDocumentFromMarkdown,
} from ${JSON.stringify(textDocumentUrl)};

const doc = (source) => textDocumentFromMarkdown(source);
const types = (source) => doc(source).content.map((node) => node.type);
/** 一行文字的「文本 + 标记」列表，用来验行内解析。 */
const inline = (source) => {
  const patch = createTextDocumentPatch(doc(source));
  const paragraph = patch.textRichContent.document.content[0] ?? { content: [] };
  return {
    nodes: (paragraph.content ?? []).map((node) => ({
      text: node.text ?? null,
      marks: (node.marks ?? []).map((mark) => mark.type).join('+'),
    })),
    mirror: patch.textContent,
  };
};
const safe = (source) => {
  try {
    const patch = createTextDocumentPatch(doc(source));
    return { ok: true, text: patch.textContent };
  } catch (error) {
    return { ok: false, error: String(error && error.message) };
  }
};

const FULL = \`---
title: 拖入测试
tags: [a, b]
---

# 一级标题

正文里有 **加粗**、*斜体*、~~删除~~、\\\`行内代码\\\` 和一个 [链接](https://example.com)。

## 清单

- 甲
- 乙
  - 乙一

1. 第一
2. 第二

> 引用一句

\\\`\\\`\\\`js
const a = 1;
\\\`\\\`\\\`

| 镜号 | 内容 |
| --- | --- |
| 01 | 渡口 |

---
结尾一段。
\`;

console.log(JSON.stringify({
  blocks: types(FULL),
  headingLevels: ['# h1', '### h3', '###### h6'].map((source) => {
    const first = doc(source).content[0];
    return first && first.attrs ? first.attrs.level : null;
  }),
  inline: inline('**b** *i* ~~s~~ \\\`c\\\` [链接](https://x) \\\\*字面星\\\\*'),
  nested: doc('- a\\n  - b').content[0],
  orderedStart: doc('3. x\\n4. y').content[0].attrs ?? null,
  quote: doc('> a\\n> b').content[0].content.map((node) => node.type),
  code: doc('\\\`\\\`\\\`\\n# 不是标题\\n\\n第二行\\n\\\`\\\`\\\`').content[0],
  table: doc('| a | b |\\n| --- | --- |\\n| 1 | 2 |').content[0],
  mirror: createTextDocumentPatch(doc(FULL)).textContent,
  frontMatter: types('---\\ntitle: x\\n---\\n\\n正文'),
  crlf: createTextDocumentPatch(doc('# 标题\\r\\n\\r\\n正文\\r\\n')).textContent,
  hardBreak: doc('a  \\nb').content[0].content.map((node) => node.type),
  safeEmptyTable: safe('| a | \\n| --- |\\n|  | '),
  safeEmptyHeading: safe('##'),
  safeHugeNesting: safe('- a\\n  - b\\n    - c\\n      - d'),
  isMarkdown: [isMarkdownFileName('a.MD'), isMarkdownFileName('a.txt'), isMarkdownFileName('x.markdown'), isMarkdownFileName('a.mdx')],
  empty: doc('').content.length,
}));
`;

const probe = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--input-type=module', '-e', probeScript],
  { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
);
if (probe.status !== 0) {
  console.error('[markdown] 转换器探针失败：\n' + (probe.stderr || probe.stdout));
  process.exit(1);
}
const pure = JSON.parse(probe.stdout.trim().split('\n').pop());

check(
  '整篇 Markdown 的块类型都认出来了（标题 / 清单 / 引用 / 代码块 / 表格 / 分隔线 / 段落）',
  JSON.stringify(pure.blocks) ===
    JSON.stringify([
      'heading',
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'blockquote',
      'codeBlock',
      'table',
      'horizontalRule',
      'paragraph',
    ]),
  JSON.stringify(pure.blocks),
);
check(
  '标题层级 1/3/6 → 1/3/3（tiptap schema 只到 3 级，不渲染成怪东西）',
  JSON.stringify(pure.headingLevels) === JSON.stringify([1, 3, 3]),
  JSON.stringify(pure.headingLevels),
);
check(
  '行内强调：加粗/斜体/删除线/行内代码/链接取文字/反斜杠转义成字面量',
  JSON.stringify(pure.inline.nodes.map((node) => [node.text, node.marks])) ===
    JSON.stringify([
      ['b', 'bold'],
      [' ', ''],
      ['i', 'italic'],
      [' ', ''],
      ['s', 'strike'],
      [' ', ''],
      ['c', 'code'],
      [' ', ''],
      ['链接', ''],
      [' *字面星*', ''],
    ]),
  JSON.stringify(pure.inline.nodes),
);
check(
  '纯文本镜像里不残留标记符号（正文给模型看的也是干净文字）',
  pure.inline.mirror === 'b i s c 链接 *字面星*',
  JSON.stringify(pure.inline.mirror),
);
check(
  '两级清单：第二级是 listItem 里的子 bulletList（不是压平）',
  pure.nested.content.length === 1 &&
    JSON.stringify(pure.nested.content[0].content.map((node) => node.type)) ===
      JSON.stringify(['paragraph', 'bulletList']),
  JSON.stringify({
    items: pure.nested.content.length,
    blocks: pure.nested.content[0].content.map((node) => node.type),
  }),
);
check(
  '有序清单从 3 开始时写进 attrs.start（编号不会错位成 1）',
  pure.orderedStart && pure.orderedStart.start === 3,
  JSON.stringify(pure.orderedStart),
);
check(
  '引用块里是段落（> 两行合成一段，中间补空格）',
  JSON.stringify(pure.quote) === JSON.stringify(['paragraph']),
  JSON.stringify(pure.quote),
);
check(
  '围栏代码块里的 # 不当标题，换行与空行原样保留',
  pure.code.type === 'codeBlock' &&
    pure.code.content?.[0]?.text === '# 不是标题\n\n第二行',
  JSON.stringify(pure.code.content?.[0]?.text),
);
check(
  '表格：首行是 tableHeader，其余是 tableCell',
  pure.table.type === 'table' &&
    JSON.stringify(pure.table.content.map((row) => row.content.map((cell) => cell.type))) ===
      JSON.stringify([
        ['tableHeader', 'tableHeader'],
        ['tableCell', 'tableCell'],
      ]),
  JSON.stringify(pure.table.content.map((row) => row.content.map((cell) => cell.type))),
);
check(
  '整篇镜像：标题/清单项/表格单元格各占一行（表格列用 tab 分隔）',
  pure.mirror ===
    '一级标题\n正文里有 加粗、斜体、删除、行内代码 和一个 链接。\n清单\n甲\n乙\n乙一\n第一\n第二\n引用一句\nconst a = 1;\n镜号\t内容\n01\t渡口\n\n结尾一段。',
  JSON.stringify(pure.mirror),
);
check(
  '开头的 YAML front matter 被丢掉（不当作正文段落）',
  JSON.stringify(pure.frontMatter) === JSON.stringify(['paragraph']) &&
    docFrontMatterText(pure) !== 'title: 拖入测试',
  JSON.stringify(pure.frontMatter),
);
check('CRLF 换行也能切成两段', pure.crlf === '标题\n正文', JSON.stringify(pure.crlf));
check(
  '行尾两个空格 = 硬换行（hardBreak，不是普通换行）',
  JSON.stringify(pure.hardBreak) === JSON.stringify(['text', 'hardBreak', 'text']),
  JSON.stringify(pure.hardBreak),
);
check(
  '空单元格 / 空标题 / 四层嵌套清单都能过 schema 校验（不抛 Invalid）',
  pure.safeEmptyTable.ok && pure.safeEmptyHeading.ok && pure.safeHugeNesting.ok,
  JSON.stringify([pure.safeEmptyTable, pure.safeEmptyHeading, pure.safeHugeNesting]),
);
check(
  '扩展名判定：.MD/.markdown/.mdx 算 Markdown，.txt 不算',
  JSON.stringify(pure.isMarkdown) === JSON.stringify([true, false, true, true]),
  JSON.stringify(pure.isMarkdown),
);
check('空文档也给出一个空段落（节点不会变成 0 块）', pure.empty === 1, String(pure.empty));

function docFrontMatterText() {
  // front matter 是否被丢掉，看镜像正文里有没有 title 那行即可（探针里没单独带出来）
  return pure.mirror.includes('title') ? 'title' : '';
}

// ---------------------------------------------------------------- B. 真画布（jsdom）

const PROJECT_ID = 'proj-markdown-drop';
const host = await startHost();
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: 'Markdown 拖入验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
const pageErrors = [];
window.addEventListener('error', (event) => {
  pageErrors.push(String(event.error?.stack ?? event.message ?? event));
});
seedResume(window, PROJECT_ID);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const canvasBackground = () => window.document.getElementById('canvas-background');

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(150);
  }
  return last;
}

const savedNodes = async () => {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return [];
  try {
    return JSON.parse(result.text).nodes ?? [];
  } catch {
    return [];
  }
};
const textNodes = async () => (await savedNodes()).filter((node) => node.type === 'Text');

function makeMarkdown(name, content) {
  return new window.File([content], name, { type: 'text/markdown' });
}

/**
 * 派发一次 drop。
 *
 * jsdom 没有 DragEvent / DataTransfer 构造器，所以用普通 Event 补上两个只读属性 ——
 * 我们与画布的监听器都只按事件名 + `dataTransfer.files` 取值，不依赖原型。
 */
function dropOn(target, files, x = 240, y = 180) {
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'], dropEffect: 'none' },
  });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  target.dispatchEvent(event);
  return event;
}

// ---- B1. 桥与守卫

check(
  '画布挂载后装了「拖入文本文件」的桥（诊断读数）',
  Boolean(window.__FISHERAI_CANVAS_TEXT_DROP__ && window.__FISHERAI_CANVAS_TEXT_DROP__.created === 0),
  JSON.stringify(window.__FISHERAI_CANVAS_TEXT_DROP__),
);
check('画布底盘在（drop 落点判定要靠它）', Boolean(canvasBackground()));

// ---- B2. 拖到画布外不接管

{
  const before = window.__FISHERAI_CANVAS_TEXT_DROP__.drops;
  const event = dropOn(
    window.document.body,
    [makeMarkdown('outside.md', '# 不该落节点')],
    240,
    180,
  );
  await settle(300);
  check(
    '拖到画布外（会话栏/设置页）不接管：诊断不记账、也没建节点',
    window.__FISHERAI_CANVAS_TEXT_DROP__.drops === before &&
      window.__FISHERAI_CANVAS_TEXT_DROP__.lastError === '',
    JSON.stringify({
      drops: window.__FISHERAI_CANVAS_TEXT_DROP__.drops,
      lastError: window.__FISHERAI_CANVAS_TEXT_DROP__.lastError,
    }),
  );
  check('画布外的那次没有建出文本节点', (await textNodes()).length === 0, String((await textNodes()).length));
}

// ---- B2b. 画布里的「别人的拖放区」要让路（工作流库面板拖 JSON 导入）

{
  const zone = window.document.createElement('div');
  zone.setAttribute('data-fisherai-workflow-manager', 'true');
  zone.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:200px;';
  canvasBackground().appendChild(zone);
  const before = window.__FISHERAI_CANVAS_TEXT_DROP__.drops;
  const event = dropOn(zone, [new window.File(['{"1":{}}'], '图生图.json', { type: 'application/json' })], 120, 120);
  await settle(300);
  check(
    '拖到画布内的「工作流库面板」上不抢（.json 留给它自己导入）',
    window.__FISHERAI_CANVAS_TEXT_DROP__.drops === before &&
      window.__FISHERAI_CANVAS_TEXT_DROP__.lastError === '',
    JSON.stringify({
      drops: window.__FISHERAI_CANVAS_TEXT_DROP__.drops,
      lastFile: window.__FISHERAI_CANVAS_TEXT_DROP__.lastFile,
    }),
  );
  check('那次也没有建出文本节点', (await textNodes()).length === 0, String((await textNodes()).length));
  zone.remove();
}

// ---- B3. 拖 .md 进画布 → 建文本节点

const MARKDOWN_SOURCE = `---
title: 渡口分镜
---

# 渡口 · 10 秒

一句话：**双纵队**下渡口，*全程无船*。

## 镜头

- K01 高空俯瞰
- K02 滩头推船

1. 先拍雾
2. 再拍人

| 镜号 | 时长 |
| --- | --- |
| 01 | 10s |
`;

{
  const before = window.__FISHERAI_CANVAS_TEXT_DROP__.drops;
  const event = dropOn(canvasBackground(), [makeMarkdown('渡口.md', MARKDOWN_SOURCE)], 240, 180);
  check('拖入 .md 时被我们接管（preventDefault，画布不会再弹「无法识别的文件类型」）', event.defaultPrevented);

  const created = await waitFor(async () => (await textNodes()).length > 0, 8000);
  const nodes = await textNodes();
  const node = nodes[0];
  check('画布上真的多了一个文本节点', Boolean(created) && nodes.length === 1, String(nodes.length));
  check(
    '诊断读数：拦下 1 次、建出 1 个、走的是 markdown 解析',
    window.__FISHERAI_CANVAS_TEXT_DROP__.drops === before + 1 &&
      window.__FISHERAI_CANVAS_TEXT_DROP__.created === 1 &&
      window.__FISHERAI_CANVAS_TEXT_DROP__.lastKind === 'markdown',
    JSON.stringify(window.__FISHERAI_CANVAS_TEXT_DROP__),
  );

  const rich = node?.textRichContent?.document;
  check(
    '节点带的是富文档：一级标题 + 加粗 + 斜体 + 两个清单 + 表格',
    Boolean(rich) &&
      JSON.stringify(rich.content.map((block) => block.type)) ===
        JSON.stringify([
          'heading',
          'paragraph',
          'heading',
          'bulletList',
          'orderedList',
          'table',
        ]),
    JSON.stringify(rich?.content?.map((block) => block.type)),
  );
  check(
    '标题文字与层级都对（# 渡口 · 10 秒 → heading level 1）',
    rich?.content?.[0]?.attrs?.level === 1 &&
      (rich?.content?.[0]?.content ?? []).map((part) => part.text).join('') === '渡口 · 10 秒',
    JSON.stringify(rich?.content?.[0]),
  );
  check(
    '正文里的加粗/斜体落成了 marks（不是字面量 **双纵队**）',
    (rich?.content?.[1]?.content ?? []).some((part) => (part.marks ?? []).some((mark) => mark.type === 'bold')) &&
      (rich?.content?.[1]?.content ?? []).some((part) => (part.marks ?? []).some((mark) => mark.type === 'italic')),
    JSON.stringify(rich?.content?.[1]?.content),
  );
  check(
    '纯文本镜像里没有 Markdown 记号（模型读到的是干净正文）',
    typeof node?.textContent === 'string' &&
      node.textContent.includes('双纵队') &&
      !node.textContent.includes('**') &&
      !node.textContent.includes('## ') &&
      !node.textContent.includes('| ---'),
    JSON.stringify(node?.textContent).slice(0, 200),
  );
  check(
    'front matter 没有进正文（title: 渡口分镜 不该出现在节点里）',
    typeof node?.textContent === 'string' && !node.textContent.includes('title:'),
    JSON.stringify(node?.textContent).slice(0, 120),
  );
  check(
    '节点以指针为中心落下（240,180 − 252/2）',
    window.__FISHERAI_CANVAS_TEXT_DROP__.lastPoint?.x === 240 &&
      window.__FISHERAI_CANVAS_TEXT_DROP__.lastPoint?.y === 180 &&
      Math.abs(Number(node?.x) + 126 - 240) <= 1 &&
      Math.abs(Number(node?.y) + 126 - 180) <= 1,
    JSON.stringify({ point: window.__FISHERAI_CANVAS_TEXT_DROP__.lastPoint, x: node?.x, y: node?.y }),
  );
}

// ---- B3b. 一次拖入里混了图片：文本照建，非文本给一句提示（不静默吞掉）

{
  const before = (await textNodes()).length;
  dropOn(
    canvasBackground(),
    [makeMarkdown('混拖.md', '# 混拖\n\n- 一\n'), new window.File(['x'], '图.png', { type: 'image/png' })],
    480,
    360,
  );
  const created = await waitFor(async () => (await textNodes()).length === before + 1, 6000);
  check('混拖时文本文件照建节点', Boolean(created), `${(await textNodes()).length}/${before + 1}`);
  const mixedToast = window.document.querySelector('[data-fisherai-text-drop-toast]');
  check(
    '混拖时给一句「非文本文件请单独拖一次」的提示',
    Boolean(mixedToast) && /非文本文件/.test(mixedToast.textContent ?? ''),
    String(mixedToast?.textContent ?? ''),
  );
  mixedToast?.remove();
}

// ---- B4. 拖入的 .md 里没有正文时给出提示

{
  const before = (await textNodes()).length;
  const event = dropOn(canvasBackground(), [makeMarkdown('空.md', '   \n\n  ')], 420, 300);
  check('空文件也会被接管（走我们这条，不落到上传链路）', event.defaultPrevented);
  const toastWait = await waitFor(
    () => window.document.querySelector('[data-fisherai-text-drop-toast="error"]'),
    3000,
  );
  check(
    '空文件给一条错误提示，且不建节点',
    Boolean(toastWait) && (await textNodes()).length === before,
    JSON.stringify({
      toast: Boolean(toastWait),
      nodes: (await textNodes()).length,
      before,
      error: window.__FISHERAI_CANVAS_TEXT_DROP__.lastError,
    }),
  );
  toastWait?.remove();
}

// ---- B5. 文本节点自己的「导入文本」也按 Markdown 解析

{
  // 建一个**空**文本节点（有正文时上游会弹「替换/追加」确认框，而 jsdom 没有 showModal）
  window.dispatchEvent(
    new window.CustomEvent('fisherai:add-canvas-node', {
      detail: { type: 'Text', point: { x: 600, y: 300 } },
    }),
  );
  const emptyNode = await waitFor(async () => {
    const found = (await textNodes()).find((node) => !node.textContent);
    return found ?? null;
  }, 6000);
  check('先用建节点出口放一个空文本节点', Boolean(emptyNode), JSON.stringify((await textNodes()).map((node) => node.id)));

  const input = emptyNode
    ? window.document.querySelector(
        `[data-node-id="${emptyNode.id}"] input[aria-label="选择文本文件"]`,
      )
    : null;
  check('空文本节点上有「导入文本」的隐藏文件框', Boolean(input));

  if (input && emptyNode) {
    const file = makeMarkdown('镜头表.md', '## 镜头表\n\n- 渡口\n- 攀索\n');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    const updated = await waitFor(async () => {
      const found = (await textNodes()).find((node) => node.id === emptyNode.id);
      return found && found.textContent ? found : null;
    }, 8000);
    const rich = updated?.textRichContent?.document;
    check(
      '导入 .md 后正文进节点',
      Boolean(updated) && updated.textContent.includes('渡口'),
      JSON.stringify(updated?.textContent),
    );
    check(
      '导入的格式是富文档（heading level 2 + bulletList），不是字面量「## 镜头表」',
      rich?.content?.[0]?.type === 'heading' &&
        rich?.content?.[0]?.attrs?.level === 2 &&
        rich?.content?.[1]?.type === 'bulletList',
      JSON.stringify(rich?.content?.map((block) => block.type)),
    );
  }
}

// ---------------------------------------------------------------- C. 产物与 vendor 补丁

{
  const repo = process.cwd();
  const textDocument = readFileSync(
    path.join(repo, 'vendor/aifisher/src/stable/text/textDocument.ts'),
    'utf8',
  );
  const textNodeImport = readFileSync(
    path.join(repo, 'vendor/aifisher/src/stable/text/textNodeImport.ts'),
    'utf8',
  );
  const textNodeContent = readFileSync(
    path.join(repo, 'vendor/aifisher/src/stable/text/CanvasTextNodeContent.tsx'),
    'utf8',
  );
  const nodeState = readFileSync(
    path.join(repo, 'vendor/aifisher/src/stable/nodes/canvasNodeState.ts'),
    'utf8',
  );

  check(
    'vendor 的 textDocument.ts 末尾有 Markdown 转换器（构建期追加）',
    textDocument.includes('export function textDocumentFromMarkdown') &&
      textDocument.includes('export function isMarkdownFileName'),
  );
  check(
    'vendor 的「导入文本」对 .md 走本机解析（FileReader + 转换器），不再交给 host',
    textNodeImport.includes('isMarkdownFileName(file.name)') &&
      textNodeImport.includes('createTextDocumentPatch(textDocumentFromMarkdown(source))') &&
      textNodeImport.includes('reader.readAsText(file)'),
  );
  check(
    'vendor 的文本节点把富文档一起交给 importText（含确认框的替换/追加）',
    textNodeContent.includes('rich?: unknown') &&
      textNodeContent.includes('resolveTextDocument(text, rich)') &&
      textNodeContent.includes('imported.document') &&
      textNodeContent.split('pendingImport.document').length - 1 === 2,
    String(textNodeContent.split('pendingImport.document').length - 1),
  );
  check(
    'vendor 的建节点出口接受 textPatch（拖入时一建出来就带正文）',
    nodeState.includes('textPatch?: Partial<CanvasNode>') &&
      nodeState.includes('if (detail.textPatch && node.type === \'Text\')'),
  );

  const bundlePath = path.join(repo, 'lib/canvas/canvas-app.js');
  if (existsSync(bundlePath)) {
    const bundle = readFileSync(bundlePath, 'utf8');
    check(
      '产物里带拖入文本文件的锚点（诊断全局 / 事件名 / 文件扩展名判定）',
      bundle.includes('__FISHERAI_CANVAS_TEXT_DROP__') &&
        bundle.includes('fisherai:add-canvas-node') &&
        bundle.includes('data-fisherai-text-drop-toast'),
    );
    check(
      '产物里带拖入失败的中文提示（证明文本拖入模块真的被打进去了）',
      bundle.includes('拖入上限 2 MB'),
    );
  } else {
    check('产物里带拖入文本文件的锚点', false, 'lib/canvas/canvas-app.js 不存在');
  }
}

// ---------------------------------------------------------------- 收尾

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check(
    'Markdown 拖入全程无运行时错误',
    errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)',
  );
  check('页面里没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败会在渲染测试里单独断言 */
}
const { rmSync } = await import('node:fs');
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
