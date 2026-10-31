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
 * 源的 name 不在 kebab-case 时可在条目上写 `name` 覆盖（MOKE 出的原件用 MOKEAIGC-V017
 * 这类版本号式名字，直接当技能名既不好用、也不符合 provider 的命名校验）。
 *
 * 用法：
 *   node scripts/build-canvas-skills.mjs                 # 输出到 .dsh-tmp/skills（暂存）
 *   node scripts/build-canvas-skills.mjs --out <dir>     # 输出到指定目录（如 ~/.dsh/skills）
 *
 * 源文件路径可用环境变量覆盖：
 *   XIAOMO_STORYBOARD_SRC / XIAOMO_ASSETS_SRC / MOKE_WORLDBUILDING_SRC。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const SOURCES = [
  {
    src: process.env.XIAOMO_STORYBOARD_SRC
      ?? 'E:/AllAssets/Skill/原件/小墨skill/小墨个人分镜SKILL6.0（画面优化）.md',
    adapter: 'docs/skill-canvas-adapter-storyboard.md',
    suffix: '（画布版：文末追加 canvas-shots/v1 机读块，镜头标题「镜头 NN」，设计约束全保留、自检不输出）',
  },
  {
    src: process.env.XIAOMO_ASSETS_SRC
      ?? 'E:/AllAssets/Skill/原件/小墨skill/小墨个人资产提取SKILL.md',
    adapter: 'docs/skill-canvas-adapter-assets.md',
    suffix: '（画布版：文末追加 canvas-shots/v1 锁定块，产出锚点·角色NN/场景NN 定版提示词）',
  },
  {
    // MOKE 藏经阁原件：name 是 MOKEAIGC-V017（版本号式），这里归一成跨版本稳定的技能名
    src: process.env.MOKE_WORLDBUILDING_SRC
      ?? 'E:/AllAssets/Skill/原件/MOKE/worldbuilding-moke-v17.md',
    adapter: 'docs/skill-canvas-adapter-worldbuilding.md',
    name: 'worldbuilding-moke',
    suffix: '（画布版：文末追加 canvas-shots/v1 机读块，九张概览落成「镜头 NN」、默认不挂锚点、锚点命名与分镜/资产技能共用）',
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

/**
 * 把值写成 YAML 双引号标量，转义反斜杠与双引号。
 *
 * 不转义的代价很隐蔽：源件的 description 里常有直双引号（MOKE 的 v17 就写着
 * 「视觉展开产出的是"电影剧照式"图像提示词」），直接拼成 `description: "…"…"` 会在第一个
 * 内层引号处提前收尾，整条 frontmatter 解析失败 —— DSH 不报错，只是该技能**静默地从
 * 技能目录里消失**（磁盘文件还在、画布的扫盘接口也还能看到它）。
 */
function yamlQuote(value) {
  if (/[\r\n]/.test(value)) fail(`description 含换行，无法写成单行 YAML 标量：${value.slice(0, 40)}…`);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
  const name = entry.name ?? unquote(readField(meta, 'name', label));
  const description = unquote(readField(meta, 'description', label));
  const adapter = readFileSync(path.join(ROOT, entry.adapter), 'utf8').trim();

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`${label}：name「${name}」不是 kebab-case`);

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(`${description}${entry.suffix}`)}`,
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
