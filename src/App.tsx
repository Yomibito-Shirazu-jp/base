import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onIdTokenChanged, signInWithPopup, signOut } from 'firebase/auth';
import { Check, LogIn, LogOut, RefreshCw } from 'lucide-react';
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
import type { Hex } from 'viem';
import {
  analyzeWithdrawalFromTxHash,
  fetchRecentWithdrawalSamples,
} from './lib/withdrawalAnalyzer';
import {
  clearFinalizedCache,
  getAllCachedFinalizedResults,
  getFinalizedCacheCount,
  isImmutableFinalizedResult,
  lookupFinalizedCache,
  saveFinalizedResultsToCache,
} from './lib/finalizedCache';
import { auth, googleAuthProvider } from './lib/firebase';
import { TopBar, ActiveTab } from './components/TopBar';
import { ChainHeadStrip } from './components/ChainHeadStrip';
import { BatchInputPanel } from './components/BatchInputPanel';
import { VerificationTable } from './components/VerificationTable';
import { WithdrawalVerificationSection } from './components/WithdrawalVerificationSection';
import { AiAuditAssistantSection } from './components/AiAuditAssistantSection';
import { TxInspectorDrawer } from './components/TxInspectorDrawer';
import { FinalityGuideSection } from './components/FinalityGuideSection';
import { HistorySection } from './components/HistorySection';
import { WithdrawalSimulatorSection } from './components/WithdrawalSimulatorSection';

const HISTORY_STORAGE_KEY = 'base-finality-history-v1';
const WORKSPACE_STORAGE_KEY = 'base-finality-workspace-v1';
const AUTO_POLL_SECONDS = 15;

const VALID_TABS = new Set<ActiveTab>([
  'verify',
  'withdrawal-verify',
  'withdrawals',
  'ai-audit',
  'guide',
  'history',
]);

const VALID_NETWORKS = new Set<NetworkId>([
  'base-mainnet',
  'base-sepolia',
  'custom',
]);

interface PersistedWorkspaceState {
  activeTab: ActiveTab;
  networkId: NetworkId;
  customRpcUrl: string;
  rawInput: string;
  withdrawalRawInput: string;
  results: VerifiedTransactionResult[];
  verifiedSnapshot: ChainHeadSnapshot | null;
  withdrawalVerifyResults: VerifiedTransactionResult[];
  withdrawalSnapshot: ChainHeadSnapshot | null;
  simulatorInitialHash: string | null;
  lastRunCacheStats: { reusedFromLocal: number; fetchedFromRpc: number } | null;
  updatedAt: number;
}

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

function normalizeSnapshot(snap: unknown): ChainHeadSnapshot | null {
  if (!snap || typeof snap !== 'object') return null;
  const s = snap as ChainHeadSnapshot;
  return {
    ...s,
    l1Head: s.l1Head ?? {
      latestNumber: null,
      finalizedNumber: null,
      rpcEndpointUsed: null,
    },
    isServerProxy:
      typeof s.isServerProxy === 'boolean'
        ? s.isServerProxy
        : Boolean(s.rpcEndpointUsed?.startsWith('/api/rpc/')),
  };
}

function normalizeResults(raw: unknown): VerifiedTransactionResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is VerifiedTransactionResult => Boolean(r && typeof r === 'object'))
    .map((r) => ({
      ...r,
      reliability: fallbackReliability(r),
    }));
}

function compactResults(rows: VerifiedTransactionResult[]): VerifiedTransactionResult[] {
  return rows.slice(0, 500).map((r) => ({
    ...r,
    rawTx: null,
    rawReceipt: null,
  }));
}

function loadWorkspaceFromStorage(): PersistedWorkspaceState | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const tab = VALID_TABS.has(parsed.activeTab) ? parsed.activeTab : 'verify';
    const net = VALID_NETWORKS.has(parsed.networkId) ? parsed.networkId : 'base-mainnet';
    return {
      activeTab: tab,
      networkId: net,
      customRpcUrl: typeof parsed.customRpcUrl === 'string' ? parsed.customRpcUrl : '',
      rawInput: typeof parsed.rawInput === 'string' ? parsed.rawInput : '',
      withdrawalRawInput:
        typeof parsed.withdrawalRawInput === 'string' ? parsed.withdrawalRawInput : '',
      results: normalizeResults(parsed.results),
      verifiedSnapshot: normalizeSnapshot(parsed.verifiedSnapshot),
      withdrawalVerifyResults: normalizeResults(parsed.withdrawalVerifyResults),
      withdrawalSnapshot: normalizeSnapshot(parsed.withdrawalSnapshot),
      simulatorInitialHash:
        typeof parsed.simulatorInitialHash === 'string'
          ? parsed.simulatorInitialHash
          : null,
      lastRunCacheStats:
        parsed.lastRunCacheStats && typeof parsed.lastRunCacheStats === 'object'
          ? parsed.lastRunCacheStats
          : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function saveWorkspaceToStorage(ws: PersistedWorkspaceState): void {
  try {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        ...ws,
        results: compactResults(ws.results),
        withdrawalVerifyResults: compactResults(ws.withdrawalVerifyResults),
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

function loadHistoryFromStorage(): VerificationRunSummary[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((run): run is VerificationRunSummary => Boolean(run && typeof run === 'object'))
      .map((run: VerificationRunSummary) => ({
        ...run,
        snapshot:
          normalizeSnapshot(run.snapshot) ?? {
            networkId: run.networkId ?? 'base-mainnet',
            networkName: run.networkName ?? 'Base Mainnet',
            chainId: 8453,
            rpcEndpointUsed: '',
            isServerProxy: false,
            fetchedAt: run.createdAt ?? Date.now(),
            latest: null,
            safe: null,
            finalized: null,
            l1Head: {
              latestNumber: null,
              finalizedNumber: null,
              rpcEndpointUsed: null,
            },
          },
        results: normalizeResults(run.results),
      }));
  } catch {
    return [];
  }
}

function saveHistoryToStorage(runs: VerificationRunSummary[]): void {
  try {
    const compact = runs.slice(0, 20).map((run) => ({
      ...run,
      results: compactResults(run.results),
    }));
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Ignore storage quota errors
  }
}

export default function App() {
  const initialWorkspace = useMemo(() => loadWorkspaceFromStorage(), []);

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    () => initialWorkspace?.activeTab ?? 'verify'
  );
  const [networkId, setNetworkId] = useState<NetworkId>(
    () => initialWorkspace?.networkId ?? 'base-mainnet'
  );
  const [customRpcUrl, setCustomRpcUrl] = useState(
    () => initialWorkspace?.customRpcUrl ?? ''
  );

  // Main Batch Tab State
  const [rawInput, setRawInput] = useState(() => initialWorkspace?.rawInput ?? '');
  const [headSnapshot, setHeadSnapshot] = useState<ChainHeadSnapshot | null>(null);
  const [isLoadingHead, setIsLoadingHead] = useState(false);
  const [headError, setHeadError] = useState<string | null>(null);

  const [isVerifying, setIsVerifying] = useState(false);
  const [isRetryingErrors, setIsRetryingErrors] = useState(false);
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [isLoadingWithdrawalSamples, setIsLoadingWithdrawalSamples] = useState(false);
  const [simulatorInitialHash, setSimulatorInitialHash] = useState<string | null>(
    () => initialWorkspace?.simulatorInitialHash ?? null
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    phase: string;
  } | null>(null);
  const [lastRunCacheStats, setLastRunCacheStats] = useState<{
    reusedFromLocal: number;
    fetchedFromRpc: number;
  } | null>(() => initialWorkspace?.lastRunCacheStats ?? null);
  const [cacheVersion, setCacheVersion] = useState(0);

  const [results, setResults] = useState<VerifiedTransactionResult[]>(
    () => initialWorkspace?.results ?? []
  );
  const [verifiedSnapshot, setVerifiedSnapshot] = useState<ChainHeadSnapshot | null>(
    () => initialWorkspace?.verifiedSnapshot ?? null
  );
  const [selectedResult, setSelectedResult] = useState<VerifiedTransactionResult | null>(null);

  // Dedicated Withdrawal Verification Tab State
  const [withdrawalRawInput, setWithdrawalRawInput] = useState(
    () => initialWorkspace?.withdrawalRawInput ?? ''
  );
  const [withdrawalVerifyResults, setWithdrawalVerifyResults] = useState<
    VerifiedTransactionResult[]
  >(() => initialWorkspace?.withdrawalVerifyResults ?? []);
  const [withdrawalSnapshot, setWithdrawalSnapshot] = useState<ChainHeadSnapshot | null>(
    () => initialWorkspace?.withdrawalSnapshot ?? null
  );
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

  // Firebase Auth & Sync state (ID token stored strictly in memory)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudWorkspaceReady, setCloudWorkspaceReady] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number>(
    () => initialWorkspace?.updatedAt || Date.now()
  );
  const skipNextLocalTimestampBumpRef = useRef(false);

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

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      if (!user) {
        setAuthToken(null);
        setUserEmail(null);
        setCloudWorkspaceReady(false);
        return;
      }
      try {
        const token = await user.getIdToken();
        setAuthToken(token);
        setUserEmail(user.email ?? user.uid);
        fetch('/api/user/me', {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      } catch {
        setAuthToken(null);
        setUserEmail(null);
        setCloudWorkspaceReady(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Automatically save workspace state to localStorage on every change
  const isInitialMountRef = useRef(true);
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    const now = skipNextLocalTimestampBumpRef.current ? lastSavedAt : Date.now();
    skipNextLocalTimestampBumpRef.current = false;
    setLastSavedAt(now);
    saveWorkspaceToStorage({
      activeTab,
      networkId,
      customRpcUrl,
      rawInput,
      withdrawalRawInput,
      results,
      verifiedSnapshot,
      withdrawalVerifyResults,
      withdrawalSnapshot,
      simulatorInitialHash,
      lastRunCacheStats,
      updatedAt: now,
    });
  }, [
    activeTab,
    networkId,
    customRpcUrl,
    rawInput,
    withdrawalRawInput,
    results,
    verifiedSnapshot,
    withdrawalVerifyResults,
    withdrawalSnapshot,
    simulatorInitialHash,
    lastRunCacheStats,
  ]);

  const syncFinalizedToCloud = useCallback(
    (rows: VerifiedTransactionResult[]) => {
      if (!authToken) return;
      const immutableRows = rows.filter(isImmutableFinalizedResult);
      if (immutableRows.length === 0) return;

      fetch('/api/tx-cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          items: immutableRows.map((r) => ({
            networkId: activeNetworkConfig.id,
            chainId: activeNetworkConfig.chainId,
            txHash: r.hash,
            finality: r.finality,
            executionStatus: r.executionStatus,
            blockNumber: r.blockNumber,
            l1OriginBlock: r.l1OriginBlock,
            isWithdrawal: r.withdrawal !== null,
            portalFinalized: r.withdrawal?.portalFinalized ?? null,
            reliabilityTier: r.reliability?.tier ?? 'verified_onchain',
            payloadJson: { ...r, rawTx: null, rawReceipt: null },
          })),
        }),
      }).catch(() => {});
    },
    [authToken, activeNetworkConfig.id, activeNetworkConfig.chainId]
  );

  // Bidirectional sync on Google sign-in: workspace, finalized cache, and verification history
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    setIsSyncingCloud(true);

    const localFinalized = getAllCachedFinalizedResults(
      activeNetworkConfig.id,
      activeNetworkConfig.chainId
    );
    if (localFinalized.length > 0) {
      syncFinalizedToCloud(localFinalized);
    }

    const syncAll = async () => {
      try {
        // 1. Sync Finalized cache
        const txRes = await fetch(
          `/api/tx-cache?networkId=${encodeURIComponent(
            activeNetworkConfig.id
          )}&chainId=${activeNetworkConfig.chainId}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (!cancelled && txRes.ok) {
          const txData = await txRes.json();
          if (Array.isArray(txData?.items) && txData.items.length > 0) {
            const count = saveFinalizedResultsToCache(
              activeNetworkConfig.id,
              activeNetworkConfig.chainId,
              txData.items as VerifiedTransactionResult[]
            );
            if (count > 0) setCacheVersion((v) => v + 1);
          }
        }

        // 2. Sync verification history (both directions)
        const runsRes = await fetch('/api/runs', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!cancelled && runsRes.ok) {
          const runsData = await runsRes.json();
          const cloudRuns = Array.isArray(runsData?.runs)
            ? (runsData.runs as VerificationRunSummary[])
            : [];
          const cloudIds = new Set(cloudRuns.map((r) => r.id));

          const currentLocalRuns = loadHistoryFromStorage();
          for (const localRun of currentLocalRuns.slice(0, 10)) {
            if (localRun.id && !cloudIds.has(localRun.id)) {
              fetch('/api/runs', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({
                  ...localRun,
                  results: compactResults(localRun.results),
                }),
              }).catch(() => {});
            }
          }

          setHistory((prev) => {
            const map = new Map(prev.map((r) => [r.id, r]));
            for (const run of cloudRuns) {
              if (run?.id && !map.has(run.id)) {
                map.set(run.id, {
                  ...run,
                  snapshot:
                    normalizeSnapshot(run.snapshot) ?? prev[0]?.snapshot ?? ({} as ChainHeadSnapshot),
                  results: normalizeResults(run.results),
                });
              }
            }
            const merged = Array.from(map.values())
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 20);
            saveHistoryToStorage(merged);
            return merged;
          });
        }

        // 3. Hydrate or push active workspace state
        const wsRes = await fetch('/api/workspace', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!cancelled && wsRes.ok) {
          const wsData = await wsRes.json();
          const cloudWs = wsData?.workspace;
          const currentLocalWs = loadWorkspaceFromStorage();
          const localHasWork = Boolean(
            currentLocalWs &&
              (currentLocalWs.rawInput.trim() ||
                currentLocalWs.results.length > 0 ||
                currentLocalWs.withdrawalRawInput.trim() ||
                currentLocalWs.withdrawalVerifyResults.length > 0)
          );
          const cloudUpdatedAt = Number(
            cloudWs?.stateJson?.clientUpdatedAt ?? cloudWs?.updatedAt ?? 0
          );
          const localUpdatedAt = currentLocalWs?.updatedAt ?? 0;

          if (cloudWs && (!localHasWork || cloudUpdatedAt > localUpdatedAt)) {
            const sj = (cloudWs.stateJson ?? {}) as Record<string, unknown>;
            skipNextLocalTimestampBumpRef.current = true;
            setLastSavedAt(cloudUpdatedAt || Date.now());
            if (VALID_TABS.has(cloudWs.activeTab)) {
              setActiveTab(cloudWs.activeTab);
            }
            if (VALID_NETWORKS.has(cloudWs.networkId)) {
              setNetworkId(cloudWs.networkId);
            }
            setCustomRpcUrl(String(cloudWs.customRpcUrl || ''));
            setRawInput(String(cloudWs.rawInput || ''));
            setWithdrawalRawInput(String(cloudWs.withdrawalRawInput || ''));
            setResults(normalizeResults(sj.results));
            setVerifiedSnapshot(normalizeSnapshot(sj.verifiedSnapshot));
            setWithdrawalVerifyResults(normalizeResults(sj.withdrawalVerifyResults));
            setWithdrawalSnapshot(normalizeSnapshot(sj.withdrawalSnapshot));
            if (typeof sj.simulatorInitialHash === 'string') {
              setSimulatorInitialHash(sj.simulatorInitialHash);
            }
          }
        }
      } catch {
        // Non-fatal cloud sync error; local storage remains intact
      } finally {
        if (!cancelled) {
          setCloudWorkspaceReady(true);
          setIsSyncingCloud(false);
        }
      }
    };

    syncAll();

    return () => {
      cancelled = true;
    };
  }, [authToken, activeNetworkConfig.id, activeNetworkConfig.chainId, syncFinalizedToCloud]);

  // Continuously push workspace changes to cloud once initial hydration completes
  useEffect(() => {
    if (!authToken || !cloudWorkspaceReady) return;
    const timer = setTimeout(() => {
      setIsSyncingCloud(true);
      fetch('/api/workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          activeTab,
          networkId,
          customRpcUrl,
          rawInput,
          withdrawalRawInput,
          stateJson: {
            results: compactResults(results),
            verifiedSnapshot,
            withdrawalVerifyResults: compactResults(withdrawalVerifyResults),
            withdrawalSnapshot,
            simulatorInitialHash,
            lastRunCacheStats,
            clientUpdatedAt: Date.now(),
          },
        }),
      })
        .then((res) => {
          if (res.ok) setLastSavedAt(Date.now());
        })
        .catch(() => {})
        .finally(() => setIsSyncingCloud(false));
    }, 800);

    return () => clearTimeout(timer);
  }, [
    authToken,
    cloudWorkspaceReady,
    activeTab,
    networkId,
    customRpcUrl,
    rawInput,
    withdrawalRawInput,
    results,
    verifiedSnapshot,
    withdrawalVerifyResults,
    withdrawalSnapshot,
    simulatorInitialHash,
    lastRunCacheStats,
  ]);

  const handleSignIn = async () => {
    setAuthBusy(true);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch {
      // Popup closed or blocked
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    try {
      await signOut(auth);
    } finally {
      setAuthBusy(false);
    }
  };

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

  // Refresh L1 Prove/Finalize status of any restored unclaimed withdrawals on session load
  const didAutoRefreshRestoredWithdrawalsRef = useRef(false);
  useEffect(() => {
    if (didAutoRefreshRestoredWithdrawalsRef.current) return;
    if (activeNetworkConfig.rpcUrls.length === 0) return;

    const activeHashes = new Set<string>();
    for (const r of results) {
      if (r.withdrawal && !r.withdrawal.portalFinalized) {
        activeHashes.add(r.hash.toLowerCase());
      }
    }
    for (const r of withdrawalVerifyResults) {
      if (r.withdrawal && !r.withdrawal.portalFinalized) {
        activeHashes.add(r.hash.toLowerCase());
      }
    }

    if (activeHashes.size === 0) return;
    didAutoRefreshRestoredWithdrawalsRef.current = true;

    let cancelled = false;
    (async () => {
      const updates = new Map<string, VerifiedTransactionResult['withdrawal']>();
      await Promise.all(
        Array.from(activeHashes)
          .slice(0, 10)
          .map(async (h) => {
            try {
              const refreshed = await analyzeWithdrawalFromTxHash(
                h as Hex,
                activeNetworkConfig
              );
              if (refreshed) {
                updates.set(h, refreshed);
              }
            } catch {
              // Keep existing snapshot if offline
            }
          })
      );

      if (cancelled || updates.size === 0) return;

      setResults((prev) =>
        prev.map((row) => {
          const nextW = updates.get(row.hash.toLowerCase());
          return nextW ? { ...row, withdrawal: nextW } : row;
        })
      );
      setWithdrawalVerifyResults((prev) =>
        prev.map((row) => {
          const nextW = updates.get(row.hash.toLowerCase());
          return nextW ? { ...row, withdrawal: nextW } : row;
        })
      );
      setSelectedResult((prev) => {
        if (!prev) return null;
        const nextW = updates.get(prev.hash.toLowerCase());
        return nextW ? { ...prev, withdrawal: nextW } : prev;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeNetworkConfig, results, withdrawalVerifyResults]);

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

        // Persist any newly Finalized immutable results to local cache (+ cloud if signed in)
        const savedCount = saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          mergedRows
        );
        if (savedCount > 0) {
          setCacheVersion((v) => v + 1);
          syncFinalizedToCloud(mergedRows);
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

          if (authToken) {
            fetch('/api/runs', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({
                ...entry,
                results: entry.results.map((r) => ({ ...r, rawTx: null, rawReceipt: null })),
              }),
            }).catch(() => {});
          }

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
    [
      parsedBatch,
      activeNetworkConfig,
      headSnapshot,
      mergeWithdrawalsIntoTab,
      syncFinalizedToCloud,
      authToken,
    ]
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
          syncFinalizedToCloud(retriedRows);
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
    [activeNetworkConfig, mergeWithdrawalsIntoTab, results.length, syncFinalizedToCloud]
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

        const savedCount = saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          verifiedRows
        );
        if (savedCount > 0) {
          setCacheVersion((v) => v + 1);
          syncFinalizedToCloud(verifiedRows);
        }

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
    [parsedWithdrawalBatch, activeNetworkConfig, syncFinalizedToCloud]
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
        const savedCount = saveFinalizedResultsToCache(
          activeNetworkConfig.id,
          activeNetworkConfig.chainId,
          retriedRows
        );
        if (savedCount > 0) {
          setCacheVersion((v) => v + 1);
          syncFinalizedToCloud(retriedRows);
        }
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
    [activeNetworkConfig, syncFinalizedToCloud]
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

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div
              role="tablist"
              aria-label="検証モード切り替え"
              className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg"
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
                出金確定・シミュレーター
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'ai-audit'}
                onClick={() => setActiveTab('ai-audit')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeTab === 'ai-audit'
                    ? 'bg-white text-[#0052FF] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                AI監査チャット
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'guide'}
                onClick={() => setActiveTab('guide')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeTab === 'guide'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                検証ロジック
              </button>
            </div>

            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 px-1">
              {isSyncingCloud ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#0052FF]" />
                  <span>クラウド保存中...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>
                    {userEmail ? 'クラウド同期済' : 'ローカル自動保存済'}
                    {' · '}
                    {new Date(lastSavedAt).toLocaleTimeString('ja-JP', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </>
              )}
            </span>

            {userEmail ? (
              <button
                type="button"
                onClick={handleSignOut}
                disabled={authBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                title={`${userEmail} でクラウド同期中（クリックでサインアウト）`}
              >
                <span className="max-w-[140px] truncate">{userEmail}</span>
                <LogOut className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                disabled={authBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                title="Googleサインインで入力状態・検証結果・確定キャッシュ・履歴をクラウド保存します"
              >
                <LogIn className="w-3.5 h-3.5 text-[#0052FF]" />
                <span>Google同期ログイン</span>
              </button>
            )}
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
                if (authToken) {
                  fetch(
                    `/api/tx-cache?networkId=${encodeURIComponent(
                      activeNetworkConfig.id
                    )}&chainId=${activeNetworkConfig.chainId}`,
                    {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${authToken}` },
                    }
                  ).catch(() => {});
                }
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

        {activeTab === 'ai-audit' && (
          <AiAuditAssistantSection
            snapshot={verifiedSnapshot ?? withdrawalSnapshot ?? headSnapshot}
            results={results}
            withdrawalResults={withdrawalVerifyResults}
            authToken={authToken}
            userEmail={userEmail}
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
              if (authToken) {
                fetch('/api/runs', {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${authToken}` },
                }).catch(() => {});
              }
            }}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-12">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            Base Finality · オンチェーンJSON-RPC直接検証コンソール
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
