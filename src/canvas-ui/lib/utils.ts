/**
 * shadcn/ui 的类名合并工具（等价于 shadcn 官方的 lib/utils）。
 *
 * 之所以自己写而不是 `shadcn add utils`：registry 的 utils 项同样通过 GitHub 分发模板，
 * 而这里只需要 clsx + tailwind-merge 两行组合，保持同名 API（cn）即可。
 *
 * 注意 tailwind-merge 需要知道本项目自定义的 scale（`af-*` 变量并不产生类名，
 * 所以默认配置即可；但 `size-*` / `h-*` 这类冲突合并它原生支持）。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
