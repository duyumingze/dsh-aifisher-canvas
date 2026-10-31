import { agentDocumentAccept, isAgentDocument } from '../../shared/agentDocumentFormats.js';
import { readAgentDocument } from '../agent/agentDocuments';
// dsh-aifisher-canvas v1.87：Markdown 在本机解析成富文档（host 那条路只给回纯文本）。
import {
  createTextDocumentPatch,
  isMarkdownFileName,
  textDocumentFromMarkdown,
} from './textDocument';

export const TEXT_NODE_FILE_ACCEPT = agentDocumentAccept;

/** Extract complete text with the existing local parser. DOCX layout, embedded
 * objects and links are not imported; no model, saved file or source path is needed. */
export async function readTextNodeFile(
  file: File,
  signal: AbortSignal,
): Promise<{ name: string; text: string; document?: unknown }> {
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  if (!isAgentDocument(file.name)) {
    throw new Error(
      '支持 DOCX、TXT、Markdown、CSV、TSV、JSON、YAML、XML、LOG、SRT 和 VTT。旧版 DOC 请另存为 DOCX。',
    );
  }
  if (!file.name.trim() || file.name.length > 160 || /[\\/\0\r\n]/.test(file.name)) {
    throw new Error('文件名无效，请选择本机文档文件。');
  }
  if (!file.size) throw new Error('文件为空，请选择有正文的文档。');
  // dsh-aifisher-canvas v1.87：`.md/.markdown` 不走 host 解析（那条路只会给回纯文本，
  // 标题/列表/加粗全变成字面量），本机把正文读成 Markdown 再转成节点富文档。
  if (isMarkdownFileName(file.name)) {
    // FileReader 而不是 Blob.text()：老环境与回归用的 jsdom 都没有 File.text()。
    const source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('文档读取失败'));
      reader.readAsText(file);
    });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (!source.trim()) throw new Error('文档中没有可导入的正文。');
    const patch = createTextDocumentPatch(textDocumentFromMarkdown(source));
    return { name: file.name, text: patch.textContent, document: patch.textRichContent };
  }
  const document = await readAgentDocument(file, signal, { preserveWhitespace: true });
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  if (!document.text.trim()) throw new Error('文档中没有可导入的正文。');
  return { name: document.name, text: document.text };
}
