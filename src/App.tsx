import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  NetworkConfig,
  NetworkId,
  ReliabilityInfo,
  VerificationRunSummary,
  VerifiedTransactionResult,
} from './types/finality';
import {
  NETWORK_PRESETS,
  fetchChainHeadSnapshot,
  fetchLiveOnChainSamples,
  parseTxHashes,
  verifyTransactionsBatch,
} from './lib/baseRpc';
import { fetchRecentWithdrawalSamples } from './lib/withdrawalAnalyzer';
import {
  clearFinalizedCache,
  getFinalizedCacheCount,
  lookupFinalizedCache,
  saveFinalizedResultsToCache,
} from './lib/finalizedCache';
import { TopBar, ActiveTab } from './components/TopBar';
import { ChainHeadStrip } from './components/ChainHeadStrip';
import { BatchInputPanel } from './components/BatchInputPanel';
import { VerificationTable } from './components/VerificationTable';
import { WithdrawalVerificationSection } from './components/WithdrawalVerificationSection';
import { TxInspectorDrawer } from './components/TxInspectorDrawer';
import { FinalityGuideSection } from './components/FinalityGuideSection';
import { HistorySection } from './components/HistorySection';
import { WithdrawalSimulatorSection } from './components/WithdrawalSimulatorSection';

const HISTORY_STORAGE_KEY = 'base-finality-history-v1';
const AUTO_POLL_SECONDS = 15;

function fallbackReliability(r: Partial<VerifiedTransactionResult>): ReliabilityInfo {
  if (r.reliability && r.reliability.tier && r.reliability.label) {
    return r.reliability;
  }
  if (r.finality === FinalityStage.FINALIZED) {
    return {
      tier: 'verified_onchain',
      label: 'オンチェーン実測確定',
      basis: ['保存済みオンチェーン検証データ'],
      caveat: null,
    };
  }
  return {
    tier: 'partial',
    label: '保存済みスナップショット',
    basis: ['過去の検証履歴データ'],
    caveat: '最新状態の確認には再検証をおすすめします',
  };
}

function loadHistoryFromStorage(): VerificationRunSummary[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((run: VerificationRunSummary) => ({
      ...run,
      snapshot: {
        ...run.snapshot,
        isServerProxy:
          typeof run.snapshot?.isServerProxy === 'boolean'
            ? run.snapshot.isServerProxy
            : Boolean(run.snapshot?.rpcEndpointUsed?.startsWith('/api/rpc/')),
      },
      results: Array.isArray(run.results)
        ? run.results.map((r) => ({
            ...r,
            reliability: fallbackReliability(r),
          }))
        : [],
    }));
  } catch {
    return [];
  }
}

function saveHistoryToStorage(runs: VerificationRunSummary[]): void {
  try {
    const compact = runs.slice(0, 20).map((run) => ({
      ...run,
      results: run.results.map((r) => ({
        ...r,
        rawTx: null,
        rawReceipt: null,
      })),
    }));
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Ignore storage quota errors
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('verify');
  const [networkId, setNetworkId] = useState<NetworkId>('base-mainnet');
  const [customRpcUrl, setCustomRpcUrl] = useState('');

  // Main Batch Tab State
  const [rawInput, setRawInput] = useState('');
  const [headSnapshot, setHeadSnapshot] = useState<ChainHeadSnapshot | null>(null);
  const [isLoadingHead, setIsLoadingHead] = useState(false);
  const [headError, setHeadError] = useState<string | null>(null);

  const [isVerifying, setIsVerifying] = useState(false);
  const [isRetryingErrors, setIsRetryingErrors] = useState(false);
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [isLoadingWithdrawalSamples, setIsLoadingWithdrawalSamples] = useState(false);
  const [simulatorInitialHash, setSimulatorInitialHash] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    phase: string;
  } | null>(null);
  const [lastRunCacheStats, setLastRunCacheStats] = useState<{
    reusedFromLocal: number;
    fetchedFromRpc: number;
  } | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  const [results, setResults] = useState<VerifiedTransactionResult[]>([]);
  const [verifiedSnapshot, setVerifiedSnapshot] = useState<ChainHeadSnapshot | null>(null);
  const [selectedResult, setSelectedResult] = useState<VerifiedTransactionResult | null>(null);

  // Dedicated Withdrawal Verification Tab State
  const [withdrawalRawInput, setWithdrawalRawInput] = useState('');
  const [withdrawalVerifyResults, setWithdrawalVerifyResults] = useState<
    VerifiedTransactionResult[]
  >([]);
  const [withdrawalSnapshot, setWithdrawalSnapshot] = useState<ChainHeadSnapshot | null>(null);
  const [isVerifyingWithdrawals, setIsVerifyingWithdrawals] = useState(false);
  const [isRetryingWithdrawalErrors, setIsRetryingWithdrawalErrors] = useState(false);
  const [isLoadingWithdrawalTabSamples, setIsLoadingWithdrawalTabSamples] = useState(false);
  const [withdrawalVerifyError, setWithdrawalVerifyError] = useState<string | null>(null);
  const [withdrawalProgress, setWithdrawalProgress] = useState<{
    completed: number;
    total: number;
    phase: string;
  } | null>(null);

  const [autoPollEnabled, setAutoPollEnabled] = useState(false);
  const [autoPollCountdown, setAutoPollCountdown] = useState(AUTO_POLL_SECONDS);

  const [history, setHistory] = useState<VerificationRunSummary[]>(() =>
    loadHistoryFromStorage()
  );

  const activeNetworkConfig: NetworkConfig = useMemo(() => {
    if (networkId === 'custom') {
      return {
        id: 'custom',
        name: 'Custom Base RPC',
        chainId: 8453,
        rpcUrls: customRpcUrl.trim() ? [customRpcUrl.trim()] : [],
        l1RpcUrls: ['/api/rpc/eth-mainnet', 'https://ethereum-rpc.publicnode.com'],
        explorerUrl: 'https://basescan.org',
        l1ExplorerUrl: 'https://etherscan.io',
      };
    }
    return NETWORK_PRESETS[networkId];
  }, [networkId, customRpcUrl]);

  const verifiedWithdrawals = useMemo(() => {
    const combined = new Map<string, VerifiedTransactionResult>();
    for (const r of withdrawalVerifyResults) {
      if (r.withdrawal) combined.set(r.hash.toLowerCase(), r);
    }
    for (const r of results) {
      if (r.withdrawal) combined.set(r.hash.toLowerCase(), r);
    }
    return Array.from(combined.values());
  }, [results, withdrawalVerifyResults]);

  const batchWithdrawalsOnly = useMemo(
    () => results.filter((r) => r.withdrawal !== null),
    [results]
  );

  const parsedBatch = useMemo(() => parseTxHashes(rawInput), [rawInput]);
  const parsedWithdrawalBatch = useMemo(
    () => parseTxHashes(withdrawalRawInput),
    [withdrawalRawInput]
  );

  // Cache hit preview for main batch input
  const cachedHitCount = useMemo(() => {
    void cacheVersion;
    if (parsedBatch.validHashes.length === 0) return 0;
    const { cachedMap } = lookupFinalizedCache(
      activeNetworkConfig.id,
      activeNetworkConfig.chainId,
      parsedBatch.validHashes,
      headSnapshot
    );
    return cachedMap.size;
  }, [
    parsedBatch.validHashes,
    activeNetworkConfig.id,
    activeNetworkConfig.chainId,
    headSnapshot,
    cacheVersion,
  ]);

  const totalSavedCacheCount = useMemo(() => {
    void cacheVersion;
    return getFinalizedCacheCount(activeNetworkConfig.id, activeNetworkConfig.chainId);
  }, [activeNetworkConfig.id, activeNetworkConfig.chainId, cacheVersion]);

  const refreshHead = useCallback(async () => {
    if (activeNetworkConfig.rpcUrls.length === 0) {
      setHeadSnapshot(null);
      setHeadError(null);
      return;
    }
    setIsLoadingHead(true);
    setHeadError(null);
    try {
      const snap = await fetchChainHeadSnapshot(activeNetworkConfig);
      setHeadSnapshot(snap);
    } catch (err) {
      setHeadError(
        err instanceof Error ? err.message : 'オンチェーンヘッドの取得に失敗しました'
      );
    } finally {
      setIsLoadingHead(false);
    }
  }, [activeNetworkConfig]);

  useEffect(() => {
    refreshHead();
  }, [refreshHead]);

  const mergeWithdrawalsIntoTab = useCallback(
    (rows: VerifiedTransactionResult[], snap: ChainHeadSnapshot) => {
      const wRows = rows.filter((r) => r.withdrawal !== null);
      if (wRows.length === 0) return;
      setWithdrawalSnapshot(snap);
      setWithdrawalVerifyResults((prev) => {
        const map = new Map(prev.map((p) => [p.hash.toLowerCase(), p]));
        for (const item of wRows) {
          map.set(item.hash.toLowerCase(), item);
        }
        return Array.from(map.values()).map((r, idx) => ({ ...r, index: idx + 1 }));
      });
    },
    []
  );

  const runBatchVerification = useCallback(
    async (inputText?: string, saveToHistory = true, forceRefresh = false) => {
      const targetParsed = inputText !== undefined ? parseTxHashes(inputText) : parsedBatch;
      if (
        targetParsed.validHashes.length === 0 &&
        targetParsed.invalidTokens.length === 0
      ) {
        return;
      }
      if (activeNetworkConfig.rpcUrls.length === 0) {
        setVerifyError('カスタムRPC URLを入力してください');
        return;
      }

      setIsVerifying(true);
      setVerifyError(null);
      setProgress({
        completed: 0,
        total: targetParsed.validHashes.length,
        phase: 'ローカル確定キャッシュを確認中...',
      });

      try {
        const { cachedMap, missingHashes } = forceRefresh
          ? {
              cachedMap: new Map<string, VerifiedTransactionResult>(),
              missingHashes: targetParsed.validHashes,
            }
          : lookupFinalizedCache(
              activeNetworkConfig.id,
              activeNetworkConfig.chainId,
              targetParsed.validHashes,
              headSnapshot
            );

        let activeSnapshot: ChainHeadSnapshot | null = headSnapshot;
        let fetchedRows: VerifiedTransactionResult[] = [];

        if (missingHashes.length > 0 || targetParsed.invalidTokens.length > 0) {
          const rpcBatch = {
            validHashes: missingHashes,
            invalidTokens: targetParsed.invalidTokens,
            duplicateCount: targetParsed.duplicateCount,
            totalLinesOrTokens: missingHashes.length + targetParsed.invalidTokens.length,
          };

          const { snapshot, results: rpcResults } = await verifyTransactionsBatch(
            rpcBatch,
            activeNetworkConfig,
            (completed, total, phase) => {
              setProgress({ completed, total, phase });
            }
          );
          activeSnapshot = snapshot;
          fetchedRows = rpcResults;
        } else {
          // All valid hashes are already Finalized & immutable in local cache!
          if (!activeSnapshot) {
            activeSnapshot = await fetchChainHeadSnapshot(activeNetworkConfig);
          }
          setProgress({
            completed: targetParsed.validHashes.length,
            total: targetParsed.validHashes.length,
            phase: `ローカル確定データから ${cachedMap.size}件を復元完了（RPC新規取得なし）`,
          });
        }

        const fetchedValidMap = new Map<string, VerifiedTransactionResult>();
        const invalidRows: VerifiedTransactionResult[] = [];
        for (const r of fetchedRows) {
          if (r.finality === FinalityStage.INVALID) {
            invalidRows.push(r);
          } else {
            fetchedValidMap.set(r.hash.toLowerCase(), r);
          }
        }

        // Reassemble rows in the exact input order
        const mergedRows: VerifiedTransactionResult[] = [];
        let rowIdx = 1;
        for (const rawH of targetParsed.validHashes) {
          const h = rawH.toLowerCase();
          const row = fetchedValidMap.get(h) ?? cachedMap.get(h);
          if (row) {
            const refreshedConf =
              row.blockNumber !== null && activeSnapshot?.latest
                ? Math.max(0, activeSnapshot.latest.number - row.blockNumber)
                : row.confirmations;
            mergedRows.push({
              ...row,
              index: rowIdx++,
              confirmations: refreshedConf,
            });
          }
        }
        for (const inv of invalidRows) {
          mergedRows.push({ ...inv, index: rowIdx++ });
        }

        // Persist any newly Finalized immutable results to local cache
        const savedCount = saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          mergedRows
        );
        if (savedCount > 0) {
          setCacheVersion((v) => v + 1);
        }

        setLastRunCacheStats({
          reusedFromLocal: cachedMap.size,
          fetchedFromRpc: missingHashes.length + targetParsed.invalidTokens.length,
        });

        if (activeSnapshot) {
          setHeadSnapshot(activeSnapshot);
          setVerifiedSnapshot(activeSnapshot);
          mergeWithdrawalsIntoTab(mergedRows, activeSnapshot);
        }
        setResults(mergedRows);

        setSelectedResult((prev) =>
          prev ? mergedRows.find((r) => r.hash === prev.hash) ?? null : null
        );

        if (saveToHistory && mergedRows.length > 0 && activeSnapshot) {
          const counts = {
            total: mergedRows.length,
            finalized: mergedRows.filter((r) => r.finality === FinalityStage.FINALIZED).length,
            safe: mergedRows.filter((r) => r.finality === FinalityStage.SAFE).length,
            unsafe: mergedRows.filter((r) => r.finality === FinalityStage.UNSAFE).length,
            pending: mergedRows.filter((r) => r.finality === FinalityStage.PENDING).length,
            notFoundOrError: mergedRows.filter(
              (r) =>
                r.finality === FinalityStage.NOT_FOUND ||
                r.finality === FinalityStage.INVALID ||
                r.finality === FinalityStage.RPC_ERROR
            ).length,
            reverted: mergedRows.filter(
              (r) => r.executionStatus === ExecutionStatus.REVERTED
            ).length,
          };

          const entry: VerificationRunSummary = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
            networkId: activeNetworkConfig.id,
            networkName: activeSnapshot.networkName,
            snapshot: activeSnapshot,
            results: mergedRows,
            counts,
          };

          setHistory((prev) => {
            const next = [entry, ...prev].slice(0, 20);
            saveHistoryToStorage(next);
            return next;
          });
        }
      } catch (err) {
        setVerifyError(
          err instanceof Error ? err.message : 'オンチェーン検証中にエラーが発生しました'
        );
      } finally {
        setIsVerifying(false);
      }
    },
    [parsedBatch, activeNetworkConfig, headSnapshot, mergeWithdrawalsIntoTab]
  );

  // Auto-poll effect (automatically reuses local Finalized cache and polls only remaining items!)
  const latestRunRef = useRef(runBatchVerification);
  latestRunRef.current = runBatchVerification;

  useEffect(() => {
    if (!autoPollEnabled) {
      setAutoPollCountdown(AUTO_POLL_SECONDS);
      return;
    }

    const interval = setInterval(() => {
      setAutoPollCountdown((prev) => {
        if (prev <= 1) {
          latestRunRef.current(undefined, false, false);
          return AUTO_POLL_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [autoPollEnabled]);

  const handleLoadLiveSamples = async () => {
    if (activeNetworkConfig.rpcUrls.length === 0) {
      setNetworkId('base-mainnet');
    }
    const targetConfig =
      activeNetworkConfig.rpcUrls.length > 0
        ? activeNetworkConfig
        : NETWORK_PRESETS['base-mainnet'];

    setActiveTab('verify');
    setIsLoadingSamples(true);
    setVerifyError(null);

    try {
      const sampleHashes = await fetchLiveOnChainSamples(targetConfig);
      if (sampleHashes.length === 0) {
        setVerifyError('最新ブロックからサンプルトランザクションを取得できませんでした');
        return;
      }
      const joined = sampleHashes.join('\n');
      setRawInput(joined);
      await runBatchVerification(joined, true, false);
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : 'サンプル取得中にRPCエラーが発生しました'
      );
    } finally {
      setIsLoadingSamples(false);
    }
  };

  const handleLoadWithdrawalSamples = async () => {
    const targetConfig =
      activeNetworkConfig.rpcUrls.length > 0
        ? activeNetworkConfig
        : NETWORK_PRESETS['base-mainnet'];

    setActiveTab('verify');
    setIsLoadingWithdrawalSamples(true);
    setVerifyError(null);

    try {
      const sampleHashes = await fetchRecentWithdrawalSamples(targetConfig, 3);
      if (sampleHashes.length === 0) {
        setVerifyError('直近ブロックから出金トランザクションが見つかりませんでした');
        return;
      }
      const joined = sampleHashes.join('\n');
      setRawInput(joined);
      await runBatchVerification(joined, true, false);
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : '出金Txサンプルの取得中にエラーが発生しました'
      );
    } finally {
      setIsLoadingWithdrawalSamples(false);
    }
  };

  const handleRetryErrors = useCallback(
    async (hashesToRetry: string[]) => {
      if (hashesToRetry.length === 0) return;
      if (activeNetworkConfig.rpcUrls.length === 0) {
        setVerifyError('カスタムRPC URLを入力してください');
        return;
      }

      setIsRetryingErrors(true);
      setVerifyError(null);

      try {
        const retryParsed = {
          validHashes: hashesToRetry.map((h) => h.toLowerCase()),
          invalidTokens: [],
          duplicateCount: 0,
          totalLinesOrTokens: hashesToRetry.length,
        };
        const { snapshot, results: retriedRows } = await verifyTransactionsBatch(
          retryParsed,
          activeNetworkConfig
        );

        const savedCount = saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          retriedRows
        );
        if (savedCount > 0) {
          setCacheVersion((v) => v + 1);
        }

        const retriedMap = new Map(retriedRows.map((r) => [r.hash.toLowerCase(), r]));
        setHeadSnapshot(snapshot);
        setVerifiedSnapshot(snapshot);
        mergeWithdrawalsIntoTab(retriedRows, snapshot);
        setLastRunCacheStats({
          reusedFromLocal: Math.max(0, results.length - hashesToRetry.length),
          fetchedFromRpc: hashesToRetry.length,
        });
        setResults((prev) =>
          prev.map((existing) => {
            const replacement = retriedMap.get(existing.hash.toLowerCase());
            if (!replacement) return existing;
            return { ...replacement, index: existing.index };
          })
        );
      } catch (err) {
        setVerifyError(
          err instanceof Error ? err.message : 'エラー項目の再検証に失敗しました'
        );
      } finally {
        setIsRetryingErrors(false);
      }
    },
    [activeNetworkConfig, mergeWithdrawalsIntoTab, results.length]
  );

  // Dedicated Withdrawal Tab Handlers
  const runWithdrawalTabVerification = useCallback(
    async (inputText?: string) => {
      const targetParsed =
        inputText !== undefined ? parseTxHashes(inputText) : parsedWithdrawalBatch;
      if (
        targetParsed.validHashes.length === 0 &&
        targetParsed.invalidTokens.length === 0
      ) {
        return;
      }
      if (activeNetworkConfig.rpcUrls.length === 0) {
        setWithdrawalVerifyError('カスタムRPC URLを入力してください');
        return;
      }

      setIsVerifyingWithdrawals(true);
      setWithdrawalVerifyError(null);
      setWithdrawalProgress({
        completed: 0,
        total: targetParsed.validHashes.length,
        phase: '出金TxのL1/L2状態を取得中...',
      });

      try {
        const { snapshot, results: verifiedRows } = await verifyTransactionsBatch(
          targetParsed,
          activeNetworkConfig,
          (completed, total, phase) => {
            setWithdrawalProgress({ completed, total, phase });
          }
        );

        saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          verifiedRows
        );
        setCacheVersion((v) => v + 1);

        setHeadSnapshot(snapshot);
        setWithdrawalSnapshot(snapshot);
        setWithdrawalVerifyResults(verifiedRows);
      } catch (err) {
        setWithdrawalVerifyError(
          err instanceof Error ? err.message : '出金検証中にRPCエラーが発生しました'
        );
      } finally {
        setIsVerifyingWithdrawals(false);
      }
    },
    [parsedWithdrawalBatch, activeNetworkConfig]
  );

  const handleFetchWithdrawalTabSamples = async () => {
    const targetConfig =
      activeNetworkConfig.rpcUrls.length > 0
        ? activeNetworkConfig
        : NETWORK_PRESETS['base-mainnet'];

    setIsLoadingWithdrawalTabSamples(true);
    setWithdrawalVerifyError(null);
    try {
      const sampleHashes = await fetchRecentWithdrawalSamples(targetConfig, 5);
      if (sampleHashes.length === 0) {
        setWithdrawalVerifyError('直近ブロックから出金トランザクションが見つかりませんでした');
        return;
      }
      const joined = sampleHashes.join('\n');
      setWithdrawalRawInput(joined);
      await runWithdrawalTabVerification(joined);
    } catch (err) {
      setWithdrawalVerifyError(
        err instanceof Error ? err.message : '出金Txの自動取得に失敗しました'
      );
    } finally {
      setIsLoadingWithdrawalTabSamples(false);
    }
  };

  const handleRetryWithdrawalErrors = useCallback(
    async (hashesToRetry: string[]) => {
      if (hashesToRetry.length === 0) return;
      setIsRetryingWithdrawalErrors(true);
      setWithdrawalVerifyError(null);
      try {
        const retryParsed = {
          validHashes: hashesToRetry.map((h) => h.toLowerCase()),
          invalidTokens: [],
          duplicateCount: 0,
          totalLinesOrTokens: hashesToRetry.length,
        };
        const { snapshot, results: retriedRows } = await verifyTransactionsBatch(
          retryParsed,
          activeNetworkConfig
        );
        const retriedMap = new Map(retriedRows.map((r) => [r.hash.toLowerCase(), r]));
        setHeadSnapshot(snapshot);
        setWithdrawalSnapshot(snapshot);
        setWithdrawalVerifyResults((prev) =>
          prev.map((existing) => {
            const replacement = retriedMap.get(existing.hash.toLowerCase());
            if (!replacement) return existing;
            return { ...replacement, index: existing.index };
          })
        );
      } catch (err) {
        setWithdrawalVerifyError(
          err instanceof Error ? err.message : 'エラー項目の再検証に失敗しました'
        );
      } finally {
        setIsRetryingWithdrawalErrors(false);
      }
    },
    [activeNetworkConfig]
  );

  const handleClear = () => {
    setRawInput('');
    setResults([]);
    setVerifiedSnapshot(null);
    setSelectedResult(null);
    setVerifyError(null);
    setLastRunCacheStats(null);
    setAutoPollEnabled(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onLoadLiveSamples={handleLoadLiveSamples}
        isLoadingSamples={isLoadingSamples}
        historyCount={history.length}
      />

      <main className="flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
        {/* Page Heading & Direct Tab Switcher */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="max-w-3xl">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              {activeTab === 'withdrawal-verify'
                ? 'Base L2 → L1 出金検証コンソール'
                : 'Base トランザクション・ファイナライズ一括検証'}
            </h1>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
              {activeTab === 'withdrawal-verify'
                ? 'L2ToL1MessagePasser イベントと L1 OptimismPortal2.finalizedWithdrawals を直接照会し、出金完了有無・残り時間・情報の信頼性を検証します。'
                : '複数のトランザクションハッシュをBaseノードのオンチェーンJSON-RPCへ直接照会し、L1コンセンサス確定（Finalized）・L1バッチ投稿（Safe）・L2シーケンサー承認（Unsafe）と L2→L1 出金状態を一括判定します。'}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="検証モード切り替え"
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg shrink-0"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'verify'}
              onClick={() => setActiveTab('verify')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'verify'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              一括検証
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'withdrawal-verify'}
              onClick={() => setActiveTab('withdrawal-verify')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'withdrawal-verify'
                  ? 'bg-white text-[#0052FF] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              出金検証
              {verifiedWithdrawals.length > 0 ? ` (${verifiedWithdrawals.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'withdrawals'}
              onClick={() => setActiveTab('withdrawals')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'withdrawals'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              出金シミュレーター
            </button>
          </div>
        </div>

        {activeTab === 'verify' && (
          <>
            <ChainHeadStrip
              snapshot={headSnapshot}
              isLoading={isLoadingHead}
              error={headError}
              onRefresh={refreshHead}
            />

            <BatchInputPanel
              rawInput={rawInput}
              onRawInputChange={setRawInput}
              parsed={parsedBatch}
              networkId={networkId}
              onNetworkChange={(id) => {
                setNetworkId(id);
                setAutoPollEnabled(false);
              }}
              customRpcUrl={customRpcUrl}
              onCustomRpcUrlChange={setCustomRpcUrl}
              isVerifying={isVerifying}
              progress={progress}
              onVerify={() => runBatchVerification(undefined, true, false)}
              onClear={handleClear}
              autoPollEnabled={autoPollEnabled}
              onToggleAutoPoll={() => {
                setAutoPollCountdown(AUTO_POLL_SECONDS);
                setAutoPollEnabled((v) => !v);
              }}
              autoPollCountdown={autoPollCountdown}
              hasResults={results.length > 0}
              onLoadWithdrawalSamples={handleLoadWithdrawalSamples}
              isLoadingWithdrawalSamples={isLoadingWithdrawalSamples}
              cachedHitCount={cachedHitCount}
              totalSavedCacheCount={totalSavedCacheCount}
              onClearFinalizedCache={() => {
                clearFinalizedCache(activeNetworkConfig.id, activeNetworkConfig.chainId);
                setCacheVersion((v) => v + 1);
                setLastRunCacheStats(null);
              }}
              onForceRefreshAll={() => runBatchVerification(undefined, true, true)}
            />

            {verifyError && (
              <div
                role="alert"
                className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-xl px-4 py-3"
              >
                検証エラー: {verifyError}
              </div>
            )}

            <VerificationTable
              results={results}
              snapshot={verifiedSnapshot ?? headSnapshot}
              explorerUrl={activeNetworkConfig.explorerUrl}
              isVerifying={isVerifying}
              isRetryingErrors={isRetryingErrors}
              selectedHash={selectedResult?.hash ?? null}
              lastRunCacheStats={lastRunCacheStats}
              onSelectResult={setSelectedResult}
              onLoadLiveSamples={handleLoadLiveSamples}
              onRetryErrors={handleRetryErrors}
            />
          </>
        )}

        {activeTab === 'withdrawal-verify' && (
          <WithdrawalVerificationSection
            rawInput={withdrawalRawInput}
            onRawInputChange={setWithdrawalRawInput}
            parsed={parsedWithdrawalBatch}
            results={withdrawalVerifyResults}
            snapshot={withdrawalSnapshot ?? headSnapshot}
            networkConfig={activeNetworkConfig}
            isVerifying={isVerifyingWithdrawals}
            isRetryingErrors={isRetryingWithdrawalErrors}
            isLoadingSamples={isLoadingWithdrawalTabSamples}
            progress={withdrawalProgress}
            verifyError={withdrawalVerifyError}
            selectedHash={selectedResult?.hash ?? null}
            batchWithdrawalCount={batchWithdrawalsOnly.length}
            onVerify={() => runWithdrawalTabVerification()}
            onClear={() => {
              setWithdrawalRawInput('');
              setWithdrawalVerifyResults([]);
              setWithdrawalVerifyError(null);
            }}
            onFetchRecentWithdrawals={handleFetchWithdrawalTabSamples}
            onImportFromBatch={() => {
              const hashes = batchWithdrawalsOnly.map((r) => r.hash);
              setWithdrawalRawInput(hashes.join('\n'));
              setWithdrawalSnapshot(verifiedSnapshot ?? headSnapshot);
              setWithdrawalVerifyResults(
                batchWithdrawalsOnly.map((r, i) => ({ ...r, index: i + 1 }))
              );
            }}
            onRetryErrors={handleRetryWithdrawalErrors}
            onSelectResult={setSelectedResult}
            onOpenInSimulator={(txHash) => {
              setSimulatorInitialHash(txHash);
              setActiveTab('withdrawals');
            }}
          />
        )}

        {activeTab === 'withdrawals' && (
          <WithdrawalSimulatorSection
            networkConfig={activeNetworkConfig}
            verifiedWithdrawals={verifiedWithdrawals}
            initialTxHash={simulatorInitialHash}
          />
        )}

        {activeTab === 'guide' && <FinalityGuideSection />}

        {activeTab === 'history' && (
          <HistorySection
            history={history}
            onLoadRun={(run) => {
              setNetworkId(run.networkId);
              setRawInput(run.results.map((r) => r.inputToken).join('\n'));
              setResults(run.results);
              setVerifiedSnapshot(run.snapshot);
              setLastRunCacheStats(null);
              setActiveTab('verify');
            }}
            onRerunHashes={(run) => {
              const joined = run.results.map((r) => r.inputToken).join('\n');
              setNetworkId(run.networkId);
              setRawInput(joined);
              setActiveTab('verify');
              runBatchVerification(joined, true, false);
            }}
            onClearHistory={() => {
              setHistory([]);
              saveHistoryToStorage([]);
            }}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-12">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            Base Finality · オンチェーンJSON-RPC直接検証コンソール（外部DB・トラッキング不使用）
          </span>
          <span className="font-mono">
            OP Stack Finality: Latest → Safe (L1 Batch) → Finalized (L1 Casper FFG)
          </span>
        </div>
      </footer>

      <TxInspectorDrawer
        result={selectedResult}
        snapshot={verifiedSnapshot ?? withdrawalSnapshot ?? headSnapshot}
        networkConfig={activeNetworkConfig}
        explorerUrl={activeNetworkConfig.explorerUrl}
        l1ExplorerUrl={activeNetworkConfig.l1ExplorerUrl}
        onClose={() => setSelectedResult(null)}
        onOpenInSimulator={(txHash) => {
          setSelectedResult(null);
          setSimulatorInitialHash(txHash);
          setActiveTab('withdrawals');
        }}
      />
    </div>
  );
}
