import {
  createPublicClient,
  fallback,
  formatEther,
  formatGwei,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import {
  getWithdrawals,
  publicActionsL1,
  publicActionsL2,
} from 'viem/op-stack';
import {
  NetworkConfig,
  WithdrawalInfo,
  WithdrawalSimulationResult,
  WithdrawalStatus,
} from '../types/finality';

export const L2_TO_L1_MESSAGE_PASSER =
  '0x4200000000000000000000000000000000000016'.toLowerCase();

const L2_STANDARD_BRIDGE_ABI = parseAbi([
  'event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)',
  'event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)',
  'event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
]);

const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const OPTIMISM_PORTAL_READ_ABI = parseAbi([
  'function proofMaturityDelaySeconds() view returns (uint256)',
  'function disputeGameFinalityDelaySeconds() view returns (uint256)',
  'function finalizedWithdrawals(bytes32) view returns (bool)',
  'function finalizeWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx)',
  'function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _disputeGameIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)',
]);

function buildTransport(urls: string[]) {
  const transports = urls.map((u) => {
    const resolved = u.startsWith('/') && typeof window !== 'undefined'
      ? `${window.location.origin}${u}`
      : u;
    return http(resolved, { timeout: 15000 });
  });
  return transports.length === 1 ? transports[0] : fallback(transports);
}

function getChains(config: NetworkConfig) {
  const isSepolia = config.id === 'base-sepolia' || config.chainId === 84532;
  if (isSepolia) {
    return {
      l2Chain: baseSepolia,
      l1Chain: sepolia,
      portalAddress: baseSepolia.contracts.portal[sepolia.id].address,
    };
  }
  return {
    l2Chain: base,
    l1Chain: mainnet,
    portalAddress: base.contracts.portal[mainnet.id].address,
  };
}

export function createBaseAndL1Clients(config: NetworkConfig) {
  const { l2Chain, l1Chain, portalAddress } = getChains(config);
  const l2Client = createPublicClient({
    chain: l2Chain,
    transport: buildTransport(config.rpcUrls),
  }).extend(publicActionsL2());

  const l1Client = createPublicClient({
    chain: l1Chain,
    transport: buildTransport(
      config.l1RpcUrls.length > 0
        ? config.l1RpcUrls
        : ['/api/rpc/eth-mainnet', 'https://ethereum-rpc.publicnode.com']
    ),
  }).extend(publicActionsL1());

  return { l2Client, l1Client, l2Chain, l1Chain, portalAddress };
}

export interface LiveWithdrawalConditions {
  proofMaturityDelaySeconds: number;
  disputeGameFinalityDelaySeconds: number;
  usedFallbackDelay: boolean;
  l1GasPriceGwei: string;
  l2GasPriceGwei: string;
  l1GasPriceWei: string;
  l2GasPriceWei: string;
  estimatedProveGas: number;
  estimatedFinalizeGas: number;
  estimatedProveFeeEth: string;
  estimatedFinalizeFeeEth: string;
  totalL1FeeEth: string;
  fetchedAtMs: number;
}

export async function fetchLiveWithdrawalConditions(
  config: NetworkConfig
): Promise<LiveWithdrawalConditions> {
  const { l1Client, l2Client, portalAddress } = createBaseAndL1Clients(config);
  let usedFallbackDelay = false;

  const [maturityDelay, gameDelay, l1GasPrice, l2GasPrice] = await Promise.all([
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proofMaturityDelaySeconds',
      })
      .catch(() => {
        usedFallbackDelay = true;
        return 86400n;
      }),
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'disputeGameFinalityDelaySeconds',
      })
      .catch(() => {
        usedFallbackDelay = true;
        return 0n;
      }),
    l1Client.getGasPrice(),
    l2Client.getGasPrice(),
  ]);

  const estimatedProveGas = 290000;
  const estimatedFinalizeGas = 230000;
  const proveFeeWei = l1GasPrice * BigInt(estimatedProveGas);
  const finalizeFeeWei = l1GasPrice * BigInt(estimatedFinalizeGas);
  const totalFeeWei = proveFeeWei + finalizeFeeWei;

  return {
    proofMaturityDelaySeconds: Number(maturityDelay),
    disputeGameFinalityDelaySeconds: Number(gameDelay),
    usedFallbackDelay,
    l1GasPriceGwei: Number(formatGwei(l1GasPrice)).toFixed(3),
    l2GasPriceGwei: Number(formatGwei(l2GasPrice)).toFixed(4),
    l1GasPriceWei: l1GasPrice.toString(),
    l2GasPriceWei: l2GasPrice.toString(),
    estimatedProveGas,
    estimatedFinalizeGas,
    estimatedProveFeeEth: Number(formatEther(proveFeeWei)).toFixed(6),
    estimatedFinalizeFeeEth: Number(formatEther(finalizeFeeWei)).toFixed(6),
    totalL1FeeEth: Number(formatEther(totalFeeWei)).toFixed(6),
    fetchedAtMs: Date.now(),
  };
}

export async function analyzeWithdrawalFromTxHash(
  txHash: Hex,
  config: NetworkConfig
): Promise<WithdrawalInfo | null> {
  const { l1Client, l2Client, l2Chain, l1Chain, portalAddress } =
    createBaseAndL1Clients(config);
  const receipt = await l2Client.getTransactionReceipt({ hash: txHash });
  return analyzeWithdrawalFromReceipt(receipt, config, {
    l1Client,
    l2Client,
    l2Chain,
    l1Chain,
    portalAddress,
  });
}

export async function analyzeWithdrawalFromReceipt(
  receipt: TransactionReceipt,
  config: NetworkConfig,
  clients?: ReturnType<typeof createBaseAndL1Clients>
): Promise<WithdrawalInfo | null> {
  const withdrawals = getWithdrawals(receipt);
  if (withdrawals.length === 0) return null;

  const primary = withdrawals[0];
  const { l1Client, l2Client, l2Chain, portalAddress } =
    clients ?? createBaseAndL1Clients(config);

  // Decode bridge asset & recipient details from L2StandardBridge logs
  let assetType: 'ETH' | 'ERC20' | 'MESSAGE' = primary.value > 0n ? 'ETH' : 'MESSAGE';
  let assetSymbol = primary.value > 0n ? 'ETH' : 'Message';
  let assetDecimals = 18;
  let l2TokenAddress: string | null = null;
  let l1TokenAddress: string | null = null;
  let amountRaw = primary.value;
  let l1Recipient: string = primary.target;

  try {
    const bridgeEvents = parseEventLogs({
      abi: L2_STANDARD_BRIDGE_ABI,
      logs: receipt.logs,
    });

    const erc20Evt = bridgeEvents.find(
      (e) => e.eventName === 'ERC20BridgeInitiated' || e.eventName === 'WithdrawalInitiated'
    );
    const ethEvt = bridgeEvents.find((e) => e.eventName === 'ETHBridgeInitiated');

    if (erc20Evt) {
      assetType = 'ERC20';
      const args = erc20Evt.args as {
        localToken?: Address;
        l2Token?: Address;
        remoteToken?: Address;
        l1Token?: Address;
        to: Address;
        amount: bigint;
      };
      l2TokenAddress = args.localToken ?? args.l2Token ?? null;
      l1TokenAddress = args.remoteToken ?? args.l1Token ?? null;
      l1Recipient = args.to;
      amountRaw = args.amount;

      if (l2TokenAddress) {
        const [sym, dec] = await Promise.all([
          l2Client
            .readContract({
              address: l2TokenAddress as Address,
              abi: ERC20_META_ABI,
              functionName: 'symbol',
            })
            .catch(() => 'ERC20'),
          l2Client
            .readContract({
              address: l2TokenAddress as Address,
              abi: ERC20_META_ABI,
              functionName: 'decimals',
            })
            .catch(() => 18),
        ]);
        assetSymbol = sym;
        assetDecimals = Number(dec);
      }
    } else if (ethEvt) {
      assetType = 'ETH';
      assetSymbol = 'ETH';
      assetDecimals = 18;
      const args = ethEvt.args as { to: Address; amount: bigint };
      l1Recipient = args.to;
      amountRaw = args.amount;
    }
  } catch {
    // Keep MessagePassed fallback
  }

  const formattedRaw = formatUnits(amountRaw, assetDecimals);
  const amountFormatted = formatDisplayAmount(formattedRaw);

  // Query live OptimismPortal2 parameters & withdrawal status on L1
  let usedFallbackDelay = false;

  const [status, portalFinalized, maturityDelayBig, gameDelayBig] = await Promise.all([
    l1Client.getWithdrawalStatus({
      receipt,
      targetChain: l2Chain,
    }) as Promise<WithdrawalStatus>,
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'finalizedWithdrawals',
        args: [primary.withdrawalHash],
      })
      .catch(() => {
        usedFallbackDelay = true;
        return false;
      }),
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proofMaturityDelaySeconds',
      })
      .catch(() => {
        usedFallbackDelay = true;
        return 86400n;
      }),
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'disputeGameFinalityDelaySeconds',
      })
      .catch(() => {
        usedFallbackDelay = true;
        return 0n;
      }),
  ]);

  const effectiveStatus: WithdrawalStatus =
    status === 'finalized' && !portalFinalized ? 'ready-to-finalize' : status;

  const proofMaturityDelaySeconds = Number(maturityDelayBig);
  const disputeGameFinalityDelaySeconds = Number(gameDelayBig);
  const analyzedAtMs = Date.now();

  let secondsToProve: number | null = null;
  let secondsToFinalize: number | null = null;
  let totalSecondsRemaining: number | null = null;
  let estimatedClaimableAtMs: number | null = null;

  if (effectiveStatus === 'waiting-to-prove') {
    try {
      const ttp = await l1Client.getTimeToProve({
        receipt,
        targetChain: l2Chain,
      });
      secondsToProve = Math.max(0, Math.ceil(ttp.seconds));
      totalSecondsRemaining =
        secondsToProve + proofMaturityDelaySeconds + disputeGameFinalityDelaySeconds;
      estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
    } catch {
      usedFallbackDelay = true;
      secondsToProve = null;
      totalSecondsRemaining = proofMaturityDelaySeconds + disputeGameFinalityDelaySeconds;
      estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
    }
  } else if (effectiveStatus === 'ready-to-prove') {
    secondsToProve = 0;
    secondsToFinalize = proofMaturityDelaySeconds + disputeGameFinalityDelaySeconds;
    totalSecondsRemaining = secondsToFinalize;
    estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
  } else if (effectiveStatus === 'waiting-to-finalize') {
    try {
      const ttf = await l1Client.getTimeToFinalize({
        withdrawalHash: primary.withdrawalHash,
        targetChain: l2Chain,
      });
      secondsToFinalize = Math.max(0, Math.ceil(ttf.seconds));
      totalSecondsRemaining = secondsToFinalize;
      estimatedClaimableAtMs = ttf.timestamp || analyzedAtMs + secondsToFinalize * 1000;
    } catch {
      usedFallbackDelay = true;
      secondsToFinalize = proofMaturityDelaySeconds;
      totalSecondsRemaining = proofMaturityDelaySeconds;
      estimatedClaimableAtMs = analyzedAtMs + proofMaturityDelaySeconds * 1000;
    }
  } else if (effectiveStatus === 'ready-to-finalize' || effectiveStatus === 'finalized') {
    secondsToProve = 0;
    secondsToFinalize = 0;
    totalSecondsRemaining = 0;
    estimatedClaimableAtMs = analyzedAtMs;
  }

  return {
    withdrawalHash: primary.withdrawalHash,
    nonce: primary.nonce.toString(),
    sender: primary.sender,
    target: primary.target,
    l1Recipient,
    assetType,
    assetSymbol,
    assetDecimals,
    l2TokenAddress,
    l1TokenAddress,
    amountRaw: amountRaw.toString(),
    amountFormatted,
    valueWei: primary.value.toString(),
    gasLimit: primary.gasLimit.toString(),
    data: primary.data,
    status: effectiveStatus,
    portalFinalized: Boolean(portalFinalized),
    usedFallbackDelay,
    proofMaturityDelaySeconds,
    disputeGameFinalityDelaySeconds,
    secondsToProve,
    secondsToFinalize,
    totalSecondsRemaining,
    estimatedClaimableAtMs,
    analyzedAtMs,
  };
}

export async function simulateWithdrawalOnL1(
  txHash: Hex,
  config: NetworkConfig
): Promise<WithdrawalSimulationResult> {
  const { l1Client, l2Client, l2Chain, l1Chain, portalAddress } =
    createBaseAndL1Clients(config);
  const receipt = await l2Client.getTransactionReceipt({ hash: txHash });
  const info = await analyzeWithdrawalFromReceipt(receipt, config, {
    l1Client,
    l2Client,
    l2Chain,
    l1Chain,
    portalAddress,
  });

  if (!info) {
    throw new Error('このトランザクションには L2ToL1MessagePasser の出金イベントが含まれていません');
  }
  const withdrawals = getWithdrawals(receipt);
  const withdrawalTuple = withdrawals[0];
  const l1GasPrice = await l1Client.getGasPrice();
  const l2GasPrice = await l2Client.getGasPrice();

  let estimatedProveGas = 290000n;
  let estimatedFinalizeGas = 230000n;
  let l1DryRunAction: WithdrawalSimulationResult['l1DryRunAction'] =
    'finalizeWithdrawalTransaction';
  let l1DryRunSuccess = false;
  let l1DryRunMessage = '';

  const withdrawalArg = {
    nonce: withdrawalTuple.nonce,
    sender: withdrawalTuple.sender,
    target: withdrawalTuple.target,
    value: withdrawalTuple.value,
    gasLimit: withdrawalTuple.gasLimit,
    data: withdrawalTuple.data,
  };

  if (info.status === 'finalized') {
    l1DryRunAction = 'already-finalized';
    l1DryRunSuccess = true;
    l1DryRunMessage =
      'OptimismPortal2 上で既に出金ファイナライズ (Claim) 済みのため、追加の L1 実行は不要です。';
    estimatedFinalizeGas = 0n;
    estimatedProveGas = 0n;
  } else if (info.status === 'ready-to-finalize') {
    l1DryRunAction = 'finalizeWithdrawalTransaction';
    try {
      const est = await l1Client.estimateContractGas({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'finalizeWithdrawalTransaction',
        args: [withdrawalArg],
        account: receipt.from,
      });
      estimatedFinalizeGas = est;
      await l1Client.simulateContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'finalizeWithdrawalTransaction',
        args: [withdrawalArg],
        account: receipt.from,
      });
      l1DryRunSuccess = true;
      l1DryRunMessage = `L1 OptimismPortal2.finalizeWithdrawalTransaction のドライランが成功しました（推定Gas: ${est.toLocaleString()}）。今すぐ出金クレームを実行できます。`;
    } catch (err) {
      l1DryRunSuccess = false;
      l1DryRunMessage =
        err instanceof Error
          ? `L1シミュレーション結果: ${extractShortRevertReason(err.message)}`
          : 'L1 Finalize シミュレーションに失敗しました';
    }
  } else if (info.status === 'ready-to-prove') {
    l1DryRunAction = 'proveWithdrawalTransaction';
    try {
      const output = await l1Client.getL2Output({
        l2BlockNumber: receipt.blockNumber,
        targetChain: l2Chain,
      });
      const proveArgs = await l2Client.buildProveWithdrawal({
        output,
        withdrawal: withdrawalTuple,
      });
      const est = await l1Client.estimateContractGas({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proveWithdrawalTransaction',
        args: [
          proveArgs.withdrawal,
          BigInt(proveArgs.l2OutputIndex),
          proveArgs.outputRootProof,
          proveArgs.withdrawalProof,
        ],
        account: receipt.from,
      });
      estimatedProveGas = est;
      l1DryRunSuccess = true;
      l1DryRunMessage = `L1 OptimismPortal2.proveWithdrawalTransaction のドライランが成功しました（推定Gas: ${est.toLocaleString()}）。Prove 実行後、${formatSecondsJapanese(
        info.proofMaturityDelaySeconds
      )}の待機期間を経て出金可能になります。`;
    } catch (err) {
      l1DryRunSuccess = false;
      l1DryRunMessage = `L1 Prove シミュレーション: ${extractShortRevertReason(
        err instanceof Error ? err.message : String(err)
      )}`;
    }
  } else {
    // waiting-to-prove or waiting-to-finalize: perform real L1 dry-run against finalizeWithdrawalTransaction to surface exact on-chain guard
    l1DryRunAction = 'finalizeWithdrawalTransaction';
    try {
      await l1Client.simulateContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'finalizeWithdrawalTransaction',
        args: [withdrawalArg],
        account: receipt.from,
      });
      l1DryRunSuccess = true;
      l1DryRunMessage = 'L1 Finalize シミュレーションが通過しました。';
    } catch (err) {
      const reason = extractShortRevertReason(
        err instanceof Error ? err.message : String(err)
      );
      l1DryRunSuccess = false;
      l1DryRunMessage =
        info.status === 'waiting-to-prove'
          ? `L1オンチェーン照合 (Revert確認): 未Proveのため出金保留中 (${reason})。DisputeGame提案後に Prove 可能です。`
          : `L1オンチェーン照合 (Revert確認): 成熟期間待機中のため出金保留中 (${reason})。`;
    }
  }

  const proveFeeWei =
    info.status === 'waiting-to-finalize' ||
    info.status === 'ready-to-finalize' ||
    info.status === 'finalized'
      ? 0n
      : l1GasPrice * estimatedProveGas;
  const finalizeFeeWei =
    info.status === 'finalized' ? 0n : l1GasPrice * estimatedFinalizeGas;
  const totalL1ClaimCostWei = proveFeeWei + finalizeFeeWei;

  let netAmountFormatted: string | null = null;
  if (info.assetType === 'ETH') {
    const grossWei = BigInt(info.amountRaw);
    const netWei = grossWei > totalL1ClaimCostWei ? grossWei - totalL1ClaimCostWei : 0n;
    netAmountFormatted = `${formatDisplayAmount(formatEther(netWei))} ETH`;
  } else if (info.assetType === 'ERC20') {
    netAmountFormatted = `${info.amountFormatted} ${info.assetSymbol} (別途 L1ガス ${Number(
      formatEther(totalL1ClaimCostWei)
    ).toFixed(6)} ETH)`;
  }

  return {
    simulatedAtMs: Date.now(),
    withdrawalHash: info.withdrawalHash,
    status: info.status,
    canClaimNow: info.status === 'ready-to-finalize',
    canProveNow: info.status === 'ready-to-prove',
    l1GasPriceGwei: Number(formatGwei(l1GasPrice)).toFixed(3),
    l2GasPriceGwei: Number(formatGwei(l2GasPrice)).toFixed(4),
    estimatedProveGas: estimatedProveGas.toString(),
    estimatedFinalizeGas: estimatedFinalizeGas.toString(),
    estimatedProveFeeEth: Number(formatEther(proveFeeWei)).toFixed(6),
    estimatedFinalizeFeeEth: Number(formatEther(finalizeFeeWei)).toFixed(6),
    totalL1ClaimCostEth: Number(formatEther(totalL1ClaimCostWei)).toFixed(6),
    netAmountFormatted,
    l1DryRunAction,
    l1DryRunSuccess,
    l1DryRunMessage,
    proofMaturityDelaySeconds: info.proofMaturityDelaySeconds,
    estimatedClaimableAtMs: info.estimatedClaimableAtMs,
    totalSecondsRemaining: info.totalSecondsRemaining,
  };
}

export async function fetchRecentWithdrawalSamples(
  config: NetworkConfig,
  maxSamples = 3
): Promise<string[]> {
  const { l2Client } = createBaseAndL1Clients(config);
  const latest = await l2Client.getBlockNumber();
  const picks: string[] = [];
  const seen = new Set<string>();

  // Scan recent windows back up to ~150k blocks (~3.5 days on Base) to find real withdrawals
  const windows = [
    { from: latest > 25000n ? latest - 25000n : 0n, to: latest },
    {
      from: latest > 80000n ? latest - 80000n : 0n,
      to: latest > 25001n ? latest - 25001n : 0n,
    },
    {
      from: latest > 150000n ? latest - 150000n : 0n,
      to: latest > 80001n ? latest - 80001n : 0n,
    },
  ];

  for (const w of windows) {
    if (picks.length >= maxSamples || w.to <= w.from) break;
    try {
      const logs = await l2Client.getLogs({
        address: L2_TO_L1_MESSAGE_PASSER as Address,
        fromBlock: w.from,
        toBlock: w.to,
      });
      for (let i = logs.length - 1; i >= 0 && picks.length < maxSamples; i -= 1) {
        const txHash = logs[i].transactionHash?.toLowerCase();
        if (txHash && !seen.has(txHash)) {
          seen.add(txHash);
          picks.push(txHash);
        }
      }
    } catch {
      // Continue to next window if RPC log range is capped
    }
  }

  return picks;
}

export function formatSecondsJapanese(totalSec: number | null): string {
  if (totalSec === null) return '—';
  if (totalSec <= 0) return '0秒（実行可能）';
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (days === 0 && hours === 0 && seconds > 0) parts.push(`${seconds}秒`);
  return parts.join(' ') || '1分未満';
}

export function getWithdrawalStatusLabel(status: WithdrawalStatus): string {
  switch (status) {
    case 'waiting-to-prove':
      return 'Prove待機中 (L1提案待ち)';
    case 'ready-to-prove':
      return 'Prove実行可能';
    case 'waiting-to-finalize':
      return '確定待機中 (成熟期間)';
    case 'ready-to-finalize':
      return '出金実行可能 (Claim可)';
    case 'finalized':
      return 'L1出金完了済み';
  }
}

function formatDisplayAmount(str: string): string {
  const num = Number(str);
  if (!Number.isFinite(num)) return str;
  if (num === 0) return '0';
  if (num >= 1) {
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return str.slice(0, 10).replace(/\.?0+$/, '');
}

function extractShortRevertReason(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const revertLine = lines.find(
    (l) =>
      l.includes('OptimismPortal') ||
      l.includes('reverted') ||
      l.includes('reason:') ||
      l.includes('Error:')
  );
  return (revertLine ?? lines[0] ?? message).slice(0, 180);
}
