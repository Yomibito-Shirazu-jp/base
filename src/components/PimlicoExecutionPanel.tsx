import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Code2,
  Coins,
  Copy,
  ExternalLink,
  Play,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import type { Hex } from 'viem';
import {
  NetworkConfig,
  TeeZkProofInspection,
  WithdrawalInfo,
  WithdrawalSimulationResult,
} from '../types/finality';
import {
  formatSecondsJapanese,
  getDisputeGameStatusText,
  getProveLifecycleBadgeText,
  getWithdrawalProveDisplayMeta,
  inspectWithdrawalTeeZkStatus,
  simulateWithdrawalOnL1,
} from '../lib/withdrawalAnalyzer';
import {
  ExecutionMode,
  L1ExecutionOutcome,
  PimlicoAccountPreview,
  PimlicoExecutionSettings,
  PreparedWithdrawalActionCall,
  ServerAaStatus,
  SmartAccountKind,
  WithdrawalL1Action,
  executeWithdrawalOnL1,
  fetchServerAaStatus,
  prepareWithdrawalActionCall,
  previewPimlicoSmartAccount,
} from '../lib/withdrawalExecutor';
import { formatUnixTimestamp, shortenHex } from '../lib/exportUtils';

const AA_SESSION_PREFS_KEY = 'base-finality-aa-prefs-v2';

interface PimlicoExecutionPanelProps {
  txHash: string;
  withdrawalInfo: WithdrawalInfo;
  networkConfig: NetworkConfig;
  nowMs: number;
  externalSimResult?: WithdrawalSimulationResult | null;
  externalIsSimulating?: boolean;
  onRunExternalSimulation?: () => void;
  onWithdrawalUpdated?: (updated: WithdrawalInfo) => void;
  onExecutionCompleted?: () => void;
}

function loadSessionPrefs(): Partial<PimlicoExecutionSettings> {
  try {
    const raw = sessionStorage.getItem(AA_SESSION_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const mode: ExecutionMode =
      parsed.mode === 'alchemy' || parsed.mode === 'wallet'
        ? parsed.mode
        : 'pimlico';
    return {
      mode,
      usePaymaster:
        typeof parsed.usePaymaster === 'boolean' ? parsed.usePaymaster : true,
      smartAccountKind: parsed.smartAccountKind === 'safe' ? 'safe' : 'simple',
    };
  } catch {
    return {};
  }
}

export function PimlicoExecutionPanel({
  txHash,
  withdrawalInfo,
  networkConfig,
  nowMs,
  externalSimResult,
  externalIsSimulating,
  onRunExternalSimulation,
  onWithdrawalUpdated,
  onExecutionCompleted,
}: PimlicoExecutionPanelProps) {
  const initialPrefs = useMemo(() => loadSessionPrefs(), []);

  const [mode, setMode] = useState<ExecutionMode>(
    initialPrefs.mode ?? 'pimlico'
  );
  const [usePaymaster, setUsePaymaster] = useState(
    initialPrefs.usePaymaster ?? true
  );
  const [smartAccountKind, setSmartAccountKind] = useState<SmartAccountKind>(
    initialPrefs.smartAccountKind ?? 'simple'
  );

  const [aaStatus, setAaStatus] = useState<ServerAaStatus | null>(null);
  const [accountPreview, setAccountPreview] =
    useState<PimlicoAccountPreview | null>(null);
  const [isPreviewingAccount, setIsPreviewingAccount] = useState(false);

  // TEE / ZK & L1 Prove live inspection state
  const [liveTeeZk, setLiveTeeZk] = useState<TeeZkProofInspection | null>(
    withdrawalInfo.validation?.teeZk ?? null
  );
  const [isCheckingTeeZk, setIsCheckingTeeZk] = useState(false);
  const [isCheckingProveStatus, setIsCheckingProveStatus] = useState(false);
  const [lastProveCheckedAtMs, setLastProveCheckedAtMs] = useState<number>(
    withdrawalInfo.analyzedAtMs
  );
  const [teeZkError, setTeeZkError] = useState<string | null>(null);

  // 2-step L1 Simulation (proveWithdrawalTransaction + post-maturity finalizeWithdrawalTransaction)
  const [internalSim, setInternalSim] =
    useState<WithdrawalSimulationResult | null>(null);
  const [isInternalSimulating, setIsInternalSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  const [preparedCall, setPreparedCall] =
    useState<PreparedWithdrawalActionCall | null>(null);
  const [isPreparingCall, setIsPreparingCall] = useState(false);

  const [executingAction, setExecutingAction] =
    useState<WithdrawalL1Action | null>(null);
  const [stepMessage, setStepMessage] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [execOutcome, setExecOutcome] = useState<L1ExecutionOutcome | null>(
    null
  );
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchServerAaStatus()
      .then((status) => {
        if (!active) return;
        setAaStatus(status);
        if (!status.pimlicoEthConfigured && status.alchemyEthConfigured) {
          setMode((prev) => (prev === 'pimlico' ? 'alchemy' : prev));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        AA_SESSION_PREFS_KEY,
        JSON.stringify({ mode, usePaymaster, smartAccountKind })
      );
    } catch {
      // Ignore storage errors
    }
  }, [mode, usePaymaster, smartAccountKind]);

  useEffect(() => {
    setLiveTeeZk(withdrawalInfo.validation?.teeZk ?? null);
    setLastProveCheckedAtMs(withdrawalInfo.analyzedAtMs);
  }, [withdrawalInfo]);

  useEffect(() => {
    setInternalSim(null);
    setSimError(null);
    setTeeZkError(null);
    setPreparedCall(null);
    setExecError(null);
    setExecOutcome(null);
    setStepMessage(null);
  }, [txHash]);

  const activeSim = externalSimResult ?? internalSim;
  const isSimulating = Boolean(externalIsSimulating || isInternalSimulating);

  const settings: PimlicoExecutionSettings = useMemo(
    () => ({
      mode,
      usePaymaster,
      smartAccountKind,
    }),
    [mode, usePaymaster, smartAccountKind]
  );

  const val = withdrawalInfo.validation;
  const proveMeta = useMemo(
    () => getWithdrawalProveDisplayMeta(withdrawalInfo),
    [withdrawalInfo]
  );
  const activeTeeZk = liveTeeZk ?? activeSim?.teeZk ?? val?.teeZk ?? null;

  const elapsedSecSinceAnalyzed = Math.max(
    0,
    Math.floor((nowMs - withdrawalInfo.analyzedAtMs) / 1000)
  );

  const liveMaturityRemSec = useMemo(() => {
    if (withdrawalInfo.portalFinalized) return 0;
    if (
      val?.maturityRemainingSeconds === null ||
      val?.maturityRemainingSeconds === undefined
    ) {
      return withdrawalInfo.proofMaturityDelaySeconds;
    }
    if ((val.numProofSubmitters ?? 0) === 0) {
      return val.maturityRemainingSeconds;
    }
    return Math.max(0, val.maturityRemainingSeconds - elapsedSecSinceAnalyzed);
  }, [withdrawalInfo, val, elapsedSecSinceAnalyzed]);

  const liveGameRemSec = useMemo(() => {
    if (withdrawalInfo.portalFinalized) return 0;
    if (activeTeeZk && activeTeeZk.remainingToResolveSeconds !== null) {
      const elapsedSinceCheck = Math.max(
        0,
        Math.floor((nowMs - activeTeeZk.checkedAtMs) / 1000)
      );
      if (activeTeeZk.isReferenceLatestGame) {
        return activeTeeZk.activeWindowSeconds;
      }
      return Math.max(
        0,
        activeTeeZk.remainingToResolveSeconds - elapsedSinceCheck
      );
    }
    if (
      val?.gameResolutionRemainingSeconds === null ||
      val?.gameResolutionRemainingSeconds === undefined
    ) {
      return withdrawalInfo.disputeGameResolutionSeconds;
    }
    if (val.disputeGameCreatedAt === null) {
      return val.gameResolutionRemainingSeconds;
    }
    return Math.max(
      0,
      val.gameResolutionRemainingSeconds - elapsedSecSinceAnalyzed
    );
  }, [withdrawalInfo, val, activeTeeZk, nowMs, elapsedSecSinceAnalyzed]);

  const isZeroPayoutBlocked =
    !withdrawalInfo.portalFinalized &&
    (val?.canWithdrawAfterWait === false ||
      val?.recipientBalanceIncreased === false);

  const canProveNow =
    !withdrawalInfo.portalFinalized &&
    !isZeroPayoutBlocked &&
    (withdrawalInfo.status === 'ready-to-prove' ||
      val?.proveState === 'unproven-ready' ||
      val?.proveState === 'invalid-need-reprove');

  const canFinalizeNow =
    !withdrawalInfo.portalFinalized &&
    !isZeroPayoutBlocked &&
    (withdrawalInfo.status === 'ready-to-finalize' ||
      val?.proveState === 'proven-ready' ||
      ((val?.numProofSubmitters ?? 0) > 0 &&
        liveMaturityRemSec === 0 &&
        liveGameRemSec === 0 &&
        val?.disputeGameBlacklisted !== true));

  const l1ChainId =
    networkConfig.id === 'base-sepolia' || networkConfig.chainId === 84532
      ? 11155111
      : 1;
  const l1ChainLabel =
    l1ChainId === 11155111 ? 'Ethereum Sepolia' : 'Ethereum Mainnet';

  const pimlicoReady =
    l1ChainId === 11155111
      ? Boolean(aaStatus?.pimlicoSepoliaConfigured)
      : Boolean(aaStatus?.pimlicoEthConfigured);
  const alchemyReady =
    l1ChainId === 11155111
      ? Boolean(aaStatus?.alchemySepoliaConfigured)
      : Boolean(aaStatus?.alchemyEthConfigured);

  const copyValue = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // Ignore
    }
  };

  const handleRefreshProveStatus = async () => {
    setIsCheckingProveStatus(true);
    setTeeZkError(null);
    try {
      const res = await inspectWithdrawalTeeZkStatus(
        txHash as Hex,
        networkConfig
      );
      setLiveTeeZk(res.teeZk);
      setLastProveCheckedAtMs(Date.now());
      if (res.updatedWithdrawal) {
        onWithdrawalUpdated?.(res.updatedWithdrawal);
      }
    } catch (err) {
      setTeeZkError(
        err instanceof Error
          ? err.message
          : 'L1 Prove状態のオンチェーン照会に失敗しました'
      );
    } finally {
      setIsCheckingProveStatus(false);
    }
  };

  const handleCheckTeeZk = async () => {
    setIsCheckingTeeZk(true);
    setTeeZkError(null);
    try {
      const res = await inspectWithdrawalTeeZkStatus(
        txHash as Hex,
        networkConfig
      );
      setLiveTeeZk(res.teeZk);
      setLastProveCheckedAtMs(Date.now());
      if (res.updatedWithdrawal) {
        onWithdrawalUpdated?.(res.updatedWithdrawal);
      }
    } catch (err) {
      setTeeZkError(
        err instanceof Error
          ? err.message
          : 'DisputeGame の TEE / ZK 証明照会に失敗しました'
      );
    } finally {
      setIsCheckingTeeZk(false);
    }
  };

  const handleRunDualSimulation = async () => {
    if (onRunExternalSimulation) {
      onRunExternalSimulation();
      return;
    }
    setIsInternalSimulating(true);
    setSimError(null);
    try {
      const res = await simulateWithdrawalOnL1(txHash as Hex, networkConfig);
      setInternalSim(res);
      if (res.teeZk) {
        setLiveTeeZk(res.teeZk);
      }
    } catch (err) {
      setSimError(
        err instanceof Error
          ? err.message
          : 'Prove / Finalize の L1 シミュレーションに失敗しました'
      );
    } finally {
      setIsInternalSimulating(false);
    }
  };

  const handlePreviewAccount = async () => {
    setIsPreviewingAccount(true);
    setExecError(null);
    try {
      const preview = await previewPimlicoSmartAccount(
        settings,
        networkConfig,
        aaStatus
      );
      setAccountPreview(preview);
    } catch (err) {
      setExecError(
        err instanceof Error
          ? err.message
          : 'Smart Account の接続確認に失敗しました'
      );
    } finally {
      setIsPreviewingAccount(false);
    }
  };

  const handlePrepareCalldata = async (targetAction: WithdrawalL1Action) => {
    setIsPreparingCall(true);
    setExecError(null);
    try {
      const prepared = await prepareWithdrawalActionCall(
        txHash as Hex,
        targetAction,
        networkConfig
      );
      setPreparedCall(prepared);
    } catch (err) {
      setExecError(
        err instanceof Error ? err.message : 'L1 Calldata の構築に失敗しました'
      );
    } finally {
      setIsPreparingCall(false);
    }
  };

  const handleExecute = async (action: WithdrawalL1Action) => {
    setExecutingAction(action);
    setExecError(null);
    setExecOutcome(null);
    setStepMessage('オンチェーン実行準備を開始しています...');
    try {
      const outcome = await executeWithdrawalOnL1({
        txHash: txHash as Hex,
        action,
        settings,
        networkConfig,
        onStep: (msg) => setStepMessage(msg),
      });
      setExecOutcome(outcome);
      setStepMessage(null);
      onExecutionCompleted?.();
    } catch (err) {
      setExecError(
        err instanceof Error
          ? err.message
          : 'L1 トランザクション実行に失敗しました'
      );
      setStepMessage(null);
    } finally {
      setExecutingAction(null);
    }
  };

  return (
    <div className="border border-slate-200 rounded-xl bg-white divide-y divide-slate-100">
      {/* Section 0: Unmistakable L1 Prove Status Verdict & 3-Step Withdrawal Progress */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-500">
              あなたの出金の L1 Prove（出金証明）ステータス判定
            </div>
            <div
              className={`mt-1 flex items-center gap-2 text-base font-bold ${
                proveMeta.isProven
                  ? 'text-emerald-700'
                  : proveMeta.stateKind === 'reprove'
                  ? 'text-red-700'
                  : 'text-amber-800'
              }`}
            >
              {proveMeta.isProven ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : proveMeta.stateKind === 'reprove' ? (
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
              ) : (
                <Clock className="w-5 h-5 text-amber-600 shrink-0" />
              )}
              <span>{proveMeta.headline}</span>
            </div>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              {proveMeta.subline}
            </p>
          </div>

          <div className="flex flex-col items-start sm:items-end gap-1 shrink-0">
            <button
              type="button"
              onClick={handleRefreshProveStatus}
              disabled={isCheckingProveStatus || isCheckingTeeZk}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isCheckingProveStatus ? 'animate-spin' : ''
                }`}
              />
              <span>
                {isCheckingProveStatus
                  ? 'L1 Prove状態を照会中...'
                  : 'Prove状態をオンチェーン再確認'}
              </span>
            </button>
            <span className="text-[11px] font-mono tabular-nums text-slate-500">
              最終照会: {formatUnixTimestamp(Math.floor(lastProveCheckedAtMs / 1000))}
            </span>
          </div>
        </div>

        {/* 3-Step Horizontal L2->L1 Progress Tracker */}
        <div className="border border-slate-200 rounded-xl grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          {/* Step 1: Base L2 Withdrawal Initiated */}
          <div className="p-3.5 space-y-1 bg-emerald-50/30">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-700">
                STEP 1 · Base L2 出金開始
              </span>
              <span className="font-bold text-emerald-700 inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                <span>完了</span>
              </span>
            </div>
            <div className="text-xs font-mono text-slate-700">
              {withdrawalInfo.amountFormatted} {withdrawalInfo.assetSymbol}
            </div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              MessagePasser記録: {val?.messagePasser.sentMessageRecorded !== false ? '確認済 ✓' : '未確認'}
            </div>
          </div>

          {/* Step 2: Ethereum L1 Prove */}
          <div
            className={`p-3.5 space-y-1 ${
              proveMeta.isProven
                ? 'bg-emerald-50/50'
                : proveMeta.stateKind === 'reprove'
                ? 'bg-red-50/50'
                : 'bg-amber-50/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-900">
                STEP 2 · L1 出金証明 (Prove)
              </span>
              <span
                className={`font-bold whitespace-nowrap ${
                  proveMeta.isProven
                    ? 'text-emerald-700'
                    : proveMeta.stateKind === 'reprove'
                    ? 'text-red-700'
                    : 'text-amber-800'
                }`}
              >
                {proveMeta.isProven
                  ? 'Prove済 ✓'
                  : proveMeta.stateKind === 'reprove'
                  ? '要再Prove'
                  : '未Prove (未提出)'}
              </span>
            </div>

            {proveMeta.isProven ? (
              <div className="space-y-0.5 text-[11px] font-mono text-slate-700">
                <div>
                  登録数: {val?.numProofSubmitters && val.numProofSubmitters > 0 ? `${val.numProofSubmitters}件` : '確認済'}
                  {val?.provenTimestamp
                    ? ` · ${formatUnixTimestamp(val.provenTimestamp)}`
                    : ''}
                </div>
                {val?.proofSubmitter && (
                  <div className="flex items-center gap-1 truncate">
                    <span>提出者: {shortenHex(val.proofSubmitter, 8, 6)}</span>
                    <button
                      type="button"
                      onClick={() => copyValue('submitter', val.proofSubmitter!)}
                      className="text-slate-400 hover:text-slate-700 cursor-pointer shrink-0"
                      aria-label="Prove提出者アドレスをコピー"
                    >
                      {copiedField === 'submitter' ? (
                        <Check className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span>
                    1日成熟:{' '}
                    {liveMaturityRemSec === 0
                      ? '完了 ✓'
                      : `残り ${formatSecondsJapanese(liveMaturityRemSec)}`}
                  </span>
                  {val?.l1ProveTxHash && networkConfig.l1ExplorerUrl && (
                    <a
                      href={`${networkConfig.l1ExplorerUrl}/tx/${val.l1ProveTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-sans font-semibold text-[#0052FF] hover:underline shrink-0"
                    >
                      <span>L1 Prove Tx</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-0.5 text-[11px] text-slate-700">
                <div className="font-mono text-amber-900">
                  numProofSubmitters = {val?.numProofSubmitters ?? 0} (証明記録なし)
                </div>
                <div>
                  {canProveNow
                    ? '今すぐ下の「1. 出金証明を提出」ボタンからProveを実行できます'
                    : `L1 DisputeGame 提案待ち（残り目安 ${formatSecondsJapanese(
                        withdrawalInfo.secondsToProve
                      )}）`}
                </div>
              </div>
            )}
          </div>

          {/* Step 3: Ethereum L1 Finalize / Receive Funds */}
          <div
            className={`p-3.5 space-y-1 ${
              isZeroPayoutBlocked
                ? 'bg-red-50/50'
                : withdrawalInfo.portalFinalized || canFinalizeNow
                ? 'bg-emerald-50/40'
                : 'bg-slate-50/40'
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-900">
                STEP 3 · L1 資金受け取り (Finalize)
              </span>
              <span
                className={`font-bold whitespace-nowrap ${
                  isZeroPayoutBlocked
                    ? 'text-red-700'
                    : withdrawalInfo.portalFinalized || canFinalizeNow
                    ? 'text-emerald-700'
                    : 'text-slate-600'
                }`}
              >
                {withdrawalInfo.portalFinalized
                  ? '受取完了 ✓'
                  : isZeroPayoutBlocked
                  ? '着金不可 (受取 0)'
                  : canFinalizeNow
                  ? '今すぐ受取可 ✓'
                  : '待機中'}
              </span>
            </div>
            <div
              className={`text-[11px] font-mono tabular-nums ${
                isZeroPayoutBlocked ? 'text-red-800' : 'text-slate-700'
              }`}
            >
              {withdrawalInfo.portalFinalized
                ? 'finalizedWithdrawals = true'
                : isZeroPayoutBlocked
                ? 'Finalizeを実行しないでください（L1ガス代のみ消費）'
                : canFinalizeNow
                ? '全待機期間クリア · 着金実行可能'
                : proveMeta.isProven
                ? `ゲーム解決残り: ${formatSecondsJapanese(liveGameRemSec)}`
                : 'STEP 2 の Prove 提出後にカウント開始'}
            </div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              L1受取先: {shortenHex(withdrawalInfo.l1Recipient, 8, 6)}
            </div>
          </div>
        </div>
      </div>

      {/* Section 1: DisputeGame TEE / ZK Multi-Proof Check & 1-Day vs 5-Day Window */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              ブロック検証ゲーム (DisputeGame) の TEE / ZK 証明状態 ＆ 1日 / 5日 待機期間チェック
            </h3>
            <p className="mt-0.5 text-xs text-slate-600 leading-relaxed">
              ※ こちらはネットワーク側のブロック検証証明（待機期間を決める条件）です。
              <strong>単一証明（TEEのみ / ZKのみ）は 5日（432,000秒）</strong>、
              <strong>TEE と ZK の両方がある場合は 1日（86,400秒）</strong> になります。
            </p>
          </div>

          <button
            type="button"
            onClick={handleCheckTeeZk}
            disabled={isCheckingTeeZk || isCheckingProveStatus}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0052FF] bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isCheckingTeeZk ? 'animate-spin' : ''}`}
            />
            <span>
              {isCheckingTeeZk ? 'TEE / ZK 照会中...' : 'TEE / ZK 証明チェック'}
            </span>
          </button>
        </div>

        {teeZkError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {teeZkError}
          </div>
        )}

        {/* 4-Column TEE / ZK & Prove Lock Breakdown */}
        <div className="border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-100 bg-slate-50/50">
          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              TEE 証明 (teeProver)
            </div>
            <div
              className={`mt-1 text-sm font-bold ${
                activeTeeZk?.hasTeeProof ? 'text-emerald-700' : 'text-slate-700'
              }`}
            >
              {activeTeeZk
                ? activeTeeZk.hasTeeProof
                  ? '検証済 (あり)'
                  : '未提出 (なし)'
                : '未照会'}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-500 truncate">
              {activeTeeZk?.teeProver
                ? `Prover: ${shortenHex(activeTeeZk.teeProver, 8, 6)}`
                : 'TEE Attestation'}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              ZK 証明 (zkProver)
            </div>
            <div
              className={`mt-1 text-sm font-bold ${
                activeTeeZk?.hasZkProof ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {activeTeeZk
                ? activeTeeZk.hasZkProof
                  ? '検証済 (あり)'
                  : '未提出 (なし)'
                : '未照会'}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-500 truncate">
              {activeTeeZk?.zkProver
                ? `Prover: ${shortenHex(activeTeeZk.zkProver, 8, 6)}`
                : 'ZK Validity Proof'}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              適用ゲーム待機枠 (1日 / 5日)
            </div>
            <div
              className={`mt-1 text-sm font-bold font-mono tabular-nums ${
                activeTeeZk?.windowMode === 'dual-1d'
                  ? 'text-emerald-700'
                  : 'text-slate-900'
              }`}
            >
              {activeTeeZk?.windowMode === 'dual-1d'
                ? '1日 (TEE+ZK 両方あり)'
                : `5日 (単一証明 ${activeTeeZk?.proofCount ?? 1}/2)`}
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-600 truncate">
              {withdrawalInfo.portalFinalized
                ? 'ゲーム解決済'
                : `解決残り: ${formatSecondsJapanese(liveGameRemSec)}`}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              L1 Prove 状態 / 成熟残り (1日)
            </div>
            <div className="mt-1 text-sm font-bold font-mono tabular-nums text-slate-900">
              {val
                ? val.numProofSubmitters > 0
                  ? `Prove済 · 残り ${formatSecondsJapanese(liveMaturityRemSec)}`
                  : getProveLifecycleBadgeText(val.proveState)
                : '—'}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-500 truncate">
              {activeTeeZk?.disputeGameAddress
                ? `Game: ${shortenHex(activeTeeZk.disputeGameAddress, 6, 4)} · ${getDisputeGameStatusText(
                    activeTeeZk.gameStatus
                  ).split(' ')[0]}`
                : 'L1 OptimismPortal2'}
            </div>
          </div>
        </div>

        {activeTeeZk && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>{activeTeeZk.summary}</span>
            {activeTeeZk.expectedResolution && (
              <span className="font-mono tabular-nums text-slate-500 shrink-0">
                expectedResolution: {formatUnixTimestamp(activeTeeZk.expectedResolution)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Section 2: Explicit 2-Step Simulation (proveWithdrawalTransaction & Post-Maturity finalizeWithdrawalTransaction) */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900">
              L1 資産受取 2段階シミュレーション（proveWithdrawalTransaction ＆ 成熟待機後 finalizeWithdrawalTransaction）
            </h4>
            <p className="mt-0.5 text-xs text-slate-600">
              L1 で実際に資産を受け取るための <span className="font-mono">proveWithdrawalTransaction</span> と、成熟待機後の{' '}
              <span className="font-mono">finalizeWithdrawalTransaction</span> の両方をオンチェーン検証します。
            </p>
          </div>

          <button
            type="button"
            onClick={handleRunDualSimulation}
            disabled={isSimulating}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSimulating ? 'animate-spin' : ''}`}
            />
            <span>
              {isSimulating
                ? '2段階シミュレーション実行中...'
                : 'Prove ＆ 成熟後 Finalize シミュレーションを実行'}
            </span>
          </button>
        </div>

        {simError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {simError}
          </div>
        )}

        <div className="border border-slate-200 rounded-xl grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          {/* Step 1: proveWithdrawalTransaction */}
          <div className="p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold font-mono text-slate-900">
                1. proveWithdrawalTransaction
              </span>
              <span
                className={`text-xs font-semibold shrink-0 ${
                  activeSim
                    ? activeSim.proveSim.passed
                      ? 'text-emerald-700'
                      : 'text-red-700'
                    : val?.messagePasser.merkleProofVerified
                    ? 'text-emerald-700'
                    : 'text-slate-500'
                }`}
              >
                {activeSim
                  ? activeSim.proveSim.alreadyCompletedOnChain
                    ? '提出完了済'
                    : activeSim.proveSim.executableNow
                    ? 'PASS (今すぐ送信可)'
                    : activeSim.proveSim.passed
                    ? 'MPT証明合格 (提案待ち)'
                    : '要確認'
                  : (val?.numProofSubmitters ?? 0) > 0
                  ? '提出完了済'
                  : canProveNow
                  ? '送信可能 (シミュ未実行)'
                  : '提案待ち'}
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {activeSim
                ? activeSim.proveSim.summary
                : (val?.numProofSubmitters ?? 0) > 0
                ? `L1 OptimismPortal2 に既に証明提出済みです (${val?.numProofSubmitters}件)。`
                : '上のシミュレーションボタンを押すと L2 ストレージ証明と L1 ガス見積を検証します。'}
            </p>
            {activeSim && !activeSim.proveSim.alreadyCompletedOnChain && (
              <div className="text-[11px] font-mono tabular-nums text-slate-500">
                推定Gas: {Number(activeSim.proveSim.estimatedGas).toLocaleString()} · 約{' '}
                {activeSim.proveSim.estimatedFeeEth} ETH
              </div>
            )}
          </div>

          {/* Step 2: finalizeWithdrawalTransaction */}
          <div className="p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold font-mono text-slate-900">
                2. 成熟待機後 finalizeWithdrawalTransaction
              </span>
              <span
                className={`text-xs font-semibold shrink-0 ${
                  withdrawalInfo.portalFinalized
                    ? 'text-emerald-700'
                    : activeSim
                    ? activeSim.finalizeSim.passed
                      ? 'text-emerald-700'
                      : 'text-red-700'
                    : val?.canWithdrawAfterWait
                    ? 'text-emerald-700'
                    : 'text-red-700'
                }`}
              >
                {withdrawalInfo.portalFinalized
                  ? '資金受取完了済'
                  : activeSim
                  ? activeSim.finalizeSim.alreadyCompletedOnChain
                    ? '資金受取完了済'
                    : activeSim.finalizeSim.executableNow &&
                      activeSim.finalizeSim.passed
                    ? 'PASS (今すぐ資金受取可)'
                    : activeSim.finalizeSim.passed
                    ? 'PASS (実測L1着金確認済)'
                    : val?.recipientBalanceIncreased === false
                    ? `着金不可 (実測受取 0 ${withdrawalInfo.assetSymbol})`
                    : '着金不可 (阻害要因あり)'
                  : val?.canWithdrawAfterWait
                  ? 'PASS (実測L1着金確認済)'
                  : val?.recipientBalanceIncreased === false
                  ? `着金不可 (実測受取 0 ${withdrawalInfo.assetSymbol})`
                  : '着金不可 (阻害要因あり)'}
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {activeSim
                ? activeSim.finalizeSim.summary
                : val?.verdictSummary ??
                  '成熟待機経過後に受取人へ資産が送出されるかを L1 EVM 上で検証します。'}
            </p>
            {activeSim && !activeSim.finalizeSim.alreadyCompletedOnChain && (
              <div className="text-[11px] font-mono tabular-nums text-slate-500">
                推定Gas: {Number(activeSim.finalizeSim.estimatedGas).toLocaleString()} · 約{' '}
                {activeSim.finalizeSim.estimatedFeeEth} ETH
              </div>
            )}
          </div>
        </div>

        {val &&
          (val.portalTopLevelFinalizePassed !== undefined ||
            (val.cdmHops && val.cdmHops.length > 0)) && (
            <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 bg-slate-50/40">
              <div className="px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold text-slate-700">
                <span>
                  L1 確定フレーム ＆ 実測受取残高（Multicall3）検査
                </span>
                <span className="font-mono text-slate-500">
                  外枠メソッド: {val.winningFinalizeFrame ?? 'finalizeExternalProof'}
                </span>
              </div>
              <div
                className={`px-3.5 py-2.5 text-[11px] space-y-1 ${
                  val.recipientBalanceIncreased === false ||
                  val.outerPortalRelaySimulated === false
                    ? 'bg-red-50/60'
                    : 'bg-emerald-50/30'
                }`}
              >
                <div className="font-mono flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-slate-700 font-semibold">1. Portal外枠Tx:</span>
                  <span
                    className={
                      val.portalTopLevelFinalizePassed === false
                        ? 'text-red-700 font-semibold'
                        : val.outerPortalRelaySimulated === false
                        ? 'text-amber-800 font-semibold'
                        : 'text-emerald-700 font-semibold'
                    }
                  >
                    {val.portalTopLevelFinalizePassed === true
                      ? val.outerPortalRelaySimulated === false
                        ? '非Revert (SafeCallが内部失敗を吸収)'
                        : 'PASS (Revertなし)'
                      : val.portalTopLevelFinalizePassed === false
                      ? 'Revert'
                      : '照会済'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-700 font-semibold">2. Hop 1 中継:</span>
                  <span
                    className={
                      val.outerPortalRelaySimulated === false
                        ? 'text-red-700 font-bold'
                        : 'text-emerald-700 font-semibold'
                    }
                  >
                    {val.outerPortalRelaySimulated === false
                      ? 'Revert (ここで処理停止)'
                      : val.outerPortalRelaySimulated === true
                      ? 'PASS'
                      : '—'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-700 font-semibold">3. リーフ着金:</span>
                  <span
                    className={
                      val.outerPortalRelaySimulated === false
                        ? 'text-slate-500 font-medium'
                        : val.leafBridgeCallPassed !== false
                        ? 'text-emerald-700 font-semibold'
                        : 'text-red-700 font-semibold'
                    }
                  >
                    {val.outerPortalRelaySimulated === false
                      ? '未到達 (Hop 1停止のため実行されず)'
                      : val.leafBridgeCallPassed === true
                      ? 'PASS'
                      : val.leafBridgeCallPassed === false
                      ? 'Revert'
                      : '—'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-900 font-semibold">実測L1着金額:</span>
                  <span
                    className={
                      val.recipientBalanceIncreased === false
                        ? 'text-red-700 font-bold'
                        : 'text-emerald-700 font-bold'
                    }
                  >
                    {val.recipientBalanceIncreased === false
                      ? `0 ${withdrawalInfo.assetSymbol}（着金しません）`
                      : val.recipientBalanceIncreased === true
                      ? `+${withdrawalInfo.amountFormatted} ${withdrawalInfo.assetSymbol}（着金確認済 ✓）`
                      : '—'}
                  </span>
                </div>
                {val.recipientBalanceIncreased === false && (
                  <p className="text-[11px] text-red-800 leading-relaxed">
                    ※ 外枠の finalizeWithdrawalTransactionExternalProof は SafeCall により Revert しませんが、Hop 1 で停止するため L1 受取アドレスの残高は 1 枚も増えません（L1ガス代のみ消費されるため確定実行は行わないでください）。
                  </p>
                )}
              </div>
              {val.cdmHops?.map((hop) => {
                const nonceCounter = BigInt(hop.nonce) & ((1n << 240n) - 1n);
                const blockedByEarlierHop =
                  hop.hopIndex > 1 && val.outerPortalRelaySimulated === false;
                return (
                  <div
                    key={`${hop.hopIndex}-${hop.versionedHash}`}
                    className="px-3.5 py-2.5 space-y-1 text-[11px]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        Hop {hop.hopIndex} · CDM nonce #{nonceCounter.toString()}
                      </span>
                      <span
                        className={`font-mono font-semibold ${
                          hop.standaloneRelayPassed === false
                            ? 'text-red-700'
                            : blockedByEarlierHop
                            ? 'text-slate-500'
                            : hop.standaloneRelayPassed === true
                            ? 'text-emerald-700'
                            : 'text-slate-600'
                        }`}
                      >
                        {hop.standaloneRelayPassed === false
                          ? 'Revert（本番実行時はここで停止）'
                          : blockedByEarlierHop
                          ? '単体テスト時はPASS（本番ではHop 1停止のため未到達）'
                          : hop.standaloneRelayPassed === true
                          ? 'フレーム実行: PASS'
                          : 'オンチェーン状態照会済'}
                      </span>
                    </div>
                    <div className="font-mono text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>sender: {shortenHex(hop.sender, 8, 6)}</span>
                      <span aria-hidden="true">→</span>
                      <span>target: {shortenHex(hop.target, 8, 6)}</span>
                      <span aria-hidden="true">·</span>
                      <span>successfulMessages: {String(hop.successfulMessage ?? '—')}</span>
                      <span aria-hidden="true">·</span>
                      <span>failedMessages: {String(hop.failedMessage ?? '—')}</span>
                    </div>
                    {hop.standaloneRelayError && (
                      <div className="font-mono text-red-700 break-words">
                        Revert理由: {hop.standaloneRelayError}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>

      {/* Section 3: L1 Execution & Prominent 「資金を受け取る」 Button */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="inline-flex flex-wrap p-1 bg-slate-100 rounded-lg self-start gap-1">
            <button
              type="button"
              onClick={() => setMode('pimlico')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                mode === 'pimlico'
                  ? 'bg-white text-[#0052FF] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Pimlico ERC-4337{pimlicoReady ? ' (接続済)' : ''}
            </button>
            <button
              type="button"
              onClick={() => setMode('alchemy')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                mode === 'alchemy'
                  ? 'bg-white text-[#0052FF] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Alchemy Gas Manager{alchemyReady ? ' (接続済)' : ''}
            </button>
            <button
              type="button"
              onClick={() => setMode('wallet')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                mode === 'wallet'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ブラウザウォレット直接送信 (EOA)
            </button>
          </div>

          <div className="text-xs text-slate-500 font-mono">
            L1受取アドレス: {shortenHex(withdrawalInfo.l1Recipient, 10, 8)} ({l1ChainLabel})
          </div>
        </div>

        {!withdrawalInfo.portalFinalized && mode !== 'wallet' && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs">
            <div className="flex flex-wrap items-center gap-4">
              <div className="inline-flex items-center gap-1.5">
                <span className="text-slate-500 font-medium">Smart Account:</span>
                <button
                  type="button"
                  onClick={() => setSmartAccountKind('simple')}
                  className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                    smartAccountKind === 'simple'
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  SimpleAccount
                </button>
                <button
                  type="button"
                  onClick={() => setSmartAccountKind('safe')}
                  className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                    smartAccountKind === 'safe'
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Safe v1.4.1
                </button>
              </div>

              <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={usePaymaster}
                  onChange={(e) => setUsePaymaster(e.target.checked)}
                  className="rounded border-slate-300 text-[#0052FF] focus:ring-[#0052FF]"
                />
                <span>
                  Paymaster ガス代スポンサー適用
                  {mode === 'pimlico' && aaStatus?.pimlicoPolicyConfigured
                    ? ' (Pimlico Policy設定済)'
                    : mode === 'alchemy' && aaStatus?.alchemyPolicyConfigured
                    ? ' (Alchemy Policy設定済)'
                    : ''}
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={handlePreviewAccount}
              disabled={isPreviewingAccount}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isPreviewingAccount ? 'animate-spin' : ''
                }`}
              />
              <span>Smart Account 接続確認</span>
            </button>
          </div>
        )}

        {!withdrawalInfo.portalFinalized && mode === 'wallet' && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs text-slate-700 flex items-center gap-2.5">
            <Wallet className="w-4 h-4 text-[#0052FF] shrink-0" />
            <span>
              ブラウザウォレットを <strong className="font-mono">{l1ChainLabel}</strong>{' '}
              に切り替え、<span className="font-mono">OptimismPortal2</span>{' '}
              へ直接送信します（別アドレスでProve済みの出金もそのまま資金受け取り可能）。
            </span>
          </div>
        )}

        {accountPreview && mode !== 'wallet' && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">
                {accountPreview.provider === 'pimlico' ? 'Pimlico' : 'Alchemy'} Bundler プロキシ接続OK ({accountPreview.l1ChainName})
              </span>
              <span className="font-mono tabular-nums text-slate-600">
                MaxFee: {accountPreview.fastMaxFeeGwei} Gwei
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-slate-700">
              <div className="flex items-center gap-1.5">
                <span className="font-sans text-slate-500">Smart Account:</span>
                <span className="truncate">{accountPreview.smartAccountAddress}</span>
                <button
                  type="button"
                  onClick={() =>
                    copyValue('sa', accountPreview.smartAccountAddress)
                  }
                  className="text-slate-400 hover:text-slate-700 cursor-pointer shrink-0"
                  aria-label="Smart Account アドレスをコピー"
                >
                  {copiedField === 'sa' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <div>
                <span className="font-sans text-slate-500">状態 / 残高: </span>
                <span>
                  {accountPreview.isDeployed
                    ? 'Deployed'
                    : '未デプロイ (初回自動展開)'}{' '}
                  · {accountPreview.smartAccountEthBalance} ETH
                </span>
              </div>
            </div>
            <div className="text-[11px] text-slate-600">
              {accountPreview.sponsorshipPolicyNote}
            </div>
          </div>
        )}

        {/* Primary Prove & Receive Funds CTA Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => handleExecute('prove')}
              disabled={executingAction !== null || !canProveNow}
              title={
                canProveNow
                  ? 'Ethereum L1 OptimismPortal2 に proveWithdrawalTransaction を送信します'
                  : withdrawalInfo.portalFinalized || (val?.numProofSubmitters ?? 0) > 0
                  ? '既に Prove 提出済みです'
                  : 'L1 DisputeGame 提案到達後に実行可能になります'
              }
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {executingAction === 'prove' ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>出金証明 (Prove) 送信中...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    1. 出金証明を提出 (proveWithdrawalTransaction)
                    {(val?.numProofSubmitters ?? 0) > 0 &&
                    val?.proveState !== 'invalid-need-reprove'
                      ? ' · 提出済'
                      : ''}
                  </span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleExecute('finalize')}
              disabled={executingAction !== null || !canFinalizeNow}
              title={
                withdrawalInfo.portalFinalized
                  ? '既に L1 で資金受け取りが完了しています'
                  : canFinalizeNow
                  ? 'finalizeWithdrawalTransaction を実行して L1 受取アドレスへ資金を送出します'
                  : 'Prove提出および待機期間（TEE+ZK両方: 1日 / 単一証明: 5日）完了後に資金を受け取れます'
              }
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {executingAction === 'finalize' ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>資金受け取り処理を実行中...</span>
                </>
              ) : withdrawalInfo.portalFinalized ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    資金受け取り完了済 ({withdrawalInfo.amountFormatted}{' '}
                    {withdrawalInfo.assetSymbol})
                  </span>
                </>
              ) : isZeroPayoutBlocked ? (
                <>
                  <AlertTriangle className="w-4 h-4" />
                  <span>
                    受取不可・実行停止中 (実測着金 0{' '}
                    {withdrawalInfo.assetSymbol})
                  </span>
                </>
              ) : (
                <>
                  <Coins className="w-4 h-4" />
                  <span>
                    資金を受け取る ({withdrawalInfo.amountFormatted}{' '}
                    {withdrawalInfo.assetSymbol})
                  </span>
                </>
              )}
            </button>
          </div>

          {(canProveNow || canFinalizeNow) && (
            <button
              type="button"
              onClick={() =>
                handlePrepareCalldata(canFinalizeNow ? 'finalize' : 'prove')
              }
              disabled={isPreparingCall || executingAction !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>
                {isPreparingCall ? '構築中...' : '送信Calldataをプレビュー'}
              </span>
            </button>
          )}
        </div>

        {!withdrawalInfo.portalFinalized && !canFinalizeNow && (
          <p
            className={`text-xs leading-relaxed ${
              isZeroPayoutBlocked
                ? 'text-red-800 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5'
                : 'text-slate-600'
            }`}
          >
            {isZeroPayoutBlocked
              ? `【対処方法】このトランザクションは放置して構いません（Base側で ${withdrawalInfo.assetSymbol} は1枚も引き落とされていません。L1でFinalizeするとガス代だけ損するためボタンを安全停止しています）。実際に残高が入っているウォレットから公式ブリッジ（L2StandardBridge）経由で新しく出金を実行してください。`
              : canProveNow
              ? '現在「1. 出金証明を提出 (proveWithdrawalTransaction)」を実行できます。Prove提出後、ゲーム待機期間（TEE+ZK両方: 1日 / 単一証明: 5日）と成熟期間（1日）が経過すると「資金を受け取る」ボタンが有効になります。'
              : withdrawalInfo.status === 'waiting-to-prove'
              ? '現在 L1 DisputeGame 提案待ちです（通常 約25〜30分で提案され、Prove提出が可能になります）。'
              : `現在ロック期間待機中です（ゲーム解決残り: ${formatSecondsJapanese(
                  liveGameRemSec
                )} / Prove後成熟残り: ${formatSecondsJapanese(
                  liveMaturityRemSec
                )}）。期間完了後すぐに「資金を受け取る」ボタンから着金を実行できます。`}
          </p>
        )}

        {stepMessage && (
          <div className="bg-blue-50/80 border border-blue-200 text-slate-900 rounded-xl px-4 py-3 text-xs flex items-center gap-2.5">
            <RefreshCw className="w-4 h-4 text-[#0052FF] animate-spin shrink-0" />
            <span>{stepMessage}</span>
          </div>
        )}

        {execError && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span className="break-words">{execError}</span>
          </div>
        )}

        {execOutcome && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-xl p-4 space-y-2 text-xs">
            <div className="flex items-center gap-2 font-bold text-emerald-800">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>
                {execOutcome.action === 'prove'
                  ? 'L1 出金証明 (proveWithdrawalTransaction) がオンチェーンで確定しました'
                  : `L1 資金受け取り (finalizeWithdrawalTransaction) が完了し、${withdrawalInfo.amountFormatted} ${withdrawalInfo.assetSymbol} が送出されました`}
              </span>
            </div>
            <div className="font-mono space-y-1 text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-sans text-emerald-800">L1 Tx Hash:</span>
                <span className="break-all">{execOutcome.l1TxHash}</span>
                {networkConfig.l1ExplorerUrl && (
                  <a
                    href={`${networkConfig.l1ExplorerUrl}/tx/${execOutcome.l1TxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[#0052FF] hover:underline font-sans font-semibold"
                  >
                    <span>Etherscanで確認</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              {execOutcome.userOpHash && (
                <div className="break-all">
                  <span className="font-sans text-emerald-800">
                    UserOperation Hash:{' '}
                  </span>
                  {execOutcome.userOpHash}
                </div>
              )}
              {execOutcome.smartAccountAddress && (
                <div>
                  <span className="font-sans text-emerald-800">
                    実行 Smart Account:{' '}
                  </span>
                  {execOutcome.smartAccountAddress}
                </div>
              )}
            </div>
          </div>
        )}

        {preparedCall && (
          <div className="bg-slate-900 text-slate-100 rounded-xl p-3.5 space-y-2 text-[11px] font-mono">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-300 font-sans font-semibold">
                構築済み L1 Calldata ({preparedCall.functionName}
                {preparedCall.disputeGameIndex !== null
                  ? ` · Game #${preparedCall.disputeGameIndex}`
                  : ''}
                {preparedCall.estimatedGas
                  ? ` · 推定Gas ${preparedCall.estimatedGas.toLocaleString()}`
                  : ''}
                )
              </span>
              <button
                type="button"
                onClick={() => copyValue('calldata', preparedCall.callData)}
                className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-sans cursor-pointer"
              >
                {copiedField === 'calldata' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>コピー済</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Calldataコピー</span>
                  </>
                )}
              </button>
            </div>
            <div className="text-slate-400">
              To (OptimismPortal2): {preparedCall.portalAddress}
            </div>
            <div className="max-h-28 overflow-y-auto break-all text-slate-200 leading-relaxed">
              {preparedCall.callData}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
