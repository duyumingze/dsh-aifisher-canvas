/**
 * canvas_control 工具参数 → 画布指令（canvasControlProtocol 的 CanvasControl）的映射。
 *
 * 为什么单独一层：工具的参数表是给模型看的（平坦、带 enum），而画布协议是一棵
 * 判别联合（action + operation + 若干必填字段）。把两者的翻译集中在这一个纯函数里，
 * 既方便单测，也避免在工具 execute 里堆一长串 if。
 *
 * 约定：
 *   - 返回对象 = 要下发的指令；
 *   - 返回字符串 = 参数不合法，字符串就是给模型看的错误说明（工具据此返回 NEED_COMMAND）；
 *   - `action:"command"` + `command{...}` 是逃生舱：把完整 CanvasControl 透传给画布。
 *     只放行 AGENT_COMMAND_ACTIONS 里的动作；runGeneration 与费用授权类永远拒绝
 *     （红线见 docs/canvas-agent-contract.md §4）。
 */
export interface CanvasToolArgs {
  action: string;
  revision?: unknown;
  operations?: unknown;
  nodeIds?: unknown;
  name?: unknown;
  operationId?: unknown;
  type?: unknown;
  offset?: unknown;
  command?: unknown;
}

/**
 * 逃生舱放行的动作。
 *
 * 判据只有一条：**不会让 Agent 自己把钱花出去**。
 * 生成的提交（runGeneration）与预算授权（prepareBudget / revokeBudget）不在其中：
 * 前者只能由用户在画布右下角的确认卡上按，后者属于授权流程本身。
 * product 虽然能「运行工作流」，但它在画布侧只是排队，等用户点开才执行。
 */
const AGENT_COMMAND_ACTIONS = new Set([
  'read',
  'edit',
  'undo',
  'focus',
  'projects',
  'project',
  'assets',
  'importAsset',
  'models',
  'tasks',
  'cancelTask',
  'prepareGeneration',
  'media',
  'workflow',
  'workflows',
  'product',
  'budgets',
]);

/** 明确拒绝的动作：给模型一句能读懂的理由，而不是让它以为参数写错了。 */
const REFUSED_COMMAND_ACTIONS: Record<string, string> = {
  runGeneration:
    'runGeneration 只会由用户在画布右下角点「确认本批生成与费用」时触发；Agent 只能 prepareGeneration，然后等用户按。',
  prepareBudget: 'prepareBudget 属于费用授权流程，只由画布 UI 发起；Agent 不要碰预算授权。',
  revokeBudget: 'revokeBudget 只由画布 UI 发起。',
};

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return list.length === value.length ? list : null;
}

export function buildCanvasCommand(args: CanvasToolArgs): Record<string, unknown> | string {
  // 逃生舱：给了完整指令就校验后照原样下发（不再看外层的 action 名）
  if (args.command && typeof args.command === 'object' && !Array.isArray(args.command)) {
    const raw = args.command as Record<string, unknown>;
    const action = typeof raw.action === 'string' ? raw.action : '';
    if (!action) {
      return 'command 需要 action 字段（完整 CanvasControl 指令，例如 {action:"media",operation:"frames",nodeId,times:[1.5]}）。';
    }
    const refused = REFUSED_COMMAND_ACTIONS[action];
    if (refused) return refused;
    if (!AGENT_COMMAND_ACTIONS.has(action)) {
      return `command 不接受 action:"${action}"；可用的是 ${[...AGENT_COMMAND_ACTIONS].join(' / ')}。`;
    }
    return { ...raw };
  }

  if (args.action === 'command') {
    return 'action:"command" 要同时给 command:{action:..., ...}（完整画布指令）。' +
      '例如 {action:"command", command:{action:"media", operation:"frames", nodeId:"…", times:[1.5, 8]}}。';
  }

  switch (args.action) {
    case 'read':
      return { action: 'read' };

    case 'focus': {
      const nodeIds = stringList(args.nodeIds);
      if (!nodeIds || nodeIds.length === 0) {
        return 'focus 需要 nodeIds（要聚焦的节点 id 数组），先用 action:"read" 拿到节点列表。';
      }
      return { action: 'focus', nodeIds };
    }

    case 'edit': {
      const revision = typeof args.revision === 'string' ? args.revision : '';
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        return 'edit 需要非空 operations 数组，例如 [{kind:"create",ref:"n1",type:"Image",x:0,y:0}]。';
      }
      // revision 可以省略：host 会在下发前自己读一次补上（见 index.ts）。
      // 这样模型「读+改」只要一次工具调用，省掉一个模型往返 —— 对话控制画布慢的主因之一。
      return revision
        ? { action: 'edit', revision, operations: args.operations }
        : { action: 'edit', operations: args.operations };
    }

    case 'undo': {
      const revision = typeof args.revision === 'string' ? args.revision : '';
      const operationId = typeof args.operationId === 'string' ? args.operationId : '';
      if (!revision || !operationId) {
        return 'undo 需要 revision 与 operationId（两者都在上一次 edit 的返回里，read 也能拿到最新 revision）。';
      }
      return { action: 'undo', revision, operationId };
    }

    case 'projects': {
      const command: Record<string, unknown> = { action: 'projects' };
      if (typeof args.name === 'string' && args.name) command.query = args.name;
      if (typeof args.offset === 'number') command.offset = args.offset;
      return command;
    }

    case 'assets': {
      const command: Record<string, unknown> = { action: 'assets' };
      if (typeof args.name === 'string' && args.name) command.query = args.name;
      if (typeof args.offset === 'number') command.offset = args.offset;
      return command;
    }

    case 'models': {
      const type = typeof args.type === 'string' ? args.type : '';
      if (!type) return 'models 需要 type（Image / Video / Audio / Text）。';
      const command: Record<string, unknown> = { action: 'models', type };
      if (typeof args.name === 'string' && args.name) command.model = args.name;
      return command;
    }

    case 'tasks': {
      const command: Record<string, unknown> = { action: 'tasks' };
      const nodeIds = stringList(args.nodeIds);
      if (nodeIds && nodeIds.length) command.nodeIds = nodeIds;
      return command;
    }

    case 'cancelTask': {
      const revision = typeof args.revision === 'string' ? args.revision : '';
      const nodeIds = stringList(args.nodeIds);
      if (!revision || !nodeIds || nodeIds.length !== 1) {
        return 'cancelTask 需要 revision 与恰好一个 nodeIds（要取消的任务节点）。';
      }
      return { action: 'cancelTask', revision, nodeId: nodeIds[0] };
    }

    case 'prepareGeneration': {
      const revision = typeof args.revision === 'string' ? args.revision : '';
      const nodeIds = stringList(args.nodeIds);
      if (!revision || !nodeIds || nodeIds.length === 0) {
        return 'prepareGeneration 需要 revision 与 nodeIds（要生成的目标节点）。';
      }
      return { action: 'prepareGeneration', revision, nodeIds };
    }

    // media / workflow / product 等「参数多、用得少」的动作不再做成平坦参数（v1.70），
    // 统一走 action:"command"；runGeneration 则连逃生舱也不放行。
    default:
      return `未知动作：${args.action}。参数较多或很少用的动作（media / workflow / product）用 action:"command" + command:{...} 下发。`;
  }
}
