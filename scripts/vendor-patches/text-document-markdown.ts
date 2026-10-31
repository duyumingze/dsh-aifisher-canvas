/* ------------------------------------------------------------------ dsh-aifisher-canvas v1.87
 * Markdown → 文本节点富文档。
 *
 * 这段源码由 scripts/vendor-aifisher.mjs 追加到 vendor 的
 * `src/stable/text/textDocument.ts` 末尾（不单独成文件：vendor 里只能覆盖已有文件，
 * 不能新增文件，见该脚本 3.9 段）。
 *
 * 为什么需要它（用户 2026-11-01 原话）：「现在画布里的文本节点不兼容 .md 格式的文件，
 * 导入 .md 文件内容格式完全不正确」。上游的「导入文本」把文件送去 host 的
 * `/agent/drama/script` 解析，拿回来的是**纯文本** —— `## 标题`、`- 列表`、`**加粗**`
 * 全部变成字面量。这里把 Markdown 子集直接翻成节点自己的 tiptap 文档（schema 见本文件
 * 顶部 safeDocument：heading / bulletList / orderedList / blockquote / codeBlock /
 * horizontalRule / table + bold / italic / strike / code），纯文本镜像仍由
 * createTextDocumentPatch 统一重算，所以正文与富文档永远一致。
 *
 * 刻意不做：链接与图片不落 URL（schema 里没有 link / image 节点，只留可见文字）；
 * HTML 块、脚注、数学公式一律按普通文字处理；表格只认 GFM 管道表、不做单元格内换行。
 */

const MD_EMPHASIS: ReadonlyArray<{ token: string; marks: string[] }> = [
  { token: '***', marks: ['bold', 'italic'] },
  { token: '___', marks: ['bold', 'italic'] },
  { token: '**', marks: ['bold'] },
  { token: '__', marks: ['bold'] },
  { token: '~~', marks: ['strike'] },
  { token: '*', marks: ['italic'] },
  { token: '_', marks: ['italic'] },
];

const MD_ESCAPABLE = '\\`*_{}[]()#+-.!|~>';

const MD_HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/;
const MD_RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const MD_QUOTE = /^\s{0,3}>\s?(.*)$/;
const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const MD_TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MD_FRONT_MATTER_KEY = /^[A-Za-z_][\w-]*\s*:/;
const MD_MAX_TABLE_ROWS = 200;
const MD_MAX_TABLE_COLUMNS = 40;

const MARKDOWN_FILE_NAME = /\.(md|markdown|mdown|mkd|mkdn|mdx|mdwn|mdtxt|mdtext)$/i;

/** 这个文件名是不是 Markdown（拖入与「导入文本」共用一套判定）。 */
export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_FILE_NAME.test(String(name ?? '').trim());
}

function mdIsWordChar(value: string | undefined): boolean {
  return Boolean(value) && /[0-9A-Za-z_]/.test(String(value));
}

function mdInlineText(text: string, marks: string[]): TextDocumentNode {
  const node: TextDocumentNode = { type: 'text', text };
  if (marks.length > 0) node.marks = marks.map((type) => ({ type }));
  return node;
}

/** 从 `from` 往后找未转义的 token；找不到返回 -1。 */
function mdFindClosing(source: string, from: number, token: string): number {
  let index = from;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith(token, index)) return index;
    index += 1;
  }
  return -1;
}

/**
 * 行内（一个段落/标题/单元格里的文字）→ 文本节点数组。
 *
 * 递归而不是状态机：`**加粗里有_斜体_**` 这种嵌套靠「找到配对的收尾、对中间再跑一遍」
 * 最省事，也不会把不配对的 `*` 当成强调（找不到收尾就按普通字符输出）。
 */
function mdInline(source: string, marks: string[] = []): TextDocumentNode[] {
  const nodes: TextDocumentNode[] = [];
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    nodes.push(mdInlineText(buffer, marks));
    buffer = '';
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length && MD_ESCAPABLE.includes(source[index + 1])) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const close = mdFindClosing(source, index + 1, '`');
      if (close > index + 1) {
        flush();
        nodes.push(mdInlineText(source.slice(index + 1, close), [...marks, 'code']));
        index = close + 1;
        continue;
      }
    }
    if (char === '<') {
      const rest = source.slice(index);
      const br = /^<br\s*\/?>/i.exec(rest);
      if (br) {
        flush();
        nodes.push({ type: 'hardBreak' });
        index += br[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][^>]*>/.exec(rest);
      if (tag) {
        index += tag[0].length;
        continue;
      }
    }
    if (char === '!' || char === '[') {
      const link = /^!?\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(source.slice(index));
      if (link) {
        flush();
        const label = link[1].trim();
        if (label) nodes.push(...mdInline(label, marks));
        index += link[0].length;
        continue;
      }
    }
    let matched = false;
    for (const emphasis of MD_EMPHASIS) {
      const token = emphasis.token;
      if (!source.startsWith(token, index)) continue;
      const after = source[index + token.length];
      if (after === undefined || /\s/.test(after)) continue;
      // 词内下划线不是强调（snake_case / 文件名），否则整段会被拆错
      if (token.includes('_') && mdIsWordChar(source[index - 1])) continue;
      const close = mdFindClosing(source, index + token.length, token);
      if (close < 0) continue;
      const inner = source.slice(index + token.length, close);
      if (!inner.trim()) continue;
      flush();
      nodes.push(...mdInline(inner, [...marks, ...emphasis.marks]));
      index = close + token.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

function mdIndentOf(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 2;
    else break;
  }
  return indent;
}

/** 去掉最多 width 列缩进（tab 按 2 列算，多切的补回空格）。 */
function mdStripIndent(line: string, width: number): string {
  let index = 0;
  let columns = 0;
  while (index < line.length && columns < width) {
    const char = line[index];
    if (char === ' ') {
      columns += 1;
      index += 1;
      continue;
    }
    if (char === '\t') {
      columns += 2;
      index += 1;
      continue;
    }
    break;
  }
  const extra = columns - width;
  return (extra > 0 ? ' '.repeat(extra) : '') + line.slice(index);
}

function mdStartsBlock(line: string, lines: string[], index: number): boolean {
  if (
    MD_FENCE.test(line) ||
    MD_HEADING.test(line) ||
    MD_RULE.test(line) ||
    MD_QUOTE.test(line) ||
    MD_ITEM.test(line)
  )
    return true;
  return (
    line.includes('|') &&
    index + 1 < lines.length &&
    lines[index + 1].includes('-') &&
    MD_TABLE_SEPARATOR.test(lines[index + 1])
  );
}

/** 软换行拼接：两侧都是 ASCII 词字符才补空格（中文直接接上，不然中文正文里全是空格）。 */
function mdJoinWrap(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  const tail = previous[previous.length - 1];
  const head = next[0];
  return /[0-9A-Za-z]/.test(tail) && /[0-9A-Za-z]/.test(head) ? previous + ' ' + next : previous + next;
}

function mdParagraph(lines: string[]): TextDocumentNode {
  const segments: string[] = [];
  let current = '';
  const pushSegment = () => {
    segments.push(current);
    current = '';
  };
  for (const line of lines) {
    const hard = /(\\|\s{2,})$/.test(line);
    const text = line.replace(/(\\|\s{2,})$/, '').trim();
    current = mdJoinWrap(current, text);
    if (hard) pushSegment();
  }
  pushSegment();
  const content: TextDocumentNode[] = [];
  segments.forEach((segment, index) => {
    if (segment) content.push(...mdInline(segment));
    if (index < segments.length - 1) content.push({ type: 'hardBreak' });
  });
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function mdSplitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let index = 0;
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 2;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      index += 1;
      continue;
    }
    cell += char;
    index += 1;
  }
  cells.push(cell.trim());
  return cells;
}

function mdCell(cell: string, header: boolean): TextDocumentNode {
  const content = cell.trim() ? mdInline(cell.trim()) : [];
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: [content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }],
  };
}

function mdTable(lines: string[], start: number): { node: TextDocumentNode; next: number } | null {
  if (start + 1 >= lines.length) return null;
  if (!MD_TABLE_SEPARATOR.test(lines[start + 1]) || !lines[start + 1].includes('-')) return null;
  const header = mdSplitRow(lines[start]);
  const separator = mdSplitRow(lines[start + 1]);
  if (header.length === 0 || header.length !== separator.length) return null;
  const columns = Math.min(header.length, MD_MAX_TABLE_COLUMNS);
  const rows: string[][] = [header.slice(0, columns)];
  let index = start + 2;
  while (index < lines.length && rows.length <= MD_MAX_TABLE_ROWS) {
    const line = lines[index];
    if (!line.trim() || !line.includes('|')) break;
    const cells = mdSplitRow(line);
    while (cells.length < columns) cells.push('');
    rows.push(cells.slice(0, columns));
    index += 1;
  }
  const content = rows.map((cells, rowIndex) => ({
    type: 'tableRow',
    content: cells.map((cell) => mdCell(cell, rowIndex === 0)),
  }));
  return { node: { type: 'table', content }, next: index };
}

function mdList(lines: string[], start: number): { node: TextDocumentNode; next: number } | null {
  const first = MD_ITEM.exec(lines[start]);
  if (!first) return null;
  const ordered = /^\d/.test(first[2]);
  const baseIndent = first[1].length;
  const items: TextDocumentNode[] = [];
  let startNumber = 1;
  let index = start;
  while (index < lines.length) {
    const match = MD_ITEM.exec(lines[index]);
    if (!match) break;
    if (match[1].length !== baseIndent) break;
    if (/^\d/.test(match[2]) !== ordered) break;
    if (items.length === 0) startNumber = ordered ? Number.parseInt(match[2], 10) || 1 : 1;
    const contentIndent = match[1].length + match[2].length + match[3].length;
    const body: string[] = [match[4].replace(/^\[[ xX]\]\s+/, '')];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) {
        const following = lines[index + 1];
        if (following === undefined) break;
        if (!following.trim()) {
          index += 1;
          continue;
        }
        if (mdIndentOf(following) > baseIndent) {
          body.push('');
          index += 1;
          continue;
        }
        break;
      }
      const nested = MD_ITEM.exec(next);
      if (nested && nested[1].length <= baseIndent) break;
      const indent = mdIndentOf(next);
      if (indent >= contentIndent) {
        body.push(mdStripIndent(next, contentIndent));
        index += 1;
        continue;
      }
      // 懒续行（缩进不足但仍在同一项里）：Markdown 会把它当这一项的续行
      if (!mdStartsBlock(next, lines, index)) {
        body.push(next.trim());
        index += 1;
        continue;
      }
      break;
    }
    const blocks = mdBlocks(body);
    const content =
      blocks.length > 0 && blocks[0].type === 'paragraph'
        ? blocks
        : [{ type: 'paragraph' } as TextDocumentNode, ...blocks];
    items.push({ type: 'listItem', content });
  }
  const node: TextDocumentNode = { type: ordered ? 'orderedList' : 'bulletList', content: items };
  if (ordered && startNumber !== 1) node.attrs = { start: startNumber };
  return { node, next: index };
}

function mdQuote(lines: string[], start: number): { node: TextDocumentNode; next: number } {
  const inner: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = MD_QUOTE.exec(lines[index]);
    if (!match) break;
    inner.push(match[1]);
    index += 1;
  }
  const blocks = mdBlocks(inner);
  return {
    node: {
      type: 'blockquote',
      content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
    },
    next: index,
  };
}

/** 收尾围栏：同一字符、长度不少于开围栏、整行只有它。 */
function mdIsFenceEnd(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < marker.length) return false;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== marker[0]) return false;
  }
  return true;
}

function mdFence(lines: string[], start: number): { node: TextDocumentNode; next: number } {
  const open = MD_FENCE.exec(lines[start]);
  const marker = open ? open[1] : '```';
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (mdIsFenceEnd(line, marker)) {
      index += 1;
      break;
    }
    body.push(line);
    index += 1;
  }
  const code = body.join('\n');
  const node: TextDocumentNode = { type: 'codeBlock' };
  if (code) node.content = [{ type: 'text', text: code }];
  return { node, next: index };
}

function mdDropFrontMatter(lines: string[]): string[] {
  if ((lines[0] ?? '').trim() !== '---') return lines;
  for (let index = 1; index < Math.min(lines.length, 240); index += 1) {
    const line = lines[index];
    if (line.trim() === '---') return lines.slice(index + 1);
    if (line.trim() && !MD_FRONT_MATTER_KEY.test(line) && !/^\s*-\s+/.test(line)) return lines;
  }
  return lines;
}

function mdBlocks(lines: string[]): TextDocumentNode[] {
  const blocks: TextDocumentNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (MD_FENCE.test(line)) {
      const read = mdFence(lines, index);
      blocks.push(read.node);
      index = read.next;
      continue;
    }
    if (MD_RULE.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      index += 1;
      continue;
    }
    const heading = MD_HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      const text = (heading[2] ?? '').trim();
      blocks.push({
        type: 'heading',
        attrs: { level },
        content: text ? mdInline(text) : [],
      });
      index += 1;
      continue;
    }
    if (MD_QUOTE.test(line)) {
      const read = mdQuote(lines, index);
      blocks.push(read.node);
      index = read.next;
      continue;
    }
    if (MD_ITEM.test(line)) {
      const read = mdList(lines, index);
      if (read) {
        blocks.push(read.node);
        index = read.next;
        continue;
      }
    }
    if (line.includes('|')) {
      const read = mdTable(lines, index);
      if (read) {
        blocks.push(read.node);
        index = read.next;
        continue;
      }
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (paragraph.length > 0 && mdStartsBlock(current, lines, index)) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push(mdParagraph(paragraph));
  }
  return blocks;
}

/**
 * 把一份 Markdown 正文翻成文本节点的富文档。
 *
 * 结果**必须**再交给 createTextDocumentPatch 落库：它负责 schema 校验（safeDocument）
 * 与纯文本镜像（plaintText），两者对不上的话 resolveTextDocument 会退回纯段落，
 * 用户看到的就是「格式又丢了」。
 */
export function textDocumentFromMarkdown(source: string): TextDocumentNode {
  const lines = String(source ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/);
  const content = mdBlocks(mdDropFrontMatter(lines));
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}
