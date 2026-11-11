import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

import { protectLocalLinkAttributes } from '../../src/shared/local-links.ts';

/**
 * Markdown 渲染 —— 模型正文与工具输出都走这里。
 *
 * ★ 安全边界：`marked` 只负责把 Markdown 变 HTML，**不负责可信**；
 *   结果一律再过一遍 `DOMPurify.sanitize`。模型输出是不可信文本，
 *   不洗就 `dangerouslySetInnerHTML` 等于把 XSS 做进产品里。
 * ★ 流式：每来一个 delta 就重解析会让长回答抖，所以按内容 `useMemo`。
 * ★ `breaks: true`：聊天里换行就是换行，不必等空行才分段。
 * ★ 代码块自己套一层工具条（语言标签 + 复制）。`marked` 产出的
 *   `<pre><code class="language-x">` 在这里被改写成 `.md-code` 结构，
 *   复制按钮用容器上的**事件代理**处理 —— 因为 sanitize 过的 HTML 里
 *   挂不了 React 事件。
 */

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  // 最终净化阶段剥除危险导航目标，不能只在 Markdown renderer 或左键 click 上拦截。
  protectLocalLinkAttributes(node, window.location.origin);
  if (node.tagName?.toLowerCase() === 'a' && node.getAttribute('href') !== null) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** 语言标识 → 工具条上显示的名字（认不出就原样） */
const LANG_LABEL: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  sh: 'shell',
  bash: 'bash',
  zsh: 'zsh',
  pwsh: 'powershell',
  ps1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  diff: 'diff',
  toml: 'toml',
  ini: 'ini',
};

/** 把 `<pre><code class="language-x">` 改写成带工具条的 `.md-code` */
function withCodeChrome(html: string): string {
  return html.replace(
    /<pre><code(?: class="language-([\w+#-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_whole, lang: string | undefined, body: string) => {
      const name = (lang ?? '').toLowerCase();
      const label = name.length > 0 ? (LANG_LABEL[name] ?? name) : 'text';
      return (
        '<div class="md-code">' +
        '<div class="md-code-bar">' +
        `<span class="lang">${label}</span>` +
        '<button type="button" class="copy">复制</button>' +
        '</div>' +
        `<pre class="md-code-body"><code>${body}</code></pre>` +
        '</div>'
      );
    },
  );
}

export function Markdown(props: { text: string }): React.ReactElement {
  const html = useMemo(() => {
    const parsed = marked.parse(props.text, { async: false });
    /**
     * ★★ 2026-11-11 审计 `ALK-P3-⑥`：**先加工，再净化**。
     *
     * 原来的顺序是 `sanitize` → `withCodeChrome`（用正则往净化后的字符串里插 HTML），
     * 于是最终交给 `dangerouslySetInnerHTML` 的那一段**没有经过净化器** ——
     * 安全保证从"最后一步是净化"退化成"中间某一步是净化"。
     * 当下它不构成 XSS（代码内容已被 marked 转义成 `&lt;`），但这条保证不该靠"当下碰巧安全"。
     * 现在：`marked` → 加代码块工具条 → **一次净化**，净化器永远是最后一道。
     */
    const withChrome = withCodeChrome(parsed);
    return DOMPurify.sanitize(withChrome, { ADD_ATTR: ['target'] });
  }, [props.text]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('copy')) return;
    const code = target.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard.writeText(code).then(
      () => {
        target.textContent = '已复制';
        window.setTimeout(() => {
          target.textContent = '复制';
        }, 1400);
      },
      () => {
        target.textContent = '复制失败';
        window.setTimeout(() => {
          target.textContent = '复制';
        }, 1400);
      },
    );
  };

  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
