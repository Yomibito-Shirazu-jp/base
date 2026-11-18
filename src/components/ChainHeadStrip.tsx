import { RefreshCw, ShieldCheck, Layers, Zap, Anchor } from 'lucide-react';
import { ChainHeadSnapshot } from '../types/finality';
import { formatUnixTimestamp, shortenHex } from '../lib/exportUtils';

interface ChainHeadStripProps {
  snapshot: ChainHeadSnapshot | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function ChainHeadStrip({
  snapshot,
  isLoading,
  error,
  onRefresh,
}: ChainHeadStripProps) {
  const safeLag =
    snapshot?.latest && snapshot?.safe
      ? Math.max(0, snapshot.latest.number - snapshot.safe.number)
      : null;

  const finalizedLag =
    snapshot?.latest && snapshot?.finalized
      ? Math.max(0, snapshot.latest.number - snapshot.finalized.number)
      : null;

  return (
    <section
      aria-label="オンチェーン最新ブロックヘッド"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-100">
        <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-600">
          <span className="font-semibold text-slate-900">
            オンチェーン・ヘッド基準値
          </span>
          {snapshot && (
            <>
              <span aria-hidden="true">·</span>
              <span>{snapshot.networkName}</span>
              {snapshot.chainId !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">Chain ID {snapshot.chainId}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-500 truncate max-w-[260px]">
                {snapshot.rpcEndpointUsed.startsWith('/api/rpc/')
                  ? 'Server RPC Proxy (L1/L2 Archive)'
                  : snapshot.rpcEndpointUsed}
              </span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>ヘッド更新</span>
        </button>
      </div>

      {error ? (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
          RPC接続エラー: {error}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4">
          {/* Finalized Head */}
          <div className="flex flex-col justify-between gap-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Finalized Head (L1確定)</span>
            </div>
            <div className="text-xl font-semibold font-mono tabular-nums text-slate-900">
              {snapshot?.finalized ? `#${snapshot.finalized.number.toLocaleString()}` : isLoading ? '読込中...' : '—'}
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {snapshot?.finalized
                ? `${formatUnixTimestamp(snapshot.finalized.timestamp)} · ${
                    finalizedLag !== null ? `Latest差 ${finalizedLag.toLocaleString()} blk` : ''
                  }`
                : 'Ethereum L1 コンセンサス確定'}
            </div>
          </div>

          {/* Safe Head */}
          <div className="flex flex-col justify-between gap-1.5 sm:border-l sm:border-slate-100 sm:pl-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700">
              <Layers className="w-4 h-4 shrink-0" />
              <span>Safe Head (L1バッチ済)</span>
            </div>
            <div className="text-xl font-semibold font-mono tabular-nums text-slate-900">
              {snapshot?.safe ? `#${snapshot.safe.number.toLocaleString()}` : isLoading ? '読込中...' : '—'}
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {snapshot?.safe
                ? `${formatUnixTimestamp(snapshot.safe.timestamp)} · ${
                    safeLag !== null ? `Latest差 ${safeLag.toLocaleString()} blk` : ''
                  }`
                : 'L1 calldata / blob 投稿済み'}
            </div>
          </div>

          {/* Latest (Unsafe) Head */}
          <div className="flex flex-col justify-between gap-1.5 lg:border-l lg:border-slate-100 lg:pl-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
              <Zap className="w-4 h-4 shrink-0" />
              <span>Latest Head (L2シーケンサー)</span>
            </div>
            <div className="text-xl font-semibold font-mono tabular-nums text-slate-900">
              {snapshot?.latest ? `#${snapshot.latest.number.toLocaleString()}` : isLoading ? '読込中...' : '—'}
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {snapshot?.latest
                ? `${formatUnixTimestamp(snapshot.latest.timestamp)} · ${shortenHex(snapshot.latest.hash, 8, 6)}`
                : 'L2 即時承認 (~2秒)'}
            </div>
          </div>

          {/* L1 Origin & L1 Consensus Reference */}
          <div className="flex flex-col justify-between gap-1.5 sm:border-l sm:border-slate-100 sm:pl-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
              <Anchor className="w-4 h-4 shrink-0" />
              <span>Ethereum L1 Origin / 確定</span>
            </div>
            <div className="text-xl font-semibold font-mono tabular-nums text-slate-900">
              {snapshot?.finalized?.l1OriginNumber
                ? `L1 #${snapshot.finalized.l1OriginNumber.toLocaleString()}`
                : snapshot?.l1Head.finalizedNumber
                ? `L1 #${snapshot.l1Head.finalizedNumber.toLocaleString()}`
                : isLoading
                ? '読込中...'
                : '—'}
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {snapshot?.l1Head.finalizedNumber
                ? `L1確定 #${snapshot.l1Head.finalizedNumber.toLocaleString()} / 最新 #${
                    snapshot.l1Head.latestNumber?.toLocaleString() ?? '—'
                  }`
                : 'L1Block Predeploy (0x4200...0015)'}
            </div>
          </div>
        </div>
      )}

      {/* Clean Data Provenance Strip (zero-pill) */}
      {snapshot && !error && (
        <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-700">情報の信頼性・照合元:</span>
            <span className={snapshot.isServerProxy ? 'text-emerald-700 font-medium' : 'text-slate-700'}>
              {snapshot.isServerProxy
                ? 'L2 Archive Proxy (Alchemy経由サーバープロキシ)'
                : 'L2 Public / Custom JSON-RPC'}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={
                snapshot.l1Head.finalizedNumber !== null
                  ? 'text-emerald-700 font-medium'
                  : 'text-amber-700 font-medium'
              }
            >
              {snapshot.l1Head.finalizedNumber !== null
                ? 'L1 OptimismPortal2 / Casper FFG 照合可'
                : 'L1 RPC未接続 (一部照合不可)'}
            </span>
          </div>
          <span>外部インデクサー不使用 · オンチェーン直接検証</span>
        </div>
      )}
    </section>
  );
}
