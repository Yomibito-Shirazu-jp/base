import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Play,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
  Coins,
} from 'lucide-react';
import type { Hex } from 'viem';
import {
  NetworkConfig,
  VerifiedTransactionResult,
  WithdrawalInfo,
  WithdrawalSimulationResult,
} from '../types/finality';
import {
  LiveWithdrawalConditions,
  analyzeWithdrawalFromTxHash,
  fetchLiveWithdrawalConditions,
  fetchRecentWithdrawalSamples,
  formatSecondsJapanese,
  getProveLifecycleBadgeText,
  getWithdrawalStatusLabel,
  simulateWithdrawalOnL1,
} from '../lib/withdrawalAnalyzer';
import { formatUnixTimestamp, shortenHex } from '../lib/exportUtils';
import { PimlicoExecutionPanel } from './PimlicoExecutionPanel';

interface WithdrawalSimulatorSectionProps {
  networkConfig: NetworkConfig;
  verifiedWithdrawals: VerifiedTransactionResult[];
  initialTxHash?: string | null;
}

export function WithdrawalSimulatorSection({
  networkConfig,
  verifiedWithdrawals,
  initialTxHash,
}: WithdrawalSimulatorSectionProps) {
  const [txHashInput, setTxHashInput] = useState(initialTxHash ?? '');
  const [isAnalyzingTx, setIsAnalyzingTx] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [withdrawalInfo, setWithdrawalInfo] = useState<WithdrawalInfo | null>(null);
  const [simResult, setSimResult] = useState<WithdrawalSimulationResult | null>(null);

  // Live 1-second tick for real-time remaining countdown
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Live on-chain conditions for interactive what-if simulator
  const [conditions, setConditions] = useState<LiveWithdrawalConditions | null>(null);
  const [isLoadingConditions, setIsLoadingConditions] = useState(false);
  const [simAssetType, setSimAssetType] = useState<'ETH' | 'ERC20'>('ETH');
  const [simTokenSymbol, setSimTokenSymbol] = useState('USDC');
  const [simAmount, setSimAmount] = useState('1.0');
  const [simL1GweiOverride, setSimL1GweiOverride] = useState('');
  const [simProposalMinutes, setSimProposalMinutes] = useState('30');
  const [simUsePimlicoSponsor, setSimUsePimlicoSponsor] = useState(false);

  const loadConditions = useCallback(async () => {
    if (networkConfig.rpcUrls.length === 0) return;
    setIsLoadingConditions(true);
    try {
      const cond = await fetchLiveWithdrawalConditions(networkConfig);
      setConditions(cond);
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

  const runTxAnalysisAndSimulation = useCallback(
    async (hashToRun: string) => {
      const cleaned = hashToRun.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(cleaned)) {
        setTxError('有効な64桁のトランザクションハッシュ (0x...) を入力してください');
        return;
      }

      setIsAnalyzingTx(true);
      setTxError(null);

      try {
        const info = await analyzeWithdrawalFromTxHash(cleaned as Hex, networkConfig);
        if (!info) {
          setWithdrawalInfo(null);
          setSimResult(null);
          setTxError(
            'このトランザクションには L2ToL1MessagePasser の出金イベントが見つかりませんでした'
          );
          return;
        }
        setWithdrawalInfo(info);

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
    [networkConfig]
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

  // Interactive what-if simulator math using BOTH DisputeGame resolution (~5 days) and Proof Maturity (1 day)
  const whatIfSimulation = useMemo(() => {
    const parsedAmount = Number(simAmount);
    const amountValid = Number.isFinite(parsedAmount) && parsedAmount >= 0;
    const gwei = Number(simL1GweiOverride || conditions?.l1GasPriceGwei || '1');
    const validGwei = Number.isFinite(gwei) && gwei >= 0 ? gwei : 1;
    const proposalMin = Math.max(0, Number(simProposalMinutes) || 30);

    const proveGas = conditions?.estimatedProveGas ?? 290000;
    const finalizeGas = conditions?.estimatedFinalizeGas ?? 230000;

    // 1 Gwei = 1e-9 ETH
    const rawProveCostEth = proveGas * validGwei * 1e-9;
    const rawFinalizeCostEth = finalizeGas * validGwei * 1e-9;
    const proveCostEth = simUsePimlicoSponsor ? 0 : rawProveCostEth;
    const finalizeCostEth = simUsePimlicoSponsor ? 0 : rawFinalizeCostEth;
    const totalL1GasEth = proveCostEth + finalizeCostEth;
    const rawTotalL1GasEth = rawProveCostEth + rawFinalizeCostEth;

    const maturitySec = conditions?.proofMaturityDelaySeconds ?? 86400;
    const gameResolutionSec =
      conditions?.disputeGameResolutionSeconds ?? 432000;
    const gameFinalityDelaySec =
      conditions?.disputeGameFinalityDelaySeconds ?? 0;

    // Crucial OP Stack v6 rule: post-Prove wait is max(DisputeGame resolution + finalityDelay, proofMaturityDelay)
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
    simUsePimlicoSponsor,
    conditions,
    nowMs,
  ]);

  return (
    <div className="space-y-6">
      {/* Section 1: Real On-Chain Withdrawal Inspector, Prove Status & Direct L1 Execution */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              実トランザクション Prove状態チェック・L1ドライラン・そのまま出金確定 (Pimlico対応)
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Base の出金トランザクションハッシュを入力すると、L2 MessagePasser・Prove状態・DisputeGame解決残り時間を実測し、そのまま Pimlico (RPC / API Key / Policy ID) またはウォレットで Prove / Finalize を実行できます。
            </p>
          </div>
          <button
            type="button"
            onClick={handleFetchLatestSample}
            disabled={isLoadingSample || isAnalyzingTx}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSample ? 'animate-spin' : ''}`} />
            <span>{isLoadingSample ? '検索中...' : '最新出金Txをオンチェーン取得'}</span>
          </button>
        </div>

        {/* Detected withdrawal shortcuts from batch / withdrawal tables */}
        {verifiedWithdrawals.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500 font-medium">検証済みの出金Txを選択:</span>
            {verifiedWithdrawals.map((item) => (
              <button
                key={item.hash}
                type="button"
                onClick={() => {
                  setTxHashInput(item.hash);
                  runTxAnalysisAndSimulation(item.hash);
                }}
                className={`px-2.5 py-1 font-mono text-xs rounded-md transition-colors cursor-pointer ${
                  txHashInput.toLowerCase() === item.hash.toLowerCase()
                    ? 'bg-[#0052FF] text-white'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                }`}
              >
                {shortenHex(item.hash, 8, 6)}
                {item.withdrawal
                  ? ` (${item.withdrawal.amountFormatted} ${item.withdrawal.assetSymbol})`
                  : ''}
              </button>
            ))}
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
                <span>Prove状態・L1検証中...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>Prove状態チェック・出金画面を開く</span>
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
                  <span>出金金額・アセット</span>
                </div>
                <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-900">
                  {withdrawalInfo.amountFormatted} {withdrawalInfo.assetSymbol}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono truncate">
                  L1受取: {shortenHex(withdrawalInfo.l1Recipient, 8, 6)}
                </div>
              </div>

              <div className="p-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  <span>出金確定 (Finalize) まで残り</span>
                </div>
                <div
                  className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                    liveRemainingSeconds === 0 ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {formatSecondsJapanese(liveRemainingSeconds)}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                  {withdrawalInfo.estimatedClaimableAtMs && liveRemainingSeconds !== 0
                    ? `予定: ${formatUnixTimestamp(
                        Math.floor(withdrawalInfo.estimatedClaimableAtMs / 1000)
                      )}`
                    : withdrawalInfo.portalFinalized
                    ? 'L1 着金完了済'
                    : '今すぐ Claim 実行可能'}
                </div>
              </div>

              <div className="p-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>現在のステージ / Prove状態</span>
                </div>
                <div className="mt-1.5 text-sm font-bold text-slate-900">
                  {getWithdrawalStatusLabel(withdrawalInfo.status)}
                </div>
                <div className="mt-1 text-xs text-[#0052FF] font-medium truncate">
                  {withdrawalInfo.validation
                    ? getProveLifecycleBadgeText(withdrawalInfo.validation.proveState)
                    : '—'}
                </div>
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
                    : 'Pimlico Policy指定時はガス0 ETH可'}
                </div>
              </div>
            </div>

            {/* L1 Contract Dry-Run Simulation Result */}
            {simResult && (
              <div
                className={`border rounded-xl p-4 flex flex-col gap-2 ${
                  simResult.l1DryRunSuccess
                    ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                    : 'bg-amber-50/70 border-amber-200 text-amber-950'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {simResult.l1DryRunSuccess ? (
                      <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                    )}
                    <span>
                      Ethereum L1 OptimismPortal2 ({simResult.l1DryRunAction}) ＆ 待機後着金ドライラン
                    </span>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-600">
                    L1 GasPrice: {simResult.l1GasPriceGwei} Gwei · Prove推定:{' '}
                    {simResult.estimatedProveFeeEth} ETH · Finalize推定:{' '}
                    {simResult.estimatedFinalizeFeeEth} ETH
                  </span>
                </div>
                <p className="text-xs leading-relaxed">{simResult.l1DryRunMessage}</p>
              </div>
            )}

            {/* Direct L1 Prove & Finalize Execution Console (Pimlico ERC-4337 + Wallet) */}
            <PimlicoExecutionPanel
              txHash={txHashInput.trim()}
              withdrawalInfo={withdrawalInfo}
              networkConfig={networkConfig}
              nowMs={nowMs}
              onExecutionCompleted={() => runTxAnalysisAndSimulation(txHashInput)}
            />
          </div>
        )}
      </section>

      {/* Section 2: Accurate Dual-Window New Withdrawal Timeline & Net Amount Simulator */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-slate-100">
          <div className="space-y-1.5">
            <h2 className="text-base font-bold text-slate-900">
              新規出金 タイムライン＆実質受取額シミュレーター（2段階ロック実測対応）
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Ethereum L1 の最新{' '}
              <span className="font-mono text-slate-800">
                OptimismPortal2{conditions?.portalVersion ? ` v${conditions.portalVersion}` : ''}
              </span>{' '}
              では、出金確定までに{' '}
              <strong className="text-slate-900">
                ① DisputeGame解決期間（GameType {conditions?.respectedGameType ?? 621} 実測:{' '}
                {conditions
                  ? `${conditions.disputeGameResolutionSeconds.toLocaleString()}秒 = ${formatSecondsJapanese(
                      conditions.disputeGameResolutionSeconds
                    )}`
                  : '取得中...'}
                ）
              </strong>{' '}
              と{' '}
              <strong className="text-slate-900">
                ② Prove提出後の成熟遅延（
                {conditions
                  ? `${conditions.proofMaturityDelaySeconds.toLocaleString()}秒 = ${formatSecondsJapanese(
                      conditions.proofMaturityDelaySeconds
                    )}`
                  : '取得中...'}
                ）
              </strong>{' '}
              の<strong>両方の経過（長い方＝実質 約5日間）</strong>が必要です。
            </p>
            {conditions && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-500">
                <span>信頼性・参照ソース:</span>
                <span
                  className={
                    conditions.usedFallbackDelay ? 'text-amber-700' : 'text-emerald-700'
                  }
                >
                  {conditions.usedFallbackDelay
                    ? '一部フォールバック値使用'
                    : 'L1 OptimismPortal2 & DisputeGameFactory 解決履歴実測値'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  直近Game提案間隔: 約{Math.max(1, Math.round(conditions.proposalIntervalSeconds / 60))}分
                </span>
                {conditions.rawMeasuredResolutionSeconds !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Game解決実測(resolvedAt-createdAt):{' '}
                      {conditions.rawMeasuredResolutionSeconds.toLocaleString()}秒
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={loadConditions}
            disabled={isLoadingConditions}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingConditions ? 'animate-spin' : ''}`} />
            <span>最新オンチェーン設定を再取得</span>
          </button>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
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

          <div className="pb-2">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={simUsePimlicoSponsor}
                onChange={(e) => setSimUsePimlicoSponsor(e.target.checked)}
                className="rounded border-slate-300 text-[#0052FF] focus:ring-[#0052FF]"
              />
              <span>Pimlico Paymaster スポンサー適用</span>
            </label>
          </div>
        </div>

        {/* Simulated Timeline & Net Outcome */}
        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
          <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
            <div>
              <div className="text-xs text-slate-500">
                新規出金の総所要時間 (L2実行→L1受取)
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
                待機内訳 (長い方の完了が必須)
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-900 space-y-0.5">
                <div>
                  ・Game解決: <strong>{formatSecondsJapanese(whatIfSimulation.gameResolutionSec)}</strong>
                </div>
                <div>
                  ・Prove後成熟: <strong>{formatSecondsJapanese(whatIfSimulation.maturitySec)}</strong>
                </div>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                ※5日経過後に遅れてProveした場合はProve後1日で確定可
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
                  ? `Paymaster負担 (実費相当 ${whatIfSimulation.rawTotalL1GasEth.toFixed(6)} ETH)`
                  : `Prove ${whatIfSimulation.proveCostEth.toFixed(6)} + Finalize ${whatIfSimulation.finalizeCostEth.toFixed(6)} ETH`}
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
                  ? 'Pimlico Sponsorship Policy により L1 ガス代控除なし'
                  : simAssetType === 'ETH'
                  ? '出金額から L1 Prove/Finalize ガス代を控除'
                  : `別途 L1 ガス代 ${whatIfSimulation.totalL1GasEth.toFixed(6)} ETH が必要`}
              </div>
            </div>
          </div>

          <div className="p-4 bg-slate-50/70 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-slate-700">
              <span className="font-semibold text-slate-900">1. Base L2 出金開始</span>
              <span className="font-mono tabular-nums text-slate-500">
                ({formatUnixTimestamp(Math.floor(nowMs / 1000))})
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-900">2. L1 Prove 実行可能</span>
              <span className="font-mono tabular-nums text-slate-500">
                ({formatUnixTimestamp(whatIfSimulation.proveReadyAtSec)})
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-600">
                [Prove1日成熟: {formatUnixTimestamp(whatIfSimulation.proveMaturityDoneAtSec)}]
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-emerald-700">
                3. Game解決＆L1 Finalize可能
              </span>
              <span className="font-mono tabular-nums text-emerald-700">
                ({formatUnixTimestamp(whatIfSimulation.claimableAtSec)})
              </span>
            </div>
            <span className="text-slate-500 font-mono tabular-nums shrink-0">
              L2 Base Gas: {conditions?.l2GasPriceGwei ?? '—'} Gwei · L1 Gas:{' '}
              {conditions?.l1GasPriceGwei ?? '—'} Gwei
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
