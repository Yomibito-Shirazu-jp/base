import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Play,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import type { Hex } from 'viem';
import { NetworkConfig, WithdrawalInfo } from '../types/finality';
import {
  formatSecondsJapanese,
  getDisputeGameStatusText,
  getProveLifecycleBadgeText,
} from '../lib/withdrawalAnalyzer';
import {
  L1ExecutionOutcome,
  PimlicoAccountPreview,
  PimlicoExecutionSettings,
  PreparedWithdrawalActionCall,
  SmartAccountKind,
  SignerSource,
  WithdrawalL1Action,
  executeWithdrawalOnL1,
  prepareWithdrawalActionCall,
  previewPimlicoSmartAccount,
} from '../lib/withdrawalExecutor';
import { formatUnixTimestamp, shortenHex } from '../lib/exportUtils';

const PIMLICO_SESSION_STORAGE_KEY = 'base-finality-pimlico-session-v1';

interface PimlicoExecutionPanelProps {
  txHash: string;
  withdrawalInfo: WithdrawalInfo;
  networkConfig: NetworkConfig;
  nowMs: number;
  onExecutionCompleted?: () => void;
}

function loadSessionPimlicoPrefs(): Partial<PimlicoExecutionSettings> {
  try {
    const raw = sessionStorage.getItem(PIMLICO_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      mode: parsed.mode === 'wallet' ? 'wallet' : 'pimlico',
      pimlicoRpcUrl:
        typeof parsed.pimlicoRpcUrl === 'string' ? parsed.pimlicoRpcUrl : '',
      pimlicoApiKey:
        typeof parsed.pimlicoApiKey === 'string' ? parsed.pimlicoApiKey : '',
      sponsorshipPolicyId:
        typeof parsed.sponsorshipPolicyId === 'string'
          ? parsed.sponsorshipPolicyId
          : '',
      usePaymaster:
        typeof parsed.usePaymaster === 'boolean' ? parsed.usePaymaster : true,
      smartAccountKind:
        parsed.smartAccountKind === 'safe' ? 'safe' : 'simple',
      signerSource:
        parsed.signerSource === 'privateKey' ? 'privateKey' : 'injected',
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
  onExecutionCompleted,
}: PimlicoExecutionPanelProps) {
  const initialPrefs = useMemo(() => loadSessionPimlicoPrefs(), []);

  const [mode, setMode] = useState<'pimlico' | 'wallet'>(
    initialPrefs.mode ?? 'pimlico'
  );
  const [pimlicoRpcUrl, setPimlicoRpcUrl] = useState(
    initialPrefs.pimlicoRpcUrl ?? ''
  );
  const [pimlicoApiKey, setPimlicoApiKey] = useState(
    initialPrefs.pimlicoApiKey ?? ''
  );
  const [sponsorshipPolicyId, setSponsorshipPolicyId] = useState(
    initialPrefs.sponsorshipPolicyId ?? ''
  );
  const [usePaymaster, setUsePaymaster] = useState(
    initialPrefs.usePaymaster ?? true
  );
  const [smartAccountKind, setSmartAccountKind] = useState<SmartAccountKind>(
    initialPrefs.smartAccountKind ?? 'simple'
  );
  const [signerSource, setSignerSource] = useState<SignerSource>(
    initialPrefs.signerSource ?? 'injected'
  );
  // Owner private key is strictly kept in React memory only (never written to storage)
  const [ownerPrivateKey, setOwnerPrivateKey] = useState('');

  const [showApiKey, setShowApiKey] = useState(false);
  const [showOwnerKey, setShowOwnerKey] = useState(false);

  const [accountPreview, setAccountPreview] =
    useState<PimlicoAccountPreview | null>(null);
  const [isPreviewingAccount, setIsPreviewingAccount] = useState(false);

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

  // Persist non-private-key Pimlico config in sessionStorage for current browser tab convenience
  useEffect(() => {
    try {
      sessionStorage.setItem(
        PIMLICO_SESSION_STORAGE_KEY,
        JSON.stringify({
          mode,
          pimlicoRpcUrl,
          pimlicoApiKey,
          sponsorshipPolicyId,
          usePaymaster,
          smartAccountKind,
          signerSource,
        })
      );
    } catch {
      // Ignore sessionStorage errors
    }
  }, [
    mode,
    pimlicoRpcUrl,
    pimlicoApiKey,
    sponsorshipPolicyId,
    usePaymaster,
    smartAccountKind,
    signerSource,
  ]);

  // Reset per-tx execution outputs when txHash changes
  useEffect(() => {
    setPreparedCall(null);
    setExecError(null);
    setExecOutcome(null);
    setStepMessage(null);
  }, [txHash]);

  const settings: PimlicoExecutionSettings = useMemo(
    () => ({
      mode,
      pimlicoRpcUrl,
      pimlicoApiKey,
      sponsorshipPolicyId,
      usePaymaster,
      smartAccountKind,
      signerSource,
      ownerPrivateKey,
    }),
    [
      mode,
      pimlicoRpcUrl,
      pimlicoApiKey,
      sponsorshipPolicyId,
      usePaymaster,
      smartAccountKind,
      signerSource,
      ownerPrivateKey,
    ]
  );

  const val = withdrawalInfo.validation;
  const elapsedSecSinceAnalyzed = Math.max(
    0,
    Math.floor((nowMs - withdrawalInfo.analyzedAtMs) / 1000)
  );

  const liveMaturityRemSec = useMemo(() => {
    if (withdrawalInfo.portalFinalized) return 0;
    if (val?.maturityRemainingSeconds === null || val?.maturityRemainingSeconds === undefined) {
      return withdrawalInfo.proofMaturityDelaySeconds;
    }
    if ((val.numProofSubmitters ?? 0) === 0) {
      // Clock hasn't started until Prove is submitted
      return val.maturityRemainingSeconds;
    }
    return Math.max(0, val.maturityRemainingSeconds - elapsedSecSinceAnalyzed);
  }, [withdrawalInfo, val, elapsedSecSinceAnalyzed]);

  const liveGameRemSec = useMemo(() => {
    if (withdrawalInfo.portalFinalized) return 0;
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
  }, [withdrawalInfo, val, elapsedSecSinceAnalyzed]);

  const canProveNow =
    !withdrawalInfo.portalFinalized &&
    (withdrawalInfo.status === 'ready-to-prove' ||
      val?.proveState === 'unproven-ready' ||
      val?.proveState === 'invalid-need-reprove');

  const canFinalizeNow =
    !withdrawalInfo.portalFinalized &&
    (withdrawalInfo.status === 'ready-to-finalize' ||
      val?.proveState === 'proven-ready');

  const l1ChainId =
    networkConfig.id === 'base-sepolia' || networkConfig.chainId === 84532
      ? 11155111
      : 1;
  const l1ChainLabel = l1ChainId === 11155111 ? 'Ethereum Sepolia' : 'Ethereum Mainnet';

  const copyValue = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // Ignore
    }
  };

  const handlePreviewAccount = async () => {
    setIsPreviewingAccount(true);
    setExecError(null);
    try {
      const preview = await previewPimlicoSmartAccount(settings, networkConfig);
      setAccountPreview(preview);
    } catch (err) {
      setExecError(
        err instanceof Error
          ? err.message
          : 'Pimlico Smart Account の接続確認に失敗しました'
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
        err instanceof Error
          ? err.message
          : 'L1 Calldata の構築に失敗しました'
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
        err instanceof Error ? err.message : 'L1 トランザクション実行に失敗しました'
      );
      setStepMessage(null);
    } finally {
      setExecutingAction(null);
    }
  };

  return (
    <div className="border border-slate-200 rounded-xl bg-white divide-y divide-slate-100">
      {/* 1. Prove & DisputeGame Detailed Inspection Header */}
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Prove状態チェック ＆ L1 出金確定 (Prove / Finalize) 実行コンソール
            </h3>
            <p className="mt-0.5 text-xs text-slate-600">
              <span className="font-mono">{l1ChainLabel}</span> の{' '}
              <span className="font-mono">
                OptimismPortal2{withdrawalInfo.portalVersion ? ` v${withdrawalInfo.portalVersion}` : ''}
              </span>{' '}
              に対して、Pimlico ERC-4337 (Bundler / Paymaster) またはブラウザウォレットで直接{' '}
              <span className="font-mono">proveWithdrawalTransaction</span> /{' '}
              <span className="font-mono">finalizeWithdrawalTransaction</span> を実行します。
            </p>
          </div>
          {val && (
            <div
              className={`text-xs font-semibold shrink-0 ${
                val.proveState === 'finalized' || val.proveState === 'proven-ready'
                  ? 'text-emerald-700'
                  : val.proveState === 'invalid-need-reprove'
                  ? 'text-red-700'
                  : 'text-[#0052FF]'
              }`}
            >
              {getProveLifecycleBadgeText(val.proveState)}
            </div>
          )}
        </div>

        {/* 4-Column Prove & Lock Breakdown */}
        <div className="border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-100 bg-slate-50/50">
          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              1. L1 Prove 提出記録
            </div>
            <div className="mt-1 text-sm font-bold font-mono tabular-nums text-slate-900">
              {val
                ? val.numProofSubmitters > 0
                  ? `提出済 (${val.numProofSubmitters}件)`
                  : '未提出 (0件)'
                : '—'}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-500 truncate">
              {val?.proofSubmitter
                ? `Submitter: ${shortenHex(val.proofSubmitter, 8, 6)}`
                : val?.proveState === 'unproven-ready'
                ? '今すぐProve送信可能'
                : 'L1 DisputeGame提案待ち'}
            </div>
            {val?.provenTimestamp ? (
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500">
                提出時刻: {formatUnixTimestamp(val.provenTimestamp)}
              </div>
            ) : null}
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              2. DisputeGame 状態 (5日枠)
            </div>
            <div className="mt-1 text-sm font-bold font-mono tabular-nums text-slate-900">
              {withdrawalInfo.portalFinalized
                ? '解決済 (完了)'
                : formatSecondsJapanese(liveGameRemSec)}
            </div>
            <div className="mt-1 text-[11px] text-slate-600 truncate">
              {val?.disputeGameAddress
                ? `${shortenHex(val.disputeGameAddress, 8, 6)} · ${getDisputeGameStatusText(
                    val.disputeGameStatus
                  )}`
                : val?.disputeGameIndex !== null && val?.disputeGameIndex !== undefined
                ? `対象 DisputeGame #${val.disputeGameIndex}`
                : `GameType ${withdrawalInfo.respectedGameType ?? 621} · 解決期間 ${formatSecondsJapanese(
                    withdrawalInfo.disputeGameResolutionSeconds
                  )}`}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              3. Prove後成熟待機 (1日枠)
            </div>
            <div className="mt-1 text-sm font-bold font-mono tabular-nums text-slate-900">
              {withdrawalInfo.portalFinalized
                ? '経過済 (完了)'
                : (val?.numProofSubmitters ?? 0) > 0
                ? formatSecondsJapanese(liveMaturityRemSec)
                : `Prove後に ${formatSecondsJapanese(
                    withdrawalInfo.proofMaturityDelaySeconds
                  )}`}
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
              proofMaturityDelay: {withdrawalInfo.proofMaturityDelaySeconds.toLocaleString()}秒
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[11px] font-medium text-slate-500">
              4. checkWithdrawal / 着金可否
            </div>
            <div
              className={`mt-1 text-sm font-bold ${
                withdrawalInfo.portalFinalized || canFinalizeNow
                  ? 'text-emerald-700'
                  : val?.canWithdrawAfterWait
                  ? 'text-slate-900'
                  : 'text-amber-700'
              }`}
            >
              {withdrawalInfo.portalFinalized
                ? 'L1出金完了済'
                : canFinalizeNow
                ? '合格 (今すぐ出金確定可)'
                : val?.canWithdrawAfterWait
                ? '待機後に実出金可'
                : '要確認'}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 truncate">
              {val?.messagePasser.sentMessageRecorded
                ? `MessagePasser=true · MPT ${val.messagePasser.merkleProofNodes}階層`
                : 'MessagePasser未確認'}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Execution Configuration (Pimlico RPC / API Key / Policy ID or Direct Wallet) */}
      {!withdrawalInfo.portalFinalized && (
        <div className="p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="inline-flex p-1 bg-slate-100 rounded-lg self-start">
              <button
                type="button"
                onClick={() => setMode('pimlico')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === 'pimlico'
                    ? 'bg-white text-[#0052FF] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pimlico ERC-4337 (RPC / Key / Policy ID)
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
              L1受取アドレス固定: {shortenHex(withdrawalInfo.l1Recipient, 10, 8)} (誰が実行しても受取人へ着金)
            </div>
          </div>

          {mode === 'pimlico' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label
                    htmlFor="pimlico-rpc-url"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Pimlico RPC URL (任意・API Keyのみでも自動生成)
                  </label>
                  <input
                    id="pimlico-rpc-url"
                    type="text"
                    value={pimlicoRpcUrl}
                    onChange={(e) => setPimlicoRpcUrl(e.target.value)}
                    placeholder={`https://api.pimlico.io/v2/${l1ChainId}/rpc?apikey=...`}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="pimlico-api-key"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Pimlico API Key (<span className="font-mono">pim_...</span>)
                  </label>
                  <div className="relative">
                    <input
                      id="pimlico-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={pimlicoApiKey}
                      onChange={(e) => setPimlicoApiKey(e.target.value)}
                      placeholder="pim_xxxxxxxxxxxxxxxxxxxxxx"
                      autoComplete="off"
                      className="w-full pl-3 pr-9 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={showApiKey ? 'APIキーを隠す' : 'APIキーを表示'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showApiKey ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="pimlico-policy-id"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Sponsorship Policy ID (<span className="font-mono">sp_...</span> 任意)
                  </label>
                  <input
                    id="pimlico-policy-id"
                    type="text"
                    value={sponsorshipPolicyId}
                    onChange={(e) => setSponsorshipPolicyId(e.target.value)}
                    placeholder="sp_xxxxxxxxxxxxxxxx"
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Smart Account 種別 (EntryPoint v0.7)
                  </label>
                  <div className="inline-flex w-full p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setSmartAccountKind('simple')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        smartAccountKind === 'simple'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      SimpleAccount
                    </button>
                    <button
                      type="button"
                      onClick={() => setSmartAccountKind('safe')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        smartAccountKind === 'safe'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Safe v1.4.1
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Smart Account オーナー署名元
                  </label>
                  <div className="inline-flex w-full p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setSignerSource('injected')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        signerSource === 'injected'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      ウォレット署名
                    </button>
                    <button
                      type="button"
                      onClick={() => setSignerSource('privateKey')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        signerSource === 'privateKey'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      オーナー秘密鍵
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pb-1">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={usePaymaster}
                      onChange={(e) => setUsePaymaster(e.target.checked)}
                      className="rounded border-slate-300 text-[#0052FF] focus:ring-[#0052FF]"
                    />
                    <span>Paymaster ガス代スポンサーを使用</span>
                  </label>

                  <button
                    type="button"
                    onClick={handlePreviewAccount}
                    disabled={
                      isPreviewingAccount ||
                      (!pimlicoRpcUrl.trim() && !pimlicoApiKey.trim())
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        isPreviewingAccount ? 'animate-spin' : ''
                      }`}
                    />
                    <span>接続・Smart Account確認</span>
                  </button>
                </div>
              </div>

              {signerSource === 'privateKey' && (
                <div>
                  <label
                    htmlFor="pimlico-owner-pk"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    オーナー秘密鍵 (0x... · ストレージやサーバーには一切保存されません)
                  </label>
                  <div className="relative max-w-xl">
                    <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="pimlico-owner-pk"
                      type={showOwnerKey ? 'text' : 'password'}
                      value={ownerPrivateKey}
                      onChange={(e) => setOwnerPrivateKey(e.target.value)}
                      placeholder="0x..."
                      autoComplete="off"
                      className="w-full pl-8 pr-9 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowOwnerKey((v) => !v)}
                      aria-label={showOwnerKey ? '秘密鍵を隠す' : '秘密鍵を表示'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showOwnerKey ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {accountPreview && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">
                      Pimlico Bundler 接続OK ({accountPreview.l1ChainName})
                    </span>
                    <span className="font-mono tabular-nums text-slate-600">
                      Bundler Fast MaxFee: {accountPreview.fastMaxFeeGwei} Gwei
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
                        {accountPreview.isDeployed ? 'Deployed' : '未デプロイ (初回自動展開)'}{' '}
                        · {accountPreview.smartAccountEthBalance} ETH
                      </span>
                    </div>
                    <div className="truncate">
                      <span className="font-sans text-slate-500">Owner: </span>
                      <span>{accountPreview.ownerAddress}</span>
                    </div>
                    <div className="truncate">
                      <span className="font-sans text-slate-500">Endpoint: </span>
                      <span>{accountPreview.resolvedBundlerUrlMasked}</span>
                    </div>
                  </div>
                  {accountPreview.sponsorshipPolicyNote && (
                    <div className="text-[11px] text-slate-600 pt-0.5">
                      {accountPreview.sponsorshipPolicyNote}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs text-slate-700 flex items-center gap-2.5">
              <Wallet className="w-4 h-4 text-[#0052FF] shrink-0" />
              <span>
                ブラウザウォレット (MetaMask / Rabby / Coinbase Wallet) を{' '}
                <strong className="font-mono">{l1ChainLabel}</strong> に切り替え、{' '}
                <span className="font-mono">OptimismPortal2</span> へ直接トランザクションを送信します。他アドレスでProve済みの出金も{' '}
                <span className="font-mono">finalizeWithdrawalTransactionExternalProof</span> でそのまま確定可能です。
              </span>
            </div>
          )}

          {/* Action Buttons Row */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => handleExecute('prove')}
                disabled={executingAction !== null || !canProveNow}
                title={
                  canProveNow
                    ? 'Ethereum L1 OptimismPortal2 に proveWithdrawalTransaction を送信します'
                    : withdrawalInfo.status === 'waiting-to-prove'
                    ? 'L1 DisputeGame 提案到達後に実行可能になります'
                    : '既に Prove 提出済みです'
                }
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                {executingAction === 'prove' ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Prove 送信中...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>
                      1. L1で Prove (出金証明) を実行
                      {(val?.numProofSubmitters ?? 0) > 0 &&
                      val?.proveState !== 'invalid-need-reprove'
                        ? ' (提出済)'
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
                  canFinalizeNow
                    ? 'Ethereum L1 OptimismPortal2 で出金をファイナライズし資産を受け取ります'
                    : 'Prove後成熟期間 (1日) と DisputeGame解決期間 (約5日) の完了後に実行可能になります'
                }
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                {executingAction === 'finalize' ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>出金確定 (Finalize) 送信中...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>2. L1で出金確定 (Finalize / Claim) を実行</span>
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

          {!canProveNow && !canFinalizeNow && (
            <p className="text-xs text-slate-600">
              {withdrawalInfo.status === 'waiting-to-prove'
                ? '現在 L1 DisputeGame 提案待ちです（通常 約25〜30分以内に「Prove実行可能」になります）。'
                : `現在 Prove提出済みでロック期間待機中です（DisputeGame解決残り: ${formatSecondsJapanese(
                    liveGameRemSec
                  )} / Prove成熟残り: ${formatSecondsJapanese(
                    liveMaturityRemSec
                  )}）。経過後すぐに上の「2. L1で出金確定」ボタンが有効になります。`}
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
                    ? 'L1 Prove (出金証明提出) がオンチェーンで確定しました'
                    : 'L1 出金確定 (Finalize) が完了し、受取アドレスへ資産が送出されました'}
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
                      Pimlico UserOp Hash:{' '}
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
      )}
    </div>
  );
}
