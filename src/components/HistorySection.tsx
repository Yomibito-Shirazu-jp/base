import { Trash2, RotateCcw } from 'lucide-react';
import { VerificationRunSummary } from '../types/finality';
import { formatUnixTimestamp } from '../lib/exportUtils';

interface HistorySectionProps {
  history: VerificationRunSummary[];
  onLoadRun: (run: VerificationRunSummary) => void;
  onRerunHashes: (run: VerificationRunSummary) => void;
  onClearHistory: () => void;
}

export function HistorySection({
  history,
  onLoadRun,
  onRerunHashes,
  onClearHistory,
}: HistorySectionProps) {
  if (history.length === 0) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl px-6 py-14 text-center">
        <h2 className="text-base font-semibold text-slate-900">検証履歴はまだありません</h2>
        <p className="mt-2 text-sm text-slate-600">
          一括検証を実行すると、ブラウザのローカルストレージに直近20件までの検証スナップショットが保存されます。
        </p>
      </section>
    );
  }

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            過去の検証バッチ履歴 ({history.length}件)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            スナップショットを復元するか、最新ブロックヘッドで再検証できます
          </p>
        </div>
        <button
          type="button"
          onClick={onClearHistory}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 border border-red-200 rounded-lg transition-colors cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>履歴をすべて削除</span>
        </button>
      </div>

      <div className="divide-y divide-slate-100">
        {history.map((run) => (
          <div
            key={run.id}
            className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/70 transition-colors"
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span className="font-sans font-semibold text-slate-900">
                  {run.networkName}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatUnixTimestamp(Math.floor(run.createdAt / 1000))}</span>
                <span aria-hidden="true">·</span>
                <span>
                  Finalized基準 #{run.snapshot.finalized?.number.toLocaleString() ?? '—'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
                <span className="text-slate-700 font-medium">
                  合計 {run.counts.total}件
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-700">Finalized {run.counts.finalized}</span>
                <span aria-hidden="true">·</span>
                <span className="text-sky-700">Safe {run.counts.safe}</span>
                <span aria-hidden="true">·</span>
                <span className="text-amber-700">Unsafe/Pending {run.counts.unsafe + run.counts.pending}</span>
                {run.counts.notFoundOrError > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-red-700">エラー/未検出 {run.counts.notFoundOrError}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onLoadRun(run)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                結果を表示
              </button>
              <button
                type="button"
                onClick={() => onRerunHashes(run)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0052FF] hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>最新状態で再検証</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
