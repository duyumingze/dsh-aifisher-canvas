/**
 * 画布助手 P2（v1.63）回归：意图编译器 + 质量评估。
 *
 * 验证口径：
 *   1. compileIntent 是纯函数且确定：同一 brief 两次编译结果一致；
 *   2. 镜头数/画幅/时长/类型从明确线索里取；句子不够时如实少出镜头并写 notes；
 *   3. 风格（项目记忆）与锁定串逐字织进每一镜；质量锚点/限制是固定串；
 *   4. 给了 model 才挂 parameters（画布 configure 的硬约束）；
 *   5. op:"apply" 一次调用把计划展开成画布节点；
 *   6. reviewCanvas 只做可判定检查：提示词缺光/缺质感、锚点未接、结果文件坏/空；
 *   7. probeImageFile 只读文件头就能拿到 PNG 像素尺寸；
 *   8. op:"fix" 只追加固定串，apply:true 才写回画布。
 *
 * 用法：node scripts/test-canvas-p2.mjs    （需要先 build）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileIntent,
  distributeBeats,
  planPromptFixes,
  probeImageFile,
  reviewCanvas,
  splitBrief,
} from '../lib/index.js';
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ---------------------------------------------------------------- 1. 纯函数：切句与分配

{
  const brief = '雨夜追车。挡风玻璃上水痕。远处警灯逼近。';
  const segments = splitBrief(brief);
  check('splitBrief 按句切出 3 段', segments.length === 3, JSON.stringify(segments));

  const groups = distributeBeats(segments, 3);
  check('distributeBeats 3 段分 3 组', groups.length === 3 && groups.every((g) => g.length === 1), JSON.stringify(groups));

  const two = distributeBeats(['a', 'b', 'c', 'd', 'e'], 2);
  check('distributeBeats 5 段分 2 组（前组多拿一个）', two.length === 2 && two[0].length === 3 && two[1].length === 2, JSON.stringify(two));

  // 段数不够时按逗号细分（不复制文本），而不是少出镜头
  const rich =
    '雨夜追车，车灯扫过湿路面，雨刷来回摆。挡风玻璃上水痕，霓虹在玻璃上糊开。远处警灯逼近，红蓝光打湿墙。';
  const six = compileIntent({ brief: rich, shots: 6 });
  check('段数不够时按逗号细分到 6 镜', six.plan.count === 6, `${six.plan.count} / beats=${six.plan.beats}`);
  check('细分后每镜仍有内容来源（不重复文本）', new Set(six.plan.shots.map((shot) => shot.prompt.split('；')[0])).size >= 5, JSON.stringify(six.plan.shots.map((s) => s.prompt.split('；')[0])));
  check('细分够数时不报 missing', six.plan.missing.length === 0, JSON.stringify(six.plan.missing));
}

// ---------------------------------------------------------------- 2. 纯函数：编译器确定性

{
  const input = { brief: '雨夜追车。挡风玻璃上水痕。远处警灯逼近。', shots: 3, aspectRatio: '16:9', type: 'video', duration: 5 };
  const context = { style: ['冷色调霓虹，低饱和'], characters: ['林溯：短寸头，左眉疤'], rules: ['不要出现品牌 logo'] };
  const first = compileIntent(input, context);
  const second = compileIntent(input, context);
  check('compileIntent 无错误', 'plan' in first, JSON.stringify(first).slice(0, 200));
  check(
    '同一输入两次编译完全一致（确定性）',
    JSON.stringify(first) === JSON.stringify(second),
    'plan 不稳定',
  );
  const plan = first.plan;
  check('3 句 → 3 镜', plan.count === 3, String(plan.count));
  check('类型取 video', plan.type === 'Video', plan.type);
  check('画幅取 16:9', plan.aspectRatio === '16:9', String(plan.aspectRatio));
  check('时长取 5', plan.duration === 5, String(plan.duration));
  check('标题按「镜头 NN · 短语」', plan.shots.every((shot) => /^镜头 \d{2} · /.test(shot.title)), JSON.stringify(plan.shots.map((s) => s.title)));
  check(
    '每镜都织进风格串与锁定串',
    plan.shots.every((shot) => shot.prompt.includes('冷色调霓虹') && shot.prompt.includes('林溯')),
    JSON.stringify(plan.shots.map((shot) => shot.prompt)),
  );
  check(
    '每镜都带固定质感锚点/限制与规则',
    plan.shots.every((shot) => shot.prompt.includes('清晰锐利') && shot.prompt.includes('不出现文字与水印') && shot.prompt.includes('品牌 logo')),
    JSON.stringify(plan.shots[0]?.prompt),
  );
  check('没给 model 时不挂 parameters', plan.shots.every((shot) => shot.parameters === undefined), JSON.stringify(plan.shots.map((s) => s.parameters)));
  check('没给 model 但给了画幅/时长 → 有提示', plan.notes.some((note) => note.includes('model')), JSON.stringify(plan.notes));

  const withModel = compileIntent({ ...input, model: '测试模型' }, context);
  check(
    '给了 model 才挂 parameters（含 duration/aspectRatio）',
    withModel.plan.shots.every((shot) => shot.model === '测试模型' && shot.parameters?.duration === 5 && shot.parameters?.aspectRatio === '16:9'),
    JSON.stringify(withModel.plan.shots[0]),
  );

  const tooMany = compileIntent({ brief: '只有一句话。', shots: 6 });
  check('句子不够时如实少出镜头', tooMany.plan.count === 1, String(tooMany.plan.count));
  check('并写 notes 说明请求数', tooMany.plan.notes.some((note) => note.includes('请求 6')), JSON.stringify(tooMany.plan.notes));
  check('missing 标出缺口', tooMany.plan.missing.length === 1, JSON.stringify(tooMany.plan.missing));

  const empty = compileIntent({ brief: '   ' });
  check('空 brief 返回错误', 'error' in empty, JSON.stringify(empty));
}

// ---------------------------------------------------------------- 3. 纯函数：质量评估

const tempDir = mkdtempSync(join(tmpdir(), 'canvas-review-'));
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const goodPath = join(tempDir, 'good.png');
const emptyPath = join(tempDir, 'empty.png');
writeFileSync(goodPath, png1x1);
writeFileSync(emptyPath, Buffer.alloc(0));

{
  const probe = probeImageFile(goodPath);
  check('probeImageFile 读出 PNG 格式', probe?.format === 'png', JSON.stringify(probe));
  check('probeImageFile 读出 1×1 尺寸', probe?.width === 1 && probe?.height === 1, JSON.stringify(probe));
  check('probeImageFile 对 0 字节文件仍返回大小', probeImageFile(emptyPath)?.bytes === 0, JSON.stringify(probeImageFile(emptyPath)));
  check('probeImageFile 对不存在的文件返回 null', probeImageFile(join(tempDir, 'nope.png')) === null);

  const nodes = [
    {
      id: 'good',
      type: 'Image',
      title: '镜头 01 · 海边',
      prompt: '黄昏海边，逆光从侧面打来，画面清晰锐利，不出现文字与水印',
      status: 'success',
      resultUrl: '/api/aifisher/canvas/media/p/images/good.png',
    },
    { id: 'bad', type: 'Image', title: '镜头 02 · 空镜', prompt: '海边', status: 'idle' },
    { id: 'failed', type: 'Video', title: '镜头 03 · 追车', prompt: '雨夜追车，车灯扫过路面', status: 'failed', errorCode: 'COMFY_NODE_MISSING' },
    {
      id: 'broken',
      type: 'Image',
      title: '镜头 04 · 坏图',
      prompt: '雨夜街道，路灯下积水反光',
      status: 'success',
      resultUrl: '/api/aifisher/canvas/media/p/images/empty.png',
    },
  ];
  const report = reviewCanvas({
    nodes,
    uncovered: [{ id: 'good', title: '镜头 01 · 海边', missingAnchors: ['anchor-1'] }],
    resolvePath: (url) => (url.endsWith('good.png') ? goodPath : url.endsWith('empty.png') ? emptyPath : null),
  });
  check('review 覆盖 4 个节点', report.summary.nodes === 4, JSON.stringify(report.summary));
  check('有结果且提示词完整的节点判 pass（除一致性）', report.nodes.find((n) => n.nodeId === 'good')?.verdict === 'attention', JSON.stringify(report.nodes.find((n) => n.nodeId === 'good')?.checks));
  check(
    '缺光/过短的提示词判 attention',
    report.nodes.find((n) => n.nodeId === 'bad')?.checks.some((c) => c.id === 'prompt-light') &&
      report.nodes.find((n) => n.nodeId === 'bad')?.checks.some((c) => c.id === 'prompt-length'),
    JSON.stringify(report.nodes.find((n) => n.nodeId === 'bad')?.checks),
  );
  check(
    '失败节点判 fail 且进 retry',
    report.nodes.find((n) => n.nodeId === 'failed')?.verdict === 'fail' && report.summary.retry.includes('failed'),
    JSON.stringify(report.summary.retry),
  );
  check(
    '0 字节结果判 fail 且进 retry',
    report.nodes.find((n) => n.nodeId === 'broken')?.checks.some((c) => c.id === 'result-file' && c.level === 'fail') &&
      report.summary.retry.includes('broken'),
    JSON.stringify(report.summary.retry),
  );
  check(
    '未接锚点给出 anchor-coverage',
    report.nodes.find((n) => n.nodeId === 'good')?.checks.some((c) => c.id === 'anchor-coverage'),
    JSON.stringify(report.nodes.find((n) => n.nodeId === 'good')?.checks),
  );
  check('结果带像素尺寸供视觉判断', report.nodes.find((n) => n.nodeId === 'good')?.media?.[0]?.width === 1, JSON.stringify(report.nodes.find((n) => n.nodeId === 'good')?.media));

  const prompts = new Map(nodes.map((node) => [node.id, node.prompt]));
  const fixes = planPromptFixes(report, prompts);
  check('修补计划只针对缺项的节点', fixes.patches.length >= 1 && fixes.patches.some((p) => p.nodeId === 'bad'), JSON.stringify(fixes.patches.map((p) => p.nodeId)));
  const badPatch = fixes.operations.find((op) => op.nodeId === 'bad');
  check(
    '修补是「原文 + 追加」，不重写原文',
    typeof badPatch?.patch?.prompt === 'string' &&
      badPatch.patch.prompt.startsWith('海边') &&
      badPatch.patch.prompt.includes('光源：'),
    JSON.stringify(badPatch),
  );
}

// ---------------------------------------------------------------- 4. 真画布：intent apply + review fix

const host = await startHost();
const projectId = 'p2-proj';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'P2 验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入', save.status === 200);
}
const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-p2' } } });
const readNodes = async () => {
  const read = await run({ action: 'read' });
  return Array.isArray(read.result?.nodes) ? read.result.nodes : [];
};

{
  const memory = await run({ action: 'memory', memory: { op: 'set', kind: 'style', text: '冷色调霓虹，低饱和' } });
  check('项目记忆写入风格', memory.result?.entry?.text === '冷色调霓虹，低饱和', JSON.stringify(memory).slice(0, 200));

  const compiled = await run({
    action: 'intent',
    intent: { op: 'compile', brief: '雨夜追车。挡风玻璃上水痕。远处警灯逼近。', shots: 3 },
  });
  check('intent compile 成功', compiled.ok === true && compiled.result?.plan?.count === 3, JSON.stringify(compiled).slice(0, 240));
  check(
    'compile 自动带上项目记忆里的风格',
    compiled.result?.plan?.shots?.every((shot) => shot.prompt.includes('冷色调霓虹')),
    JSON.stringify(compiled.result?.plan?.shots?.map((s) => s.prompt)),
  );

  const applied = await run({
    action: 'intent',
    intent: { op: 'apply', brief: '雨夜追车。挡风玻璃上水痕。远处警灯逼近。', shots: 3, columns: 3 },
  });
  check('intent apply 一次调用成功', applied.ok === true && applied.result?.ok === true, JSON.stringify(applied).slice(0, 260));
  check('apply 回带 created 三个节点', Array.isArray(applied.result?.created) && applied.result.created.length === 3, JSON.stringify(applied.result?.created));

  const nodes = await readNodes();
  const shots = nodes.filter((node) => node.type === 'Image' || node.type === 'Video');
  check('画布上出现 3 个镜头节点', shots.length === 3, JSON.stringify(shots.map((n) => n.title)));
  check('标题为「镜头 01 · …」并被分镜板排序识别', shots.every((n) => /^镜头 \d{2} · /.test(n.title ?? '')), JSON.stringify(shots.map((n) => n.title)));
  check(
    '提示词含风格/质感/限制',
    shots.every((n) => String(n.prompt).includes('冷色调霓虹') && String(n.prompt).includes('清晰锐利') && String(n.prompt).includes('不出现文字与水印')),
    JSON.stringify(shots.map((n) => n.prompt)),
  );

  // 「挡风玻璃上水痕」这一镜没有光源词 → review 应点出来
  const scan = await run({ action: 'review', review: { op: 'scan' } });
  check('review scan 成功', scan.ok === true && scan.result?.report?.summary?.nodes >= 3, JSON.stringify(scan).slice(0, 240));
  const water = scan.result?.report?.nodes?.find((n) => String(n.title).includes('水痕'));
  check('未写光源的镜头被判 attention', water?.checks?.some((c) => c.id === 'prompt-light'), JSON.stringify(water));

  const fixed = await run({ action: 'review', review: { op: 'fix', apply: true } });
  check('review fix 写回画布', fixed.ok === true && fixed.result?.ok === true, JSON.stringify(fixed).slice(0, 240));
  check('fix 报告 applied 数量', (fixed.result?.fixes?.applied ?? 0) >= 1, JSON.stringify(fixed.result?.fixes));
  const after = await readNodes();
  const waterAfter = after.find((n) => String(n.title).includes('水痕'));
  check(
    '修补后提示词追加了光源句（原文保留）',
    String(waterAfter?.prompt ?? '').includes('水痕') && String(waterAfter?.prompt ?? '').includes('光源：'),
    JSON.stringify(waterAfter?.prompt),
  );
}

rmSync(tempDir, { recursive: true, force: true });

const summary = `SUMMARY pass=${lines.length - failures} fail=${failures}`;
console.log(lines.join('\n'));
console.log(summary);
process.exit(failures === 0 ? 0 : 1);
