import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ExternalLink,
  Globe,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  ChainHeadSnapshot,
  FinalityStage,
  VerifiedTransactionResult,
} from '../types/finality';

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'model';
  modelUsed: string;
  content: string;
  groundingSources?: Array<{ title: string; uri: string }>;
  createdAt: number;
}

interface AiAuditAssistantSectionProps {
  snapshot: ChainHeadSnapshot | null;
  results: VerifiedTransactionResult[];
  withdrawalResults: VerifiedTransactionResult[];
  authToken: string | null;
  userEmail: string | null;
}

const DEFAULT_SESSION_ID = 'base-audit-main';
const LOCAL_CHAT_STORAGE_KEY = 'base-finality-ai-chat-v1';

interface PersistedChatState {
  messages?: ChatMessageItem[];
  selectedModel?: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  useGoogleSearch?: boolean;
  includeContext?: boolean;
}

function loadLocalChatState(): PersistedChatState {
  try {
    const raw = localStorage.getItem(LOCAL_CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedChatState;
  } catch {
    return {};
  }
}

export function AiAuditAssistantSection({
  snapshot,
  results,
  withdrawalResults,
  authToken,
  userEmail,
}: AiAuditAssistantSectionProps) {
  const initialLocal = useMemo(() => loadLocalChatState(), []);
  const [messages, setMessages] = useState<ChatMessageItem[]>(() =>
    Array.isArray(initialLocal.messages) ? initialLocal.messages : []
  );
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState<
    'gemini-4-hydrogen' | 'gemini-3.1-flash-lite'
  >(() =>
    initialLocal.selectedModel === 'gemini-3.1-flash-lite'
      ? 'gemini-3.1-flash-lite'
      : 'gemini-4-hydrogen'
  );
  const [useGoogleSearch, setUseGoogleSearch] = useState<boolean>(() =>
    typeof initialLocal.useGoogleSearch === 'boolean'
      ? initialLocal.useGoogleSearch
      : true
  );
  const [includeContext, setIncludeContext] = useState<boolean>(() =>
    typeof initialLocal.includeContext === 'boolean'
      ? initialLocal.includeContext
      : true
  );
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // Google Search Grounding quick query state
  const [searchQuery, setSearchQuery] = useState(
    'Base Mainnet OptimismPortal2 proofMaturityDelaySeconds fault proofs status'
  );
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<{
    text: string;
    groundingSources: Array<{ title: string; uri: string }>;
  } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Persist chat messages & settings locally across reloads
  useEffect(() => {
    try {
      const payload: PersistedChatState = {
        messages: messages.slice(-100),
        selectedModel,
        useGoogleSearch,
        includeContext,
      };
      localStorage.setItem(LOCAL_CHAT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota errors
    }
  }, [messages, selectedModel, useGoogleSearch, includeContext]);

  // Load persisted chat messages when signed in
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    fetch(`/api/ai/chat/history?sessionId=${encodeURIComponent(DEFAULT_SESSION_ID)}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.messages)) return;
        if (data.messages.length > 0) {
          setMessages(data.messages);
        }
      })
      .catch(() => {
        // Non-fatal
      });

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    if (snapshot) {
      parts.push(
        `ネットワーク: ${snapshot.networkName} (Chain ID ${snapshot.chainId ?? '—'})`,
        `Latest: #${snapshot.latest?.number ?? '—'}, Safe: #${
          snapshot.safe?.number ?? '—'
        }, Finalized: #${snapshot.finalized?.number ?? '—'}`,
        `L1 Finalized: #${snapshot.l1Head?.finalizedNumber ?? '—'}`
      );
    }

    const activeList = results.length > 0 ? results : withdrawalResults;
    if (activeList.length > 0) {
      const finalizedCount = activeList.filter(
        (r) => r.finality === FinalityStage.FINALIZED
      ).length;
      const errorCount = activeList.filter(
        (r) =>
          r.finality === FinalityStage.NOT_FOUND ||
          r.finality === FinalityStage.RPC_ERROR ||
          r.finality === FinalityStage.INVALID
      ).length;
      const wList = activeList.filter((r) => r.withdrawal !== null);

      parts.push(
        `現在の検証バッチ: 合計 ${activeList.length}件 (Finalized: ${finalizedCount}件, 未検出/エラー: ${errorCount}件, 出金Tx: ${wList.length}件)`
      );

      for (const wRow of wList.slice(0, 5)) {
        const w = wRow.withdrawal!;
        parts.push(
          `- 出金Tx ${wRow.hash}: ${w.amountFormatted} ${w.assetSymbol}, L1ステータス=${w.status}, portalFinalized=${w.portalFinalized}, 残り時間=${w.totalSecondsRemaining ?? '—'}秒`
        );
      }
    }
    return parts.join('\n');
  }, [snapshot, results, withdrawalResults]);

  const handleSendChat = async (overrideMessage?: string) => {
    const text = (overrideMessage ?? input).trim();
    if (!text || isSending) return;

    const userMsg: ChatMessageItem = {
      id: `u-${Date.now()}`,
      role: 'user',
      modelUsed: selectedModel,
      content: text,
      createdAt: Date.now(),
    };

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!overrideMessage) setInput('');
    setIsSending(true);
    setChatError(null);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: DEFAULT_SESSION_ID,
          model: selectedModel,
          message: text,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          contextSummary: includeContext ? contextSummary : undefined,
          useGoogleSearch: selectedModel === 'gemini-4-hydrogen' && useGoogleSearch,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      const assistantMsg: ChatMessageItem = {
        id: `m-${Date.now()}`,
        role: 'model',
        modelUsed: data.modelUsed ?? selectedModel,
        content: data.text,
        groundingSources: Array.isArray(data.groundingSources)
          ? data.groundingSources
          : [],
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : 'チャット応答の取得に失敗しました'
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleRunSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || isSearching) return;
    setIsSearching(true);
    setSearchError(null);

    try {
      const res = await fetch('/api/ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setSearchResult({
        text: data.text,
        groundingSources: Array.isArray(data.groundingSources)
          ? data.groundingSources
          : [],
      });
    } catch (err) {
      setSearchError(
        err instanceof Error ? err.message : 'Google検索グラウンディングに失敗しました'
      );
    } finally {
      setIsSearching(false);
    }
  };

  const handleClearChat = async () => {
    setMessages([]);
    setChatError(null);
    try {
      localStorage.removeItem(LOCAL_CHAT_STORAGE_KEY);
    } catch {
      // Ignore
    }
    if (authToken) {
      await fetch(
        `/api/ai/chat/history?sessionId=${encodeURIComponent(DEFAULT_SESSION_ID)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authToken}` },
        }
      ).catch(() => {});
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Google Search Grounding Lookup */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Globe className="w-4 h-4 text-[#0052FF]" />
              <span>Base プロトコル最新情報検索 (Google Search Grounding)</span>
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              <span className="font-mono">gemini-4-hydrogen</span> と Google Search を連携し、Base の最新の障害情報・Fault Proof・OptimismPortal2 の公式パラメーター変更を引用URL付きで照会します。
            </p>
          </div>
        </div>

        <form onSubmit={handleRunSearch} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="例: Base mainnet withdrawal delay 2025 OptimismPortal2 / Base status incident"
            className="flex-1 px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
          />
          <button
            type="submit"
            disabled={isSearching || !searchQuery.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {isSearching ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Google検索中...</span>
              </>
            ) : (
              <>
                <Globe className="w-4 h-4" />
                <span>最新情報を検索</span>
              </>
            )}
          </button>
        </form>

        {searchError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
            {searchError}
          </div>
        )}

        {searchResult && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
              {searchResult.text}
            </div>
            {searchResult.groundingSources.length > 0 && (
              <div className="pt-3 border-t border-slate-200 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-500">
                  Google Search 参照元 ({searchResult.groundingSources.length}件)
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {searchResult.groundingSources.map((src) => (
                    <a
                      key={src.uri}
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#0052FF] hover:underline"
                    >
                      <span className="truncate max-w-[260px]">{src.title}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 2: Multi-Turn Gemini Audit Chatbot */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[#0052FF]" />
              <span>Base オンチェーン監査 AI チャット</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              ファイナライズ判定・出金待ち時間・エラー原因を現在の検証実測値と合わせて質問できます
              {userEmail ? ` · 履歴クラウド同期中 (${userEmail})` : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedModel}
              onChange={(e) =>
                setSelectedModel(
                  e.target.value as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite'
                )
              }
              aria-label="応答モデル選択"
              className="px-2.5 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
            >
              <option value="gemini-4-hydrogen">
                Gemini 4 Hydrogen (標準 · Search対応)
              </option>
              <option value="gemini-3.1-flash-lite">
                Gemini 3.1 Flash Lite (高速応答)
              </option>
            </select>

            {selectedModel === 'gemini-4-hydrogen' && (
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useGoogleSearch}
                  onChange={(e) => setUseGoogleSearch(e.target.checked)}
                  className="rounded border-slate-300 text-[#0052FF]"
                />
                <span>Google検索併用</span>
              </label>
            )}

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
                className="rounded border-slate-300 text-[#0052FF]"
              />
              <span>検証結果をコンテキストに含める</span>
            </label>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClearChat}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>履歴クリア</span>
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Message Thread */}
        <div className="h-[380px] overflow-y-auto p-5 space-y-4 bg-slate-50/50">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto space-y-4">
              <Sparkles className="w-6 h-6 text-[#0052FF]" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900">
                  検証結果や Base の出金仕様について質問できます
                </p>
                <p className="text-xs text-slate-500">
                  会話履歴を保持し、実測中のヘッド・出金データ・Google Search Grounding を組み合わせて回答します。
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  'L2ブロックがFinalizedなのにL1で出金完了にならない理由は？',
                  '現在検証中のデータと出金状況を要約して',
                  'Baseの最新のFault Proof / 出金待機時間の公式仕様を調べて',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => handleSendChat(prompt)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors cursor-pointer"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed space-y-2 ${
                    msg.role === 'user'
                      ? 'bg-[#0052FF] text-white'
                      : 'bg-white border border-slate-200 text-slate-800'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {msg.role === 'model' &&
                    msg.groundingSources &&
                    msg.groundingSources.length > 0 && (
                      <div className="pt-2 border-t border-slate-100 space-y-1">
                        <div className="text-[11px] font-semibold text-slate-500">
                          参照元 (Google Search)
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {msg.groundingSources.map((src) => (
                            <a
                              key={src.uri}
                              href={src.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-[#0052FF] hover:underline"
                            >
                              <span className="truncate max-w-[220px]">{src.title}</span>
                              <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              </div>
            ))
          )}

          {isSending && (
            <div className="flex justify-start">
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-500 flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#0052FF]" />
                <span>回答を生成中...</span>
              </div>
            </div>
          )}

          <div ref={threadEndRef} />
        </div>

        {chatError && (
          <div className="px-5 py-2.5 bg-red-50 border-t border-red-200 text-xs text-red-700">
            エラー: {chatError}
          </div>
        )}

        {/* Chat Input Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendChat();
          }}
          className="p-4 border-t border-slate-200 bg-white flex gap-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Baseのファイナライズ、出金証明、L1/L2状態について質問を入力..."
            disabled={isSending}
            className="flex-1 px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim()}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Send className="w-4 h-4" />
            <span>送信</span>
          </button>
        </form>
      </section>
    </div>
  );
}
