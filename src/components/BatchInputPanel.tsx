import React, { useRef, useState } from 'react';
import { Upload, Play, Trash2, RefreshCw, ListFilter } from 'lucide-react';
import { NetworkId, ParsedHashBatch } from '../types/finality';

interface BatchInputPanelProps {
  rawInput: string;
  onRawInputChange: (value: string) => void;
  parsed: ParsedHashBatch;
  networkId: NetworkId;
  onNetworkChange: (id: NetworkId) => void;
  customRpcUrl: string;
  onCustomRpcUrlChange: (url: string) => void;
  isVerifying: boolean;
  progress: { completed: number; total: number; phase: string } | null;
  onVerify: () => void;
  onClear: () => void;
  autoPollEnabled: boolean;
  onToggleAutoPoll: () => void;
  autoPollCountdown: number;
  hasResults: boolean;
  onLoadWithdrawalSamples: () => void;
  isLoadingWithdrawalSamples: boolean;
  cachedHitCount: number;
  totalSavedCacheCount: number;
  onClearFinalizedCache: () => void;
  onForceRefreshAll: () => void;
}

export function BatchInputPanel({
  rawInput,
  onRawInputChange,
  parsed,
  networkId,
  onNetworkChange,
  customRpcUrl,
  onCustomRpcUrlChange,
  isVerifying,
  progress,
  onVerify,
  onClear,
  autoPollEnabled,
  onToggleAutoPoll,
  autoPollCountdown,
  hasResults,
  onLoadWithdrawalSamples,
  isLoadingWithdrawalSamples,
  cachedHitCount,
  totalSavedCacheCount,
  onClearFinalizedCache,
  onForceRefreshAll,
}: BatchInputPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileRead = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const merged = rawInput.trim()
          ? `${rawInput.trim()}\n${reader.result}`
          : reader.result;
        onRawInputChange(merged);
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileRead(file);
    }
  };

  const totalActionable = parsed.validHashes.length + parsed.invalidTokens.length;

  return (
    <section
      aria-label="一括トランザクションハッシュ入力"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6"
    >
      {/* Top Workspace Toolbar: Network + Auto-poll */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-slate-500 whitespace-nowrap">
            対象ネットワーク
          </span>
          <div
            role="group"
            aria-label="ネットワーク選択"
            className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            <button
              type="button"
              onClick={() => onNetworkChange('base-mainnet')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                networkId === 'base-mainnet'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Base Mainnet
            </button>
            <button
              type="button"
              onClick={() => onNetworkChange('base-sepolia')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                networkId === 'base-sepolia'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Base Sepolia
            </button>
            <button
              type="button"
              onClick={() => onNetworkChange('custom')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                networkId === 'custom'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              カスタムRPC
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onToggleAutoPoll}
            disabled={!hasResults && !autoPollEnabled}
            className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
              autoPollEnabled
                ? 'bg-blue-50 text-[#0052FF] border-blue-200'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoPollEnabled ? 'animate-spin' : ''}`} />
            <span>
              {autoPollEnabled
                ? `自動再検証オン (${autoPollCountdown}s)`
                : '15秒ごとの自動再検証'}
            </span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.csv,.json,.log"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleFileRead(file);
                e.target.value = '';
              }
            }}
          />
          <button
            type="button"
            onClick={onLoadWithdrawalSamples}
            disabled={isLoadingWithdrawalSamples || isVerifying}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingWithdrawalSamples ? 'animate-spin' : ''}`} />
            <span>{isLoadingWithdrawalSamples ? '出金Tx検索中...' : '出金Txサンプル読込'}</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>CSV / JSON / TXT読込</span>
          </button>
        </div>
      </div>

      {/* Custom RPC Input Row */}
      {networkId === 'custom' && (
        <div className="mt-4">
          <label
            htmlFor="custom-rpc-input"
            className="block text-xs font-medium text-slate-700 mb-1.5"
          >
            カスタム Base L2 ノード JSON-RPC URL (op-geth / op-node互換)
          </label>
          <input
            id="custom-rpc-input"
            type="url"
            value={customRpcUrl}
            onChange={(e) => onCustomRpcUrlChange(e.target.value)}
            placeholder="https://mainnet.base.org"
            className="w-full px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF] focus:border-transparent"
          />
        </div>
      )}

      {/* Batch Textarea with Drag & Drop */}
      <div
        className="mt-4 relative"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <label htmlFor="tx-batch-input" className="sr-only">
          トランザクションハッシュ一括入力
        </label>
        <textarea
          id="tx-batch-input"
          rows={5}
          value={rawInput}
          onChange={(e) => onRawInputChange(e.target.value)}
          placeholder={`Baseのトランザクションハッシュ (0x...) を改行・カンマ・スペース区切りで一括貼り付け\nBasescanのURL (https://basescan.org/tx/0x...) やJSON / CSVファイルのドロップにも対応しています`}
          className={`w-full px-4 py-3 text-sm font-mono leading-relaxed bg-slate-50 border rounded-lg text-slate-900 placeholder:text-slate-400 placeholder:font-sans focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF] focus:border-transparent transition-colors resize-y ${
            isDragging ? 'border-[#0052FF] bg-blue-50/40' : 'border-slate-200'
          }`}
        />
      </div>

      {/* Bottom Action Bar */}
      <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        {/* Clean unboxed typographic metadata */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
          <span>
            有効ハッシュ:{' '}
            <strong className="font-semibold text-slate-900">
              {parsed.validHashes.length.toLocaleString()}件
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>重複除外: {parsed.duplicateCount.toLocaleString()}件</span>
          <span aria-hidden="true">·</span>
          <span className={parsed.invalidTokens.length > 0 ? 'text-red-600 font-medium' : ''}>
            形式不正: {parsed.invalidTokens.length.toLocaleString()}件
          </span>
          {cachedHitCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-700 font-medium">
                ローカル確定済キャッシュ: {cachedHitCount.toLocaleString()}件 (RPC新規対象:{' '}
                {Math.max(0, parsed.validHashes.length - cachedHitCount).toLocaleString()}件)
              </span>
            </>
          )}
          {totalSavedCacheCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onClearFinalizedCache}
                disabled={isVerifying}
                className="text-slate-500 hover:text-red-700 underline cursor-pointer disabled:opacity-50"
                title={`このネットワークでローカル保存済みのFinalizedトランザクション (${totalSavedCacheCount}件) を削除します`}
              >
                確定キャッシュ削除 ({totalSavedCacheCount}件)
              </button>
            </>
          )}
          {progress && isVerifying && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[#0052FF] font-medium">{progress.phase}</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
          {parsed.validHashes.length > 0 &&
            (parsed.duplicateCount > 0 ||
              parsed.invalidTokens.length > 0 ||
              rawInput.trim().startsWith('{') ||
              rawInput.trim().startsWith('[')) && (
              <button
                type="button"
                onClick={() => onRawInputChange(parsed.validHashes.join('\n'))}
                disabled={isVerifying}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <ListFilter className="w-3.5 h-3.5" />
                <span>重複・JSONを整理</span>
              </button>
            )}

          {rawInput.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              disabled={isVerifying}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              <span>クリア</span>
            </button>
          )}

          {cachedHitCount > 0 && (
            <button
              type="button"
              onClick={onForceRefreshAll}
              disabled={isVerifying || totalActionable === 0 || (networkId === 'custom' && !customRpcUrl.trim())}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              title="ローカル保存済みのFinalized結果を使わず、全件をRPCから再取得します"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>全件RPC再取得</span>
            </button>
          )}

          <button
            type="button"
            onClick={onVerify}
            disabled={isVerifying || totalActionable === 0 || (networkId === 'custom' && !customRpcUrl.trim())}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0052FF]"
          >
            {isVerifying ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>検証中...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {cachedHitCount > 0
                    ? `未取得・未確定のみ検証 (${Math.max(0, totalActionable - cachedHitCount)}件 + キャッシュ${cachedHitCount}件)`
                    : `オンチェーン一括検証 (${totalActionable}件)`}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
