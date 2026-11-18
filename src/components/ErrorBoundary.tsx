import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-red-200 rounded-xl p-6 space-y-4">
            <h1 className="text-base font-bold text-red-800">
              画面の表示中にエラーが発生しました
            </h1>
            <p className="text-xs font-mono text-red-700 bg-red-50 border border-red-100 rounded-lg p-3 break-all">
              {this.state.errorMessage || '不明なランタイムエラー'}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.removeItem('base-finality-history-v1');
                    localStorage.removeItem('base-finality-tx-cache-v1');
                    localStorage.removeItem('base-finality-workspace-v1');
                    localStorage.removeItem('base-finality-ai-chat-v1');
                  } catch {
                    // Ignore
                  }
                  window.location.reload();
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0052FF] hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                キャッシュをクリアして再読み込み
              </button>
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, errorMessage: '' })}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                再試行
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
