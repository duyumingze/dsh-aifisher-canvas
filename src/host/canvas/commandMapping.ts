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
 *   - `command` 参数是逃生舱：参数多、暂未单独暴露的动作（prepareGeneration/media/workflow…）
 *     直接透传完整协议指令。
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

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return list.length === value.length ? list : null;
}

export function buildCanvasCommand(args: CanvasToolArgs): Record<string, unknown> | string {
  // 逃生舱优先：给了完整指令就照原样下发（并带上 action 便于排查）
  if (args.command && typeof args.command === 'object' && !Array.isArray(args.command)) {
    return { ...(args.command as Record<string, unknown>) };
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

    case 'runGeneration':
    case 'media':
    case 'workflow':
    case 'product':
      return `action:"${args.action}" 的参数较多且需要授权流程，请用 command 参数直接给出完整指令（见 canvasControlProtocol 的 CanvasControl）。`;

    default:
      return `未知动作：${args.action}。`;
  }
}
