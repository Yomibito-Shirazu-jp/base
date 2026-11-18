import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  Layers,
  Clock,
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileJson,
  Search,
  ExternalLink,
  ChevronRight,
  XCircle,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  ReliabilityTier,
  VerifiedTransactionResult,
} from '../types/finality';
import {
  buildTsvSummary,
  exportResultsAsCsv,
  exportResultsAsJson,
  formatDurationRough,
  formatUnixTimestamp,
  shortenHex,
} from '../lib/exportUtils';
import {
  formatSecondsJapanese,
  getWithdrawalProveDisplayMeta,
  getWithdrawalStatusLabel,
} from '../lib/withdrawalAnalyzer';

type FilterMode = 'all' | 'finalized' | 'safe' | 'unsafe_pending' | 'withdrawals' | 'reverted' | 'errors';

interface VerificationTableProps {
  results: VerifiedTransactionResult[];
  snapshot: ChainHeadSnapshot | null;
  explorerUrl: string;
  isVerifying: boolean;
  isRetryingErrors?: boolean;
  selectedHash: string | null;
  lastRunCacheStats?: { reusedFromLocal: number; fetchedFromRpc: number } | null;
  onSelectResult: (result: VerifiedTransactionResult) => void;
  onLoadLiveSamples: () => void;
  onRetryErrors?: (hashes: string[]) => void;
}

export function VerificationTable({
  results,
  snapshot,
  explorerUrl,
  isVerifying,
  isRetryingErrors = false,
  selectedHash,
  lastRunCacheStats = null,
  onSelectResult,
  onLoadLiveSamples,
  onRetryErrors,
}: VerificationTableProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const retryableHashes = useMemo(
    () =>
      results
        .filter(
          (r) =>
            r.finality === FinalityStage.RPC_ERROR ||
            r.finality === FinalityStage.NOT_FOUND
        )
        .map((r) => r.hash),
    [results]
  );

  const hasActiveWithdrawalCountdown = useMemo(
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
    if (!hasActiveWithdrawalCountdown) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveWithdrawalCountdown]);

  const counts = useMemo(() => {
    let finalized = 0;
    let safe = 0;
    let unsafeOrPending = 0;
    let withdrawals = 0;
    let reverted = 0;
    let errors = 0;

    for (const r of results) {
      if (r.withdrawal) withdrawals += 1;
      if (r.finality === FinalityStage.FINALIZED) finalized += 1;
      else if (r.finality === FinalityStage.SAFE) safe += 1;
      else if (
        r.finality === FinalityStage.UNSAFE ||
        r.finality === FinalityStage.PENDING
      ) {
        unsafeOrPending += 1;
      } else {
        errors += 1;
      }

      if (r.executionStatus === ExecutionStatus.REVERTED) {
        reverted += 1;
      }
    }

    return {
      total: results.length,
      finalized,
      safe,
      unsafeOrPending,
      withdrawals,
      reverted,
      errors,
    };
  }, [results]);

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return results.filter((r) => {
      if (filterMode === 'finalized' && r.finality !== FinalityStage.FINALIZED) return false;
      if (filterMode === 'safe' && r.finality !== FinalityStage.SAFE) return false;
      if (
        filterMode === 'unsafe_pending' &&
        r.finality !== FinalityStage.UNSAFE &&
        r.finality !== FinalityStage.PENDING
      ) {
        return false;
      }
      if (filterMode === 'withdrawals' && !r.withdrawal) {
        return false;
      }
      if (filterMode === 'reverted' && r.executionStatus !== ExecutionStatus.REVERTED) {
        return false;
      }
      if (
        filterMode === 'errors' &&
        r.finality !== FinalityStage.NOT_FOUND &&
        r.finality !== FinalityStage.INVALID &&
        r.finality !== FinalityStage.RPC_ERROR
      ) {
        return false;
      }

      if (!q) return true;
      return (
        r.hash.toLowerCase().includes(q) ||
        (r.blockNumber !== null && String(r.blockNumber).includes(q)) ||
        (r.from && r.from.toLowerCase().includes(q)) ||
        (r.to && r.to.toLowerCase().includes(q)) ||
        (r.withdrawal && r.withdrawal.assetSymbol.toLowerCase().includes(q))
      );
    });
  }, [results, filterMode, searchQuery]);

  const handleCopyHash = async (hash: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 1500);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleCopyTsv = async () => {
    if (!snapshot || results.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildTsvSummary(filteredResults, snapshot));
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 1800);
    } catch {
      // Ignore
    }
  };

  const renderFinalityCell = (row: VerifiedTransactionResult) => {
    if (row.withdrawal) {
      const proveMeta = getWithdrawalProveDisplayMeta(row.withdrawal);
      if (row.withdrawal.portalFinalized) {
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Prove済 ✓ · L1出金完了</span>
          </span>
        );
      }
      const l2StageText =
        row.finality === FinalityStage.FINALIZED
          ? 'L2確定'
          : row.finality === FinalityStage.SAFE
          ? 'L2 Safe'
          : 'L2 Unsafe';

      if (proveMeta.isProven) {
        return (
          <span
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap"
            title={proveMeta.headline}
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{l2StageText} · {proveMeta.shortBadge}</span>
          </span>
        );
      }

      return (
        <span
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap"
          title={proveMeta.headline}
        >
          <Clock className="w-4 h-4 shrink-0" />
          <span>{l2StageText} · {proveMeta.shortBadge}</span>
        </span>
      );
    }

    switch (row.finality) {
      case FinalityStage.FINALIZED:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Finalized (L2確定)</span>
          </span>
        );
      case FinalityStage.SAFE:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 whitespace-nowrap">
            <Layers className="w-4 h-4 shrink-0" />
            <span>Safe (L1バッチ済)</span>
          </span>
        );
      case FinalityStage.UNSAFE:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
            <Clock className="w-4 h-4 shrink-0" />
            <span>Unsafe (L2承認のみ)</span>
          </span>
        );
      case FinalityStage.PENDING:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
            <Clock className="w-4 h-4 shrink-0" />
            <span>Pending (待機中)</span>
          </span>
        );
      case FinalityStage.NOT_FOUND:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Not Found (未検出)</span>
          </span>
        );
      case FinalityStage.INVALID:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>Invalid (形式不正)</span>
          </span>
        );
      case FinalityStage.RPC_ERROR:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>RPC Error</span>
          </span>
        );
    }
  };

  const renderExecutionCell = (status: ExecutionStatus) => {
    switch (status) {
      case ExecutionStatus.SUCCESS:
        return <span className="text-xs font-medium text-emerald-700">Success</span>;
      case ExecutionStatus.REVERTED:
        return <span className="text-xs font-semibold text-red-700">Reverted</span>;
      case ExecutionStatus.PENDING:
        return <span className="text-xs text-amber-700">Pending</span>;
      case ExecutionStatus.UNKNOWN:
        return <span className="text-xs text-slate-400">—</span>;
    }
  };

  const renderReliabilityCell = (row: VerifiedTransactionResult) => {
    const tier: ReliabilityTier = row.reliability?.tier ?? 'partial';
    const label = row.reliability?.label ?? '検証済み';
    const tooltip = row.reliability?.caveat || row.reliability?.basis?.join(' / ') || label;

    if (tier === 'verified_onchain') {
      return (
        <span
          className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap"
          title={tooltip}
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
          title={tooltip}
        >
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>{label}</span>
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap"
        title={tooltip}
      >
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </span>
    );
  };

  // Loading Skeleton State (initial run)
  if (isVerifying && results.length === 0) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="h-4 w-48 bg-slate-200 rounded animate-pulse" />
          <div className="h-4 w-32 bg-slate-100 rounded animate-pulse" />
        </div>
        <div className="divide-y divide-slate-100">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="px-5 py-3 flex items-center justify-between gap-4">
              <div className="h-4 w-64 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-32 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-28 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Empty State
  if (results.length === 0) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl px-6 py-14 text-center">
        <div className="max-w-lg mx-auto">
          <h2 className="text-base font-semibold text-slate-900">
            オンチェーン・ファイナライズ検証結果がここに表示されます
          </h2>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            上部の入力エリアにBaseのトランザクションハッシュを一括入力して検証を実行すると、
            L2ノードの <span className="font-mono text-slate-800">finalized</span> /{' '}
            <span className="font-mono text-slate-800">safe</span> /{' '}
            <span className="font-mono text-slate-800">latest</span>{' '}
            ブロックと直接照合し、L1確定状態・L1 Origin・手数料を一括出力します。
          </p>
          <div className="mt-6">
            <button
              type="button"
              onClick={onLoadLiveSamples}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0052FF] hover:bg-blue-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              最新Txサンプルを取得して試す
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="検証結果一覧" className="space-y-4">
      {/* 4-column summary strip */}
      <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-100">
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">検証済み合計</div>
          <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {counts.total.toLocaleString()}
            <span className="text-xs font-sans font-normal text-slate-500 ml-1">件</span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-emerald-700">Finalized (L1確定済み)</div>
          <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
            {counts.finalized.toLocaleString()}
            <span className="text-xs font-sans font-normal text-slate-500 ml-1">
              ({counts.total > 0 ? Math.round((counts.finalized / counts.total) * 100) : 0}%)
            </span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-sky-700">Safe (L1バッチ投稿済)</div>
          <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-sky-700">
            {counts.safe.toLocaleString()}
            <span className="text-xs font-sans font-normal text-slate-500 ml-1">件</span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-600">Unsafe / 未検出・エラー</div>
          <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {(counts.unsafeOrPending + counts.errors).toLocaleString()}
            <span className="text-xs font-sans font-normal text-slate-500 ml-1">
              (Reverted: {counts.reverted})
            </span>
          </div>
        </div>
      </div>

      {lastRunCacheStats && lastRunCacheStats.reusedFromLocal > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span>
            ローカル保存データ参照:{' '}
            <strong className="font-semibold text-emerald-700">
              {lastRunCacheStats.reusedFromLocal.toLocaleString()}件
            </strong>{' '}
            (Finalized確定済みのためRPCスキップ) · 新規RPC取得:{' '}
            <strong className="font-semibold text-slate-900">
              {lastRunCacheStats.fetchedFromRpc.toLocaleString()}件
            </strong>
          </span>
          <span className="text-slate-500">
            変更がない確定済みハッシュはローカルデータから即時復元されます
          </span>
        </div>
      )}

      {/* Main Data Grid Container */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Filter + Search + Export Bar */}
        <div className="p-4 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          {/* Interactive filter tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterMode === 'all'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              すべて ({counts.total})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('finalized')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterMode === 'finalized'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Finalized ({counts.finalized})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('safe')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterMode === 'safe'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Safe ({counts.safe})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('unsafe_pending')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterMode === 'unsafe_pending'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Unsafe / 待機 ({counts.unsafeOrPending})
            </button>
            {counts.withdrawals > 0 && (
              <button
                type="button"
                onClick={() => setFilterMode('withdrawals')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  filterMode === 'withdrawals'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                出金Tx ({counts.withdrawals})
              </button>
            )}
            {counts.reverted > 0 && (
              <button
                type="button"
                onClick={() => setFilterMode('reverted')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  filterMode === 'reverted'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Reverted ({counts.reverted})
              </button>
            )}
            {counts.errors > 0 && (
              <button
                type="button"
                onClick={() => setFilterMode('errors')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  filterMode === 'errors'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                未検出 / エラー ({counts.errors})
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {retryableHashes.length > 0 && onRetryErrors && (
              <button
                type="button"
                onClick={() => onRetryErrors(retryableHashes)}
                disabled={isRetryingErrors || isVerifying}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isRetryingErrors ? 'animate-spin' : ''}`}
                />
                <span>
                  {isRetryingErrors
                    ? 'エラー項目を再検証中...'
                    : `エラー/未検出のみ再実行 (${retryableHashes.length}件)`}
                </span>
              </button>
            )}

            {/* Search Input */}
            <div className="relative flex-1 sm:flex-initial">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ハッシュ / ブロック / アドレス検索"
                className="w-full sm:w-56 pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
              />
            </div>

            <button
              type="button"
              onClick={handleCopyTsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedSummary ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>コピー済</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>TSVコピー</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => snapshot && exportResultsAsCsv(filteredResults, snapshot)}
              disabled={!snapshot}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV出力</span>
            </button>

            <button
              type="button"
              onClick={() => snapshot && exportResultsAsJson(filteredResults, snapshot)}
              disabled={!snapshot}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <FileJson className="w-3.5 h-3.5" />
              <span>JSON証拠</span>
            </button>
          </div>
        </div>

        {/* High-Density Data Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 pl-4 pr-2 w-10 text-right tabular-nums">#</th>
                <th className="py-2.5 px-3">トランザクションハッシュ</th>
                <th className="py-2.5 px-3">ファイナリティ状態</th>
                <th className="py-2.5 px-3">実行結果</th>
                <th className="py-2.5 px-3 text-right">L2 Block</th>
                <th className="py-2.5 px-3">時刻 (ローカル)</th>
                <th className="py-2.5 px-3 text-right">金額 / 出金額</th>
                <th className="py-2.5 px-3 text-right">出金可能残り時間</th>
                <th className="py-2.5 px-3 text-right">確定 / 残りブロック</th>
                <th className="py-2.5 px-3 text-right">合計手数料</th>
                <th className="py-2.5 px-3">情報の信頼性</th>
                <th className="py-2.5 pl-2 pr-4 w-10 text-right">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-sm text-slate-500">
                    現在のフィルタ条件に一致するトランザクションはありません
                  </td>
                </tr>
              ) : (
                filteredResults.map((row) => {
                  const isSelected = selectedHash === row.hash;
                  const isValidHexHash = /^0x[0-9a-fA-F]{64}$/.test(row.hash);

                  return (
                    <tr
                      key={`${row.index}-${row.hash}`}
                      onClick={() => onSelectResult(row)}
                      className={`h-11 transition-colors cursor-pointer ${
                        isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50/90'
                      }`}
                    >
                      <td className="py-2 pl-4 pr-2 text-right font-mono tabular-nums text-slate-400">
                        {row.index}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="font-mono text-slate-900 font-medium"
                            title={row.hash}
                          >
                            {shortenHex(row.hash, 10, 8)}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => handleCopyHash(row.hash, e)}
                            aria-label="ハッシュをコピー"
                            className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                          >
                            {copiedHash === row.hash ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          {isValidHexHash && explorerUrl && (
                            <a
                              href={`${explorerUrl}/tx/${row.hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Basescanで確認"
                              className="p-1 text-slate-400 hover:text-[#0052FF] rounded"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-3">{renderFinalityCell(row)}</td>
                      <td className="py-2 px-3">{renderExecutionCell(row.executionStatus)}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                        {row.blockNumber !== null ? `#${row.blockNumber.toLocaleString()}` : '—'}
                      </td>
                      <td className="py-2 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatUnixTimestamp(row.blockTimestamp)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {row.withdrawal ? (
                          <span className="font-semibold text-slate-900">
                            {row.withdrawal.amountFormatted} {row.withdrawal.assetSymbol}
                          </span>
                        ) : row.valueEth && row.valueEth !== '0' ? (
                          <span className="text-slate-700">{row.valueEth} ETH</span>
                        ) : (
                          <span className="text-slate-400">0 ETH</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {row.withdrawal ? (
                          row.withdrawal.status === 'finalized' ? (
                            <span className="text-emerald-700 font-semibold">
                              Prove済 · 受取完了
                            </span>
                          ) : row.withdrawal.status === 'ready-to-finalize' ? (
                            <span className="text-emerald-700 font-semibold">
                              Prove済 ✓ · 0秒 (受取可)
                            </span>
                          ) : (
                            <div>
                              <span
                                className="text-amber-700 font-medium"
                                title={getWithdrawalStatusLabel(row.withdrawal.status)}
                              >
                                {row.withdrawal.estimatedClaimableAtMs
                                  ? formatSecondsJapanese(
                                      Math.max(
                                        0,
                                        Math.ceil(
                                          (row.withdrawal.estimatedClaimableAtMs - nowMs) / 1000
                                        )
                                      )
                                    )
                                  : formatSecondsJapanese(row.withdrawal.totalSecondsRemaining)}
                              </span>
                              <div
                                className={`text-[10px] font-sans font-semibold ${
                                  getWithdrawalProveDisplayMeta(row.withdrawal).isProven
                                    ? 'text-emerald-700'
                                    : 'text-amber-700'
                                }`}
                              >
                                {getWithdrawalProveDisplayMeta(row.withdrawal).shortBadge}
                              </div>
                            </div>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {row.finality === FinalityStage.FINALIZED && row.confirmations !== null ? (
                          <span className="text-slate-700">
                            {row.confirmations.toLocaleString()} conf
                          </span>
                        ) : row.blocksToFinalized !== null && row.blocksToFinalized > 0 ? (
                          <span className="text-amber-700">
                            あと {row.blocksToFinalized.toLocaleString()} blk (
                            {formatDurationRough(row.blocksToFinalized)})
                          </span>
                        ) : row.errorReason ? (
                          <span className="text-red-600 font-sans truncate max-w-[180px] inline-block align-bottom">
                            {row.errorReason}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.totalFeeEth !== null ? `${row.totalFeeEth} ETH` : '—'}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {renderReliabilityCell(row)}
                      </td>
                      <td className="py-2 pl-2 pr-4 text-right">
                        <ChevronRight className="w-4 h-4 text-slate-400 inline-block" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
