/**
 * 画布助手 P3 · 摄影参数 / 定向查询 / 创作进度回归（v1.69）。
 *
 * 三件事各自的「为什么」：
 *   1. 摄影参数：分镜里最容易被写没的是镜头语言（焦段/光圈/机身）。结构化之后要保证
 *      **幂等**——重复 apply 只能替换、不能叠加，否则提示词越跑越长、越跑越乱；
 *   2. 定向查询：`read` 是整张画布，节点一多上下文就爆。查询必须只回命中的几条 +
 *      它们之间的连线，且分页、关键词、类型过滤都要准；
 *   3. 创作进度：换会话/刷新之后，「做到第几步、用户确认了哪一版」不能靠猜。
 *
 * 本套件验证：
 *   1. 纯函数：焦段/光圈翻译、片段拼装与**剥离**（用户自己写的同形 tag 不误删）；
 *   2. action:"camera" list/set/apply/strip/reset；重复 apply 不再增长；只写提示词；
 *      disabled 时拒绝 apply；非法焦段/机身直接 INVALID；
 *   3. action:"query" self/upstream/downstream、关键词、类型、分页、幽灵 id；
 *   4. action:"progress" get/set/clear、阶段机、changed 判定、history、digest 补充段；
 *   5. 画布对话注入带上创作进度（与项目记忆同一条通道）。
 *
 * 用法：node scripts/test-canvas-agent-tools.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import {
  applyCameraToPrompt,
  buildCameraClause,
  describeAperture,
  describeFocalLength,
  normalizeCameraInput,
  queryCanvas,
  stripCameraClause,
  formatProgressForPrompt,
  nextPhase,
} from './lib/plugin-exports.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ================================================================ 1. 纯函数

{
  const focal = [
    [14, 'ultra-wide'],
    [24, 'wide-angle'],
    [35, 'slight-wide'],
    [50, 'standard'],
    [85, 'short-telephoto'],
    [135, 'telephoto'],
    [200, 'long-telephoto'],
  ];
  const bad = focal.filter(([mm, word]) => !describeFocalLength(mm).toLowerCase().includes(word));
  check('焦段翻译覆盖 14→200mm 的七档透视', bad.length === 0, JSON.stringify(bad));

  const apertures = [
    [1.2, 'extremely shallow'],
    [2, 'very shallow'],
    [2.8, 'shallow depth'],
    [4, 'moderate depth'],
    [5.6, 'balanced depth'],
    [8, 'deep depth'],
    [11, 'very deep'],
  ];
  const badAperture = apertures.filter(([f, word]) => !describeAperture(f).toLowerCase().includes(word));
  check('光圈翻译覆盖 f/1.2→f/11 的七档景深', badAperture.length === 0, JSON.stringify(badAperture));
  check('光圈翻译带上具体光圈值', describeAperture(1.8).includes('f/1.8'), describeAperture(1.8).slice(0, 60));

  const clause = buildCameraClause({
    enabled: true,
    body: 'arri-alexa-mini-lf',
    lens: 'cooke-s7i',
    focalLength: 85,
    aperture: 1.8,
  });
  check(
    '片段带头部护栏（不要把相机画进画面）',
    clause.includes('camera direction only') && clause.includes('no camera or gear in frame'),
    clause.slice(0, 120),
  );
  check(
    '片段带机身/镜头/焦段/光圈的完整信息',
    clause.includes('ARRI Alexa Mini LF') && clause.includes('Cooke S7/i') && clause.includes('85mm') && clause.includes('f/1.8'),
    clause.slice(-140),
  );
  check(
    '片段末尾带参数摘要行（同时也是幂等定位）',
    /\[cam: [^\]]*85mm[^\]]*f1\.8\]$/.test(clause),
    clause.slice(-90),
  );
  check('片段控制在 300 字符内（别跟用户提示词抢预算）', clause.length <= 300, `len=${clause.length}`);

  const once = applyCameraToPrompt('雨夜街头，霓虹反光', {
    enabled: true,
    body: 'arri-alexa-mini-lf',
    lens: 'cooke-s7i',
    focalLength: 85,
    aperture: 1.8,
  });
  const twice = applyCameraToPrompt(once, {
    enabled: true,
    body: 'arri-alexa-mini-lf',
    lens: 'cooke-s7i',
    focalLength: 85,
    aperture: 1.8,
  });
  check('重复 apply 结果完全相同（幂等）', once === twice && once.split('camera direction only').length === 2, `len=${once.length}`);

  const switched = applyCameraToPrompt(once, {
    enabled: true,
    body: 'sony-venice-2',
    lens: 'anamorphic-atlas',
    focalLength: 35,
    aperture: 2.8,
  });
  check(
    '换参数后旧片段被替换、不残留',
    switched.includes('35mm') && !switched.includes('85mm') && switched.split('camera direction only').length === 2,
    `len=${switched.length}`,
  );
  check('原文一字不动地留在前面', switched.startsWith('雨夜街头，霓虹反光, camera direction only'), switched.slice(0, 60));
  check('strip 把片段剥干净、只留原文', stripCameraClause(switched) === '雨夜街头，霓虹反光', stripCameraClause(switched));
  check('没有片段的提示词 strip 不变', stripCameraClause('一条普通提示词') === '一条普通提示词');
  check(
    '用户自己写的同形 tag（句首没有我们的护栏句）不误删',
    stripCameraClause('一只猫 [cam: my phone]') === '一只猫 [cam: my phone]',
    stripCameraClause('一只猫 [cam: my phone]'),
  );

  check('非法机身 id 直接报错', 'error' in normalizeCameraInput({ body: 'cooke-s7i' }), JSON.stringify(normalizeCameraInput({ body: 'cooke-s7i' })));
  check('不在档位里的焦段直接报错（不静默取默认）', 'error' in normalizeCameraInput({ focalLength: 77 }), JSON.stringify(normalizeCameraInput({ focalLength: 77 })));
  check('不在档位里的光圈直接报错', 'error' in normalizeCameraInput({ aperture: 3.3 }), JSON.stringify(normalizeCameraInput({ aperture: 3.3 })));
  const merged = normalizeCameraInput({ focalLength: 85 }, { enabled: true, body: 'arri-alexa-35', lens: 'zeiss-supreme-prime', focalLength: 50, aperture: 4 });
  check('只给的字段覆盖，其余保留', 'config' in merged && merged.config.focalLength === 85 && merged.config.body === 'arri-alexa-35' && merged.config.aperture === 4, JSON.stringify(merged));
}

{
  const nodes = [
    { id: 'a', type: 'Image', title: '镜头 1 · 雨棚', prompt: '雨夜街头', x: 0, y: 0, parentIds: [] },
    { id: 'b', type: 'Image', title: '镜头 2', prompt: '车内视角', x: 600, y: 0, parentIds: ['a'] },
    { id: 'c', type: 'Image', title: '镜头 3', prompt: '远处警灯', x: 1200, y: 0, parentIds: ['b'] },
    { id: 't', type: 'Text', title: '剧本 · 雨棚', textContent: '雨夜追车', x: 0, y: 400, parentIds: [] },
  ];
  const upstream = queryCanvas(nodes, { nodeId: 'b', path: 'upstream' });
  check(
    'query upstream：回来源节点 + 自己，并带连线',
    !('error' in upstream) && upstream.nodes.length === 2 && upstream.edges.some((edge) => edge.from === 'a' && edge.to === 'b'),
    JSON.stringify(upstream.nodes?.map((node) => [node.id, node.role])),
  );
  const downstream = queryCanvas(nodes, { nodeId: 'a', path: 'downstream', depth: 2 });
  check(
    'query downstream：按 depth 取到两跳下游（b=1、c=2）',
    !('error' in downstream) &&
      downstream.nodes.some((node) => node.id === 'b' && node.depth === 1) &&
      downstream.nodes.some((node) => node.id === 'c' && node.depth === 2),
    JSON.stringify(downstream.nodes?.map((node) => [node.id, node.depth])),
  );
  const keyword = queryCanvas(nodes, { keyword: '雨棚' });
  check(
    'query keyword：标题与正文都参与匹配',
    !('error' in keyword) && keyword.total === 2 && keyword.nodes.some((node) => node.id === 'a') && keyword.nodes.some((node) => node.id === 't'),
    JSON.stringify(keyword.nodes?.map((node) => node.id)),
  );
  const typed = queryCanvas(nodes, { type: 'text' });
  check('query type：大小写不敏感的类型过滤', !('error' in typed) && typed.total === 1 && typed.nodes[0].id === 't', JSON.stringify(typed.nodes?.map((node) => node.id)));
  const paged = queryCanvas(nodes, { pageSize: 2, page: 1 });
  check(
    'query 分页：total 是全量、当前页只回 pageSize 条并标 truncated',
    !('error' in paged) && paged.total === 4 && paged.nodes.length === 2 && paged.truncated === true,
    JSON.stringify({ total: paged.total, got: paged.nodes?.length }),
  );
  const ghost = queryCanvas(nodes, { nodeId: 'nope' });
  check('query 幽灵 id → NOT_FOUND', 'error' in ghost && ghost.code === 'NOT_FOUND', JSON.stringify(ghost));
  const long = queryCanvas([{ id: 'x', type: 'Image', title: '长', prompt: '雨'.repeat(400) }], { keyword: '长' });
  check(
    'query 提示词只回前 160 字，同时给总长度',
    !('error' in long) && long.nodes[0].excerpt.length <= 160 && long.nodes[0].promptChars === 400,
    JSON.stringify({ excerpt: long.nodes[0].excerpt.length, chars: long.nodes[0].promptChars }),
  );

  check('progress：nextPhase 沿阶段线推进', nextPhase('storyboard') === 'video' && nextPhase('complete') === null);
  const prompt = formatProgressForPrompt({
    phase: 'storyboard',
    brief: '雨夜追车',
    approvedPlan: '第二版：镜头 4 改车内视角',
    approvedNodeIds: ['b'],
    referenceNodeIds: [],
    note: '',
    updatedAt: '2026-10-25T00:00:00.000Z',
    history: [],
  });
  check(
    'progress 注入文本带阶段/原话/已确认方案/下一步',
    prompt.includes('分镜') && prompt.includes('雨夜追车') && prompt.includes('镜头 4 改车内视角') && prompt.includes('video'),
    prompt.slice(0, 160),
  );
  check('没有进度时注入文本为空串（不塞空标题）', formatProgressForPrompt(null) === '');
}

// ================================================================ 2. 工具动作（真画布）

const host = await startHost({ chat: true });
const projectId = 'tools-proj';

{
  const saved = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'P3 工具验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置空项目已写入本地后端', saved.status === 200, String(saved.status));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-tools' } } });

// 建 3 个节点：两个镜头（带提示词）+ 一个剧本节点
const created = {};
{
  const edit = await run({
    action: 'edit',
    operations: [
      { kind: 'create', ref: 's1', type: 'Image', x: 0, y: 0, title: '镜头 1 · 雨棚', prompt: '雨夜街头，霓虹在积水里反光' },
      { kind: 'create', ref: 's2', type: 'Image', x: 620, y: 0, title: '镜头 2', prompt: '车内视角，雨痕挡风玻璃' },
      { kind: 'create', ref: 'doc', type: 'Text', x: 0, y: 460, title: '剧本 · 雨棚', text: '雨夜追车：雨棚下的人抬头。' },
    ],
  });
  const list = Array.isArray(edit.result?.created) ? edit.result.created : [];
  for (const item of list) created[item.ref] = item.id;
  check(
    '建出 3 个节点（两个镜头 + 剧本）',
    edit.ok === true && Object.keys(created).length === 3,
    JSON.stringify(created),
  );
  const link = await run({ action: 'edit', operations: [{ kind: 'connect', sourceId: created.s1, targetId: created.s2 }] });
  check('镜头 1 → 镜头 2 连线成功', link.ok === true, JSON.stringify(link).slice(0, 160));
}

// ---------------------------------------------------------------- camera

{
  const listed = await run({ action: 'camera', camera: { op: 'list' } });
  check(
    'camera list 回项目参数与选型目录（8 机身 / 8 镜头 / 11 焦段 / 10 光圈）',
    listed.ok === true &&
      listed.result?.config?.body === 'arri-alexa-mini-lf' &&
      listed.result?.config?.focalLength === 50 &&
      listed.result?.catalog?.bodies?.length === 8 &&
      listed.result?.catalog?.lenses?.length === 8 &&
      listed.result?.catalog?.focalLengths?.length === 11 &&
      listed.result?.catalog?.apertures?.length === 10,
    JSON.stringify({
      body: listed.result?.config?.body,
      bodies: listed.result?.catalog?.bodies?.length,
      focals: listed.result?.catalog?.focalLengths?.length,
    }),
  );
  check('camera list 给出中文一行摘要', String(listed.result?.summary ?? '').includes('50mm'), String(listed.result?.summary ?? ''));

  const bad = await run({ action: 'camera', camera: { op: 'set', focalLength: 77 } });
  check('非法焦段 → INVALID（不静默取默认）', bad.ok === false && bad.code === 'INVALID', JSON.stringify(bad).slice(0, 200));

  const set = await run({ action: 'camera', camera: { op: 'set', lens: 'cooke-s7i', focalLength: 85, aperture: 1.8 } });
  check(
    'camera set 存进项目（焦段/光圈/镜头）',
    set.ok === true && set.result?.config?.focalLength === 85 && set.result?.config?.aperture === 1.8 && set.result?.config?.lens === 'cooke-s7i',
    JSON.stringify(set.result?.config ?? {}),
  );

  const applied = await run({ action: 'camera', camera: { op: 'apply' } });
  check(
    'camera apply 给两个镜头各写一次（剧本节点不动）',
    applied.ok === true && applied.result?.applied === 2 && applied.result?.saved === 'saved',
    JSON.stringify({ applied: applied.result?.applied, saved: applied.result?.saved, skipped: applied.result?.skipped }),
  );

  const read = await run({ action: 'read', detail: 'full' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  const s1 = nodes.find((node) => node.id === created.s1);
  const doc = nodes.find((node) => node.id === created.doc);
  check(
    '镜头提示词里真的有 85mm / f/1.8 与参数摘要行',
    typeof s1?.prompt === 'string' && s1.prompt.includes('85mm') && s1.prompt.includes('f/1.8') && /\[cam: [^\]]*\]$/.test(s1.prompt),
    String(s1?.prompt ?? '').slice(-120),
  );
  check(
    '剧本节点（Text）没被写进摄影参数',
    typeof doc?.textContent === 'string' && !doc.textContent.includes('camera direction only'),
    String(doc?.textContent ?? '').slice(0, 80),
  );

  const again = await run({ action: 'camera', camera: { op: 'apply' } });
  const readAgain = await run({ action: 'read', detail: 'full' });
  const s1Again = (Array.isArray(readAgain.result?.nodes) ? readAgain.result.nodes : []).find((node) => node.id === created.s1);
  check(
    '重复 apply 只替换不叠加（长度不变、applied=0）',
    again.ok === true && again.result?.applied === 0 && s1Again?.prompt === s1?.prompt,
    JSON.stringify({ applied: again.result?.applied, unchanged: again.result?.unchanged?.length, same: s1Again?.prompt === s1?.prompt }),
  );

  await run({ action: 'camera', camera: { op: 'set', focalLength: 35 } });
  const widened = await run({ action: 'camera', camera: { op: 'apply' } });
  const readWide = await run({ action: 'read', detail: 'full' });
  const s1Wide = (Array.isArray(readWide.result?.nodes) ? readWide.result.nodes : []).find((node) => node.id === created.s1);
  check(
    '换焦段后重新 apply：旧 85mm 片段被替换掉',
    widened.result?.applied === 2 && s1Wide.prompt.includes('35mm') && !s1Wide.prompt.includes('85mm') && s1Wide.prompt.split('camera direction only').length === 2,
    JSON.stringify({ applied: widened.result?.applied, len: s1Wide?.prompt?.length }),
  );

  await run({ action: 'camera', camera: { op: 'set', focalLength: 135 } });
  const single = await run({ action: 'camera', camera: { op: 'apply' }, nodeIds: [created.s2] });
  const readSingle = await run({ action: 'read', detail: 'full' });
  const singleNodes = Array.isArray(readSingle.result?.nodes) ? readSingle.result.nodes : [];
  const s1After = singleNodes.find((node) => node.id === created.s1);
  const s2After = singleNodes.find((node) => node.id === created.s2);
  check(
    'nodeIds 限定后只改指定镜头（另一个保持 35mm）',
    single.result?.applied === 1 && s2After.prompt.includes('135mm') && s1After.prompt.includes('35mm'),
    JSON.stringify({ applied: single.result?.applied, s1: s1After?.prompt?.includes('35mm'), s2: s2After?.prompt?.includes('135mm') }),
  );

  const stripped = await run({ action: 'camera', camera: { op: 'strip' } });
  const readStripped = await run({ action: 'read', detail: 'full' });
  const s1Stripped = (Array.isArray(readStripped.result?.nodes) ? readStripped.result.nodes : []).find((node) => node.id === created.s1);
  check(
    'strip 剥回原文（无缝衔接、只删片段）',
    stripped.result?.applied === 2 && s1Stripped.prompt === '雨夜街头，霓虹在积水里反光',
    JSON.stringify({ applied: stripped.result?.applied, prompt: s1Stripped?.prompt }),
  );

  await run({ action: 'camera', camera: { op: 'set', enabled: false } });
  const disabled = await run({ action: 'camera', camera: { op: 'apply' } });
  check('enabled:false 时 apply 被拒（CAMERA_DISABLED）', disabled.ok === false && disabled.code === 'CAMERA_DISABLED', JSON.stringify(disabled).slice(0, 160));
  const reset = await run({ action: 'camera', camera: { op: 'reset' } });
  check(
    'reset 回到默认参数（并重新打开）',
    reset.ok === true && reset.result?.config?.enabled === true && reset.result?.config?.focalLength === 50,
    JSON.stringify(reset.result?.config ?? {}),
  );
}

// ---------------------------------------------------------------- query

{
  const up = await run({ action: 'query', query: { nodeId: created.s2, path: 'upstream' } });
  check(
    'action:"query" upstream：回镜头 1 + 连线',
    up.ok === true && up.result?.nodes?.some((node) => node.id === created.s1) && up.result?.edges?.some((edge) => edge.from === created.s1 && edge.to === created.s2),
    JSON.stringify({ nodes: up.result?.nodes?.map((node) => node.id), edges: up.result?.edges }),
  );
  const down = await run({ action: 'query', query: { nodeId: created.s1, path: 'downstream' } });
  check('action:"query" downstream：回镜头 2', down.ok === true && down.result?.nodes?.some((node) => node.id === created.s2), JSON.stringify(down.result?.nodes?.map((node) => node.id)));
  const byKeyword = await run({ action: 'query', query: { keyword: '雨棚' } });
  check(
    'action:"query" keyword：命中镜头 1 与剧本节点',
    byKeyword.ok === true && byKeyword.result?.total === 2,
    JSON.stringify({ total: byKeyword.result?.total, ids: byKeyword.result?.nodes?.map((node) => node.id) }),
  );
  const byType = await run({ action: 'query', query: { type: 'Text' } });
  check('action:"query" type：只剩剧本节点', byType.ok === true && byType.result?.total === 1 && byType.result?.nodes?.[0]?.id === created.doc, JSON.stringify(byType.result?.nodes?.map((node) => node.id)));
  const ghost = await run({ action: 'query', query: { nodeId: 'ghost' } });
  check('action:"query" 幽灵节点 → NOT_FOUND', ghost.ok === false && ghost.code === 'NOT_FOUND', JSON.stringify(ghost).slice(0, 160));
  const paged = await run({ action: 'query', query: { pageSize: 2 } });
  check(
    'action:"query" 分页：total=3、当前页 2 条、标 truncated',
    paged.ok === true && paged.result?.total === 3 && paged.result?.nodes?.length === 2 && paged.result?.truncated === true,
    JSON.stringify({ total: paged.result?.total, got: paged.result?.nodes?.length }),
  );
}

// ---------------------------------------------------------------- progress

{
  const empty = await run({ action: 'progress' });
  check('progress get：新项目没有进度（带起步提示）', empty.ok === true && empty.result?.progress === null && Boolean(empty.result?.hint), JSON.stringify(empty.result).slice(0, 160));

  const bad = await run({ action: 'progress', progress: { op: 'set', phase: 'editing' } });
  check('progress set 非法 phase → INVALID', bad.ok === false && bad.code === 'INVALID', JSON.stringify(bad).slice(0, 160));

  const first = await run({
    action: 'progress',
    progress: { op: 'set', phase: 'script', brief: '雨夜追车，6 个镜头，16:9' },
  });
  check(
    'progress set：记下接单原话与下一步',
    first.ok === true && first.result?.changed === true && first.result?.next?.phase === 'breakdown' && first.result?.progress?.brief === '雨夜追车，6 个镜头，16:9',
    JSON.stringify({ changed: first.result?.changed, next: first.result?.next }),
  );

  const same = await run({
    action: 'progress',
    progress: { op: 'set', approvedPlan: '第二版：镜头 4 改成车内视角' },
  });
  check(
    '同阶段更新方案：changed=false、history 不膨胀',
    same.ok === true && same.result?.changed === false && same.result?.progress?.history?.length === 1 && same.result?.progress?.phase === 'script',
    JSON.stringify({ changed: same.result?.changed, history: same.result?.progress?.history?.length }),
  );

  const advanced = await run({
    action: 'progress',
    progress: { op: 'set', phase: 'storyboard', approvedNodeIds: [created.s1], referenceNodeIds: [created.doc], note: '镜头 2 还没出图' },
  });
  check(
    '推进到分镜：changed=true、history 记两跳、节点清单落盘',
    advanced.result?.changed === true &&
      advanced.result?.progress?.history?.length === 2 &&
      advanced.result?.progress?.approvedNodeIds?.[0] === created.s1 &&
      advanced.result?.progress?.referenceNodeIds?.[0] === created.doc,
    JSON.stringify({ history: advanced.result?.progress?.history?.length }),
  );

  const read = await run({ action: 'progress' });
  check(
    'progress get：阶段表 10 项 + 注入文本带已确认方案',
    read.result?.phases?.length === 10 &&
      String(read.result?.prompt ?? '').includes('已确认方案') &&
      String(read.result?.prompt ?? '').includes('镜头 4 改成车内视角'),
    JSON.stringify({ phases: read.result?.phases?.length }),
  );

  const digest = await run({ action: 'read', view: 'digest' });
  check(
    'digest 带进度与摄影参数补充段',
    digest.result?.digest?.progress?.phase === 'storyboard' &&
      typeof digest.result?.digest?.camera?.enabled === 'boolean' &&
      String(digest.result?.digest?.camera?.summary ?? '').includes('50mm'),
    JSON.stringify({ progress: digest.result?.digest?.progress ?? null, camera: digest.result?.digest?.camera ?? null }).slice(0, 220),
  );

  // ---------------------------------------------------------------- 会话注入
  const chatId = 'chat-tools';
  const before = host.chat.created.length;
  const turn = await host.hostApi('POST', '/chat/stream', {
    sessionId: chatId,
    message: '做到哪一步了？',
    projectId,
  });
  check('画布对话回合完成', turn.status === 200, String(turn.status));
  await settle(400);
  const dshSessionId = String(host.chat.created[before]?.sessionId ?? '');
  const decision = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: dshSessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        { id: 'msg-user', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } },
      ],
    }),
  );
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  const notice = messages.find((message) => String(message?.content?.[0]?.text ?? '').includes('画布创作进度'));
  check('画布会话下一回合注入创作进度', Boolean(notice), JSON.stringify(messages.map((message) => message?.source?.kind)));
  check(
    '注入正文带阶段与已确认方案',
    String(notice?.content?.[0]?.text ?? '').includes('分镜') && String(notice?.content?.[0]?.text ?? '').includes('镜头 4 改成车内视角'),
    String(notice?.content?.[0]?.text ?? '').slice(0, 200),
  );

  const cleared = await run({ action: 'progress', progress: { op: 'clear' } });
  const afterClear = await run({ action: 'progress' });
  check('progress clear 清掉进度', cleared.ok === true && cleared.result?.cleared === true && afterClear.result?.progress === null, JSON.stringify(cleared.result));
}

// ---------------------------------------------------------------- 无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('摄影参数/查询/进度链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');

  const read = await run({ action: 'read' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  check('三个动作跑完画布节点数不变（3 个）', nodes.length === 3, `nodes=${nodes.length}`);
}

try {
  handle.dispose();
} catch {
  /* 卸载失败不影响结论 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
