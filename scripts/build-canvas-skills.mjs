#!/usr/bin/env node
/**
 * 把「小墨」创作技能改造成画布可用的技能包（画布适配输出契约 canvas-shots/v1）。
 *
 * 做法：原文一字不改地保留在正文，只做两件事
 *   ① 重写 frontmatter：只留 name / description（官方 provider 的扁平子集；原文件的
 *      triggers / agent_created / version 不是 provider 认识的键，留着有被整条拒绝的风险）；
 *      description 末尾追加画布版标记，供模型在选择技能时看到。
 *   ② 正文末尾追加 docs/skill-canvas-adapter-*.md 的适配层（该层自带「本节优先」裁决）。
 *
 * 用法：
 *   node scripts/build-canvas-skills.mjs                 # 输出到 .dsh-tmp/skills（暂存）
 *   node scripts/build-canvas-skills.mjs --out <dir>     # 输出到指定目录（如 ~/.dsh/skills）
 *
 * 源文件路径可用环境变量覆盖：XIAOMO_STORYBOARD_SRC / XIAOMO_ASSETS_SRC。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const SOURCES = [
  {
    src: process.env.XIAOMO_STORYBOARD_SRC
      ?? 'E:/AllAssets/Skill/小墨skill/小墨个人分镜SKILL6.0（画面优化）.md',
    adapter: 'docs/skill-canvas-adapter-storyboard.md',
    suffix: '（画布版：文末追加 canvas-shots/v1 机读块，镜头标题「镜头 NN」，设计约束全保留、自检不输出）',
  },
  {
    src: process.env.XIAOMO_ASSETS_SRC
      ?? 'E:/AllAssets/Skill/小墨skill/小墨个人资产提取SKILL.md',
    adapter: 'docs/skill-canvas-adapter-assets.md',
    suffix: '（画布版：文末追加 canvas-shots/v1 锁定块，产出锚点·角色NN/场景NN 定版提示词）',
  },
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** 拆 frontmatter（首部 --- ... ---），返回 { meta: 原文, body }。没有 frontmatter 视为错误。 */
function splitFrontmatter(text, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) fail(`${label}：缺少 frontmatter（首部 --- 块）`);
  return { meta: match[1], body: text.slice(match[0].length) };
}

function readField(meta, field, label) {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(meta);
  if (!match) fail(`${label}：frontmatter 缺少 ${field}`);
  return match[1].trim();
}

/** 去掉值两端成对的引号（单/双/中文引号）。 */
function unquote(value) {
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」']];
  for (const [open, close] of pairs) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function buildOne(entry, outDir) {
  const absSrc = path.resolve(entry.src);
  let text;
  try {
    text = readFileSync(absSrc, 'utf8');
  } catch (error) {
    fail(`读不到源文件 ${absSrc}：${error.message}`);
  }
  const label = path.basename(absSrc);
  const { meta, body } = splitFrontmatter(text.replace(/^\uFEFF/, ''), label);
  const name = unquote(readField(meta, 'name', label));
  const description = unquote(readField(meta, 'description', label));
  const adapter = readFileSync(path.join(ROOT, entry.adapter), 'utf8').trim();

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`${label}：name「${name}」不是 kebab-case`);

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: "${description}${entry.suffix}"`,
    '---',
    '',
  ].join('\n');

  const content = `${frontmatter}${body.trimEnd()}\n\n---\n\n${adapter}\n`;
  const dir = path.join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'SKILL.md');
  writeFileSync(out, content, 'utf8');
  return { name, out, bytes: Buffer.byteLength(content, 'utf8') };
}

function parseOutDir(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return path.join(ROOT, '.dsh-tmp', 'skills');
  const value = argv[index + 1];
  if (!value) fail('--out 后面要跟目录');
  return path.resolve(value);
}

const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
for (const entry of SOURCES) {
  const result = buildOne(entry, outDir);
  console.log(`✓ ${result.name} → ${result.out}（${(result.bytes / 1024).toFixed(1)} KB）`);
}
console.log(`\n输出目录：${outDir}`);
