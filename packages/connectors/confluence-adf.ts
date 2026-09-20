import { SourceInputError } from './source-contract.ts';
import { MAX_MARKDOWN_BYTES } from '../import/markdown.ts';

const fail = (): never => { throw new SourceInputError('지원하지 않거나 잘못된 Confluence 본문 요소입니다.'); };
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: any, allowed: string[]) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(); };
const textValue = (value: any): string => {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) fail(); return value;
};
const escape = (text: string) => text.replace(/([\\`*_{}\[\]()#+.!|-])/g, '\\$1').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Deliberately small ADF subset. Unknown macros/media/tables never disappear silently. */
export function confluenceAdfToMarkdown(value: unknown): string {
  if (!object(value) || (value as any).type !== 'doc' || (value as any).version !== 1) fail();
  let nodes = 0;
  const children = (node: any) => { if (!Array.isArray(node.content)) fail(); return node.content as any[]; };
  const visit = (node: any, depth: number, inline = false, raw = false): string => {
    if (++nodes > 10000 || depth > 32) fail();
    fields(node, ['type', 'text', 'attrs', 'marks', 'content', 'version']);
    if (typeof node.type !== 'string') fail();
    if (node.type === 'text') {
      if (!inline || node.content !== undefined || node.attrs !== undefined || node.version !== undefined) fail();
      let text = textValue(node.text);
      if (raw) { if (node.marks?.length) fail(); return text; }
      if (node.marks !== undefined && !Array.isArray(node.marks)) fail();
      text = escape(text); const seen = new Set<string>();
      for (const mark of node.marks ?? []) {
        fields(mark, ['type', 'attrs']); if (seen.has(mark.type)) fail(); seen.add(mark.type);
        if (mark.type === 'strong' || mark.type === 'em') { if (mark.attrs !== undefined) fail(); const marker = mark.type === 'strong' ? '**' : '_'; text = `${marker}${text}${marker}`; }
        else if (mark.type === 'link') {
          fields(mark.attrs, ['href', 'title']); const href = textValue(mark.attrs.href);
          let url: URL; try { url = new URL(href); } catch { fail(); }
          if (!['https:', 'http:'].includes(url!.protocol) || url!.username || url!.password) fail();
          if (mark.attrs.title !== undefined) textValue(mark.attrs.title);
          text = `[${text}](${url!.href.replace(/[()<>\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())})`;
        } else if (mark.type === 'code') {
          if (mark.attrs !== undefined || node.marks.length !== 1) fail(); const content = textValue(node.text);
          const size = Math.max(1, ...(content.match(/`+/g) ?? []).map((run: string) => run.length + 1)); if (size > 64 || content.includes('\n')) fail();
          const fence = '`'.repeat(size); text = `${fence} ${content} ${fence}`;
        } else fail();
      }
      return text;
    }
    if (node.text !== undefined || node.marks !== undefined || (node.version !== undefined && node.type !== 'doc')) fail();
    if (node.type === 'hardBreak') { if (!inline || node.content !== undefined || node.attrs !== undefined) fail(); return '  \n'; }
    if (inline) fail();
    const content = () => children(node).map(child => visit(child, depth + 1)).join('\n\n');
    if (node.type === 'doc') { if (depth !== 0 || node.version !== 1 || node.attrs !== undefined) fail(); return content(); }
    if (node.type === 'paragraph' || node.type === 'heading') {
      let prefix = '';
      if (node.type === 'heading') { fields(node.attrs, ['level']); if (!Number.isInteger(node.attrs.level) || node.attrs.level < 1 || node.attrs.level > 6) fail(); prefix = '#'.repeat(node.attrs.level) + ' '; }
      else if (node.attrs !== undefined) fail();
      const parts = node.content === undefined ? [] : children(node);
      return prefix + parts.map(child => visit(child, depth + 1, true)).join('');
    }
    if (node.type === 'codeBlock') {
      if (node.attrs !== undefined) { fields(node.attrs, ['language']); if (node.attrs.language !== undefined && (typeof node.attrs.language !== 'string' || !/^[a-zA-Z0-9_+-]{0,32}$/.test(node.attrs.language))) fail(); }
      const code = children(node).map(child => visit(child, depth + 1, true, true)).join('');
      const size = Math.max(3, ...(code.match(/`+/g) ?? []).map(run => run.length + 1)); if (size > 64) fail();
      const fence = '`'.repeat(size); return `${fence}${node.attrs?.language ?? ''}\n${code}\n${fence}`;
    }
    if (node.type === 'blockquote') { if (node.attrs !== undefined) fail(); return content().split('\n').map(line => `> ${line}`).join('\n'); }
    if (node.type === 'rule') { if (node.content !== undefined || node.attrs !== undefined) fail(); return '---'; }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      let start = 1;
      if (node.type === 'orderedList' && node.attrs !== undefined) { fields(node.attrs, ['order']); start = node.attrs.order ?? 1; if (!Number.isSafeInteger(start) || start < 1 || start > 1000000) fail(); }
      else if (node.attrs !== undefined) fail();
      return children(node).map((child, index) => {
        if (++nodes > 10000 || depth + 1 > 32) fail();
        if (!object(child) || child.type !== 'listItem') fail(); fields(child, ['type', 'content']);
        const prefix = node.type === 'bulletList' ? '- ' : `${start + index}. `;
        if (!children(child).length) fail();
        const body = children(child).map(item => visit(item, depth + 2)).join('\n\n').split('\n');
        return prefix + body.join('\n' + ' '.repeat(prefix.length));
      }).join('\n');
    }
    return fail();
  };
  const result = visit(value, 0).trim() + '\n';
  if (!result.trim() || Buffer.byteLength(result) > MAX_MARKDOWN_BYTES) fail(); return result;
}
