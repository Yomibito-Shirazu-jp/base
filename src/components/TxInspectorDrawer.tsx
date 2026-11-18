import { useEffect, useState } from 'react';
import {
  X,
  ShieldCheck,
  Layers,
  Zap,
  Copy,
  Check,
  ExternalLink,
  Code2,
  ShieldAlert,
  Clock,
  RefreshCw,
} from 'lucide-react';
import type { Hex } from 'viem';
import {
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  NetworkConfig,
  VerifiedTransactionResult,
  WithdrawalSimulationResult,
} from '../types/finality';
import {
  formatDurationRough,
  formatUnixTimestamp,
  getExecutionLabel,
  getFinalityLabel,
} from '../lib/exportUtils';
import {
  hasWithdrawalIndicator,
  isPartiallyFetchedOrBrokenResult,
} from '../lib/finalizedCache';
import {
  formatSecondsJapanese,
  getWithdrawalProveDisplayMeta,
  getWithdrawalStatusLabel,
  simulateWithdrawalOnL1,
} from '../lib/withdrawalAnalyzer';
import { PimlicoExecutionPanel } from './PimlicoExecutionPanel';
import { WithdrawalInfo } from '../types/finality';

interface TxInspectorDrawerProps {
  result: VerifiedTransactionResult | null;
  snapshot: ChainHeadSnapshot | null;
  networkConfig: NetworkConfig;
  explorerUrl: string;
  l1ExplorerUrl: string;
  onClose: () => void;
  onRetrySingleHash?: (hash: string) => void;
  isRetryingSingle?: boolean;
  onWithdrawalUpdatedGlobal?: (hash: string, updated: WithdrawalInfo) => void;
  onOpenInSimulator?: (txHash: string) => void;
}

export function TxInspectorDrawer({
  result,
  snapshot,
  networkConfig,
  explorerUrl,
  l1ExplorerUrl,
  onClose,
  onRetrySingleHash,
  isRetryingSingle = false,
  onWithdrawalUpdatedGlobal,
  onOpenInSimulator,
}: TxInspectorDrawerProps) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<WithdrawalSimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [localWithdrawal, setLocalWithdrawal] = useState<WithdrawalInfo | null>(
    result?.withdrawal ?? null
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setSimResult(null);
    setSimError(null);
    setLocalWithdrawal(result?.withdrawal ?? null);
  }, [result?.hash, result?.withdrawal]);

  useEffect(() => {
    if (!result?.withdrawal) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result?.withdrawal]);

  if (!result) return null;

  const handleRunL1Sim = async () => {
    setIsSimulating(true);
    setSimError(null);
    try {
      const sim = await simulateWithdrawalOnL1(result.hash as Hex, networkConfig);
      setSimResult(sim);
    } catch (err) {
      setSimError(
        err instanceof Error ? err.message : 'L1出金シミュレーションに失敗しました'
      );
    } finally {
      setIsSimulating(false);
    }
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Ignore
    }
  };

  const isL2Confirmed =
    result.finality === FinalityStage.UNSAFE ||
    result.finality === FinalityStage.SAFE ||
    result.finality === FinalityStage.FINALIZED;

  const isSafeOrBetter =
    result.finality === FinalityStage.SAFE ||
    result.finality === FinalityStage.FINALIZED;

  const isFinalized = result.finality === FinalityStage.FINALIZED;

  const isValidHexHash = /^0x[0-9a-fA-F]{64}$/.test(result.hash);
  const activeWithdrawal = localWithdrawal ?? result.withdrawal;
  const isWithdrawalTx = Boolean(activeWithdrawal || hasWithdrawalIndicator(result));
  const isPartialOrBroken = isPartiallyFetchedOrBrokenResult({
    ...result,
    withdrawal: activeWithdrawal ?? result.withdrawal,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[1px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="トランザクション詳細検証"
    >
      <div
        className="w-full max-w-3xl bg-white h-full overflow-y-auto border-l border-slate-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-500">
              オンチェーン監査インスペクタ · #{result.index}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <h3 className="text-sm font-mono font-semibold text-slate-900 truncate">
                {result.hash}
              </h3>
              <button
                type="button"
                onClick={() => copyText('hash', result.hash)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer shrink-0"
                aria-label="トランザクションハッシュをコピー"
              >
                {copiedKey === 'hash' ? (
                  <Check className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
              {isValidHexHash && explorerUrl && (
                <a
                  href={`${explorerUrl}/tx/${result.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 text-slate-400 hover:text-[#0052FF] rounded shrink-0"
                  aria-label="Basescanで開く"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0"
            aria-label="詳細を閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Primary Verdict */}
          <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-slate-500">
                  {isWithdrawalTx
                    ? 'L1 OptimismPortal2 出金監査ステータス'
                    : '現在のファイナライズ判定'}
                </div>
                <div className="mt-1 text-lg font-bold text-slate-900">
                  {isWithdrawalTx
                    ? activeWithdrawal
                      ? `${getWithdrawalProveDisplayMeta(activeWithdrawal).shortBadge} · ${getWithdrawalStatusLabel(
                          activeWithdrawal.status
                        )}`
                      : 'L1 OptimismPortal2 状態 未取得'
                    : getFinalityLabel(result.finality)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">L2 EVM 実行ステータス</div>
                <div
                  className={`mt-1 text-sm font-semibold ${
                    result.executionStatus === ExecutionStatus.SUCCESS
                      ? 'text-emerald-700'
                      : result.executionStatus === ExecutionStatus.REVERTED
                      ? 'text-red-700'
                      : 'text-slate-700'
                  }`}
                >
                  {getExecutionLabel(result.executionStatus)}
                </div>
              </div>
            </div>
            {result.errorReason && (
              <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {result.errorReason}
              </p>
            )}
          </div>

          {/* Information Reliability & Provenance */}
          {result.reliability && (
            <div className="border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-500">
                  情報の信頼性・照合根拠
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                      result.reliability.tier === 'verified_onchain'
                        ? 'text-emerald-700'
                        : result.reliability.tier === 'estimated_pending'
                        ? 'text-sky-700'
                        : 'text-amber-700'
                    }`}
                  >
                    {result.reliability.tier === 'verified_onchain' ? (
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                    ) : result.reliability.tier === 'estimated_pending' ? (
                      <Clock className="w-4 h-4 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                    )}
                    <span>{result.reliability.label}</span>
                  </span>

                  {isPartialOrBroken && onRetrySingleHash && isValidHexHash && (
                    <button
                      type="button"
                      onClick={() => onRetrySingleHash(result.hash)}
                      disabled={isRetryingSingle}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${isRetryingSingle ? 'animate-spin' : ''}`}
                      />
                      <span>
                        {isRetryingSingle ? '再取得中...' : '未取得項目を再取得'}
                      </span>
                    </button>
                  )}
                </div>
              </div>
              <div className="text-xs text-slate-600 leading-relaxed">
                <span className="font-medium text-slate-700">照合ソース: </span>
                <span className="font-mono text-[11px]">
                  {result.reliability.basis.join(' · ')}
                </span>
              </div>
              {result.reliability.caveat && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                  注記: {result.reliability.caveat}
                </p>
              )}
            </div>
          )}

          {/* 3-Stage OP Stack Finality Pipeline (shown strictly for general non-withdrawal L2 transactions) */}
          {!isWithdrawalTx && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 mb-3">
                OP Stack (Base) ファイナライズ進行ステップ
              </h4>
              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                {/* Step 1: Unsafe */}
                <div className="p-4 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Zap
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        isL2Confirmed ? 'text-emerald-600' : 'text-slate-300'
                      }`}
                    />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        1. L2 シーケンサー承認 (Unsafe Head)
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
                        Base シーケンサーによりブロックへ取り込まれ、状態遷移が確定した段階（約2秒）。
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-600 shrink-0">
                    {isL2Confirmed && result.blockNumber !== null
                      ? `通過 (#${result.blockNumber.toLocaleString()})`
                      : '未確定'}
                  </span>
                </div>

                {/* Step 2: Safe */}
                <div className="p-4 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Layers
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        isSafeOrBetter ? 'text-emerald-600' : 'text-slate-300'
                      }`}
                    />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        2. Ethereum L1 バッチ投稿 (Safe Head)
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
                        該当L2ブロックを含むバッチデータがEthereum L1 (EIP-4844 Blob / Calldata) に記録され、L1から導出可能になった段階。
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-600 shrink-0">
                    {isSafeOrBetter
                      ? '通過'
                      : result.blocksToSafe !== null && result.blocksToSafe > 0
                      ? `あと ${result.blocksToSafe.toLocaleString()} blk`
                      : '待機中'}
                  </span>
                </div>

                {/* Step 3: Finalized */}
                <div className="p-4 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <ShieldCheck
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        isFinalized ? 'text-emerald-600' : 'text-slate-300'
                      }`}
                    />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        3. Ethereum L1 コンセンサス確定 (Finalized Head)
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
                        バッチを格納したL1ブロックがEthereum Casper FFGで確定（約2エポック / 13〜15分）。L1スラッシングなしに巻き戻し不可。
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-600 shrink-0">
                    {isFinalized
                      ? '確定済み'
                      : result.blocksToFinalized !== null && result.blocksToFinalized > 0
                      ? `あと ${result.blocksToFinalized.toLocaleString()} blk (${formatDurationRough(
                          result.blocksToFinalized
                        )})`
                      : '待機中'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* L2 -> L1 Withdrawal Detail, TEE/ZK Check, 2-Step Simulation & Receive Funds */}
          {(localWithdrawal ?? result.withdrawal) && (() => {
            const w = (localWithdrawal ?? result.withdrawal)!;
            const liveRemainingSec =
              w.status === 'ready-to-finalize' || w.status === 'finalized'
                ? 0
                : w.estimatedClaimableAtMs
                ? Math.max(0, Math.ceil((w.estimatedClaimableAtMs - nowMs) / 1000))
                : w.totalSecondsRemaining;

            const val = w.validation ?? simResult?.validation;

            return (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-500">
                    L2 → L1 実出金検証・TEE/ZK判定・資金受け取りコンソール
                  </h4>
                  {onOpenInSimulator && (
                    <button
                      type="button"
                      onClick={() => onOpenInSimulator(result.hash)}
                      className="text-xs font-medium text-[#0052FF] hover:underline cursor-pointer"
                    >
                      専用シミュレーター画面で開く
                    </button>
                  )}
                </div>

                <div className="border border-slate-200 rounded-xl p-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-[11px] text-slate-500">出金金額</div>
                      <div className="mt-0.5 text-base font-bold font-mono tabular-nums text-slate-900">
                        {w.amountFormatted} {w.assetSymbol}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">
                        L1 Prove（出金証明）状態
                      </div>
                      {(() => {
                        const meta = getWithdrawalProveDisplayMeta(w);
                        return (
                          <>
                            <div
                              className={`mt-0.5 text-sm font-bold ${
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
                            <div className="text-[11px] text-slate-600">
                              {getWithdrawalStatusLabel(w.status)}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">出金可能まで残り</div>
                      <div
                        className={`mt-0.5 text-base font-bold font-mono tabular-nums ${
                          liveRemainingSec === 0 ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {formatSecondsJapanese(liveRemainingSec)}
                      </div>
                    </div>
                  </div>

                  {/* Post-Wait Actual Executability Verdict */}
                  {val && (
                    <div
                      className={`rounded-xl border p-3.5 space-y-1.5 ${
                        val.canWithdrawAfterWait
                          ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                          : 'bg-red-50/70 border-red-200 text-red-950'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-xs font-bold">
                        {val.canWithdrawAfterWait ? (
                          <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                        ) : (
                          <ShieldAlert className="w-4 h-4 text-red-700 shrink-0" />
                        )}
                        <span>待機時間経過後の実出金検証: {val.verdictLabel}</span>
                      </div>
                      <p className="text-xs leading-relaxed opacity-90">
                        {val.verdictSummary}
                      </p>
                    </div>
                  )}

                  {/* L2ToL1MessagePasser Status Block */}
                  {val?.messagePasser && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800">
                          L2ToL1MessagePasser ステータス (0x4200...0016)
                        </span>
                        <span
                          className={`text-xs font-mono font-semibold ${
                            val.messagePasser.sentMessageRecorded &&
                            val.messagePasser.merkleProofVerified
                              ? 'text-emerald-700'
                              : 'text-red-700'
                          }`}
                        >
                          {val.messagePasser.sentMessageRecorded
                            ? 'sentMessages = true · MPT証明確認済'
                            : 'sentMessages = false'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono text-slate-600">
                        <div className="truncate" title={val.messagePasser.storageKey}>
                          SlotKey: {val.messagePasser.storageKey.slice(0, 14)}...
                          {val.messagePasser.storageKey.slice(-8)}
                        </div>
                        <div>
                          Slot値:{' '}
                          {val.messagePasser.storageSlotValue
                            ? `${BigInt(val.messagePasser.storageSlotValue).toString()} (Version ${val.messagePasser.messageVersion})`
                            : `Version ${val.messagePasser.messageVersion}`}
                        </div>
                        <div
                          className="truncate"
                          title={val.messagePasser.storageRoot ?? ''}
                        >
                          StorageRoot:{' '}
                          {val.messagePasser.storageRoot
                            ? `${val.messagePasser.storageRoot.slice(0, 14)}...${val.messagePasser.storageRoot.slice(-6)}`
                            : '—'}
                        </div>
                        <div>
                          Merkle証明階層: {val.messagePasser.merkleProofNodes} nodes
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 3-Stage Frame & CrossDomainMessenger Hop Breakdown */}
                  {val &&
                    (val.portalTopLevelFinalizePassed !== undefined ||
                      (val.cdmHops && val.cdmHops.length > 0)) && (
                      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                        <div className="px-3.5 py-2 bg-slate-50/80 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold text-slate-700">
                          <span>
                            L1 確定フレーム ＆ 実測受取残高（Multicall3）検査
                          </span>
                          <span className="font-mono text-slate-500">
                            外枠メソッド:{' '}
                            {val.winningFinalizeFrame ?? 'finalizeExternalProof'}
                          </span>
                        </div>

                        <div
                          className={`px-3.5 py-2.5 space-y-1 text-[11px] ${
                            val.recipientBalanceIncreased === false ||
                            val.outerPortalRelaySimulated === false
                              ? 'bg-red-50/60'
                              : 'bg-emerald-50/30'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono">
                            <span className="font-semibold text-slate-900">
                              1. Portal外枠Tx:
                            </span>
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
                                  ? '非Revert (SafeCall吸収)'
                                  : 'PASS (Revertなし)'
                                : val.portalTopLevelFinalizePassed === false
                                ? 'Revert'
                                : '照会済'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-slate-900">
                              2. Hop 1 中継:
                            </span>
                            <span
                              className={
                                val.outerPortalRelaySimulated === false
                                  ? 'text-red-700 font-bold'
                                  : 'text-emerald-700 font-semibold'
                              }
                            >
                              {val.outerPortalRelaySimulated === false
                                ? 'Revert (ここで停止)'
                                : val.outerPortalRelaySimulated === true
                                ? 'PASS'
                                : '—'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-slate-900">
                              3. リーフ着金:
                            </span>
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
                                ? '未到達'
                                : val.leafBridgeCallPassed === true
                                ? 'PASS'
                                : val.leafBridgeCallPassed === false
                                ? 'Revert'
                                : '—'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-slate-900">
                              実測L1着金額:
                            </span>
                            <span
                              className={
                                val.recipientBalanceIncreased === false
                                  ? 'text-red-700 font-bold'
                                  : 'text-emerald-700 font-bold'
                              }
                            >
                              {val.recipientBalanceIncreased === false
                                ? `0 ${w.assetSymbol}（着金なし）`
                                : val.recipientBalanceIncreased === true
                                ? `+${w.amountFormatted} ${w.assetSymbol}（着金確認済 ✓）`
                                : '—'}
                            </span>
                          </div>
                          {val.recipientBalanceIncreased === false && (
                            <p className="text-[11px] text-red-800 leading-relaxed">
                              ※ OptimismPortal2 外側確定Tx (1) は SafeCall により Revert しませんが、Hop 1 (2) が L1CDM 自身を target としているため停止し、L1 受取アドレスの残高増分は 0 です（資産は着金しません）。
                            </p>
                          )}
                        </div>

                        {val.cdmHops?.map((hop) => {
                          const nonceBig = BigInt(hop.nonce);
                          const nonceCounter = nonceBig & ((1n << 240n) - 1n);
                          const blockedByEarlierHop =
                            hop.hopIndex > 1 &&
                            val.outerPortalRelaySimulated === false;
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
                                <span title={hop.sender}>
                                  sender: {hop.sender.slice(0, 10)}...{hop.sender.slice(-6)}
                                </span>
                                <span aria-hidden="true">→</span>
                                <span title={hop.target}>
                                  target: {hop.target.slice(0, 10)}...{hop.target.slice(-6)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>minGas: {Number(hop.minGasLimit).toLocaleString()}</span>
                              </div>
                              <div className="font-mono text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span title={hop.versionedHash}>
                                  versionedHash: {hop.versionedHash.slice(0, 12)}...
                                  {hop.versionedHash.slice(-6)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  successfulMessages: {String(hop.successfulMessage ?? '—')}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  failedMessages: {String(hop.failedMessage ?? '—')}
                                </span>
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

                  {/* 5-Step Withdrawal Validation Logic Checklist */}
                  {val && val.checks.length > 0 && (
                    <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                      <div className="px-3.5 py-2 bg-slate-50/80 text-[11px] font-semibold text-slate-600">
                        出金時オンチェーン・バリデーションロジック検証 ({val.checks.filter((c) => c.passed).length}/{val.checks.length} 合格)
                      </div>
                      {val.checks.map((chk) => (
                        <div key={chk.id} className="px-3.5 py-2.5 space-y-0.5">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-semibold text-slate-900">
                              {chk.label}
                            </span>
                            <span
                              className={`font-mono font-semibold shrink-0 ${
                                chk.status === 'pass'
                                  ? 'text-emerald-700'
                                  : chk.status === 'warn'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                              }`}
                            >
                              {chk.status === 'pass'
                                ? 'PASS'
                                : chk.status === 'warn'
                                ? 'WARN'
                                : 'FAIL'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-600 leading-relaxed break-words">
                            {chk.detail}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="text-xs text-slate-600 font-mono space-y-1 pt-2 border-t border-slate-100">
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">
                        L1 Prove 状態 (numProofSubmitters)
                      </span>
                      <span
                        className={`font-semibold text-right ${
                          getWithdrawalProveDisplayMeta(w).isProven
                            ? 'text-emerald-700'
                            : 'text-amber-800'
                        }`}
                      >
                        {val
                          ? val.numProofSubmitters > 0
                            ? `Prove済 ✓ (${val.numProofSubmitters}件登録)`
                            : '未Prove (0件 · 証明未提出)'
                          : getWithdrawalProveDisplayMeta(w).shortBadge}
                      </span>
                    </div>
                    {val?.provenTimestamp && (
                      <div className="flex justify-between gap-2">
                        <span className="font-sans text-slate-500">Prove 提出日時 (L1)</span>
                        <span className="tabular-nums">
                          {formatUnixTimestamp(val.provenTimestamp)}
                        </span>
                      </div>
                    )}
                    {val?.l1ProveTxHash && (
                      <div className="flex justify-between items-center gap-2">
                        <span className="font-sans text-slate-500">L1 Prove Tx Hash</span>
                        <span className="inline-flex items-center gap-1 truncate">
                          <span className="truncate">{val.l1ProveTxHash}</span>
                          {l1ExplorerUrl && (
                            <a
                              href={`${l1ExplorerUrl}/tx/${val.l1ProveTxHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#0052FF] hover:underline shrink-0"
                              aria-label="EtherscanでProveトランザクションを表示"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </span>
                      </div>
                    )}
                    {val?.proofSubmitter && (
                      <div className="flex justify-between gap-2">
                        <span className="font-sans text-slate-500">Prove 提出アドレス</span>
                        <span className="truncate">{val.proofSubmitter}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">
                        L1 OptimismPortal2.finalizedWithdrawals
                      </span>
                      <span
                        className={
                          w.portalFinalized
                            ? 'text-emerald-700 font-semibold'
                            : 'text-slate-800 font-semibold'
                        }
                      >
                        {w.portalFinalized
                          ? 'true (L1出金完了済)'
                          : 'false (未消費 · Claim枠有効)'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">L1 受取アドレス</span>
                      <span className="truncate">{w.l1Recipient}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">出金確定予定日時</span>
                      <span className="tabular-nums">
                        {w.estimatedClaimableAtMs
                          ? formatUnixTimestamp(Math.floor(w.estimatedClaimableAtMs / 1000))
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {simError && (
                    <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      {simError}
                    </p>
                  )}
                </div>

                {/* Direct TEE/ZK Check + Prove & Post-Maturity Finalize Simulation + 資金を受け取る Button */}
                <PimlicoExecutionPanel
                  txHash={result.hash}
                  withdrawalInfo={w}
                  networkConfig={networkConfig}
                  nowMs={nowMs}
                  externalSimResult={simResult}
                  externalIsSimulating={isSimulating}
                  onRunExternalSimulation={handleRunL1Sim}
                  onWithdrawalUpdated={(updated) => {
                    setLocalWithdrawal(updated);
                    onWithdrawalUpdatedGlobal?.(result.hash, updated);
                  }}
                  onExecutionCompleted={handleRunL1Sim}
                />
              </div>
            );
          })()}

          {/* Audit Metadata Grid */}
          <div>
            <h4 className="text-xs font-semibold text-slate-500 mb-3">
              {isWithdrawalTx
                ? '出金トランザクション・コントラクト詳細'
                : 'オンチェーン検証データ詳細'}
            </h4>
            <dl className="border border-slate-200 rounded-xl divide-y divide-slate-100 text-xs">
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">L2 収録ブロック番号 / 時刻</dt>
                <dd className="font-mono tabular-nums text-slate-900 text-right">
                  {result.blockNumber !== null
                    ? `#${result.blockNumber.toLocaleString()}${
                        result.blockTimestamp !== null
                          ? ` (${formatUnixTimestamp(result.blockTimestamp)})`
                          : ''
                      }`
                    : '—'}
                </dd>
              </div>
              {isWithdrawalTx && activeWithdrawal ? (
                <>
                  <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">withdrawalHash</dt>
                    <dd className="font-mono text-slate-900 truncate">
                      {activeWithdrawal.withdrawalHash}
                    </dd>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">MessagePasser Nonce</dt>
                    <dd className="font-mono tabular-nums text-slate-900 truncate">
                      {activeWithdrawal.nonce}
                    </dd>
                  </div>
                  {activeWithdrawal.validation?.portalAddress && (
                    <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                      <dt className="text-slate-500 shrink-0">L1 OptimismPortal2</dt>
                      <dd className="font-mono text-slate-900 truncate">
                        {activeWithdrawal.validation.portalAddress}
                      </dd>
                    </div>
                  )}
                  {activeWithdrawal.validation?.disputeGameAddress && (
                    <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                      <dt className="text-slate-500 shrink-0">L1 DisputeGameProxy</dt>
                      <dd className="font-mono text-slate-900 truncate">
                        {activeWithdrawal.validation.disputeGameAddress}
                      </dd>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">L2 確認数 (vs Latest)</dt>
                    <dd className="font-mono tabular-nums text-slate-900 text-right">
                      {result.confirmations !== null
                        ? `${result.confirmations.toLocaleString()} ブロック`
                        : '—'}
                    </dd>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <dt className="text-slate-500 shrink-0">
                      L1 Origin ブロック (L1Block Predeploy)
                    </dt>
                    <dd className="font-mono tabular-nums text-slate-900 text-right flex items-center gap-1.5">
                      {result.l1OriginBlock !== null ? (
                        <>
                          <span>#{result.l1OriginBlock.toLocaleString()}</span>
                          {result.l1OriginIsFinalized !== null && (
                            <span
                              className={
                                result.l1OriginIsFinalized
                                  ? 'text-emerald-700'
                                  : 'text-amber-700'
                              }
                            >
                              ({result.l1OriginIsFinalized ? 'L1 Finalized済' : 'L1 確定待ち'})
                            </span>
                          )}
                          {l1ExplorerUrl && (
                            <a
                              href={`${l1ExplorerUrl}/block/${result.l1OriginBlock}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-400 hover:text-[#0052FF]"
                              aria-label="EtherscanでL1ブロックを見る"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                </>
              )}
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">From アドレス</dt>
                <dd className="font-mono text-slate-900 truncate">{result.from ?? '—'}</dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">To アドレス</dt>
                <dd className="font-mono text-slate-900 truncate">
                  {result.to ?? (result.rawTx ? 'Contract Creation' : '—')}
                </dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">送金額 (Value)</dt>
                <dd className="font-mono tabular-nums text-slate-900">
                  {result.valueEth !== null ? `${result.valueEth} ETH` : '—'}
                </dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">L2 実行手数料 / L1 データ手数料</dt>
                <dd className="font-mono tabular-nums text-slate-900 text-right">
                  {result.totalFeeEth !== null
                    ? `${result.l2FeeEth} + ${result.l1FeeEth} = ${result.totalFeeEth} ETH`
                    : '—'}
                </dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Gas Used / Event Logs</dt>
                <dd className="font-mono tabular-nums text-slate-900">
                  {result.gasUsed !== null
                    ? `${Number(result.gasUsed).toLocaleString()} gas · ${
                        result.logsCount ?? 0
                      } logs`
                    : '—'}
                </dd>
              </div>
              {!isWithdrawalTx && (
                <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-500 shrink-0">
                    照合基準ヘッド (Finalized / Safe)
                  </dt>
                  <dd className="font-mono tabular-nums text-slate-600 text-right">
                    {snapshot?.finalized
                      ? `#${snapshot.finalized.number.toLocaleString()} / #${
                          snapshot.safe?.number.toLocaleString() ?? '—'
                        }`
                      : '—'}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Raw JSON-RPC Proof Toggle */}
          {(result.rawTx || result.rawReceipt) && (() => {
            const rawJsonString = JSON.stringify(
              {
                eth_getTransactionByHash: result.rawTx,
                eth_getTransactionReceipt: result.rawReceipt,
              },
              null,
              2
            );
            return (
              <div>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowRawJson((v) => !v)}
                    className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                  >
                    <Code2 className="w-4 h-4" />
                    <span>{showRawJson ? 'Raw JSON-RPC レスポンスを隠す' : 'Raw JSON-RPC レスポンスを表示'}</span>
                  </button>
                  {showRawJson && (
                    <button
                      type="button"
                      onClick={() => copyText('raw', rawJsonString)}
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                    >
                      {copiedKey === 'raw' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span>コピー済</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>JSONコピー</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {showRawJson && (
                  <pre className="mt-3 p-4 bg-slate-900 text-slate-100 rounded-xl text-[11px] font-mono overflow-x-auto max-h-80 leading-relaxed">
                    {rawJsonString}
                  </pre>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
