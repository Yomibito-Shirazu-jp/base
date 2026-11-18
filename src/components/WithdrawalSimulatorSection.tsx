import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Play,
  RefreshCw,
  ShieldCheck,
  ArrowRight,
  Coins,
} from 'lucide-react';
import type { Hex } from 'viem';
import {
  NetworkConfig,
  TeeZkProofInspection,
  VerifiedTransactionResult,
  WithdrawalInfo,
  WithdrawalSimulationResult,
} from '../types/finality';
import {
  LiveWithdrawalConditions,
  analyzeWithdrawalFromTxHash,
  fetchLiveWithdrawalConditions,
  fetchRecentProvenWithdrawalSample,
  fetchRecentWithdrawalSamples,
  formatSecondsJapanese,
  getWithdrawalProveDisplayMeta,
  getWithdrawalStatusLabel,
  inspectLatestDisputeGameTeeZk,
  simulateWithdrawalOnL1,
} from '../lib/withdrawalAnalyzer';
import { formatUnixTimestamp, shortenHex } from '../lib/exportUtils';
import { PimlicoExecutionPanel } from './PimlicoExecutionPanel';

interface WithdrawalSimulatorSectionProps {
  networkConfig: NetworkConfig;
  verifiedWithdrawals: VerifiedTransactionResult[];
  initialTxHash?: string | null;
  onValidWithdrawalAnalyzed?: (txHash: string, info: WithdrawalInfo) => void;
}

export function WithdrawalSimulatorSection({
  networkConfig,
  verifiedWithdrawals,
  initialTxHash,
  onValidWithdrawalAnalyzed,
}: WithdrawalSimulatorSectionProps) {
  const [txHashInput, setTxHashInput] = useState(initialTxHash ?? '');
  const [isAnalyzingTx, setIsAnalyzingTx] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [isLoadingProvenSample, setIsLoadingProvenSample] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [withdrawalInfo, setWithdrawalInfo] = useState<WithdrawalInfo | null>(
    null
  );
  const [simResult, setSimResult] =
    useState<WithdrawalSimulationResult | null>(null);

  // Live 1-second tick for real-time remaining countdown
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Live on-chain conditions for interactive what-if simulator
  const [conditions, setConditions] =
    useState<LiveWithdrawalConditions | null>(null);
  const [isLoadingConditions, setIsLoadingConditions] = useState(false);
  const [latestTeeZk, setLatestTeeZk] = useState<TeeZkProofInspection | null>(
    null
  );
  const [isCheckingLatestTeeZk, setIsCheckingLatestTeeZk] = useState(false);
  const [simProofMode, setSimProofMode] = useState<'single-5d' | 'dual-1d'>(
    'single-5d'
  );
  const [simAssetType, setSimAssetType] = useState<'ETH' | 'ERC20'>('ETH');
  const [simTokenSymbol, setSimTokenSymbol] = useState('USDC');
  const [simAmount, setSimAmount] = useState('1.0');
  const [simL1GweiOverride, setSimL1GweiOverride] = useState('');
  const [simProposalMinutes, setSimProposalMinutes] = useState('30');
  const [simUsePimlicoSponsor, setSimUsePimlicoSponsor] = useState(true);

  const loadConditions = useCallback(async () => {
    if (networkConfig.rpcUrls.length === 0) return;
    setIsLoadingConditions(true);
    try {
      const cond = await fetchLiveWithdrawalConditions(networkConfig);
      setConditions(cond);
      if (cond.latestGameTeeZk) {
        setLatestTeeZk(cond.latestGameTeeZk);
        setSimProofMode(
          cond.latestGameTeeZk.windowMode === 'dual-1d'
            ? 'dual-1d'
            : 'single-5d'
        );
      }
      if (!simL1GweiOverride) {
        setSimL1GweiOverride(cond.l1GasPriceGwei);
      }
      if (cond.proposalIntervalSeconds > 0) {
        setSimProposalMinutes(
          String(Math.max(5, Math.round(cond.proposalIntervalSeconds / 60)))
        );
      }
    } catch {
      // Non-fatal
    } finally {
      setIsLoadingConditions(false);
    }
  }, [networkConfig, simL1GweiOverride]);

  useEffect(() => {
    loadConditions();
  }, [loadConditions]);

  const handleCheckLatestNetworkTeeZk = async () => {
    setIsCheckingLatestTeeZk(true);
    try {
      const inspected = await inspectLatestDisputeGameTeeZk(networkConfig);
      setLatestTeeZk(inspected);
      setSimProofMode(
        inspected.windowMode === 'dual-1d' ? 'dual-1d' : 'single-5d'
      );
    } catch {
      // Ignore error if RPC unreachable
    } finally {
      setIsCheckingLatestTeeZk(false);
    }
  };

  const runTxAnalysisAndSimulation = useCallback(
    async (hashToRun: string) => {
      const cleaned = hashToRun.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(cleaned)) {
        setTxError(
          '有効な64桁のトランザクションハッシュ (0x...) を入力してください'
        );
        return;
      }

      setIsAnalyzingTx(true);
      setTxError(null);

      try {
        const info = await analyzeWithdrawalFromTxHash(
          cleaned as Hex,
          networkConfig
        );
        if (!info) {
          setWithdrawalInfo(null);
          setSimResult(null);
          setTxError(
            'このトランザクションには L2ToL1MessagePasser の出金イベントが見つかりませんでした'
          );
          return;
        }
        setWithdrawalInfo(info);
        onValidWithdrawalAnalyzed?.(cleaned, info);

        const sim = await simulateWithdrawalOnL1(cleaned as Hex, networkConfig);
        setSimResult(sim);
      } catch (err) {
        setTxError(
          err instanceof Error
            ? err.message
            : 'オンチェーン出金シミュレーションに失敗しました'
        );
      } finally {
        setIsAnalyzingTx(false);
      }
    },
    [networkConfig, onValidWithdrawalAnalyzed]
  );

  useEffect(() => {
    if (initialTxHash) {
      setTxHashInput(initialTxHash);
      runTxAnalysisAndSimulation(initialTxHash);
    }
  }, [initialTxHash, runTxAnalysisAndSimulation]);

  const handleFetchLatestSample = async () => {
    setIsLoadingSample(true);
    setTxError(null);
    try {
      const samples = await fetchRecentWithdrawalSamples(networkConfig, 1);
      if (samples.length === 0) {
        setTxError('直近ブロックから出金トランザクションを検出できませんでした');
        return;
      }
      setTxHashInput(samples[0]);
      await runTxAnalysisAndSimulation(samples[0]);
    } catch (err) {
      setTxError(
        err instanceof Error ? err.message : '出金サンプルの取得に失敗しました'
      );
    } finally {
      setIsLoadingSample(false);
    }
  };

  const handleFetchProvenSample = async () => {
    setIsLoadingProvenSample(true);
    setTxError(null);
    try {
      const provenTx = await fetchRecentProvenWithdrawalSample(networkConfig);
      if (!provenTx) {
        setTxError(
          '直近のL1ブロック範囲から Prove済 の出金トランザクションを自動検出できませんでした（任意の出金Txハッシュを直接貼り付けて確認できます）'
        );
        return;
      }
      setTxHashInput(provenTx);
      await runTxAnalysisAndSimulation(provenTx);
    } catch (err) {
      setTxError(
        err instanceof Error ? err.message : 'Prove済サンプルの検索に失敗しました'
      );
    } finally {
      setIsLoadingProvenSample(false);
    }
  };

  // Compute live ticking remaining seconds for the analyzed tx
  const liveRemainingSeconds = useMemo(() => {
    if (!withdrawalInfo) return null;
    if (
      withdrawalInfo.status === 'ready-to-finalize' ||
      withdrawalInfo.status === 'finalized'
    ) {
      return 0;
    }
    if (withdrawalInfo.estimatedClaimableAtMs === null) {
      return withdrawalInfo.totalSecondsRemaining;
    }
    return Math.max(
      0,
      Math.ceil((withdrawalInfo.estimatedClaimableAtMs - nowMs) / 1000)
    );
  }, [withdrawalInfo, nowMs]);

  // Interactive what-if simulator math supporting BOTH Single Proof (5 days) and TEE + ZK Dual Proof (1 day)
  const whatIfSimulation = useMemo(() => {
    const parsedAmount = Number(simAmount);
    const amountValid = Number.isFinite(parsedAmount) && parsedAmount >= 0;
    const gwei = Number(simL1GweiOverride || conditions?.l1GasPriceGwei || '1');
    const validGwei = Number.isFinite(gwei) && gwei >= 0 ? gwei : 1;
    const proposalMin = Math.max(0, Number(simProposalMinutes) || 30);

    const proveGas = conditions?.estimatedProveGas ?? 290000;
    const finalizeGas = conditions?.estimatedFinalizeGas ?? 230000;

    const rawProveCostEth = proveGas * validGwei * 1e-9;
    const rawFinalizeCostEth = finalizeGas * validGwei * 1e-9;
    const proveCostEth = simUsePimlicoSponsor ? 0 : rawProveCostEth;
    const finalizeCostEth = simUsePimlicoSponsor ? 0 : rawFinalizeCostEth;
    const totalL1GasEth = proveCostEth + finalizeCostEth;
    const rawTotalL1GasEth = rawProveCostEth + rawFinalizeCostEth;

    const maturitySec = conditions?.proofMaturityDelaySeconds ?? 86400;
    const fast1dSec = conditions?.fastFinalizationDelaySeconds ?? 86400;
    const slow5dSec = conditions?.slowFinalizationDelaySeconds ?? 432000;
    const gameResolutionSec =
      simProofMode === 'dual-1d' ? fast1dSec : slow5dSec;
    const gameFinalityDelaySec =
      conditions?.disputeGameFinalityDelaySeconds ?? 0;

    const postProveWaitSec = Math.max(
      gameResolutionSec + gameFinalityDelaySec,
      maturitySec
    );
    const proposalSec = Math.round(proposalMin * 60);
    const totalWaitSec = proposalSec + postProveWaitSec;

    const nowSec = Math.floor(nowMs / 1000);
    const proveReadyAtSec = nowSec + proposalSec;
    const proveMaturityDoneAtSec = proveReadyAtSec + maturitySec;
    const claimableAtSec = nowSec + totalWaitSec;

    const netEth =
      simAssetType === 'ETH' && amountValid
        ? Math.max(0, parsedAmount - totalL1GasEth)
        : null;

    return {
      amountValid,
      parsedAmount: amountValid ? parsedAmount : 0,
      proveCostEth,
      finalizeCostEth,
      totalL1GasEth,
      rawTotalL1GasEth,
      maturitySec,
      fast1dSec,
      slow5dSec,
      gameResolutionSec,
      gameFinalityDelaySec,
      postProveWaitSec,
      totalWaitSec,
      proveReadyAtSec,
      proveMaturityDoneAtSec,
      claimableAtSec,
      netEth,
    };
  }, [
    simAmount,
    simL1GweiOverride,
    simProposalMinutes,
    simAssetType,
    simProofMode,
    simUsePimlicoSponsor,
    conditions,
    nowMs,
  ]);

  return (
    <div className="space-y-6">
      {/* Section 1: Real On-Chain Withdrawal Inspector, TEE/ZK Check, 2-Step Simulation & Receive Funds */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              実トランザクション TEE/ZKチェック・2段階シミュレーション・L1資金受け取り
            </h2>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Base の出金Txハッシュを入力すると、出金ゲームの{' '}
              <strong>TEE / ZK 証明状態（単一証明: 5日 / 両方あり: 1日）</strong>・
              <span className="font-mono">proveWithdrawalTransaction</span> ＆ 成熟待機後の{' '}
              <span className="font-mono">finalizeWithdrawalTransaction</span>{' '}
              シミュレーションを実行し、そのまま <strong>「資金を受け取る」</strong> ボタンで着金できます。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleFetchProvenSample}
              disabled={isLoadingProvenSample || isLoadingSample || isAnalyzingTx}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoadingProvenSample ? 'animate-spin' : ''}`}
              />
              <span>
                {isLoadingProvenSample ? 'Prove済Tx検索中...' : 'Prove済の出金Txサンプルを取得'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleFetchLatestSample}
              disabled={isLoadingSample || isLoadingProvenSample || isAnalyzingTx}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoadingSample ? 'animate-spin' : ''}`}
              />
              <span>
                {isLoadingSample ? '検索中...' : '最新の出金Txを取得'}
              </span>
            </button>
          </div>
        </div>

        {/* Detected withdrawal shortcuts from batch / withdrawal tables */}
        {verifiedWithdrawals.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500 font-medium">
              検証済みの出金Txを選択:
            </span>
            {verifiedWithdrawals.map((item) => {
              const meta = item.withdrawal
                ? getWithdrawalProveDisplayMeta(item.withdrawal)
                : null;
              const isActive =
                txHashInput.toLowerCase() === item.hash.toLowerCase();
              return (
                <button
                  key={item.hash}
                  type="button"
                  onClick={() => {
                    setTxHashInput(item.hash);
                    runTxAnalysisAndSimulation(item.hash);
                  }}
                  className={`px-2.5 py-1 font-mono text-xs rounded-md transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-[#0052FF] text-white'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                  }`}
                >
                  <span>
                    {shortenHex(item.hash, 8, 6)}
                    {item.withdrawal
                      ? ` (${item.withdrawal.amountFormatted} ${item.withdrawal.assetSymbol})`
                      : ''}
                  </span>
                  {meta && (
                    <span
                      className={`font-sans font-semibold text-[11px] ${
                        isActive
                          ? 'text-white/95'
                          : meta.isProven
                          ? 'text-emerald-700'
                          : 'text-amber-800'
                      }`}
                    >
                      [{meta.isProven ? 'Prove済' : '未Prove'}]
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={txHashInput}
            onChange={(e) => setTxHashInput(e.target.value)}
            placeholder="Base 出金トランザクションハッシュ (0x...)"
            className="flex-1 px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 placeholder:font-sans focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
          />
          <button
            type="button"
            onClick={() => runTxAnalysisAndSimulation(txHashInput)}
            disabled={isAnalyzingTx || !txHashInput.trim()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isAnalyzingTx ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>TEE/ZK・2段階シミュ実行中...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>検証 ＆ 資金受け取り画面を開く</span>
              </>
            )}
          </button>
        </div>

        {txError && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {txError}
          </div>
        )}

        {withdrawalInfo && (
          <div className="space-y-4 pt-2">
            {/* 4-column Withdrawal Telemetry */}
            <div className="border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
              <div className="p-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <Coins className="w-3.5 h-3.5" />
                  <span>実測L1受取見込・アセット</span>
                </div>
                {!withdrawalInfo.portalFinalized &&
                (withdrawalInfo.validation?.canWithdrawAfterWait === false ||
                  withdrawalInfo.validation?.recipientBalanceIncreased ===
                    false) ? (
                  <>
                    <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-red-700">
                      0 {withdrawalInfo.assetSymbol}（着金不可）
                    </div>
                    <div className="mt-1 text-xs text-red-700 font-mono truncate">
                      データ記載値: {withdrawalInfo.amountFormatted}{' '}
                      {withdrawalInfo.assetSymbol}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-900">
                      {withdrawalInfo.amountFormatted}{' '}
                      {withdrawalInfo.assetSymbol}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 font-mono truncate">
                      L1受取: {shortenHex(withdrawalInfo.l1Recipient, 8, 6)}
                    </div>
                  </>
                )}
              </div>

              <div className="p-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  <span>資金受け取りまで残り</span>
                </div>
                {!withdrawalInfo.portalFinalized &&
                (withdrawalInfo.validation?.canWithdrawAfterWait === false ||
                  withdrawalInfo.validation?.recipientBalanceIncreased ===
                    false) ? (
                  <>
                    <div className="mt-1.5 text-lg font-bold text-red-700">
                      受取不可（Finalize不要）
                    </div>
                    <div className="mt-1 text-xs text-red-700">
                      待機完了後もL1残高は増えません
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                        liveRemainingSeconds === 0
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {formatSecondsJapanese(liveRemainingSeconds)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                      {withdrawalInfo.estimatedClaimableAtMs &&
                      liveRemainingSeconds !== 0
                        ? `予定: ${formatUnixTimestamp(
                            Math.floor(
                              withdrawalInfo.estimatedClaimableAtMs / 1000
                            )
                          )}`
                        : withdrawalInfo.portalFinalized
                        ? 'L1 資金受取完了済'
                        : '今すぐ資金受け取り可能'}
                    </div>
                  </>
                )}
              </div>

              <div className="p-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>L1 Prove（出金証明）状態</span>
                </div>
                {(() => {
                  const meta = getWithdrawalProveDisplayMeta(withdrawalInfo);
                  return (
                    <>
                      <div
                        className={`mt-1.5 text-lg font-bold ${
                          meta.isProven
                            ? 'text-emerald-700'
                            : meta.stateKind === 'reprove'
                            ? 'text-red-700'
                            : 'text-amber-800'
                        }`}
                      >
                        {meta.isProven
                          ? 'Prove済 ✓'
                          : meta.stateKind === 'reprove'
                          ? '要再Prove'
                          : '未Prove（未提出）'}
                      </div>
                      <div className="mt-1 text-xs text-slate-600 font-medium truncate">
                        {getWithdrawalStatusLabel(withdrawalInfo.status)}
                        {withdrawalInfo.validation?.teeZk
                          ? ` · ${
                              withdrawalInfo.validation.teeZk.windowMode === 'dual-1d'
                                ? 'TEE+ZK 1日枠'
                                : '単一 5日枠'
                            }`
                          : ''}
                      </div>
                    </>
                  );
                })()}
              </div>

              <div className="p-4">
                <div className="text-xs font-medium text-slate-500">
                  推定L1ガス代 / 実質受取額
                </div>
                <div className="mt-1.5 text-base font-bold font-mono tabular-nums text-slate-900">
                  {simResult ? `${simResult.totalL1ClaimCostEth} ETH` : '計算中...'}
                </div>
                <div className="mt-1 text-xs text-slate-600 font-mono tabular-nums truncate">
                  {simResult?.netAmountFormatted
                    ? `実質: ${simResult.netAmountFormatted}`
                    : 'Paymaster適用時はガス負担0 ETH可'}
                </div>
              </div>
            </div>

            {/* Unified TEE/ZK Check + 2-Step Simulation + Receive Funds Console */}
            <PimlicoExecutionPanel
              txHash={txHashInput.trim()}
              withdrawalInfo={withdrawalInfo}
              networkConfig={networkConfig}
              nowMs={nowMs}
              externalSimResult={simResult}
              externalIsSimulating={isAnalyzingTx}
              onRunExternalSimulation={() =>
                runTxAnalysisAndSimulation(txHashInput)
              }
              onWithdrawalUpdated={(updated) => {
                setWithdrawalInfo(updated);
                onValidWithdrawalAnalyzed?.(txHashInput.trim(), updated);
              }}
              onExecutionCompleted={() =>
                runTxAnalysisAndSimulation(txHashInput)
              }
            />
          </div>
        )}
      </section>

      {/* Section 2: New Withdrawal Timeline & Net Amount Simulator (5-Day Single Proof vs 1-Day TEE+ZK Dual Proof) */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 pb-4 border-b border-slate-100">
          <div className="space-y-1.5">
            <h2 className="text-base font-bold text-slate-900">
              新規出金 タイムライン＆実質受取額シミュレーター（単一証明5日 ／ TEE+ZK二重証明1日 対応）
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Base L1 の{' '}
              <span className="font-mono text-slate-800">
                AggregateVerifier (GameType {conditions?.respectedGameType ?? 621})
              </span>{' '}
              では、出金ゲームの待機期間は{' '}
              <strong className="text-slate-900">
                単一証明（TEEのみ / ZKのみ）で{' '}
                {formatSecondsJapanese(whatIfSimulation.slow5dSec)}（
                {whatIfSimulation.slow5dSec.toLocaleString()}秒）
              </strong>
              、
              <strong className="text-emerald-800">
                TEE と ZK の両方がある場合は{' '}
                {formatSecondsJapanese(whatIfSimulation.fast1dSec)}（
                {whatIfSimulation.fast1dSec.toLocaleString()}秒）
              </strong>{' '}
              です（加えて Prove 提出から{' '}
              {formatSecondsJapanese(whatIfSimulation.maturitySec)}{' '}
              の成熟期間が並行して経過する必要があります）。
            </p>

            {latestTeeZk && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-700 pt-0.5">
                <span className="font-semibold text-slate-900">
                  現在のL1最新ゲーム実測 (#{latestTeeZk.disputeGameIndex ?? '—'}):
                </span>
                <span>
                  TEE証明={latestTeeZk.hasTeeProof ? 'あり' : 'なし'}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  ZK証明={latestTeeZk.hasZkProof ? 'あり' : 'なし'}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  className={`font-semibold ${
                    latestTeeZk.windowMode === 'dual-1d'
                      ? 'text-emerald-700'
                      : 'text-[#0052FF]'
                  }`}
                >
                  現在 {latestTeeZk.proofCount}/2 証明 →{' '}
                  {latestTeeZk.windowMode === 'dual-1d'
                    ? '1日高速枠で稼働中'
                    : '5日単一証明枠で稼働中'}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCheckLatestNetworkTeeZk}
              disabled={isCheckingLatestTeeZk || isLoadingConditions}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0052FF] bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isCheckingLatestTeeZk ? 'animate-spin' : ''
                }`}
              />
              <span>
                {isCheckingLatestTeeZk
                  ? 'TEE / ZK 照会中...'
                  : '最新ゲームの TEE / ZK チェック'}
              </span>
            </button>

            <button
              type="button"
              onClick={loadConditions}
              disabled={isLoadingConditions}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isLoadingConditions ? 'animate-spin' : ''
                }`}
              />
              <span>オンチェーン設定再取得</span>
            </button>
          </div>
        </div>

        {/* Proof Window Mode Selector + Inputs */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium text-slate-700">
                シミュレーションする出金ゲームの証明条件（TEE / ZK）
              </span>
              <div className="inline-flex flex-wrap p-1 bg-slate-100 rounded-lg gap-1">
                <button
                  type="button"
                  onClick={() => setSimProofMode('single-5d')}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    simProofMode === 'single-5d'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  単一証明（TEEのみ / ZKのみ）: 5日 (432,000秒)
                </button>
                <button
                  type="button"
                  onClick={() => setSimProofMode('dual-1d')}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    simProofMode === 'dual-1d'
                      ? 'bg-white text-emerald-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  TEE + ZK 両方あり（二重証明）: 1日 (86,400秒)
                </button>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={simUsePimlicoSponsor}
                onChange={(e) => setSimUsePimlicoSponsor(e.target.checked)}
                className="rounded border-slate-300 text-[#0052FF] focus:ring-[#0052FF]"
              />
              <span>Paymaster (Pimlico / Alchemy) スポンサー適用</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                出金アセット種別
              </label>
              <div className="inline-flex w-full p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setSimAssetType('ETH')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    simAssetType === 'ETH'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Native ETH
                </button>
                <button
                  type="button"
                  onClick={() => setSimAssetType('ERC20')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    simAssetType === 'ERC20'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ERC-20
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="sim-amount-input"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                出金額 ({simAssetType === 'ETH' ? 'ETH' : simTokenSymbol || 'Token'})
              </label>
              <div className="flex gap-2">
                <input
                  id="sim-amount-input"
                  type="number"
                  min="0"
                  step="any"
                  value={simAmount}
                  onChange={(e) => setSimAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                />
                {simAssetType === 'ERC20' && (
                  <input
                    type="text"
                    value={simTokenSymbol}
                    onChange={(e) => setSimTokenSymbol(e.target.value)}
                    aria-label="トークンシンボル"
                    className="w-24 px-2.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                  />
                )}
              </div>
            </div>

            <div>
              <label
                htmlFor="sim-l1-gwei"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                想定 L1 ガス価格 (Gwei)
              </label>
              <input
                id="sim-l1-gwei"
                type="number"
                min="0"
                step="0.01"
                value={simL1GweiOverride}
                onChange={(e) => setSimL1GweiOverride(e.target.value)}
                placeholder={conditions?.l1GasPriceGwei ?? '1.0'}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
              />
            </div>

            <div>
              <label
                htmlFor="sim-proposal-min"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                L1 DisputeGame 提案待機 (分)
              </label>
              <input
                id="sim-proposal-min"
                type="number"
                min="0"
                step="5"
                value={simProposalMinutes}
                onChange={(e) => setSimProposalMinutes(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
              />
            </div>
          </div>
        </div>

        {/* Simulated Timeline & Net Outcome */}
        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
          <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
            <div>
              <div className="text-xs text-slate-500">
                新規出金の総所要時間 (L2開始→資金受取)
              </div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                {formatSecondsJapanese(whatIfSimulation.totalWaitSec)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                受取可能予定: {formatUnixTimestamp(whatIfSimulation.claimableAtSec)}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">
                待機内訳 ({simProofMode === 'dual-1d' ? 'TEE+ZK 二重証明' : '単一証明'})
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-900 space-y-0.5">
                <div>
                  ・出金ゲーム待機:{' '}
                  <strong>
                    {formatSecondsJapanese(whatIfSimulation.gameResolutionSec)}
                  </strong>
                </div>
                <div>
                  ・Prove後成熟:{' '}
                  <strong>
                    {formatSecondsJapanese(whatIfSimulation.maturitySec)}
                  </strong>
                </div>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {simProofMode === 'dual-1d'
                  ? 'TEE+ZK両方揃うためProve後1日で資金受取可'
                  : '単一証明のためゲーム解決5日間が律速'}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">
                自己負担 L1 手数料 (Prove + Finalize)
              </div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                {whatIfSimulation.totalL1GasEth.toFixed(6)} ETH
              </div>
              <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                {simUsePimlicoSponsor
                  ? `Paymaster負担 (実費相当 ${whatIfSimulation.rawTotalL1GasEth.toFixed(
                      6
                    )} ETH)`
                  : `Prove ${whatIfSimulation.proveCostEth.toFixed(
                      6
                    )} + Finalize ${whatIfSimulation.finalizeCostEth.toFixed(6)} ETH`}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500">手数料考慮後の実質受取額</div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-700">
                {simAssetType === 'ETH' && whatIfSimulation.netEth !== null
                  ? `${whatIfSimulation.netEth.toFixed(6)} ETH`
                  : `${whatIfSimulation.parsedAmount.toLocaleString()} ${
                      simTokenSymbol || 'TOKEN'
                    }`}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {simUsePimlicoSponsor
                  ? 'Paymaster Policy により L1 ガス代控除なし'
                  : simAssetType === 'ETH'
                  ? '出金額から L1 Prove/Finalize ガス代を控除'
                  : `別途 L1 ガス代 ${whatIfSimulation.totalL1GasEth.toFixed(
                      6
                    )} ETH が必要`}
              </div>
            </div>
          </div>

          <div className="p-4 bg-slate-50/70 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-slate-700">
              <span className="font-semibold text-slate-900">
                1. Base L2 出金開始
              </span>
              <span className="font-mono tabular-nums text-slate-500">
                ({formatUnixTimestamp(Math.floor(nowMs / 1000))})
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-900">
                2. L1 Prove 提出可能
              </span>
              <span className="font-mono tabular-nums text-slate-500">
                ({formatUnixTimestamp(whatIfSimulation.proveReadyAtSec)})
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-emerald-700">
                3. 資金を受け取る ({simProofMode === 'dual-1d' ? '1日後' : '5日後'})
              </span>
              <span className="font-mono tabular-nums text-emerald-700">
                ({formatUnixTimestamp(whatIfSimulation.claimableAtSec)})
              </span>
            </div>
            <span className="text-slate-500 font-mono tabular-nums shrink-0">
              L2 Gas: {conditions?.l2GasPriceGwei ?? '—'} Gwei · L1 Gas:{' '}
              {conditions?.l1GasPriceGwei ?? '—'} Gwei
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
