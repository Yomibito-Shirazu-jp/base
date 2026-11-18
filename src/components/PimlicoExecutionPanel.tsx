import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
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

  // TEE / ZK live inspection state
  const [liveTeeZk, setLiveTeeZk] = useState<TeeZkProofInspection | null>(
    withdrawalInfo.validation?.teeZk ?? null
  );
  const [isCheckingTeeZk, setIsCheckingTeeZk] = useState(false);
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

  const canProveNow =
    !withdrawalInfo.portalFinalized &&
    (withdrawalInfo.status === 'ready-to-prove' ||
      val?.proveState === 'unproven-ready' ||
      val?.proveState === 'invalid-need-reprove');

  const canFinalizeNow =
    !withdrawalInfo.portalFinalized &&
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

  const handleCheckTeeZk = async () => {
    setIsCheckingTeeZk(true);
    setTeeZkError(null);
    try {
      const res = await inspectWithdrawalTeeZkStatus(
        txHash as Hex,
        networkConfig
      );
      setLiveTeeZk(res.teeZk);
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
      {/* Section 1: DisputeGame TEE / ZK Multi-Proof Check & 1-Day vs 5-Day Window */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              出金ゲーム (DisputeGame) TEE / ZK 証明状態 ＆ 1日 / 5日 待機期間チェック
            </h3>
            <p className="mt-0.5 text-xs text-slate-600 leading-relaxed">
              Base L1 <span className="font-mono">AggregateVerifier</span>{' '}
              の待機期間は、<strong>単一証明（TEEのみ / ZKのみ）で 5日（432,000秒）</strong>、
              <strong>TEE と ZK の両方がある場合は 1日（86,400秒）</strong> に短縮されます。
            </p>
          </div>

          <button
            type="button"
            onClick={handleCheckTeeZk}
            disabled={isCheckingTeeZk}
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
                  activeSim
                    ? activeSim.finalizeSim.passed
                      ? 'text-emerald-700'
                      : 'text-red-700'
                    : val?.canWithdrawAfterWait
                    ? 'text-emerald-700'
                    : 'text-amber-700'
                }`}
              >
                {activeSim
                  ? activeSim.finalizeSim.alreadyCompletedOnChain
                    ? '資金受取完了済'
                    : activeSim.finalizeSim.executableNow
                    ? 'PASS (今すぐ資金受取可)'
                    : activeSim.finalizeSim.passed
                    ? 'PASS (待機後に着金確実)'
                    : '要確認'
                  : withdrawalInfo.portalFinalized
                  ? '資金受取完了済'
                  : val?.canWithdrawAfterWait
                  ? '着金ドライラン合格'
                  : '要確認'}
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
          <p className="text-xs text-slate-600 leading-relaxed">
            {canProveNow
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
