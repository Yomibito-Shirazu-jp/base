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
  Play,
  RefreshCw,
  ShieldAlert,
  Clock,
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
  formatSecondsJapanese,
  getWithdrawalStatusLabel,
  simulateWithdrawalOnL1,
} from '../lib/withdrawalAnalyzer';

interface TxInspectorDrawerProps {
  result: VerifiedTransactionResult | null;
  snapshot: ChainHeadSnapshot | null;
  networkConfig: NetworkConfig;
  explorerUrl: string;
  l1ExplorerUrl: string;
  onClose: () => void;
  onOpenInSimulator?: (txHash: string) => void;
}

export function TxInspectorDrawer({
  result,
  snapshot,
  networkConfig,
  explorerUrl,
  l1ExplorerUrl,
  onClose,
  onOpenInSimulator,
}: TxInspectorDrawerProps) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<WithdrawalSimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setSimResult(null);
    setSimError(null);
  }, [result?.hash]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[1px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="トランザクション詳細検証"
    >
      <div
        className="w-full max-w-2xl bg-white h-full overflow-y-auto border-l border-slate-200 flex flex-col"
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
                <div className="text-xs text-slate-500">現在のファイナライズ判定</div>
                <div className="mt-1 text-lg font-bold text-slate-900">
                  {getFinalityLabel(result.finality)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">EVM 実行ステータス</div>
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-500">
                  情報の信頼性・照合根拠
                </span>
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

          {/* 3-Stage OP Stack Finality Pipeline */}
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

          {/* L2 -> L1 Withdrawal Detail & L1 Simulation */}
          {result.withdrawal && (() => {
            const w = result.withdrawal;
            const liveRemainingSec =
              w.status === 'ready-to-finalize' || w.status === 'finalized'
                ? 0
                : w.estimatedClaimableAtMs
                ? Math.max(0, Math.ceil((w.estimatedClaimableAtMs - nowMs) / 1000))
                : w.totalSecondsRemaining;

            return (
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h4 className="text-xs font-semibold text-slate-500">
                    L2 → L1 出金可能残り時間・金額・L1シミュレーション
                  </h4>
                  {onOpenInSimulator && (
                    <button
                      type="button"
                      onClick={() => onOpenInSimulator(result.hash)}
                      className="text-xs font-medium text-[#0052FF] hover:underline cursor-pointer"
                    >
                      シミュレーター画面で開く
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
                      <div className="text-[11px] text-slate-500">出金ステータス</div>
                      <div className="mt-0.5 text-xs font-semibold text-slate-900">
                        {getWithdrawalStatusLabel(w.status)}
                      </div>
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

                  <div className="text-xs text-slate-600 font-mono space-y-1 pt-2 border-t border-slate-100">
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">
                        L1 OptimismPortal2.finalizedWithdrawals
                      </span>
                      <span
                        className={
                          w.portalFinalized
                            ? 'text-emerald-700 font-semibold'
                            : 'text-red-700 font-semibold'
                        }
                      >
                        {w.portalFinalized
                          ? 'true (L1コード実行・出金完了済み)'
                          : 'false (L1ファイナライズコード未実行)'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">L1 受取アドレス</span>
                      <span className="truncate">{w.l1Recipient}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="font-sans text-slate-500">出金可能予定日時</span>
                      <span className="tabular-nums">
                        {w.estimatedClaimableAtMs
                          ? formatUnixTimestamp(Math.floor(w.estimatedClaimableAtMs / 1000))
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {!w.portalFinalized && (
                    <p className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 leading-relaxed">
                      ※ 上部の「L2 Finalized」はBaseのブロックデータがL1で確定した状態を指します。L1側で実際に資産を受け取るには、別途
                      <span className="font-mono text-slate-800"> proveWithdrawalTransaction </span>
                      および成熟待機後の
                      <span className="font-mono text-slate-800"> finalizeWithdrawalTransaction </span>
                      の実行が必要です。
                    </p>
                  )}

                  <div className="pt-1 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleRunL1Sim}
                      disabled={isSimulating}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors cursor-pointer"
                    >
                      {isSimulating ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>L1シミュレーション中...</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>L1出金シミュレーション実行</span>
                        </>
                      )}
                    </button>
                  </div>

                  {simError && (
                    <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      {simError}
                    </p>
                  )}

                  {simResult && (
                    <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                      <div className="font-semibold text-slate-900">
                        {simResult.l1DryRunMessage}
                      </div>
                      <div className="font-mono tabular-nums text-slate-600">
                        L1 Gas: {simResult.l1GasPriceGwei} Gwei · 推定L1手数料:{' '}
                        {simResult.totalL1ClaimCostEth} ETH
                        {simResult.netAmountFormatted
                          ? ` · 実質受取: ${simResult.netAmountFormatted}`
                          : ''}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Audit Metadata Grid */}
          <div>
            <h4 className="text-xs font-semibold text-slate-500 mb-3">
              オンチェーン検証データ詳細
            </h4>
            <dl className="border border-slate-200 rounded-xl divide-y divide-slate-100 text-xs">
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">L2 ブロック番号 / 時刻</dt>
                <dd className="font-mono tabular-nums text-slate-900 text-right">
                  {result.blockNumber !== null
                    ? `#${result.blockNumber.toLocaleString()} (${formatUnixTimestamp(
                        result.blockTimestamp
                      )})`
                    : '—'}
                </dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">L2 確認数 (vs Latest)</dt>
                <dd className="font-mono tabular-nums text-slate-900 text-right">
                  {result.confirmations !== null
                    ? `${result.confirmations.toLocaleString()} ブロック`
                    : '—'}
                </dd>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">L1 Origin ブロック (L1Block Predeploy)</dt>
                <dd className="font-mono tabular-nums text-slate-900 text-right flex items-center gap-1.5">
                  {result.l1OriginBlock !== null ? (
                    <>
                      <span>#{result.l1OriginBlock.toLocaleString()}</span>
                      {result.l1OriginIsFinalized !== null && (
                        <span
                          className={
                            result.l1OriginIsFinalized ? 'text-emerald-700' : 'text-amber-700'
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
              <div className="px-4 py-2.5 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">照合基準ヘッド (Finalized / Safe)</dt>
                <dd className="font-mono tabular-nums text-slate-600 text-right">
                  {snapshot?.finalized
                    ? `#${snapshot.finalized.number.toLocaleString()} / #${
                        snapshot.safe?.number.toLocaleString() ?? '—'
                      }`
                    : '—'}
                </dd>
              </div>
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
