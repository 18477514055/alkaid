/** Cookie 不区分端口。模型生成的链接不得把已配对浏览器导航到同 Cookie 主机的其他 origin。 */
export function isAllowedLocalLink(href: string, currentOrigin: string): boolean {
  try {
    const current = new URL(currentOrigin);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return false;
    const target = new URL(href, current);
    // WHATWG URL 负责 userinfo、IPv4 十进制/十六进制、转义主机、大小写与默认端口规范化。
    // 尾点也保守视作同一 Cookie 主机，不允许靠 DNS 的等价拼法绕到其他 origin。
    const cookieHost = (hostname: string) => hostname.toLowerCase().replace(/\.+$/, '');
    return cookieHost(target.hostname) !== cookieHost(current.hostname) || target.origin === current.origin;
  } catch {
    return false;
  }
}

/** 在最终 DOMPurify hook 里处理已被 HTML parser 解码的属性，覆盖 raw HTML / Markdown / SVG href。 */
export function protectLocalLinkAttributes(node: {
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}, currentOrigin: string): void {
  let blocked = false;
  for (const name of ['href', 'xlink:href']) {
    const href = node.getAttribute(name);
    if (href !== null && !isAllowedLocalLink(href, currentOrigin)) {
      node.removeAttribute(name);
      blocked = true;
    }
  }
  // 不依赖 click 处理器：危险 URL 本身被移除，中键、右键新窗、另存都没有可导航目标。
  if (blocked) {
    node.removeAttribute('target');
    node.removeAttribute('download');
    node.setAttribute('aria-disabled', 'true');
    node.setAttribute('title', '已阻止访问同一本机主机的其他端口或协议，以保护本机授权。');
  }
  node.removeAttribute('ping');
}
