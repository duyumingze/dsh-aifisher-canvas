/**
 * 「角度 / 全景图 / 扩图」面板里那个主按钮（**整文件覆盖**，dsh-aifisher-canvas v1.38）。
 *
 * 上游版本做两件事：显示「约 ¥0.xx」的价格，标题写「使用 GPT2.5 低价版」。
 * 这两个都建立在 `imageToolModel` 写死那条 Relay 通道上 —— 本次改成「跟着用户自己的通道走」后，
 * 价格不再可知（也不该替用户瞎报），所以：
 *   · 不再读 `useComposerPricing`（也就不会再出现一个 ¥NaN / 假报价）；
 *   · 标题改成中性的一句，说明「按你自己的通道计费」；
 *   · 保留原来的两态文案（`editing` 时是「应用设置」）。
 *
 * 顺带加了一个 `data-fisherai-image-tool-generate` 属性：回归与真机脚本靠它找按钮，
 * 不必依赖按钮文案（文案这次就改过）。
 */
import * as React from 'react';
import { ArrowUp } from 'lucide-react';
export function ImageToolGenerateButton({
  label,
  onClick,
  editing = false,
}: {
  label: string;
  editing?: boolean;
  aspectRatio?: string;
  onClick(): void;
}) {
  const clicked = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  return (
    <button
      className="primary"
      aria-label={label}
      data-fisherai-image-tool-generate="true"
      disabled={pending}
      title={
        editing
          ? '保存角度参数'
          : '会用你当前配置的通道出图（额度与计费以你自己那条通道的账单为准）'
      }
      onClick={() => {
        if (clicked.current) return;
        clicked.current = true;
        setPending(true);
        try {
          onClick();
        } finally {
          clicked.current = false;
          setPending(false);
        }
      }}
    >
      {label}
      <ArrowUp size={17} />
    </button>
  );
}
