import { useEffect, useRef, useState } from 'react';

import { api, type PromptInfoDto } from './api.ts';
import './setup-dialog.css';

/**
 * 系统提示查看器。
 *
 * 回答的是一个以前只能靠猜的问题：**模型到底收到了什么？**
 * - 按段列出（id / 来源 / 稳定度 / 字数），点开看正文；
 * - 首条 system 仅 static/session；turn 是派生附加上下文，压缩摘要是派生历史回顾；
 * - 下半部分是**用户自定义指令**，改完立刻影响下一轮（存会话里，不写进代码）。
 */

const STABILITY_LABEL: Record<PromptSectionDto['stability'], string> = {
  static: '固定',
  session: '会话级',
  turn: '每轮',
};

type PromptSectionDto = PromptInfoDto['sections'][number];

type Props = { readonly conversationId: string; readonly onClose: () => void; readonly onSaved: () => void };
export function PromptDialog(props: Props): React.ReactElement {
  return <ConversationPrompt key={props.conversationId} {...props} />;
}
function ConversationPrompt({
  conversationId,
  onClose,
  onSaved,
}: {
  readonly conversationId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.ReactElement {
  const [info, setInfo] = useState<PromptInfoDto | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  const load = async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await api.getPrompt(conversationId, signal);
      if (mounted.current && !signal?.aborted) { setInfo(data); setDraft(data.instructions ?? ''); }
    } catch (cause) {
      if (mounted.current && !signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.updateInstructions(conversationId, draft.trim().length === 0 ? null : draft);
      await load();
      if (mounted.current) onSaved();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const total = info === null ? 0 : info.text.length;

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>提示与动态上下文</h2>
          <span className="preset-meta">
            {info === null ? '加载中…' : `${info.sections.length} 个来源段 · 首条 system ${total} 字`}
          </span>
        </div>

        {error !== null && <div className="banner danger">{error}</div>}

        <p className="hint">
          <strong>首条 system</strong> 只含固定与会话级信息，保持稳定缓存前缀。
          项目记忆、水线与工作看板是动态附加上下文，位于最新真实用户消息前，不是新的用户指令。
          压缩摘要另放在派生历史回顾里，不改首条 system；原始历史只在需要时回读。
        </p>

        {info !== null && (
          <>
            <details className="prompt-projection"><summary>首条稳定 system · {info.text.length} 字</summary><pre className="prompt-body">{info.text}</pre></details>
            <h3 className="prompt-projection-title">来源分段（不表示全部属于 system）</h3>
            <ul className="prompt-list">
              {info.sections.map((section) => (
                <li key={section.id}>
                  <details>
                    <summary>
                      <span className={`stability ${section.stability}`}>{STABILITY_LABEL[section.stability]}</span>
                      <span className="prompt-title">{section.title.length > 0 ? section.title : section.id}</span>
                      <span className="preset-meta">
                        {section.stability === 'turn' ? '动态附加区' : '首条 system'} · {section.sourceId} · {section.chars} 字
                      </span>
                    </summary>
                    <pre className="prompt-body">{section.text}</pre>
                  </details>
                </li>
              ))}
            </ul>

            <details className="prompt-projection"><summary>动态附加上下文 · {info.contextMessages?.length ?? 0} 条（程序派生）</summary>
              {info.contextMessages === undefined ? <p className="hint">此服务未返回动态消息投影；不可把上面的每轮来源段误认为首条 system。</p> : info.contextMessages.length === 0 ? <p className="hint">本轮没有动态附加消息。</p> : info.contextMessages.map((entry, index) => <section key={index}><p className="hint">附加 {entry.role} · 不是新的用户发言</p><pre className="prompt-body">{entry.content ?? ''}</pre></section>)}
            </details>
            <details className="prompt-projection"><summary>派生历史回顾 · {info.recoveryMessages?.length ?? 0} 条（摘要 / 区间指针）</summary>
              <p className="hint">这里只列程序派生的压缩回顾，不包含全部原始消息；摘要不写回首条 system。完整原文请到“日志 → 上下文压缩”分页回读。</p>
              {info.recoveryMessages?.map((entry, index) => <pre key={index} className="prompt-body">{entry.content ?? ''}</pre>)}
            </details>
            <div className="field">
              <span className="field-label">用户自定义指令（只对本会话生效）</span>
              <textarea
                className="instructions"
                rows={5}
                value={draft}
                placeholder="例如：回答前先列出你打算查哪些文件；不要用比喻；代码注释用中文。"
                onChange={(event) => setDraft(event.target.value)}
              />
              <p className="hint">它会作为独立一段注入，排在会话级信息之后；不会覆盖上面的硬规则。</p>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="primary" disabled={busy || info === null} onClick={() => void save()}>
            保存指令
          </button>
        </div>
      </div>
    </div>
  );
}
