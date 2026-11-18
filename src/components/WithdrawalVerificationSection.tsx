import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  ListFilter,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ChainHeadSnapshot,
  NetworkConfig,
  ParsedHashBatch,
  ReliabilityTier,
  VerifiedTransactionResult,
} from '../types/finality';
import {
  exportResultsAsCsv,
  exportResultsAsJson,
  formatUnixTimestamp,
  shortenHex,
} from '../lib/exportUtils';
import { isPartiallyFetchedOrBrokenResult } from '../lib/finalizedCache';
import {
  formatSecondsJapanese,
  getWithdrawalProveDisplayMeta,
  getWithdrawalStatusLabel,
} from '../lib/withdrawalAnalyzer';
import { WithdrawalAddressCheckPanel } from './WithdrawalAddressCheckPanel';

type WithdrawalFilter =
  | 'all'
  | 'unproven'
  | 'proven_waiting'
  | 'ready'
  | 'claimed'
  | 'other_or_error';

interface WithdrawalVerificationSectionProps {
  rawInput: string;
  onRawInputChange: (val: string) => void;
  parsed: ParsedHashBatch;
  results: VerifiedTransactionResult[];
  snapshot: ChainHeadSnapshot | null;
  networkConfig: NetworkConfig;
  isVerifying: boolean;
  isRetryingErrors: boolean;
  isLoadingSamples: boolean;
  progress: { completed: number; total: number; phase: string } | null;
  verifyError: string | null;
  selectedHash: string | null;
  batchWithdrawalCount: number;
  onVerify: () => void;
  onClear: () => void;
  onFetchRecentWithdrawals: () => void;
  onImportFromBatch: () => void;
  onRetryErrors: (hashes: string[]) => void;
  onSelectResult: (row: VerifiedTransactionResult) => void;
  onOpenInSimulator: (txHash: string) => void;
}

function renderReliabilityText(row: VerifiedTransactionResult) {
  const tier: ReliabilityTier = row.reliability?.tier ?? 'partial';
  const label = row.reliability?.label ?? '検証済み';
  const caveat = row.reliability?.caveat;

  if (tier === 'verified_onchain') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap"
        title={row.reliability?.basis?.join(' / ') ?? label}
      >
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  if (tier === 'estimated_pending') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 whitespace-nowrap"
        title={caveat ?? label}
      >
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap"
      title={caveat ?? label}
    >
      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function WithdrawalVerificationSection({
  rawInput,
  onRawInputChange,
  parsed,
  results,
  snapshot,
  networkConfig,
  isVerifying,
  isRetryingErrors,
  isLoadingSamples,
  progress,
  verifyError,
  selectedHash,
  batchWithdrawalCount,
  onVerify,
  onClear,
  onFetchRecentWithdrawals,
  onImportFromBatch,
  onRetryErrors,
  onSelectResult,
  onOpenInSimulator,
}: WithdrawalVerificationSectionProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [filterMode, setFilterMode] = useState<WithdrawalFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasActiveCountdown = useMemo(
    () =>
      results.some(
        (r) =>
          r.withdrawal &&
          r.withdrawal.status !== 'ready-to-finalize' &&
          r.withdrawal.status !== 'finalized'
      ),
    [results]
  );

  useEffect(() => {
    if (!hasActiveCountdown) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveCountdown]);

  const retryableHashes = useMemo(
    () => results.filter(isPartiallyFetchedOrBrokenResult).map((r) => r.hash),
    [results]
  );

  const counts = useMemo(() => {
    let claimed = 0;
    let ready = 0;
    let provenWaiting = 0;
    let unproven = 0;
    let otherOrError = 0;

    for (const r of results) {
      if (isPartiallyFetchedOrBrokenResult(r) || !r.withdrawal) {
        otherOrError += 1;
      } else {
        const meta = getWithdrawalProveDisplayMeta(r.withdrawal);
        if (meta.stateKind === 'finalized') {
          claimed += 1;
        } else if (r.withdrawal.status === 'ready-to-finalize') {
          ready += 1;
        } else if (meta.isProven) {
          provenWaiting += 1;
        } else {
          unproven += 1;
        }
      }
    }

    return {
      total: results.length,
      claimed,
      ready,
      provenWaiting,
      unproven,
      otherOrError,
    };
  }, [results]);

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return results.filter((r) => {
      if (filterMode === 'claimed') {
        if (!r.withdrawal || isPartiallyFetchedOrBrokenResult(r)) return false;
        if (getWithdrawalProveDisplayMeta(r.withdrawal).stateKind !== 'finalized') {
          return false;
        }
      } else if (filterMode === 'ready') {
        if (
          !r.withdrawal ||
          isPartiallyFetchedOrBrokenResult(r) ||
          r.withdrawal.status !== 'ready-to-finalize'
        ) {
          return false;
        }
      } else if (filterMode === 'proven_waiting') {
        if (!r.withdrawal || isPartiallyFetchedOrBrokenResult(r)) return false;
        const meta = getWithdrawalProveDisplayMeta(r.withdrawal);
        if (
          !meta.isProven ||
          meta.stateKind === 'finalized' ||
          r.withdrawal.status === 'ready-to-finalize'
        ) {
          return false;
        }
      } else if (filterMode === 'unproven') {
        if (!r.withdrawal || isPartiallyFetchedOrBrokenResult(r)) return false;
        const meta = getWithdrawalProveDisplayMeta(r.withdrawal);
        if (meta.isProven) return false;
      } else if (filterMode === 'other_or_error') {
        if (!isPartiallyFetchedOrBrokenResult(r) && r.withdrawal !== null) return false;
      }

      if (!q) return true;
      return (
        r.hash.toLowerCase().includes(q) ||
        (r.withdrawal?.l1Recipient?.toLowerCase().includes(q) ?? false) ||
        (r.withdrawal?.assetSymbol?.toLowerCase().includes(q) ?? false) ||
        (r.blockNumber !== null && String(r.blockNumber).includes(q))
      );
    });
  }, [results, filterMode, searchQuery]);

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

  const handleCopyHash = async (hash: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 1500);
    } catch {
      // Ignore
    }
  };

  const totalActionable = parsed.validHashes.length + parsed.invalidTokens.length;

  return (
    <div className="space-y-6">
      {/* Input & Provenance Header Panel */}
      <section
        aria-label="L2→L1 出金一括検証入力"
        className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              L2 → L1 出金トランザクション専用・一括検証
            </h2>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Base の <span className="font-mono text-slate-800">L2ToL1MessagePasser</span>{' '}
              と Ethereum L1 の{' '}
              <span className="font-mono text-slate-800">OptimismPortal2</span> /{' '}
              <span className="font-mono text-slate-800">AggregateVerifier</span>{' '}
              を直接照会し、<strong>TEE / ZK 証明状態（単一5日 / 両方1日）</strong>・2段階シミュレーション・<strong>資金受け取り可否</strong>を一括判定します。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {batchWithdrawalCount > 0 && (
              <button
                type="button"
                onClick={onImportFromBatch}
                disabled={isVerifying}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0052FF] bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <span>一括検証タブから出金Tx取込 ({batchWithdrawalCount}件)</span>
              </button>
            )}

            <button
              type="button"
              onClick={onFetchRecentWithdrawals}
              disabled={isLoadingSamples || isVerifying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSamples ? 'animate-spin' : ''}`} />
              <span>{isLoadingSamples ? '出金Tx検索中...' : '直近の出金Txを自動取得'}</span>
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
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>ファイル読込</span>
            </button>
          </div>
        </div>

        <div
          className="relative"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFileRead(file);
          }}
        >
          <label htmlFor="withdrawal-batch-input" className="sr-only">
            出金トランザクションハッシュ入力
          </label>
          <textarea
            id="withdrawal-batch-input"
            rows={4}
            value={rawInput}
            onChange={(e) => onRawInputChange(e.target.value)}
            placeholder={`出金 (Bridge / Withdraw) を行った Base トランザクションハッシュ (0x...) を改行・カンマ・JSON形式で貼り付け\n「直近の出金Txを自動取得」を押すとオンチェーンの最新出金履歴を読み込んで検証できます`}
            className={`w-full px-4 py-3 text-sm font-mono leading-relaxed bg-slate-50 border rounded-lg text-slate-900 placeholder:text-slate-400 placeholder:font-sans focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF] focus:border-transparent transition-colors resize-y ${
              isDragging ? 'border-[#0052FF] bg-blue-50/40' : 'border-slate-200'
            }`}
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
            <span>
              対象ネットワーク: <strong className="text-slate-900">{networkConfig.name}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              有効ハッシュ:{' '}
              <strong className="text-slate-900">
                {parsed.validHashes.length.toLocaleString()}件
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>重複除外: {parsed.duplicateCount.toLocaleString()}件</span>
            {progress && isVerifying && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#0052FF] font-medium">{progress.phase}</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {parsed.validHashes.length > 0 &&
              (parsed.duplicateCount > 0 ||
                parsed.invalidTokens.length > 0 ||
                rawInput.trim().startsWith('{') ||
                rawInput.trim().startsWith('[')) && (
                <button
                  type="button"
                  onClick={() => onRawInputChange(parsed.validHashes.join('\n'))}
                  disabled={isVerifying}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
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
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>クリア</span>
              </button>
            )}

            <button
              type="button"
              onClick={onVerify}
              disabled={isVerifying || totalActionable === 0 || networkConfig.rpcUrls.length === 0}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {isVerifying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>L1出金状態を検証中...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>出金を一括検証 ({totalActionable}件)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {verifyError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-xl px-4 py-3"
        >
          出金検証エラー: {verifyError}
        </div>
      )}

      {/* Results Area */}
      {results.length === 0 ? (
        <section className="bg-white border border-slate-200 rounded-xl px-6 py-14 text-center">
          <div className="max-w-xl mx-auto">
            <h3 className="text-base font-semibold text-slate-900">
              出金Txの L1 OptimismPortal2 照合結果がここに表示されます
            </h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              L1側で実際に資産を受け取るための <span className="font-mono text-slate-800">proveWithdrawalTransaction</span>{' '}
              および成熟待機後の <span className="font-mono text-slate-800">finalizeWithdrawalTransaction</span>{' '}
              シミュレーション、出金ゲームの <strong>TEE / ZK 証明チェック（単一証明5日・両方あり1日）</strong>、<strong>「資金を受け取る」</strong> 実行を行えます。
            </p>
            <div className="mt-6">
              <button
                type="button"
                onClick={onFetchRecentWithdrawals}
                disabled={isLoadingSamples || isVerifying}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0052FF] hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
              >
                直近のBase出金Txを取得して検証する
              </button>
            </div>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {/* 4-column Summary Strip separating 未Prove vs Prove済 vs 受取完了 */}
          <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-100">
            <div className="p-4">
              <div className="text-xs font-medium text-slate-500">検証済み合計</div>
              <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                {counts.total.toLocaleString()}
                <span className="text-xs font-sans font-normal text-slate-500 ml-1">
                  件{counts.otherOrError > 0 ? ` (未取得/非出金: ${counts.otherOrError})` : ''}
                </span>
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs font-medium text-amber-700">
                未Prove (出金証明 未提出)
              </div>
              <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
                {counts.unproven.toLocaleString()}
                <span className="text-xs font-sans font-normal text-slate-500 ml-1">
                  件 (要Prove)
                </span>
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs font-medium text-[#0052FF]">
                Prove済 ✓ (ロック待機 / 受取可)
              </div>
              <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                {(counts.provenWaiting + counts.ready).toLocaleString()}
                <span className="text-xs font-sans font-normal text-emerald-700 ml-1 font-semibold">
                  (即受取可: {counts.ready})
                </span>
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs font-medium text-emerald-700">
                Prove済 · L1資金受取完了
              </div>
              <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
                {counts.claimed.toLocaleString()}
                <span className="text-xs font-sans font-normal text-slate-500 ml-1">件</span>
              </div>
            </div>
          </div>

          {/* Data Provenance Line */}
          <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
              <span className="font-semibold text-slate-900">情報の信頼性・照合ソース:</span>
              <span className="font-mono text-slate-700">
                L2ToL1MessagePasser · L1 OptimismPortal2 · AggregateVerifier (TEE/ZK) 直接照合
              </span>
              <span aria-hidden="true">·</span>
              <span>外部インデクサー不使用</span>
            </div>
            <span className="text-slate-500">
              出金に無関係なL2ヘッド判定を除外し、OP Stack実コントラクト4要件のみを検証
            </span>
          </div>

          {/* Withdrawal Audit Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    filterMode === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  すべて ({counts.total})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('unproven')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    filterMode === 'unproven'
                      ? 'bg-white text-amber-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  未Prove ({counts.unproven})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('proven_waiting')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    filterMode === 'proven_waiting'
                      ? 'bg-white text-[#0052FF] shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Prove済・待機中 ({counts.provenWaiting})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('ready')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    filterMode === 'ready'
                      ? 'bg-white text-emerald-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Prove済・受取可 ({counts.ready})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('claimed')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    filterMode === 'claimed'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  資金受取完了 ({counts.claimed})
                </button>
                {counts.otherOrError > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilterMode('other_or_error')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                      filterMode === 'other_or_error'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    未取得 / 非出金 ({counts.otherOrError})
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {retryableHashes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onRetryErrors(retryableHashes)}
                    disabled={isRetryingErrors || isVerifying}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isRetryingErrors ? 'animate-spin' : ''}`}
                    />
                    <span>
                      {isRetryingErrors
                        ? '未取得項目を再取得中...'
                        : `未取得・部分照合のみ再取得 (${retryableHashes.length}件)`}
                    </span>
                  </button>
                )}

                <div className="relative flex-1 sm:flex-initial">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ハッシュ / 受取アドレス / 通貨"
                    className="w-full sm:w-52 pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => snapshot && exportResultsAsCsv(filteredResults, snapshot)}
                  disabled={!snapshot}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV出力</span>
                </button>

                <button
                  type="button"
                  onClick={() => snapshot && exportResultsAsJson(filteredResults, snapshot)}
                  disabled={!snapshot}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                >
                  <FileJson className="w-3.5 h-3.5" />
                  <span>JSON証拠</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 pl-4 pr-2 w-10 text-right tabular-nums">#</th>
                    <th className="py-2.5 px-3">L2 出金Txハッシュ</th>
                    <th className="py-2.5 px-3">L1 Prove (出金証明) 状態</th>
                    <th className="py-2.5 px-3">待機後の実出金検証</th>
                    <th className="py-2.5 px-3 text-right">出金額</th>
                    <th className="py-2.5 px-3 text-right">出金可能残り時間</th>
                    <th className="py-2.5 px-3">情報の信頼性</th>
                    <th className="py-2.5 pl-2 pr-4 text-right">L1実行 / 詳細</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredResults.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-sm text-slate-500">
                        該当する出金トランザクションはありません
                      </td>
                    </tr>
                  ) : (
                    filteredResults.map((row) => {
                      const w = row.withdrawal;
                      const val = w?.validation;
                      const proveMeta = w ? getWithdrawalProveDisplayMeta(w) : null;
                      const isSelected = selectedHash === row.hash;
                      const isValidHex = /^0x[0-9a-fA-F]{64}$/.test(row.hash);
                      const remainingSec = w
                        ? w.status === 'ready-to-finalize' || w.status === 'finalized'
                          ? 0
                          : w.estimatedClaimableAtMs
                          ? Math.max(0, Math.ceil((w.estimatedClaimableAtMs - nowMs) / 1000))
                          : w.totalSecondsRemaining
                        : null;

                      return (
                        <tr
                          key={`${row.index}-${row.hash}`}
                          onClick={() => onSelectResult(row)}
                          className={`h-12 transition-colors cursor-pointer ${
                            isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50/90'
                          }`}
                        >
                          <td className="py-2 pl-4 pr-2 text-right font-mono tabular-nums text-slate-400">
                            {row.index}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="font-mono font-medium text-slate-900"
                                title={row.hash}
                              >
                                {shortenHex(row.hash, 10, 8)}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => handleCopyHash(row.hash, e)}
                                aria-label="ハッシュコピー"
                                className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                              >
                                {copiedHash === row.hash ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                              {isValidHex && networkConfig.explorerUrl && (
                                <a
                                  href={`${networkConfig.explorerUrl}/tx/${row.hash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label="Basescanで表示"
                                  className="p-1 text-slate-400 hover:text-[#0052FF] rounded"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {w && proveMeta ? (
                              <div title={proveMeta.headline}>
                                <div className="flex items-center gap-1.5">
                                  {proveMeta.isProven ? (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                  ) : proveMeta.stateKind === 'reprove' ? (
                                    <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                  ) : (
                                    <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                  )}
                                  <span
                                    className={`font-bold ${
                                      proveMeta.isProven
                                        ? 'text-emerald-700'
                                        : proveMeta.stateKind === 'reprove'
                                        ? 'text-red-700'
                                        : 'text-amber-800'
                                    }`}
                                  >
                                    {proveMeta.isProven
                                      ? `Prove済 ✓${
                                          val && val.numProofSubmitters > 0
                                            ? ` (${val.numProofSubmitters}件)`
                                            : ''
                                        }`
                                      : proveMeta.stateKind === 'reprove'
                                      ? '要再Prove'
                                      : '未Prove (未提出)'}
                                  </span>
                                  {val?.l1ProveTxHash && networkConfig.l1ExplorerUrl && (
                                    <a
                                      href={`${networkConfig.l1ExplorerUrl}/tx/${val.l1ProveTxHash}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      title={`EtherscanでL1 Proveトランザクション (${val.l1ProveTxHash}) を確認`}
                                      className="inline-flex items-center gap-0.5 text-[10px] font-mono text-[#0052FF] hover:underline"
                                    >
                                      <span>ProveTx</span>
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                </div>
                                <div className="text-[11px] font-mono text-slate-600 mt-0.5">
                                  {getWithdrawalStatusLabel(w.status)}
                                  {val?.teeZk
                                    ? ` · ${
                                        val.teeZk.windowMode === 'dual-1d'
                                          ? 'TEE+ZK 1日枠'
                                          : '単一 5日枠'
                                      }`
                                    : ''}
                                </div>
                              </div>
                            ) : isPartiallyFetchedOrBrokenResult(row) ? (
                              <span className="text-amber-700 font-medium inline-flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>L1状態 未取得 (要再取得)</span>
                              </span>
                            ) : (
                              <span className="text-slate-500">出金イベントなし</span>
                            )}
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {w ? (
                              w.portalFinalized ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                  <span>出金完了済</span>
                                </span>
                              ) : val ? (
                                val.canWithdrawAfterWait ? (
                                  <div title={val.verdictSummary}>
                                    <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                                      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                                      <span>実測L1着金 PASS</span>
                                    </span>
                                    <div className="text-[10px] font-mono text-slate-500">
                                      MP={val.messagePasser.sentMessageRecorded ? 'true' : 'false'} ·{' '}
                                      {val.checks.filter((c) => c.passed).length}/{val.checks.length}合格
                                    </div>
                                  </div>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-red-700 font-semibold"
                                    title={val.verdictSummary}
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                    <span>
                                      {val.recipientBalanceIncreased === false
                                        ? `着金不可 (実測受取 0 ${w.assetSymbol})`
                                        : '着金不可 (阻害要因あり)'}
                                    </span>
                                  </span>
                                )
                              ) : (
                                <span className="text-amber-700 font-medium">L1未取得</span>
                              )
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                            {w ? (
                              <span className="font-semibold text-slate-900">
                                {w.amountFormatted} {w.assetSymbol}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                            {w ? (
                              w.portalFinalized ? (
                                <span className="text-emerald-700 font-semibold">完了済</span>
                              ) : remainingSec === 0 ? (
                                <span className="text-emerald-700 font-semibold">0秒 (即確定可)</span>
                              ) : (
                                <div>
                                  <div className="text-amber-700 font-semibold">
                                    {formatSecondsJapanese(remainingSec)}
                                  </div>
                                  {w.estimatedClaimableAtMs && (
                                    <div className="text-[10px] text-slate-400">
                                      {formatUnixTimestamp(Math.floor(w.estimatedClaimableAtMs / 1000))}
                                    </div>
                                  )}
                                </div>
                              )
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {renderReliabilityText(row)}
                          </td>
                          <td className="py-2 pl-2 pr-4 text-right whitespace-nowrap">
                            {w ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenInSimulator(row.hash);
                                }}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                                  w.portalFinalized
                                    ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                                    : w.status === 'ready-to-finalize'
                                    ? 'text-white bg-emerald-600 hover:bg-emerald-700'
                                    : w.status === 'ready-to-prove'
                                    ? 'text-white bg-[#0052FF] hover:bg-blue-700'
                                    : 'text-[#0052FF] bg-blue-50 hover:bg-blue-100'
                                }`}
                              >
                                <Play className="w-3 h-3 fill-current" />
                                <span>
                                  {w.portalFinalized
                                    ? '受取済・詳細'
                                    : w.status === 'ready-to-finalize'
                                    ? '資金を受け取る'
                                    : w.status === 'ready-to-prove'
                                    ? 'Prove・資金受取準備'
                                    : 'TEE/ZK・資金受取'}
                                </span>
                              </button>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* On-chain Withdrawal Recipient / Sender Batch Address Audit */}
      <WithdrawalAddressCheckPanel networkConfig={networkConfig} />
    </div>
  );
}
