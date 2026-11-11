import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import './local-auth.css';

type AuthStatus = {
  authenticated: boolean;
  enabled: boolean;
  pairingPath: string | null;
  pairingExpiresAt: number | null;
};

async function readStatus(fetcher: typeof fetch): Promise<AuthStatus> {
  const response = await fetcher('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('status unavailable');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null) throw new Error('invalid status');
  const status = value as AuthStatus;
  if (typeof status.authenticated !== 'boolean' || typeof status.enabled !== 'boolean' ||
      !(status.pairingPath === null || typeof status.pairingPath === 'string') ||
      !(status.pairingExpiresAt === null || (typeof status.pairingExpiresAt === 'number' && Number.isFinite(status.pairingExpiresAt)))) {
    throw new Error('invalid status');
  }
  return status;
}

/** 只显示非秘密路径。主 token 不经 JS；人工一次性 code 只短暂存在于 password 输入框/POST body。 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const codeInput = useRef<HTMLInputElement>(null);
  const fetcher = useRef<typeof fetch>(window.fetch.bind(window));

  useEffect(() => {
    let alive = true;
    let checking = false;
    const originalFetch = window.fetch;
    const nativeFetch = fetcher.current;
    const check = async (ticketFailure = false) => {
      if (checking) return;
      checking = true;
      try {
        const next = await readStatus(nativeFetch);
        if (!alive) return;
        setStatus(next);
        setMessage(ticketFailure && next.enabled && !next.authenticated
          ? '本机授权票已失效。请刷新页面重新配对；若配对码已过期或用过，请重启 Alkaid。'
          : '');
      } catch {
        if (alive) {
          if (ticketFailure) setStatus(null);
          setMessage('暂时无法确认本机授权状态。请确认 Alkaid 正在运行，然后刷新页面重试。');
        }
      } finally {
        checking = false;
      }
    };
    // 不将业务权限 403 当成票失效：再查非秘密 status，只有 authenticated=false 才卸载 App。
    const watchedFetch: typeof fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      if (response.status === 403) {
        try {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
          if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) {
            void check(true);
          }
        } catch { /* 无法识别的 URL 不参与授权检测 */ }
      }
      return response;
    };
    window.fetch = watchedFetch;
    void check();
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      setNow(Date.now());
      // 包括 SSE 断线等非 fetch 路径，也能恢复到有解释的配对页。
      void check();
    }, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      if (window.fetch === watchedFetch) window.fetch = originalFetch;
      if (codeInput.current) codeInput.current.value = '';
    };
  }, []);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = codeInput.current;
    if (!input || !input.value.trim() || busy) return;
    setBusy(true);
    setMessage('');
    try {
      // 不建 code state、不存储、不记录；序列化后立刻擦除输入框（成功/失败都不保留）。
      const pending = fetcher.current('/api/auth/pair', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: input.value.trim() }),
      });
      input.value = '';
      const response = await pending;
      const next = await readStatus(fetcher.current);
      setStatus(next);
      if (!response.ok || (next.enabled && !next.authenticated)) {
        setMessage(next.pairingPath === null || (next.pairingExpiresAt !== null && next.pairingExpiresAt <= Date.now())
          ? '一次性配对码已过期或已使用。请重启 Alkaid 生成新的配对码，再刷新此页面。'
          : '配对未成功。请核对可信终端或编辑器中的一次性配对码后重试；过期或已使用的码需要重启 Alkaid。');
      }
    } catch {
      setMessage('配对请求未能完成。请检查 Alkaid 是否仍在运行并刷新页面；若配对码已被使用，请重启 Alkaid。');
    } finally {
      input.value = '';
      setBusy(false);
    }
  }

  if (status && (!status.enabled || status.authenticated)) return <>{children}</>;
  const expired = status !== null && (status.pairingPath === null || (status.pairingExpiresAt !== null && status.pairingExpiresAt <= now));
  return (
    <main className="local-auth">
      <section className="local-auth__card" aria-labelledby="local-auth-title">
        <div className="local-auth__brand">瑶光 · ALKAID</div>
        <h1 id="local-auth-title">{status ? '配对此浏览器' : '正在确认本机授权'}</h1>
        {status && <>
          <p>此页面还没有本机授权。请在您信任的终端或编辑器中打开下面的文件，将其中的<strong>一次性配对码</strong>粘贴到此处。</p>
          {status.pairingPath !== null && <code className="local-auth__path">{status.pairingPath}</code>}
          <p className="local-auth__note">这里只显示文件路径，不会自动读取文件。不要粘贴主令牌、API Key 或其他凭据。</p>
          {expired ? <p className="local-auth__expired" role="status">一次性配对码已过期或已使用。请重启 Alkaid 生成新的配对码，再刷新此页面。</p> : <form onSubmit={pair} autoComplete="off">
            <label htmlFor="alkaid-pairing-code">一次性配对码</label>
            <input ref={codeInput} id="alkaid-pairing-code" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} aria-describedby="local-auth-privacy" />
            <p id="local-auth-privacy" className="local-auth__note">配对码只用于本次提交，不保存到浏览器存储；提交后立即清空。</p>
            {status.pairingExpiresAt !== null && <p className="local-auth__note">有效期至 {new Date(status.pairingExpiresAt).toLocaleTimeString()}。过期或用过后须重启生成新码。</p>}
            <button type="submit" disabled={busy}>{busy ? '正在确认授权…' : '配对并进入'}</button>
          </form>}
        </>}
        {message && <p className="local-auth__error" role="alert">{message}</p>}
        {(message || expired) && <button type="button" className="local-auth__refresh" onClick={() => window.location.reload()}>刷新并重新检查</button>}
      </section>
    </main>
  );
}
