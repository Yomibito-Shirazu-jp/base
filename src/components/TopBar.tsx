import { RefreshCw } from 'lucide-react';

export type ActiveTab =
  | 'verify'
  | 'withdrawal-verify'
  | 'withdrawals'
  | 'guide'
  | 'history';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onLoadLiveSamples: () => void;
  isLoadingSamples: boolean;
  historyCount: number;
}

export function TopBar({
  activeTab,
  onSelectTab,
  onLoadLiveSamples,
  isLoadingSamples,
  historyCount,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-2.5 md:py-0 md:h-16 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-4 gap-y-2">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('verify')}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] rounded"
        >
          Base Finality
        </button>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav
          className="order-3 md:order-2 w-full md:w-auto flex flex-wrap md:flex-nowrap items-center gap-x-4 lg:gap-6 gap-y-1 border-t border-slate-100 md:border-t-0 pt-2 md:pt-0"
          aria-label="メインナビゲーション"
        >
          <button
            type="button"
            onClick={() => onSelectTab('verify')}
            className={`py-1 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] ${
              activeTab === 'verify'
                ? 'border-[#0052FF] text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            一括検証
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('withdrawal-verify')}
            className={`py-1 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] ${
              activeTab === 'withdrawal-verify'
                ? 'border-[#0052FF] text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            出金検証
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('withdrawals')}
            className={`py-1 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] ${
              activeTab === 'withdrawals'
                ? 'border-[#0052FF] text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            出金シミュレーター
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('guide')}
            className={`py-1 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] ${
              activeTab === 'guide'
                ? 'border-[#0052FF] text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            検証ロジック
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('history')}
            className={`py-1 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF] ${
              activeTab === 'history'
                ? 'border-[#0052FF] text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            検証履歴{historyCount > 0 ? ` (${historyCount})` : ''}
          </button>
        </nav>

        {/* Zone 3: Single primary header action */}
        <div className="order-2 md:order-3 flex items-center shrink-0">
          <button
            type="button"
            onClick={onLoadLiveSamples}
            disabled={isLoadingSamples}
            className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSamples ? 'animate-spin' : ''}`} />
            <span>{isLoadingSamples ? '取得中...' : '最新Txサンプル取得'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
