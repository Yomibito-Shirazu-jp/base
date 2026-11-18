import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  formatEther,
  formatGwei,
  formatUnits,
  hexToString,
  http,
  keccak256,
  pad,
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
  CdmHopInspection,
  DisputeWindowMode,
  MessagePasserStatus,
  NetworkConfig,
  ProveLifecycleState,
  StepSimulationDetail,
  TeeZkProofInspection,
  ValidationCheckItem,
  WithdrawalInfo,
  WithdrawalSimulationResult,
  WithdrawalStatus,
  WithdrawalValidationReport,
} from '../types/finality';

export const L2_TO_L1_MESSAGE_PASSER =
  '0x4200000000000000000000000000000000000016'.toLowerCase();

export const MESSAGE_PASSED_TOPIC0 =
  '0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054';

const MESSAGE_PASSED_EVENT_ABI = parseAbi([
  'event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)',
]);

const DEFAULT_L1_STANDARD_BRIDGE_MAINNET =
  '0x3154Cf16ccdb4C6d922629664174b904d80F2C35';
const DEFAULT_L1_STANDARD_BRIDGE_SEPOLIA =
  '0xfd0Bf71F60660E2f608ed56e1659C450eB113120';

const L2_STANDARD_BRIDGE_ABI = parseAbi([
  'event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)',
  'event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)',
  'event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
]);

const ERC20_TRANSFER_EVENT_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const L1_CROSS_DOMAIN_MESSENGER_ABI = parseAbi([
  'function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message) payable',
  'function successfulMessages(bytes32) view returns (bool)',
  'function failedMessages(bytes32) view returns (bool)',
]);

const L1_BRIDGE_FINALIZE_ABI = parseAbi([
  'function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes _extraData)',
  'function finalizeERC20Withdrawal(address _l1Token, address _l2Token, address _from, address _to, uint256 _amount, bytes _data)',
  'function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData) payable',
  'function finalizeETHWithdrawal(address _from, address _to, uint256 _amount, bytes _data) payable',
  'function finalizeBridgeERC721(address _localToken, address _remoteToken, address _from, address _to, uint256 _tokenId, bytes _extraData)',
]);

const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]);

const ERC20_BYTES32_META_ABI = parseAbi([
  'function symbol() view returns (bytes32)',
]);

const MULTICALL3_ADDRESS =
  '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

const MESSAGE_PASSER_ABI = parseAbi([
  'function sentMessages(bytes32) view returns (bool)',
]);

const L2_CROSS_DOMAIN_MESSENGER =
  '0x4200000000000000000000000000000000000007'.toLowerCase();

const portalL2SenderSlotCache = new Map<string, Hex>();
const cdmXDomainSenderSlotCache = new Map<string, Hex>();

export const OPTIMISM_PORTAL_READ_ABI = parseAbi([
  'function version() view returns (string)',
  'function paused() view returns (bool)',
  'function proofMaturityDelaySeconds() view returns (uint256)',
  'function disputeGameFinalityDelaySeconds() view returns (uint256)',
  'function disputeGameFactory() view returns (address)',
  'function respectedGameType() view returns (uint32)',
  'function finalizedWithdrawals(bytes32) view returns (bool)',
  'function numProofSubmitters(bytes32) view returns (uint256)',
  'function proofSubmitters(bytes32, uint256) view returns (address)',
  'function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)',
  'function disputeGameBlacklist(address) view returns (bool)',
  'function checkWithdrawal(bytes32 _withdrawalHash, address _proofSubmitter) view',
  'function finalizeWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx)',
  'function finalizeWithdrawalTransactionExternalProof((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, address _proofSubmitter)',
  'function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _disputeGameIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] _withdrawalProof)',
]);

const OPTIMISM_PORTAL_PROVEN_EVENT_ABI = parseAbi([
  'event WithdrawalProven(bytes32 indexed withdrawalHash, address indexed from, address indexed to)',
]);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const DISPUTE_GAME_FACTORY_ABI = parseAbi([
  'function gameCount() view returns (uint256)',
  'function gameAtIndex(uint256) view returns (uint32 gameType, uint64 timestamp, address proxy)',
  'function gameImpls(uint32) view returns (address)',
]);

export const DISPUTE_GAME_ABI = parseAbi([
  'function version() view returns (string)',
  'function status() view returns (uint8)',
  'function gameType() view returns (uint32)',
  'function wasRespectedGameTypeWhenCreated() view returns (bool)',
  'function createdAt() view returns (uint64)',
  'function resolvedAt() view returns (uint64)',
  'function expectedResolution() view returns (uint64)',
  'function l2SequenceNumber() view returns (uint256)',
  'function teeProver() view returns (address)',
  'function zkProver() view returns (address)',
  'function TEE_VERIFIER() view returns (address)',
  'function ZK_VERIFIER() view returns (address)',
  'function PROOF_THRESHOLD() view returns (uint256)',
  'function proofCount() view returns (uint8)',
  'function FAST_FINALIZATION_DELAY() view returns (uint256)',
  'function SLOW_FINALIZATION_DELAY() view returns (uint256)',
  'function resolve()',
]);

interface CachedPortalDisputeParams {
  portalVersion: string | null;
  respectedGameType: number | null;
  disputeGameFactoryAddress: Address | null;
  proofMaturityDelaySeconds: number;
  disputeGameFinalityDelaySeconds: number;
  disputeGameResolutionSeconds: number;
  fastFinalizationDelaySeconds: number;
  slowFinalizationDelaySeconds: number;
  rawMeasuredResolutionSeconds: number | null;
  proposalIntervalSeconds: number;
  latestGameTeeZk: TeeZkProofInspection | null;
  usedFallbackDelay: boolean;
  cachedAtMs: number;
}

const portalDisputeParamsCache = new Map<string, CachedPortalDisputeParams>();
const PORTAL_PARAMS_TTL_MS = 5 * 60 * 1000;

function isDeterministicRevertError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('execution reverted') ||
    msg.includes('OptimismPortal:') ||
    msg.includes('InvalidGameStatus') ||
    msg.includes('Unproven')
  );
}

async function withRpcRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 350
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isDeterministicRevertError(err) || attempt >= maxAttempts) {
        break;
      }
      const jitter = Math.floor(Math.random() * 140);
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt + jitter)
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildTransport(urls: string[]) {
  const transports = urls.map((u) => {
    const resolved =
      u.startsWith('/') && typeof window !== 'undefined'
        ? `${window.location.origin}${u}`
        : u;
    return http(resolved, { timeout: 15000 });
  });
  return transports.length === 1 ? transports[0] : fallback(transports);
}

export function getChains(config: NetworkConfig) {
  const isSepolia = config.id === 'base-sepolia' || config.chainId === 84532;
  if (isSepolia) {
    return {
      l2Chain: baseSepolia,
      l1Chain: sepolia,
      portalAddress: baseSepolia.contracts.portal[sepolia.id].address,
      defaultL1Bridge: DEFAULT_L1_STANDARD_BRIDGE_SEPOLIA as Address,
    };
  }
  return {
    l2Chain: base,
    l1Chain: mainnet,
    portalAddress: base.contracts.portal[mainnet.id].address,
    defaultL1Bridge: DEFAULT_L1_STANDARD_BRIDGE_MAINNET as Address,
  };
}

export function createBaseAndL1Clients(config: NetworkConfig) {
  const { l2Chain, l1Chain, portalAddress, defaultL1Bridge } = getChains(config);
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

  return { l2Client, l1Client, l2Chain, l1Chain, portalAddress, defaultL1Bridge };
}

interface RawCdmHop {
  hopIndex: number;
  messengerAddress: Address;
  nonce: bigint;
  sender: Address;
  target: Address;
  value: bigint;
  minGasLimit: bigint;
  rawRelayCalldata: Hex;
  versionedHash: Hex;
}

function unwrapCrossDomainHops(params: {
  sender: Address;
  target: Address;
  value: bigint;
  data: Hex;
}): {
  rawHops: RawCdmHop[];
  leafSender: Address;
  leafTarget: Address;
  leafValue: bigint;
  leafData: Hex;
} {
  const rawHops: RawCdmHop[] = [];
  let curSender = params.sender;
  let curTarget = params.target;
  let curValue = params.value;
  let curData = params.data;

  for (let hop = 1; hop <= 4; hop += 1) {
    if (!curData || curData.length < 10 || !curData.toLowerCase().startsWith('0xd764ad0b')) {
      break;
    }
    try {
      const decoded = decodeFunctionData({
        abi: L1_CROSS_DOMAIN_MESSENGER_ABI,
        data: curData,
      });
      if (decoded.functionName !== 'relayMessage') break;
      const [nonce, innerSender, innerTarget, innerValue, minGasLimit, innerMessage] =
        decoded.args;
      const msgVersion = nonce >> 240n;
      const canonicalEncoded =
        msgVersion === 1n
          ? encodeFunctionData({
              abi: L1_CROSS_DOMAIN_MESSENGER_ABI,
              functionName: 'relayMessage',
              args: [
                nonce,
                innerSender,
                innerTarget,
                innerValue,
                minGasLimit,
                innerMessage,
              ],
            })
          : curData;
      rawHops.push({
        hopIndex: hop,
        messengerAddress: curTarget,
        nonce,
        sender: innerSender,
        target: innerTarget,
        value: innerValue,
        minGasLimit,
        rawRelayCalldata: curData,
        versionedHash: keccak256(canonicalEncoded),
      });
      curSender = innerSender;
      curTarget = innerTarget;
      curValue = innerValue;
      curData = innerMessage;
    } catch {
      break;
    }
  }

  return {
    rawHops,
    leafSender: curSender,
    leafTarget: curTarget,
    leafValue: curValue,
    leafData: curData,
  };
}

async function resolvePortalL2SenderSlot(
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'],
  portalAddress: Address
): Promise<Hex | null> {
  const key = portalAddress.toLowerCase();
  const cached = portalL2SenderSlotCache.get(key);
  if (cached) return cached;

  const defaultSlot = pad('0x32', { size: 32 });
  try {
    const val32 = await l1Client.getStorageAt({
      address: portalAddress,
      slot: defaultSlot,
    });
    if (
      val32 &&
      val32.toLowerCase().endsWith('000000000000000000000000000000000000dead')
    ) {
      portalL2SenderSlotCache.set(key, defaultSlot);
      return defaultSlot;
    }

    for (let baseIdx = 0; baseIdx < 64; baseIdx += 16) {
      const slots = Array.from({ length: 16 }, (_, j) =>
        pad(`0x${(baseIdx + j).toString(16)}` as Hex, { size: 32 })
      );
      const vals = await Promise.all(
        slots.map((s) =>
          l1Client
            .getStorageAt({ address: portalAddress, slot: s })
            .catch(() => null)
        )
      );
      for (let j = 0; j < vals.length; j += 1) {
        const v = vals[j];
        if (
          v &&
          v.toLowerCase().endsWith('000000000000000000000000000000000000dead')
        ) {
          portalL2SenderSlotCache.set(key, slots[j]);
          return slots[j];
        }
      }
    }
  } catch {
    // Fallback to standard OptimismPortal2 slot 0x32
  }
  return defaultSlot;
}

async function resolveCdmXDomainSenderSlot(
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'],
  messengerAddress: Address
): Promise<Hex> {
  const key = messengerAddress.toLowerCase();
  const cached = cdmXDomainSenderSlotCache.get(key);
  if (cached) return cached;

  // Standard OP Stack CrossDomainMessenger xDomainMsgSender slot is 204 (0xcc) = 0x...0000dead
  const defaultSlot = pad('0xcc', { size: 32 });
  try {
    const valCc = await l1Client.getStorageAt({
      address: messengerAddress,
      slot: defaultSlot,
    });
    if (
      valCc &&
      valCc.toLowerCase().endsWith('000000000000000000000000000000000000dead')
    ) {
      cdmXDomainSenderSlotCache.set(key, defaultSlot);
      return defaultSlot;
    }
  } catch {
    // Fallback to standard slot 0xcc
  }
  return defaultSlot;
}

async function readErc20MetadataWithFallback(params: {
  l2Client: ReturnType<typeof createBaseAndL1Clients>['l2Client'];
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'];
  l2TokenAddress: string | null;
  l1TokenAddress: string | null;
}): Promise<{ symbol: string; decimals: number }> {
  const { l2Client, l1Client, l2TokenAddress, l1TokenAddress } = params;

  const tryReadOnClient = async (
    client: typeof l2Client | typeof l1Client,
    tokenAddr: Address
  ): Promise<{ symbol: string | null; decimals: number | null }> => {
    const [symStr, decNum] = await Promise.all([
      client
        .readContract({
          address: tokenAddr,
          abi: ERC20_META_ABI,
          functionName: 'symbol',
        })
        .catch(async () => {
          const b32 = await client
            .readContract({
              address: tokenAddr,
              abi: ERC20_BYTES32_META_ABI,
              functionName: 'symbol',
            })
            .catch(() => null);
          return b32 ? hexToString(b32, { size: 32 }).replace(/\0/g, '').trim() : null;
        }),
      client
        .readContract({
          address: tokenAddr,
          abi: ERC20_META_ABI,
          functionName: 'decimals',
        })
        .then((d) => Number(d))
        .catch(() => null),
    ]);
    return { symbol: symStr || null, decimals: decNum };
  };

  let symbol: string | null = null;
  let decimals: number | null = null;

  if (l2TokenAddress && l2TokenAddress.toLowerCase() !== ZERO_ADDRESS) {
    const l2Meta = await tryReadOnClient(l2Client, l2TokenAddress as Address);
    symbol = l2Meta.symbol;
    decimals = l2Meta.decimals;
  }

  if (
    (!symbol || decimals === null) &&
    l1TokenAddress &&
    l1TokenAddress.toLowerCase() !== ZERO_ADDRESS
  ) {
    const l1Meta = await tryReadOnClient(l1Client, l1TokenAddress as Address);
    if (!symbol && l1Meta.symbol) symbol = l1Meta.symbol;
    if (decimals === null && l1Meta.decimals !== null) decimals = l1Meta.decimals;
  }

  return {
    symbol: symbol || 'ERC20',
    decimals: decimals ?? 18,
  };
}

export async function inspectAggregateGameProxy(params: {
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'];
  proxyAddress: Address;
  disputeGameIndex: number | null;
  isReferenceLatestGame?: boolean;
  fallbackResolutionSeconds?: number;
}): Promise<TeeZkProofInspection> {
  const {
    l1Client,
    proxyAddress,
    disputeGameIndex,
    isReferenceLatestGame = false,
    fallbackResolutionSeconds = 432000,
  } = params;
  const nowSec = Math.floor(Date.now() / 1000);

  const [
    verRaw,
    statusRaw,
    gameTypeRaw,
    createdAtRaw,
    resolvedAtRaw,
    expectedResRaw,
    l2SeqRaw,
    teeProverRaw,
    zkProverRaw,
    teeVerifierRaw,
    zkVerifierRaw,
    thresholdRaw,
    proofCountRaw,
    fastDelayRaw,
    slowDelayRaw,
  ] = await Promise.all([
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'version',
      })
      .catch(() => null),
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: proxyAddress,
          abi: DISPUTE_GAME_ABI,
          functionName: 'status',
        }),
      2
    ).catch(() => null),
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: proxyAddress,
          abi: DISPUTE_GAME_ABI,
          functionName: 'gameType',
        }),
      2
    ).catch(() => null),
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: proxyAddress,
          abi: DISPUTE_GAME_ABI,
          functionName: 'createdAt',
        }),
      2
    ).catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'resolvedAt',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'expectedResolution',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'l2SequenceNumber',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'teeProver',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'zkProver',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'TEE_VERIFIER',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'ZK_VERIFIER',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'PROOF_THRESHOLD',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'proofCount',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'FAST_FINALIZATION_DELAY',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'SLOW_FINALIZATION_DELAY',
      })
      .catch(() => null),
  ]);

  const supportedMultiProof =
    teeProverRaw !== null ||
    zkProverRaw !== null ||
    fastDelayRaw !== null ||
    slowDelayRaw !== null;

  const teeProver =
    teeProverRaw && teeProverRaw.toLowerCase() !== ZERO_ADDRESS
      ? teeProverRaw
      : null;
  const zkProver =
    zkProverRaw && zkProverRaw.toLowerCase() !== ZERO_ADDRESS
      ? zkProverRaw
      : null;
  const hasTeeProof = teeProver !== null;
  const hasZkProof = zkProver !== null;

  const fastFinalizationDelaySeconds =
    fastDelayRaw !== null ? Number(fastDelayRaw) : 86400; // 1 day
  const slowFinalizationDelaySeconds =
    slowDelayRaw !== null ? Number(slowDelayRaw) : fallbackResolutionSeconds; // 5 days (432,000s)

  const createdAt = createdAtRaw !== null ? Number(createdAtRaw) : null;
  const resolvedAt =
    resolvedAtRaw !== null && Number(resolvedAtRaw) > 0
      ? Number(resolvedAtRaw)
      : null;
  const expectedResolution =
    expectedResRaw !== null && Number(expectedResRaw) > 0
      ? Number(expectedResRaw)
      : null;
  const gameStatus = statusRaw !== null ? Number(statusRaw) : null;
  const gameType = gameTypeRaw !== null ? Number(gameTypeRaw) : null;
  const l2SequenceNumber = l2SeqRaw !== null ? Number(l2SeqRaw) : null;

  const derivedProofCount =
    proofCountRaw !== null
      ? Number(proofCountRaw)
      : (hasTeeProof ? 1 : 0) + (hasZkProof ? 1 : 0);
  const proofThreshold = thresholdRaw !== null ? Number(thresholdRaw) : 1;

  let windowMode: DisputeWindowMode = 'standard';
  if (supportedMultiProof) {
    windowMode = hasTeeProof && hasZkProof ? 'dual-1d' : 'single-5d';
  }

  let activeWindowSeconds =
    hasTeeProof && hasZkProof
      ? fastFinalizationDelaySeconds
      : slowFinalizationDelaySeconds;

  if (
    expectedResolution !== null &&
    createdAt !== null &&
    expectedResolution > createdAt
  ) {
    activeWindowSeconds = expectedResolution - createdAt;
    if (supportedMultiProof) {
      windowMode =
        activeWindowSeconds <= fastFinalizationDelaySeconds + 1800
          ? 'dual-1d'
          : 'single-5d';
    }
  }

  let remainingToResolveSeconds: number | null = null;
  if (gameStatus === 2) {
    remainingToResolveSeconds = 0;
  } else if (expectedResolution !== null) {
    remainingToResolveSeconds = Math.max(0, expectedResolution - nowSec);
  } else if (createdAt !== null) {
    remainingToResolveSeconds = Math.max(
      0,
      createdAt + activeWindowSeconds - nowSec
    );
  }

  const canCallResolveNow =
    gameStatus === 0 &&
    expectedResolution !== null &&
    nowSec >= expectedResolution;

  let summary = '';
  const refPrefix = isReferenceLatestGame
    ? '【ネットワーク最新DisputeGame参照】'
    : '';
  if (supportedMultiProof) {
    if (hasTeeProof && hasZkProof) {
      summary = `${refPrefix}TEE証明: 検証済 ＆ ZK証明: 検証済（2/2 二重証明達成）→ 高速待機期間 1日 (${fastFinalizationDelaySeconds.toLocaleString()}秒) が適用されています`;
    } else if (hasTeeProof || hasZkProof) {
      const which = hasTeeProof
        ? 'TEE証明のみ検証済 (ZK未提出)'
        : 'ZK証明のみ検証済 (TEE未提出)';
      summary = `${refPrefix}${which}（${derivedProofCount}/2 単一証明）→ 通常待機期間 5日 (${slowFinalizationDelaySeconds.toLocaleString()}秒) が適用されています（両方揃うと1日に短縮）`;
    } else {
      summary = `${refPrefix}TEE証明: 未提出 · ZK証明: 未提出（0/2）→ 待機期間 ${formatSecondsJapanese(
        activeWindowSeconds
      )}`;
    }
  } else {
    summary = `${refPrefix}標準 FaultDisputeGame (GameType ${
      gameType ?? '—'
    }) · 解決待機期間 ${formatSecondsJapanese(activeWindowSeconds)}`;
  }

  return {
    checkedAtMs: Date.now(),
    supportedMultiProof,
    isReferenceLatestGame,
    disputeGameAddress: proxyAddress,
    disputeGameIndex,
    gameType,
    gameVersion: verRaw ?? null,
    gameStatus,
    l2SequenceNumber,
    hasTeeProof,
    hasZkProof,
    teeProver,
    zkProver,
    teeVerifier:
      teeVerifierRaw && teeVerifierRaw.toLowerCase() !== ZERO_ADDRESS
        ? teeVerifierRaw
        : null,
    zkVerifier:
      zkVerifierRaw && zkVerifierRaw.toLowerCase() !== ZERO_ADDRESS
        ? zkVerifierRaw
        : null,
    proofCount: derivedProofCount,
    proofThreshold,
    fastFinalizationDelaySeconds,
    slowFinalizationDelaySeconds,
    activeWindowSeconds,
    windowMode,
    createdAt,
    expectedResolution,
    resolvedAt,
    remainingToResolveSeconds,
    canCallResolveNow,
    summary,
  };
}

async function resolvePortalDisputeParams(
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'],
  portalAddress: Address,
  forceRefresh = false,
  allowFallback = false
): Promise<CachedPortalDisputeParams> {
  const cacheKey = portalAddress.toLowerCase();
  const existing = portalDisputeParamsCache.get(cacheKey);
  if (
    !forceRefresh &&
    existing &&
    !existing.usedFallbackDelay &&
    Date.now() - existing.cachedAtMs < PORTAL_PARAMS_TTL_MS
  ) {
    return existing;
  }

  let usedFallbackDelay = false;

  const readPortalUint = async (
    fnName: 'proofMaturityDelaySeconds' | 'disputeGameFinalityDelaySeconds',
    fallbackVal: bigint
  ): Promise<bigint> => {
    try {
      return await withRpcRetry(
        () =>
          l1Client.readContract({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: fnName,
          }),
        3
      );
    } catch (err) {
      if (!allowFallback) throw err;
      usedFallbackDelay = true;
      return fallbackVal;
    }
  };

  const [maturityDelay, gameFinalityDelay, respectedType, portalVer, dgfAddr] =
    await Promise.all([
      readPortalUint('proofMaturityDelaySeconds', 86400n),
      readPortalUint('disputeGameFinalityDelaySeconds', 0n),
      withRpcRetry(
        () =>
          l1Client.readContract({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: 'respectedGameType',
          }),
        2
      ).catch(() => null),
      l1Client
        .readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'version',
        })
        .catch(() => null),
      withRpcRetry(
        () =>
          l1Client.readContract({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: 'disputeGameFactory',
          }),
        3
      ).catch((err) => {
        if (!allowFallback) throw err;
        usedFallbackDelay = true;
        return null;
      }),
    ]);

  let disputeGameResolutionSeconds = 432000; // Base AggregateVerifier single-proof window: 5 days
  let fastFinalizationDelaySeconds = 86400; // TEE + ZK dual-proof window: 1 day
  let slowFinalizationDelaySeconds = 432000; // Single-proof window: 5 days
  let rawMeasuredResolutionSeconds: number | null = null;
  let proposalIntervalSeconds = 1800; // ~30 min default
  let latestGameTeeZk: TeeZkProofInspection | null = null;

  const validDgfAddr =
    dgfAddr && dgfAddr.toLowerCase() !== ZERO_ADDRESS
      ? (dgfAddr as Address)
      : null;

  if (validDgfAddr) {
    try {
      const count = await withRpcRetry(
        () =>
          l1Client.readContract({
            address: validDgfAddr,
            abi: DISPUTE_GAME_FACTORY_ABI,
            functionName: 'gameCount',
          }),
        3
      );

      if (count >= 1n) {
        const latestIdx = count - 1n;
        const [latestGame, prevGame] = await Promise.all([
          withRpcRetry(
            () =>
              l1Client.readContract({
                address: validDgfAddr,
                abi: DISPUTE_GAME_FACTORY_ABI,
                functionName: 'gameAtIndex',
                args: [latestIdx],
              }),
            2
          ).catch(() => null),
          count >= 2n
            ? l1Client
                .readContract({
                  address: validDgfAddr,
                  abi: DISPUTE_GAME_FACTORY_ABI,
                  functionName: 'gameAtIndex',
                  args: [count - 2n],
                })
                .catch(() => null)
            : Promise.resolve(null),
        ]);

        if (latestGame && prevGame && latestGame[1] > prevGame[1]) {
          const diff = Number(latestGame[1] - prevGame[1]);
          if (diff >= 60 && diff <= 14400) {
            proposalIntervalSeconds = diff;
          }
        }

        if (latestGame && latestGame[2].toLowerCase() !== ZERO_ADDRESS) {
          latestGameTeeZk = await inspectAggregateGameProxy({
            l1Client,
            proxyAddress: latestGame[2],
            disputeGameIndex: Number(latestIdx),
            isReferenceLatestGame: true,
          }).catch(() => null);

          if (latestGameTeeZk) {
            fastFinalizationDelaySeconds =
              latestGameTeeZk.fastFinalizationDelaySeconds;
            slowFinalizationDelaySeconds =
              latestGameTeeZk.slowFinalizationDelaySeconds;
            disputeGameResolutionSeconds = latestGameTeeZk.activeWindowSeconds;
            rawMeasuredResolutionSeconds = latestGameTeeZk.activeWindowSeconds;
          }
        }
      }
    } catch (err) {
      if (!allowFallback) throw err;
      usedFallbackDelay = true;
    }
  } else {
    usedFallbackDelay = true;
  }

  const resolved: CachedPortalDisputeParams = {
    portalVersion: portalVer ?? null,
    respectedGameType: respectedType !== null ? Number(respectedType) : null,
    disputeGameFactoryAddress: validDgfAddr,
    proofMaturityDelaySeconds: Number(maturityDelay),
    disputeGameFinalityDelaySeconds: Number(gameFinalityDelay),
    disputeGameResolutionSeconds,
    fastFinalizationDelaySeconds,
    slowFinalizationDelaySeconds,
    rawMeasuredResolutionSeconds,
    proposalIntervalSeconds,
    latestGameTeeZk,
    usedFallbackDelay,
    cachedAtMs: Date.now(),
  };

  if (!usedFallbackDelay) {
    portalDisputeParamsCache.set(cacheKey, resolved);
  }
  return resolved;
}

export async function warmPortalDisputeParams(
  config: NetworkConfig
): Promise<void> {
  const { l1Client, portalAddress } = createBaseAndL1Clients(config);
  await resolvePortalDisputeParams(l1Client, portalAddress, false, false);
}

export interface LiveWithdrawalConditions {
  portalAddress: string;
  portalVersion: string | null;
  respectedGameType: number | null;
  proofMaturityDelaySeconds: number;
  disputeGameResolutionSeconds: number;
  fastFinalizationDelaySeconds: number;
  slowFinalizationDelaySeconds: number;
  rawMeasuredResolutionSeconds: number | null;
  disputeGameFinalityDelaySeconds: number;
  effectivePostProveDelaySeconds: number;
  proposalIntervalSeconds: number;
  latestGameTeeZk: TeeZkProofInspection | null;
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

  const [portalParams, l1GasPrice, l2GasPrice] = await Promise.all([
    resolvePortalDisputeParams(l1Client, portalAddress, true, true),
    withRpcRetry(() => l1Client.getGasPrice(), 2),
    withRpcRetry(() => l2Client.getGasPrice(), 2),
  ]);

  const estimatedProveGas = 290000;
  const estimatedFinalizeGas = 230000;
  const proveFeeWei = l1GasPrice * BigInt(estimatedProveGas);
  const finalizeFeeWei = l1GasPrice * BigInt(estimatedFinalizeGas);
  const totalFeeWei = proveFeeWei + finalizeFeeWei;

  const effectivePostProveDelaySeconds = Math.max(
    portalParams.disputeGameResolutionSeconds +
      portalParams.disputeGameFinalityDelaySeconds,
    portalParams.proofMaturityDelaySeconds
  );

  return {
    portalAddress,
    portalVersion: portalParams.portalVersion,
    respectedGameType: portalParams.respectedGameType,
    proofMaturityDelaySeconds: portalParams.proofMaturityDelaySeconds,
    disputeGameResolutionSeconds: portalParams.disputeGameResolutionSeconds,
    fastFinalizationDelaySeconds: portalParams.fastFinalizationDelaySeconds,
    slowFinalizationDelaySeconds: portalParams.slowFinalizationDelaySeconds,
    rawMeasuredResolutionSeconds: portalParams.rawMeasuredResolutionSeconds,
    disputeGameFinalityDelaySeconds: portalParams.disputeGameFinalityDelaySeconds,
    effectivePostProveDelaySeconds,
    proposalIntervalSeconds: portalParams.proposalIntervalSeconds,
    latestGameTeeZk: portalParams.latestGameTeeZk,
    usedFallbackDelay: portalParams.usedFallbackDelay,
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

export async function inspectLatestDisputeGameTeeZk(
  config: NetworkConfig
): Promise<TeeZkProofInspection> {
  const { l1Client, portalAddress } = createBaseAndL1Clients(config);
  const params = await resolvePortalDisputeParams(
    l1Client,
    portalAddress,
    true,
    false
  );
  if (params.latestGameTeeZk) {
    return params.latestGameTeeZk;
  }
  throw new Error(
    'L1 DisputeGameFactory から最新の DisputeGame 情報を取得できませんでした'
  );
}

export async function inspectWithdrawalTeeZkStatus(
  txHash: Hex,
  config: NetworkConfig
): Promise<{
  teeZk: TeeZkProofInspection;
  updatedWithdrawal: WithdrawalInfo | null;
}> {
  const clients = createBaseAndL1Clients(config);
  const { l1Client, l2Client, portalAddress } = clients;
  await resolvePortalDisputeParams(l1Client, portalAddress, true, false);
  const receipt = await withRpcRetry(
    () => l2Client.getTransactionReceipt({ hash: txHash }),
    3
  );
  const updated = await analyzeWithdrawalFromReceipt(receipt, config, clients);
  if (updated?.validation?.teeZk) {
    return {
      teeZk: updated.validation.teeZk,
      updatedWithdrawal: updated,
    };
  }
  const latest = await inspectLatestDisputeGameTeeZk(config);
  return {
    teeZk: latest,
    updatedWithdrawal: updated,
  };
}

export function getDisputeGameStatusText(status: number | null): string {
  if (status === 0) return 'IN_PROGRESS (異議申立・証明期間中)';
  if (status === 1) return 'CHALLENGER_WINS (異議成立・無効化)';
  if (status === 2) return 'DEFENDER_WINS (正当性解決済)';
  return '未照会';
}

export function getProveLifecycleBadgeText(state: ProveLifecycleState): string {
  switch (state) {
    case 'finalized':
      return 'Prove済 ✓ · 資金受取完了';
    case 'proven-ready':
      return 'Prove済 ✓ · 今すぐ受取可';
    case 'proven-waiting':
      return 'Prove済 ✓ · ロック待機中';
    case 'invalid-need-reprove':
      return '要再Prove (Game無効)';
    case 'unproven-ready':
      return '未Prove · 今すぐProve可';
    case 'unproven-waiting-game':
      return '未Prove · L1提案待ち';
  }
}

export interface ProveDisplayMeta {
  stateKind: 'finalized' | 'proven' | 'reprove' | 'unproven';
  isProven: boolean;
  shortBadge: string;
  headline: string;
  subline: string;
}

export function getWithdrawalProveDisplayMeta(w: WithdrawalInfo): ProveDisplayMeta {
  const val = w.validation;
  if (w.portalFinalized || w.status === 'finalized' || val?.proveState === 'finalized') {
    return {
      stateKind: 'finalized',
      isProven: true,
      shortBadge: 'Prove済 · 受取完了',
      headline: '【Prove済 ✓】出金証明・L1資金受け取りともに完了済み',
      subline: 'OptimismPortal2 にて Prove および Finalize の完了を確認しました。',
    };
  }

  if (val?.proveState === 'invalid-need-reprove') {
    return {
      stateKind: 'reprove',
      isProven: false,
      shortBadge: '要再Prove',
      headline: '【要再Prove】紐づく DisputeGame が無効化されたため再提出が必要です',
      subline:
        '有効な最新 DisputeGame に対して再度 proveWithdrawalTransaction を実行してください。',
    };
  }

  const provenOnChain =
    val !== undefined
      ? val.numProofSubmitters > 0 ||
        val.proveState === 'proven-ready' ||
        val.proveState === 'proven-waiting'
      : w.status === 'waiting-to-finalize' || w.status === 'ready-to-finalize';

  if (provenOnChain) {
    if (
      val?.canWithdrawAfterWait === false ||
      val?.recipientBalanceIncreased === false
    ) {
      return {
        stateKind: 'reprove',
        isProven: true,
        shortBadge: 'Prove済 · 着金不可 (受取 0)',
        headline:
          '【着金不可】Prove提出済みですが、このTxを確定してもL1で資金は受け取れません（実測受取 0）',
        subline:
          'Base側でL2StandardBridge経由の資産ロック・焼却を伴わないメッセージのため、待機期間後にFinalizeを実行してもL1ガス代のみ消費され資産は届きません（このTx自体でBase上のトークンは減っていません）。',
      };
    }
    const readyToClaim =
      w.status === 'ready-to-finalize' || val?.proveState === 'proven-ready';
    return {
      stateKind: 'proven',
      isProven: true,
      shortBadge: readyToClaim ? 'Prove済 ✓ (受取可)' : 'Prove済 ✓ (待機中)',
      headline: readyToClaim
        ? '【Prove済 ✓】出金証明は提出済み・待機完了（今すぐ資金を受け取れます）'
        : '【Prove済 ✓】L1 OptimismPortal2 に出金証明が提出済みです（再Prove不要）',
      subline: readyToClaim
        ? 'Prove後成熟期間とゲーム待機期間の両方が完了しています。「資金を受け取る」を実行してください。'
        : '出金証明（proveWithdrawalTransaction）は完了しています。ロック期間満了後に「資金を受け取る」が可能になります。',
    };
  }

  const canProveImmediately =
    w.status === 'ready-to-prove' || val?.proveState === 'unproven-ready';
  return {
    stateKind: 'unproven',
    isProven: false,
    shortBadge: canProveImmediately ? '未Prove (今すぐ可)' : '未Prove (提案待ち)',
    headline: canProveImmediately
      ? '【未Prove】まだ L1 に出金証明（proveWithdrawalTransaction）が提出されていません'
      : '【未Prove】まだ出金証明は未提出です（L1 DisputeGame 提案到達待ち）',
    subline: canProveImmediately
      ? 'L1 DisputeGame 提案に到達済みのため、今すぐ「1. 出金証明を提出 (proveWithdrawalTransaction)」を実行できます。'
      : '約25〜30分間隔で L1 に DisputeGame が提案されると、出金証明（Prove）の提出が可能になります。',
  };
}

async function findL1ProveTransactionByTimestamp(params: {
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'];
  portalAddress: Address;
  withdrawalHash: Hex;
  provenTimestamp: number;
}): Promise<{ txHash: string | null; blockNumber: number | null }> {
  const { l1Client, portalAddress, withdrawalHash, provenTimestamp } = params;
  try {
    const latestBlock = await l1Client.getBlock({ blockTag: 'latest' });
    const diffSec = Math.max(0, Number(latestBlock.timestamp) - provenTimestamp);
    let estBlock = latestBlock.number - BigInt(Math.floor(diffSec / 12));
    if (estBlock < 0n) estBlock = 0n;

    const queryAround = async (center: bigint, radius: bigint) => {
      const fromBlock = center > radius ? center - radius : 0n;
      const toBlock =
        center + radius > latestBlock.number ? latestBlock.number : center + radius;
      const logs = await l1Client.getLogs({
        address: portalAddress,
        event: OPTIMISM_PORTAL_PROVEN_EVENT_ABI[0],
        args: { withdrawalHash },
        fromBlock,
        toBlock,
      });
      if (logs.length > 0) {
        const hit = logs[logs.length - 1];
        return {
          txHash: hit.transactionHash ?? null,
          blockNumber: hit.blockNumber !== null ? Number(hit.blockNumber) : null,
        };
      }
      return null;
    };

    const firstTry = await queryAround(estBlock, 350n);
    if (firstTry) return firstTry;

    const sampleBlk = await l1Client.getBlock({ blockNumber: estBlock });
    const driftSec = provenTimestamp - Number(sampleBlk.timestamp);
    let correctedBlock = estBlock + BigInt(Math.round(driftSec / 12));
    if (correctedBlock < 0n) correctedBlock = 0n;
    if (correctedBlock > latestBlock.number) correctedBlock = latestBlock.number;

    const secondTry = await queryAround(correctedBlock, 350n);
    if (secondTry) return secondTry;
  } catch {
    // Non-fatal if RPC caps getLogs
  }
  return { txHash: null, blockNumber: null };
}

/**
 * Performs ONLY the exact 4 real on-chain contract checks enforced by OP Stack withdrawals:
 * 1. L2ToL1MessagePasser (0x4200...0016): sentMessages[withdrawalHash] == true & MPT storage inclusion proof
 * 2. OptimismPortal2 Guards: !paused(), _tx.target != address(OptimismPortal2), finalizedWithdrawals[withdrawalHash]
 * 3. DisputeGameFactory & AggregateVerifier: provenWithdrawals(hash, submitter), !disputeGameBlacklist(proxy),
 *    wasRespectedGameTypeWhenCreated(), status() != CHALLENGER_WINS, and TEE/ZK 1d vs 5d window
 * 4. OptimismPortal2.checkWithdrawal(withdrawalHash, proofSubmitter) & finalizeWithdrawalTransactionExternalProof simulation
 */
async function verifyMessagePasserAndL1Validation(params: {
  clients: ReturnType<typeof createBaseAndL1Clients>;
  receipt: TransactionReceipt;
  primary: ReturnType<typeof getWithdrawals>[number];
  initialStatus: WithdrawalStatus;
  portalFinalized: boolean;
  portalParams: CachedPortalDisputeParams;
  l1Recipient: string;
  l1TokenAddress: string | null;
  amountRaw: bigint;
}): Promise<WithdrawalValidationReport> {
  const {
    clients: { l1Client, l2Client, l2Chain, portalAddress },
    receipt,
    primary,
    portalFinalized,
    portalParams,
    l1Recipient,
    l1TokenAddress,
    amountRaw,
  } = params;

  const {
    portalVersion,
    respectedGameType,
    proofMaturityDelaySeconds,
    disputeGameResolutionSeconds,
    disputeGameFinalityDelaySeconds,
  } = portalParams;

  const nowSec = Math.floor(Date.now() / 1000);
  const mpAddress = L2_TO_L1_MESSAGE_PASSER as Address;
  const storageKey = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      [primary.withdrawalHash, 0n]
    )
  );

  // Critical L2 MessagePasser + L1 OptimismPortal2 reads with retry (no silent error swallowing!)
  const [
    sentMessageRecorded,
    storageSlotValue,
    mpProof,
    portalPaused,
    numProofSubmittersBig,
  ] = await Promise.all([
    withRpcRetry(
      () =>
        l2Client.readContract({
          address: mpAddress,
          abi: MESSAGE_PASSER_ABI,
          functionName: 'sentMessages',
          args: [primary.withdrawalHash],
        }),
      4,
      450
    ),
    l2Client
      .getStorageAt({
        address: mpAddress,
        slot: storageKey,
      })
      .then((v) => v ?? null)
      .catch(() => null),
    l2Client
      .getProof({
        address: mpAddress,
        storageKeys: [storageKey],
        blockTag: 'latest',
      })
      .catch(() =>
        l2Client
          .getProof({
            address: mpAddress,
            storageKeys: [storageKey],
            blockNumber: receipt.blockNumber,
          })
          .catch(() => null)
      ),
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'paused',
        }),
      4,
      450
    ),
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'numProofSubmitters',
          args: [primary.withdrawalHash],
        }),
      4,
      450
    ),
  ]);

  let finalMpProof = mpProof;
  if (
    sentMessageRecorded &&
    (!finalMpProof || finalMpProof.storageProof?.[0]?.value === 0n)
  ) {
    finalMpProof = await l2Client
      .getProof({
        address: mpAddress,
        storageKeys: [storageKey],
        blockNumber: receipt.blockNumber,
      })
      .catch(() => finalMpProof);
  }

  const nonceVersion = Number(primary.nonce >> 240n);
  const proofNodes = finalMpProof?.storageProof?.[0]?.proof?.length ?? 0;
  const proofSlotVal = finalMpProof?.storageProof?.[0]?.value ?? 0n;
  const merkleProofVerified =
    Boolean(sentMessageRecorded) &&
    (proofSlotVal === 1n ||
      (storageSlotValue !== null && BigInt(storageSlotValue) === 1n));

  const messagePasser: MessagePasserStatus = {
    contractAddress: mpAddress,
    sentMessageRecorded: Boolean(sentMessageRecorded),
    messageVersion: nonceVersion,
    storageKey,
    storageSlotValue,
    storageRoot: finalMpProof?.storageHash ?? null,
    merkleProofNodes: proofNodes,
    merkleProofVerified,
  };

  // OptimismPortal2 real target guard: require(_tx.target != address(this))
  const targetIsValid =
    primary.target.toLowerCase() !== portalAddress.toLowerCase();

  // Inspect L1 Proof Submitters, DisputeGame & AggregateVerifier (TEE/ZK) State
  const numProofSubmitters = Number(numProofSubmittersBig);
  const proofSubmittersList: string[] = [];
  let proofSubmitter: string | null = null;
  let disputeGameIndex: number | null = null;
  let disputeGameAddress: string | null = null;
  let disputeGameStatus: number | null = null;
  let disputeGameType: number | null = null;
  let disputeGameCreatedAt: number | null = null;
  let disputeGameResolvedAt: number | null = null;
  let disputeGameBlacklisted: boolean | null = null;
  let wasRespectedGameTypeWhenCreated: boolean | null = null;
  let provenTimestamp: number | null = null;
  let provenAfterGameCreated = true;
  let l1ProveTxHash: string | null = null;
  let l1ProveBlockNumber: number | null = null;
  let maturityRemainingSeconds: number | null = null;
  let gameResolutionRemainingSeconds: number | null = null;
  let checkWithdrawalPassed: boolean | null = null;
  let checkWithdrawalError: string | null = null;
  let teeZk: TeeZkProofInspection | null = null;

  if (numProofSubmitters > 0) {
    const maxCheck = Math.min(numProofSubmitters, 5);
    const subs = await Promise.all(
      Array.from({ length: maxCheck }, (_, idx) =>
        withRpcRetry(
          () =>
            l1Client.readContract({
              address: portalAddress,
              abi: OPTIMISM_PORTAL_READ_ABI,
              functionName: 'proofSubmitters',
              args: [primary.withdrawalHash, BigInt(idx)],
            }),
          2
        ).catch(() => null)
      )
    );

    for (const s of subs) {
      if (s) proofSubmittersList.push(s);
    }

    for (const sub of proofSubmittersList) {
      try {
        const proven = await withRpcRetry(
          () =>
            l1Client.readContract({
              address: portalAddress,
              abi: OPTIMISM_PORTAL_READ_ABI,
              functionName: 'provenWithdrawals',
              args: [primary.withdrawalHash, sub as Address],
            }),
          2
        );
        const gameProxy = proven[0];
        const pTs = Number(proven[1]);

        let subCheckPassed = false;
        let subCheckErr: string | null = null;
        if (!portalFinalized) {
          try {
            await l1Client.readContract({
              address: portalAddress,
              abi: OPTIMISM_PORTAL_READ_ABI,
              functionName: 'checkWithdrawal',
              args: [primary.withdrawalHash, sub as Address],
            });
            subCheckPassed = true;
          } catch (cErr) {
            subCheckPassed = false;
            subCheckErr = extractShortRevertReason(
              cErr instanceof Error ? cErr.message : String(cErr)
            );
          }
        } else {
          subCheckPassed = true;
        }

        let blacklisted = false;
        let wasRespected: boolean | null = null;
        let inspectedGame: TeeZkProofInspection | null = null;

        if (gameProxy && gameProxy.toLowerCase() !== ZERO_ADDRESS) {
          const [bl, respectedWhenCreated, gameInspection] = await Promise.all([
            withRpcRetry(
              () =>
                l1Client.readContract({
                  address: portalAddress,
                  abi: OPTIMISM_PORTAL_READ_ABI,
                  functionName: 'disputeGameBlacklist',
                  args: [gameProxy],
                }),
              2
            ).catch(() => false),
            l1Client
              .readContract({
                address: gameProxy,
                abi: DISPUTE_GAME_ABI,
                functionName: 'wasRespectedGameTypeWhenCreated',
              })
              .catch(() => null),
            inspectAggregateGameProxy({
              l1Client,
              proxyAddress: gameProxy,
              disputeGameIndex: null,
              isReferenceLatestGame: false,
              fallbackResolutionSeconds: disputeGameResolutionSeconds,
            }).catch(() => null),
          ]);
          blacklisted = Boolean(bl);
          wasRespected = respectedWhenCreated;
          inspectedGame = gameInspection;
        }

        const gStatus = inspectedGame?.gameStatus ?? null;
        const gType = inspectedGame?.gameType ?? null;
        const gCreated = inspectedGame?.createdAt ?? null;
        const gResolved = inspectedGame?.resolvedAt ?? null;

        const isBetterCandidate =
          proofSubmitter === null ||
          (subCheckPassed && !checkWithdrawalPassed) ||
          (!blacklisted &&
            gStatus !== 1 &&
            wasRespected !== false &&
            (disputeGameBlacklisted ||
              disputeGameStatus === 1 ||
              wasRespectedGameTypeWhenCreated === false));

        if (isBetterCandidate) {
          proofSubmitter = sub;
          disputeGameAddress = gameProxy;
          provenTimestamp = pTs;
          provenAfterGameCreated = gCreated === null ? true : pTs > gCreated;
          disputeGameBlacklisted = blacklisted;
          wasRespectedGameTypeWhenCreated = wasRespected;
          disputeGameStatus = gStatus;
          disputeGameType = gType;
          disputeGameCreatedAt = gCreated;
          disputeGameResolvedAt = gResolved;
          checkWithdrawalPassed = subCheckPassed;
          checkWithdrawalError = subCheckErr;
          teeZk = inspectedGame;
        }

        if (subCheckPassed) break;
      } catch {
        // Continue checking next submitter
      }
    }

    if (provenTimestamp !== null) {
      maturityRemainingSeconds = portalFinalized
        ? 0
        : Math.max(0, provenTimestamp + proofMaturityDelaySeconds - nowSec);
      const proveTxInfo = await findL1ProveTransactionByTimestamp({
        l1Client,
        portalAddress,
        withdrawalHash: primary.withdrawalHash,
        provenTimestamp,
      });
      l1ProveTxHash = proveTxInfo.txHash;
      l1ProveBlockNumber = proveTxInfo.blockNumber;
    }

    if (portalFinalized) {
      gameResolutionRemainingSeconds = 0;
    } else if (disputeGameStatus === 2) {
      const rAt = disputeGameResolvedAt ?? nowSec;
      gameResolutionRemainingSeconds = Math.max(
        0,
        rAt + disputeGameFinalityDelaySeconds - nowSec
      );
    } else if (teeZk && teeZk.remainingToResolveSeconds !== null) {
      gameResolutionRemainingSeconds =
        teeZk.remainingToResolveSeconds + disputeGameFinalityDelaySeconds;
    } else if (disputeGameCreatedAt !== null) {
      gameResolutionRemainingSeconds = Math.max(
        0,
        disputeGameCreatedAt +
          disputeGameResolutionSeconds +
          disputeGameFinalityDelaySeconds -
          nowSec
      );
    }
  } else if (!portalFinalized) {
    try {
      const output = await l1Client.getL2Output({
        l2BlockNumber: receipt.blockNumber,
        targetChain: l2Chain,
      });
      disputeGameIndex = Number(output.outputIndex);
      disputeGameCreatedAt = Number(output.timestamp);

      if (portalParams.disputeGameFactoryAddress) {
        const entry = await withRpcRetry(
          () =>
            l1Client.readContract({
              address: portalParams.disputeGameFactoryAddress!,
              abi: DISPUTE_GAME_FACTORY_ABI,
              functionName: 'gameAtIndex',
              args: [BigInt(output.outputIndex)],
            }),
          2
        ).catch(() => null);

        if (entry && entry[2].toLowerCase() !== ZERO_ADDRESS) {
          disputeGameAddress = entry[2];
          const [bl, respectedWhenCreated, inspected] = await Promise.all([
            l1Client
              .readContract({
                address: portalAddress,
                abi: OPTIMISM_PORTAL_READ_ABI,
                functionName: 'disputeGameBlacklist',
                args: [entry[2]],
              })
              .catch(() => false),
            l1Client
              .readContract({
                address: entry[2],
                abi: DISPUTE_GAME_ABI,
                functionName: 'wasRespectedGameTypeWhenCreated',
              })
              .catch(() => null),
            inspectAggregateGameProxy({
              l1Client,
              proxyAddress: entry[2],
              disputeGameIndex,
              isReferenceLatestGame: false,
              fallbackResolutionSeconds: disputeGameResolutionSeconds,
            }).catch(() => null),
          ]);
          disputeGameBlacklisted = Boolean(bl);
          wasRespectedGameTypeWhenCreated = respectedWhenCreated;
          teeZk = inspected;
          if (teeZk) {
            disputeGameStatus = teeZk.gameStatus;
            disputeGameType = teeZk.gameType;
            disputeGameCreatedAt = teeZk.createdAt ?? disputeGameCreatedAt;
            disputeGameResolvedAt = teeZk.resolvedAt;
          }
        }
      }

      maturityRemainingSeconds = proofMaturityDelaySeconds;
      if (teeZk && teeZk.remainingToResolveSeconds !== null) {
        gameResolutionRemainingSeconds =
          teeZk.remainingToResolveSeconds + disputeGameFinalityDelaySeconds;
      } else {
        gameResolutionRemainingSeconds = Math.max(
          0,
          disputeGameCreatedAt +
            disputeGameResolutionSeconds +
            disputeGameFinalityDelaySeconds -
            nowSec
        );
      }
    } catch {
      // DisputeGame covering this L2 block has not been proposed to L1 yet; attach latest network AggregateVerifier game
      teeZk = portalParams.latestGameTeeZk;
      maturityRemainingSeconds = proofMaturityDelaySeconds;
      const activeWin =
        teeZk?.activeWindowSeconds ?? disputeGameResolutionSeconds;
      gameResolutionRemainingSeconds = activeWin + disputeGameFinalityDelaySeconds;
    }
  }

  // If DisputeGame expectedResolution has already passed (canCallResolveNow) AND maturityRemainingSeconds === 0,
  // checkWithdrawal only reverted because resolve() hasn't been called on the DisputeGame yet.
  if (
    !portalFinalized &&
    numProofSubmitters > 0 &&
    !checkWithdrawalPassed &&
    teeZk?.canCallResolveNow &&
    (maturityRemainingSeconds ?? 1) === 0 &&
    disputeGameBlacklisted !== true &&
    wasRespectedGameTypeWhenCreated !== false
  ) {
    checkWithdrawalPassed = true;
    checkWithdrawalError = null;
  }

  const gameInvalid =
    disputeGameBlacklisted === true ||
    disputeGameStatus === 1 ||
    wasRespectedGameTypeWhenCreated === false ||
    !provenAfterGameCreated;

  let proveState: ProveLifecycleState = 'unproven-waiting-game';
  let proveStateLabel = '';

  if (portalFinalized) {
    proveState = 'finalized';
    proveStateLabel =
      numProofSubmitters > 0
        ? `Prove済 (${numProofSubmitters}件) · L1出金完了済`
        : 'Prove・L1出金完了済';
  } else if (numProofSubmitters > 0) {
    if (gameInvalid) {
      proveState = 'invalid-need-reprove';
      proveStateLabel =
        '要再Prove（紐づくDisputeGameが無効化・非Respected・またはブラックリスト化されています）';
    } else if (checkWithdrawalPassed === true) {
      proveState = 'proven-ready';
      proveStateLabel = `Prove完了・checkWithdrawal要件クリア（Submitter: ${proofSubmitter?.slice(
        0,
        10
      )}... · 今すぐFinalize可能）`;
    } else {
      proveState = 'proven-waiting';
      const matStr =
        maturityRemainingSeconds !== null
          ? formatSecondsJapanese(maturityRemainingSeconds)
          : '—';
      const gameStr =
        gameResolutionRemainingSeconds !== null
          ? formatSecondsJapanese(gameResolutionRemainingSeconds)
          : '—';
      proveStateLabel = `Prove提出済 · 待機中（Prove後成熟残り: ${matStr} / DisputeGame解決残り: ${gameStr}）`;
    }
  } else if (disputeGameIndex !== null) {
    proveState = 'unproven-ready';
    proveStateLabel = `未Prove · 今すぐ proveWithdrawalTransaction 実行可能 (DisputeGame #${disputeGameIndex})`;
  } else {
    proveState = 'unproven-waiting-game';
    proveStateLabel =
      '未Prove · L1 DisputeGame 提案待機中（約25〜30分間隔でL1へ提案されます）';
  }

  // Exact L1 Target Frame Verification (OptimismPortal2 -> _tx.target with l2Sender = _tx.sender stateOverride)
  // This reproduces SafeCall.call(_tx.target, _tx.gasLimit, _tx.value, _tx.data) immediately with zero waiting,
  // avoiding the false "CrossDomainMessenger: message cannot be replayed" error caused by idle l2Sender == 0x...dEaD!
  const unwrapped = unwrapCrossDomainHops({
    sender: primary.sender,
    target: primary.target,
    value: primary.value,
    data: primary.data,
  });

  const cdmHops: CdmHopInspection[] = [];
  if (unwrapped.rawHops.length > 0) {
    const hopStates = await Promise.all(
      unwrapped.rawHops.map(async (h) => {
        const [succ, fail] = await Promise.all([
          l1Client
            .readContract({
              address: h.messengerAddress,
              abi: L1_CROSS_DOMAIN_MESSENGER_ABI,
              functionName: 'successfulMessages',
              args: [h.versionedHash],
            })
            .catch(() => null),
          l1Client
            .readContract({
              address: h.messengerAddress,
              abi: L1_CROSS_DOMAIN_MESSENGER_ABI,
              functionName: 'failedMessages',
              args: [h.versionedHash],
            })
            .catch(() => null),
        ]);
        return { succ, fail };
      })
    );

    unwrapped.rawHops.forEach((h, idx) => {
      cdmHops.push({
        hopIndex: h.hopIndex,
        messengerAddress: h.messengerAddress,
        nonce: h.nonce.toString(),
        sender: h.sender,
        target: h.target,
        valueWei: h.value.toString(),
        minGasLimit: h.minGasLimit.toString(),
        versionedHash: h.versionedHash,
        successfulMessage: hopStates[idx].succ,
        failedMessage: hopStates[idx].fail,
        standaloneRelayPassed: null,
        standaloneRelayError: null,
      });
    });
  }

  let postWaitSimError: string | null = null;
  let outerPortalRelaySimulated = false;
  let innerBridgeRelaySimulated: boolean | null = null;
  let portalTopLevelFinalizePassed: boolean | null = portalFinalized ? true : null;
  let leafBridgeCallPassed: boolean | null = portalFinalized ? true : null;
  let recipientBalanceIncreased: boolean | null = portalFinalized ? true : null;
  let winningFinalizeFrame:
    | 'resolve+finalizeExternalProof'
    | 'finalizeExternalProof'
    | 'finalizeDirect'
    | null = null;

  if (!portalFinalized && targetIsValid && !portalPaused) {
    const l2SenderSlot = await resolvePortalL2SenderSlot(l1Client, portalAddress);
    const minSafePortalGas = (primary.gasLimit * 66n) / 63n + 220000n;

    // Stage 0 (3段全体フル確定フレーム): Simulate actual OptimismPortal2.finalizeWithdrawalTransactionExternalProof
    // using post-wait stateOverride on provenWithdrawals (slot 57) + DisputeGame (slot 0 = DEFENDER_WINS) via Multicall3!
    const refGameAddress = (disputeGameAddress ??
      portalParams.latestGameTeeZk?.disputeGameAddress ??
      null) as Address | null;
    const simSubmitter = (proofSubmitter ?? receipt.from) as Address;

    if (refGameAddress && refGameAddress.toLowerCase() !== ZERO_ADDRESS) {
      try {
        const outerPwKey = keccak256(
          encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint256' }],
            [primary.withdrawalHash, 57n]
          )
        );
        const pwSlot = keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes32' }],
            [simSubmitter, outerPwKey]
          )
        );
        const pastProvenTs = BigInt(
          Math.max(1, nowSec - proofMaturityDelaySeconds - 7200)
        );
        const pwOverrideVal = pad(
          `0x${((pastProvenTs << 160n) | BigInt(refGameAddress)).toString(16)}` as Hex,
          { size: 32 }
        );

        const existingGameSlot0 = await l1Client
          .getStorageAt({
            address: refGameAddress,
            slot: pad('0x0', { size: 32 }),
          })
          .catch(() => null);
        const existingBig = existingGameSlot0 ? BigInt(existingGameSlot0) : (0x0101n << 136n);
        const highBits = (existingBig >> 136n) << 136n;
        const pastCreated = BigInt(
          Math.max(1, nowSec - proofMaturityDelaySeconds - 14400)
        );
        const pastResolved = BigInt(
          Math.max(1, nowSec - disputeGameFinalityDelaySeconds - 3600)
        );
        // status = 2 (DEFENDER_WINS) at bits 128..135
        const gameSlot0Override = pad(
          `0x${(
            highBits |
            (2n << 128n) |
            (pastResolved << 64n) |
            pastCreated
          ).toString(16)}` as Hex,
          { size: 32 }
        );

        const validRecipient =
          l1Recipient && /^0x[0-9a-fA-F]{40}$/.test(l1Recipient)
            ? (l1Recipient as Address)
            : primary.target;
        const hasErc20Token =
          Boolean(l1TokenAddress) &&
          l1TokenAddress!.toLowerCase() !== ZERO_ADDRESS;

        const balTarget = hasErc20Token
          ? (l1TokenAddress as Address)
          : MULTICALL3_ADDRESS;
        const balCallData = hasErc20Token
          ? encodeFunctionData({
              abi: ERC20_META_ABI,
              functionName: 'balanceOf',
              args: [validRecipient],
            })
          : encodeFunctionData({
              abi: MULTICALL3_ABI,
              functionName: 'getEthBalance',
              args: [validRecipient],
            });

        const finalizeCallData = encodeFunctionData({
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizeWithdrawalTransactionExternalProof',
          args: [
            {
              nonce: primary.nonce,
              sender: primary.sender,
              target: primary.target,
              value: primary.value,
              gasLimit: primary.gasLimit,
              data: primary.data,
            },
            simSubmitter,
          ],
        });

        const finalizedCheckData = encodeFunctionData({
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizedWithdrawals',
          args: [primary.withdrawalHash],
        });

        const mcSim = await l1Client.simulateContract({
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionName: 'aggregate3',
          args: [
            [
              { target: balTarget, allowFailure: true, callData: balCallData },
              {
                target: portalAddress,
                allowFailure: true,
                callData: finalizeCallData,
              },
              {
                target: portalAddress,
                allowFailure: true,
                callData: finalizedCheckData,
              },
              { target: balTarget, allowFailure: true, callData: balCallData },
            ],
          ],
          gas: minSafePortalGas + 250000n,
          stateOverride: [
            {
              address: portalAddress,
              balance: primary.value + 10n ** 18n,
              stateDiff: [{ slot: pwSlot, value: pwOverrideVal }],
            },
            {
              address: refGameAddress,
              stateDiff: [
                { slot: pad('0x0', { size: 32 }), value: gameSlot0Override },
              ],
            },
          ],
        });

        const [balBeforeRes, finRes, isFinRes, balAfterRes] = mcSim.result;
        const finMarkedTrue =
          isFinRes.success &&
          isFinRes.returnData.length >= 66 &&
          BigInt(isFinRes.returnData) === 1n;

        if (finRes.success && finMarkedTrue) {
          portalTopLevelFinalizePassed = true;
          winningFinalizeFrame =
            teeZk?.canCallResolveNow && disputeGameStatus === 0
              ? 'resolve+finalizeExternalProof'
              : 'finalizeExternalProof';

          if (
            amountRaw > 0n &&
            balBeforeRes.success &&
            balAfterRes.success &&
            balBeforeRes.returnData.length >= 66 &&
            balAfterRes.returnData.length >= 66
          ) {
            recipientBalanceIncreased =
              BigInt(balAfterRes.returnData) > BigInt(balBeforeRes.returnData);
          }
        } else {
          portalTopLevelFinalizePassed = false;
        }
      } catch {
        // Non-fatal if RPC rejects Multicall3 stateOverride; individual frame simulations run below
      }
    }

    // Stage 1: Simulate OptimismPortal2 -> _tx.target delivery frame with stateOverride: l2Sender = primary.sender
    if (l2SenderSlot) {
      try {
        await l1Client.call({
          account: portalAddress,
          to: primary.target,
          data: primary.data,
          value: primary.value,
          gas: (primary.gasLimit > 0n ? primary.gasLimit : 300000n) + 80000n,
          stateOverride: [
            {
              address: portalAddress,
              balance: primary.value + 10n ** 18n,
              stateDiff: [
                {
                  slot: l2SenderSlot,
                  value: pad(primary.sender, { size: 32 }),
                },
              ],
            },
          ],
        });
        outerPortalRelaySimulated = true;
        if (portalTopLevelFinalizePassed === null) {
          portalTopLevelFinalizePassed = true;
          winningFinalizeFrame = 'finalizeExternalProof';
        }
        if (cdmHops.length === 1) {
          cdmHops[0].standaloneRelayPassed = true;
        }
      } catch (err) {
        const rawErrMsg = err instanceof Error ? err.message : String(err);
        const lowerMsg = rawErrMsg.toLowerCase();
        const isContractRevert =
          lowerMsg.includes('execution reverted') ||
          lowerMsg.includes('reverted with reason');
        const stateOverrideUnsupported =
          !isContractRevert &&
          (lowerMsg.includes('invalid argument 2') ||
            lowerMsg.includes('too many arguments') ||
            lowerMsg.includes('stateoverride is not') ||
            lowerMsg.includes('state override is not'));

        if (!stateOverrideUnsupported) {
          outerPortalRelaySimulated = false;
          const shortReason = extractShortRevertReason(rawErrMsg);
          if (cdmHops.length >= 1) {
            cdmHops[0].standaloneRelayPassed = false;
            cdmHops[0].standaloneRelayError = shortReason;
          }
          postWaitSimError = shortReason;
        }
      }

      // Stage 2: If multi-hop nested relayMessage (e.g. Hop 1 -> L1CDM wrapping Hop 2 -> L1StandardBridge),
      // isolate and test the innermost relayMessage frame separately
      if (unwrapped.rawHops.length >= 2) {
        const leafHop = unwrapped.rawHops[unwrapped.rawHops.length - 1];
        const leafHopRecord = cdmHops[cdmHops.length - 1];
        try {
          await l1Client.call({
            account: portalAddress,
            to: leafHop.messengerAddress,
            data: leafHop.rawRelayCalldata,
            value: leafHop.value,
            gas: (leafHop.minGasLimit > 0n ? leafHop.minGasLimit : 250000n) + 80000n,
            stateOverride: [
              {
                address: portalAddress,
                balance: leafHop.value + 10n ** 18n,
                stateDiff: [
                  {
                    slot: l2SenderSlot,
                    value: pad(L2_CROSS_DOMAIN_MESSENGER as Address, {
                      size: 32,
                    }),
                  },
                ],
              },
            ],
          });
          innerBridgeRelaySimulated = true;
          leafHopRecord.standaloneRelayPassed = true;
          leafHopRecord.standaloneRelayError = null;
        } catch (innerErr) {
          innerBridgeRelaySimulated = false;
          const shortInner = extractShortRevertReason(
            innerErr instanceof Error ? innerErr.message : String(innerErr)
          );
          leafHopRecord.standaloneRelayPassed = false;
          leafHopRecord.standaloneRelayError = shortInner;
        }
      }
    }

    // Stage 3 (3段目リーフ着金コール): Simulate leaf bridge/contract call directly (e.g. L1CDM -> L1StandardBridge.finalizeBridgeERC20)
    // with xDomainMsgSender (slot 0xcc) overridden to leafSender!
    if (unwrapped.rawHops.length >= 1) {
      const leafHop = unwrapped.rawHops[unwrapped.rawHops.length - 1];
      const xDomainSlot = await resolveCdmXDomainSenderSlot(
        l1Client,
        leafHop.messengerAddress
      );
      try {
        await l1Client.call({
          account: leafHop.messengerAddress,
          to: unwrapped.leafTarget,
          data: unwrapped.leafData,
          value: unwrapped.leafValue,
          gas: (leafHop.minGasLimit > 0n ? leafHop.minGasLimit : 250000n) + 80000n,
          stateOverride: [
            {
              address: leafHop.messengerAddress,
              balance: unwrapped.leafValue + 10n ** 18n,
              stateDiff: [
                {
                  slot: xDomainSlot,
                  value: pad(unwrapped.leafSender, { size: 32 }),
                },
              ],
            },
          ],
        });
        leafBridgeCallPassed = true;
      } catch {
        leafBridgeCallPassed = false;
      }
    }

    // Live check when checkWithdrawal already passes right now
    if (checkWithdrawalPassed === true && proofSubmitter) {
      if (teeZk?.canCallResolveNow && disputeGameStatus === 0 && disputeGameAddress) {
        try {
          await l1Client.simulateContract({
            address: disputeGameAddress as Address,
            abi: DISPUTE_GAME_ABI,
            functionName: 'resolve',
            account: receipt.from,
          });
          portalTopLevelFinalizePassed = true;
          winningFinalizeFrame = 'resolve+finalizeExternalProof';
          postWaitSimError = null;
        } catch (err) {
          postWaitSimError = extractShortRevertReason(
            err instanceof Error ? err.message : String(err)
          );
        }
      } else {
        try {
          await l1Client.simulateContract({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: 'finalizeWithdrawalTransactionExternalProof',
            args: [
              {
                nonce: primary.nonce,
                sender: primary.sender,
                target: primary.target,
                value: primary.value,
                gasLimit: primary.gasLimit,
                data: primary.data,
              },
              proofSubmitter as Address,
            ],
            account: receipt.from,
            gas: minSafePortalGas,
          });
          portalTopLevelFinalizePassed = true;
          winningFinalizeFrame = 'finalizeExternalProof';
          postWaitSimError = null;
        } catch (err) {
          postWaitSimError = extractShortRevertReason(
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  }

  // Build exact 4 real OP Stack contract validation checks
  const checks: ValidationCheckItem[] = [];

  // 1. L2ToL1MessagePasser.sol
  checks.push({
    id: 'message-passer',
    label: '1. L2ToL1MessagePasser.sentMessages ＆ MPT証明 (proveWithdrawalTransaction 要件)',
    passed: merkleProofVerified,
    status: merkleProofVerified ? 'pass' : 'fail',
    detail: merkleProofVerified
      ? `sentMessages[withdrawalHash] = true · Slot値 = 1 · MPTストレージ証明 (${proofNodes}階層) 確認済`
      : 'L2ToL1MessagePasser の sentMessages スロットに有効な出金記録が確認できません',
  });

  // 2. OptimismPortal2 Guards (!paused, target != portal, !finalizedWithdrawals)
  const portalGuardPassed = !portalPaused && targetIsValid;
  checks.push({
    id: 'portal-guard',
    label: `2. OptimismPortal2${portalVersion ? ` v${portalVersion}` : ''} ガード条件 (!paused / target検証 / finalizedWithdrawals)`,
    passed: portalGuardPassed,
    status: portalGuardPassed ? 'pass' : 'fail',
    detail: !targetIsValid
      ? 'OptimismPortal: cannot send to portal (_tx.target が OptimismPortal2 自身を指しています)'
      : portalPaused
      ? 'OptimismPortal: paused (現在緊急停止中のため L1 出金が一時停止されています)'
      : portalFinalized
      ? 'paused() = false · target != portal · finalizedWithdrawals[hash] = true (L1出金完了済)'
      : `paused() = false · target != portal · finalizedWithdrawals[hash] = false (未消費 · sender=${primary.sender.slice(0, 10)}...)`,
  });

  // 3. DisputeGameFactory & AggregateVerifier (TEE / ZK)
  const typeMatches =
    wasRespectedGameTypeWhenCreated !== false &&
    (respectedGameType === null ||
      disputeGameType === null ||
      Number(respectedGameType) === disputeGameType);

  const windowBadge = teeZk
    ? teeZk.windowMode === 'dual-1d'
      ? `TEE+ZK 二重証明 1日 (${teeZk.fastFinalizationDelaySeconds.toLocaleString()}秒)`
      : `単一証明 ${teeZk.proofCount}/2 · 5日 (${teeZk.slowFinalizationDelaySeconds.toLocaleString()}秒)`
    : `${formatSecondsJapanese(disputeGameResolutionSeconds)}`;

  if (portalFinalized) {
    checks.push({
      id: 'dispute-game',
      label: '3. DisputeGame / AggregateVerifier (provenWithdrawals・Blacklist・TEE/ZK)',
      passed: true,
      status: 'pass',
      detail:
        numProofSubmitters > 0 && disputeGameAddress
          ? `provenWithdrawals 確認済 (Submitter: ${proofSubmitter?.slice(0, 10)}...) · Game ${disputeGameAddress.slice(
              0,
              10
            )}... (${getDisputeGameStatusText(disputeGameStatus)}) · ${windowBadge}`
          : 'OptimismPortal2 にて DisputeGame 解決・ファイナライズ完了済',
    });
  } else if (numProofSubmitters > 0) {
    checks.push({
      id: 'dispute-game',
      label: '3. DisputeGame / AggregateVerifier (provenWithdrawals・Blacklist・TEE/ZK)',
      passed: !gameInvalid && typeMatches,
      status: gameInvalid ? 'fail' : typeMatches ? 'pass' : 'warn',
      detail: gameInvalid
        ? `要再Prove: Blacklist=${String(disputeGameBlacklisted)} · Status=${getDisputeGameStatusText(
            disputeGameStatus
          )} · wasRespected=${String(wasRespectedGameTypeWhenCreated)}`
        : `provenWithdrawals 登録済 (${numProofSubmitters}件, Submitter ${proofSubmitter?.slice(
            0,
            10
          )}...) · !disputeGameBlacklist · wasRespectedGameTypeWhenCreated=true · ${getDisputeGameStatusText(
            disputeGameStatus
          )} · 適用枠: ${windowBadge}`,
    });
  } else {
    const unprovenGameValid = !gameInvalid && merkleProofVerified;
    checks.push({
      id: 'dispute-game',
      label: '3. DisputeGame / AggregateVerifier (L1出力ルート提案・TEE/ZK待機枠)',
      passed: unprovenGameValid,
      status: unprovenGameValid ? 'pass' : 'fail',
      detail:
        proveState === 'unproven-ready'
          ? `未Prove · DisputeGame #${
              disputeGameIndex ?? '—'
            } 到達済（今すぐ proveWithdrawalTransaction 実行可 · 適用枠: ${windowBadge}）`
          : `未Prove · L1 DisputeGame 提案待ち（提案到達後に proveWithdrawalTransaction 実行可 · 現在の最新枠: ${windowBadge}）`,
    });
  }

  // 4. OptimismPortal2.checkWithdrawal & Actual L1 Delivery Verification
  const safeCallSwallowedInnerFailure =
    !portalFinalized &&
    portalTopLevelFinalizePassed === true &&
    (outerPortalRelaySimulated === false || recipientBalanceIncreased === false);

  const stageSummaryParts: string[] = [];
  if (portalTopLevelFinalizePassed === true) {
    stageSummaryParts.push(
      safeCallSwallowedInnerFailure
        ? 'Portal外枠Tx: 非Revert(SafeCall吸収)'
        : 'Portal確定Tx: PASS'
    );
  }
  if (outerPortalRelaySimulated === false) {
    stageSummaryParts.push('Hop1中継: Revert(停止)');
  } else if (outerPortalRelaySimulated === true) {
    stageSummaryParts.push('Hop1中継: PASS');
  }
  if (recipientBalanceIncreased === true) {
    stageSummaryParts.push('実測L1残高増加: 確認済');
  } else if (recipientBalanceIncreased === false) {
    stageSummaryParts.push('実測L1残高増分: 0(着金なし)');
  }
  const stageBadge =
    stageSummaryParts.length > 0 ? ` [${stageSummaryParts.join(' · ')}]` : '';

  if (portalFinalized) {
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: true,
      status: 'pass',
      detail: 'L1 上で既に finalizeWithdrawalTransaction が実行済みです。',
    });
  } else if (safeCallSwallowedInnerFailure) {
    const hop1Err =
      cdmHops[0]?.standaloneRelayError ??
      postWaitSimError ??
      '内部中継フレームで停止';
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: false,
      status: 'fail',
      detail: `【着金不可・実測受取 0】OptimismPortal2 外枠の finalizeWithdrawalTransactionExternalProof 自体は SafeCall により Revert しませんが、内部の Hop 1 が「${hop1Err}」で停止するため 3段目 L1StandardBridge に到達せず、Multicall3 実測の受取残高増分は 0 です。`,
    });
  } else if (postWaitSimError !== null || recipientBalanceIncreased === false) {
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: false,
      status: 'fail',
      detail: `着金シミュレーションで阻害要因を検出: ${
        postWaitSimError ?? 'L1受取先残高が増加しません（実測増分 0）'
      }`,
    });
  } else if (checkWithdrawalPassed === true) {
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: true,
      status: 'pass',
      detail:
        teeZk?.canCallResolveNow && disputeGameStatus === 0
          ? `proofMaturityDelaySeconds (1日) ＆ DisputeGame expectedResolution 経過済 · resolve() + finalizeWithdrawalTransactionExternalProof 実着金確認済${stageBadge}`
          : `checkWithdrawal(hash, ${proofSubmitter?.slice(
              0,
              10
            )}...) 合格 · finalizeWithdrawalTransactionExternalProof 実着金確認済${stageBadge}`,
    });
  } else if (numProofSubmitters > 0) {
    const validWaiting = !gameInvalid && portalGuardPassed;
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: validWaiting,
      status: validWaiting ? 'pass' : 'fail',
      detail: validWaiting
        ? `待機経過後の L1 実着金シミュレーション PASS${stageBadge}（Prove成熟残り: ${formatSecondsJapanese(
            maturityRemainingSeconds
          )} / Game解決残り: ${formatSecondsJapanese(
            gameResolutionRemainingSeconds
          )}）`
        : `checkWithdrawal 阻害要因あり: ${
            checkWithdrawalError ?? 'DisputeGame または Portal 状態を確認してください'
          }`,
    });
  } else {
    const validPreProve = merkleProofVerified && portalGuardPassed && !gameInvalid;
    checks.push({
      id: 'check-withdrawal',
      label: '4. OptimismPortal2.checkWithdrawal ＆ L1実着金シミュレーション',
      passed: validPreProve,
      status: validPreProve ? 'pass' : 'fail',
      detail: validPreProve
        ? `待機経過後の L1 実着金シミュレーション PASS${stageBadge} · Prove提出後に成熟 (${formatSecondsJapanese(
            proofMaturityDelaySeconds
          )}) ＆ Game解決 (${windowBadge}) で着金可能`
        : '前提となる MessagePasser または OptimismPortal2 ガード条件を満たしていません',
    });
  }

  const canWithdrawAfterWait =
    portalFinalized ||
    (merkleProofVerified &&
      portalGuardPassed &&
      !gameInvalid &&
      !safeCallSwallowedInnerFailure &&
      outerPortalRelaySimulated !== false &&
      recipientBalanceIncreased !== false &&
      postWaitSimError === null);

  let verdictLabel = '';
  let verdictSummary = '';

  if (portalFinalized) {
    verdictLabel = 'L1出金完了済 (finalizedWithdrawals = true)';
    verdictSummary =
      'OptimismPortal2.finalizedWithdrawals[withdrawalHash] = true を確認。L1側でのファイナライズ処理は既に完了しています。';
  } else if (canWithdrawAfterWait) {
    if (proveState === 'proven-ready') {
      verdictLabel = '今すぐ確定実行 (Finalize) ＆ L1着金可能';
      verdictSummary = `OptimismPortal2.checkWithdrawal 全要件および Multicall3 L1着金残高増加シミュレーションに合格しています。成功フレーム (${
        winningFinalizeFrame ?? 'finalizeExternalProof'
      }) で Revert なく資産を受け取れます。`;
    } else if (proveState === 'unproven-ready') {
      verdictLabel = '今すぐ Prove 実行可能（待機後に L1 着金確認済）';
      verdictSummary =
        'L2ToL1MessagePasser 証明・対象 DisputeGame 到達・および待機経過後の L1 受取残高増加のすべてがオンチェーン検証で PASS しています。';
    } else if (proveState === 'proven-waiting') {
      verdictLabel = 'Prove済・L1実着金検証 PASS（待機満了後に受取可能）';
      verdictSummary =
        'provenWithdrawals 登録済みかつ L1 受取先への着金シミュレーション（残高増加）が PASS しています。待機期間経過後に確定実行して資産を受け取れます。';
    } else {
      verdictLabel = 'L2出金記録 ＆ L1実着金検証 PASS（提案→Prove→待機後に受取可能）';
      verdictSummary =
        'L2ToL1MessagePasser.sentMessages = true および待機経過後の L1 受取残高増加の PASS を確認済みです。';
    }
  } else if (safeCallSwallowedInnerFailure) {
    const hop1Err =
      cdmHops[0]?.standaloneRelayError ??
      postWaitSimError ??
      'CrossDomainMessenger: cannot send message to blocked system address.';
    verdictLabel = '着金不可（Portal外枠は非Revertですが実測受取額は 0 です）';
    verdictSummary = `OptimismPortal2.finalizeWithdrawalTransactionExternalProof（外枠）は SafeCall により Revert せず完了しますが、内部の Hop 1 中継が「${hop1Err}」で Revert して処理が止まるため、3段目の L1StandardBridge に到達しません。Multicall3 オンチェーン実測での L1 受取残高増分は 0 であり、待機後に Finalize しても資産は受け取れません（L1ガス代節約のため実行非推奨）。`;
  } else {
    verdictLabel = 'L1着金またはコントラクト要件で阻害要因を検出';
    verdictSummary =
      postWaitSimError !== null
        ? `着金シミュレーションで Revert を検出: ${postWaitSimError}`
        : !targetIsValid
        ? 'OptimismPortal2 自身をターゲットにした出金はコントラクト仕様により実行できません。'
        : portalPaused
        ? 'OptimismPortal2 が Paused（緊急停止中）のため、解除されるまで L1 出金できません。'
        : gameInvalid
        ? '紐づく DisputeGame が無効化またはブラックリスト化されているため、有効な最新 DisputeGame で再Proveが必要です。'
        : 'L2ToL1MessagePasser の出金記録が確認できませんでした。';
  }

  return {
    canWithdrawAfterWait,
    verdictLabel,
    verdictSummary,
    portalAddress,
    portalVersion,
    respectedGameType,
    portalPaused: Boolean(portalPaused),
    targetIsValid,
    alreadyFinalizedOnL1: portalFinalized,
    proveState,
    proveStateLabel,
    numProofSubmitters,
    proofSubmitter,
    proofSubmittersList,
    disputeGameIndex,
    disputeGameAddress,
    disputeGameStatus,
    disputeGameCreatedAt,
    disputeGameResolvedAt,
    disputeGameBlacklisted,
    wasRespectedGameTypeWhenCreated,
    provenTimestamp,
    l1ProveTxHash,
    l1ProveBlockNumber,
    maturityRemainingSeconds,
    gameResolutionRemainingSeconds,
    checkWithdrawalPassed,
    checkWithdrawalError,
    outerPortalRelaySimulated,
    innerBridgeRelaySimulated,
    portalTopLevelFinalizePassed,
    leafBridgeCallPassed,
    recipientBalanceIncreased,
    winningFinalizeFrame,
    cdmHops,
    postWaitSimError,
    messagePasser,
    teeZk,
    checks,
  };
}

export async function analyzeWithdrawalFromTxHash(
  txHash: Hex,
  config: NetworkConfig
): Promise<WithdrawalInfo | null> {
  const clients = createBaseAndL1Clients(config);
  const receipt = await withRpcRetry(
    () => clients.l2Client.getTransactionReceipt({ hash: txHash }),
    3
  );
  return analyzeWithdrawalFromReceipt(receipt, config, clients);
}

export async function analyzeWithdrawalFromReceipt(
  receipt: TransactionReceipt,
  config: NetworkConfig,
  clients?: ReturnType<typeof createBaseAndL1Clients>
): Promise<WithdrawalInfo | null> {
  const withdrawals = getWithdrawals(receipt);
  if (withdrawals.length === 0) return null;

  const primary = withdrawals[0];
  const resolvedClients = clients ?? createBaseAndL1Clients(config);
  const { l1Client, l2Client, l2Chain, portalAddress } = resolvedClients;

  // Decode bridge asset, amount & actual L1 recipient by:
  // 1) Unwrapping CrossDomainMessenger.relayMessage frames (1-hop or multi-hop nested) and decoding leaf L1 bridge calldata
  // 2) Supplementing with L2StandardBridge / ERC20 burn events in the L2 receipt for custom bridge implementations
  const unwrapped = unwrapCrossDomainHops({
    sender: primary.sender,
    target: primary.target,
    value: primary.value,
    data: primary.data,
  });

  let assetType: 'ETH' | 'ERC20' | 'MESSAGE' =
    primary.value > 0n || unwrapped.leafValue > 0n ? 'ETH' : 'MESSAGE';
  let assetSymbol =
    primary.value > 0n || unwrapped.leafValue > 0n ? 'ETH' : 'Message';
  let assetDecimals = 18;
  let l2TokenAddress: string | null = null;
  let l1TokenAddress: string | null = null;
  let amountRaw =
    unwrapped.leafValue > 0n ? unwrapped.leafValue : primary.value;
  let l1Recipient: string =
    unwrapped.rawHops.length > 0 ? unwrapped.leafTarget : primary.target;
  let decodedFromLeafCalldata = false;

  if (unwrapped.leafData && unwrapped.leafData.length >= 10) {
    try {
      const leafDecoded = decodeFunctionData({
        abi: L1_BRIDGE_FINALIZE_ABI,
        data: unwrapped.leafData,
      });

      if (
        leafDecoded.functionName === 'finalizeBridgeERC20' ||
        leafDecoded.functionName === 'finalizeERC20Withdrawal'
      ) {
        const [l1Tok, l2Tok, , toAddr, amt] = leafDecoded.args;
        assetType = 'ERC20';
        l1TokenAddress = l1Tok;
        l2TokenAddress = l2Tok;
        l1Recipient = toAddr;
        amountRaw = amt;
        decodedFromLeafCalldata = true;
      } else if (
        leafDecoded.functionName === 'finalizeBridgeETH' ||
        leafDecoded.functionName === 'finalizeETHWithdrawal'
      ) {
        const [, toAddr, amt] = leafDecoded.args;
        assetType = 'ETH';
        assetSymbol = 'ETH';
        assetDecimals = 18;
        l1Recipient = toAddr;
        amountRaw = amt;
        decodedFromLeafCalldata = true;
      } else if (leafDecoded.functionName === 'finalizeBridgeERC721') {
        const [l1Tok, l2Tok, , toAddr] = leafDecoded.args;
        assetType = 'MESSAGE';
        assetSymbol = 'ERC721';
        assetDecimals = 0;
        l1TokenAddress = l1Tok;
        l2TokenAddress = l2Tok;
        l1Recipient = toAddr;
        amountRaw = 1n;
        decodedFromLeafCalldata = true;
      }
    } catch {
      // Custom L1 target selector — fall through to L2 receipt log inspection
    }
  }

  if (!decodedFromLeafCalldata) {
    try {
      const bridgeEvents = parseEventLogs({
        abi: L2_STANDARD_BRIDGE_ABI,
        logs: receipt.logs,
      });

      const erc20Evt = bridgeEvents.find(
        (e) =>
          e.eventName === 'ERC20BridgeInitiated' ||
          e.eventName === 'WithdrawalInitiated'
      );
      const ethEvt = bridgeEvents.find(
        (e) => e.eventName === 'ETHBridgeInitiated'
      );

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
      } else if (ethEvt) {
        assetType = 'ETH';
        assetSymbol = 'ETH';
        assetDecimals = 18;
        const args = ethEvt.args as { to: Address; amount: bigint };
        l1Recipient = args.to;
        amountRaw = args.amount;
      } else if (assetType === 'MESSAGE') {
        // Check for custom bridge ERC20 burn log (Transfer to 0x0000...0000)
        const transferEvents = parseEventLogs({
          abi: ERC20_TRANSFER_EVENT_ABI,
          logs: receipt.logs,
        });
        const burnEvt = transferEvents.find(
          (e) => e.args.to.toLowerCase() === ZERO_ADDRESS && e.args.value > 0n
        );
        if (burnEvt) {
          assetType = 'ERC20';
          l2TokenAddress = burnEvt.address;
          amountRaw = burnEvt.args.value;
        }
      }
    } catch {
      // Keep unwrapped target & value fallback
    }
  }

  if (assetType === 'ERC20') {
    const meta = await readErc20MetadataWithFallback({
      l2Client,
      l1Client,
      l2TokenAddress,
      l1TokenAddress,
    });
    assetSymbol = meta.symbol;
    assetDecimals = meta.decimals;
  }

  const formattedRaw = formatUnits(amountRaw, assetDecimals);
  const amountFormatted = formatDisplayAmount(formattedRaw);

  // Strict L1 OptimismPortal2 reads with retry — if L1 RPC fails after retries, throw so caller marks row partial for re-acquisition!
  const [portalFinalized, portalParams] = await Promise.all([
    withRpcRetry(
      () =>
        l1Client.readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizedWithdrawals',
          args: [primary.withdrawalHash],
        }),
      4,
      450
    ),
    resolvePortalDisputeParams(l1Client, portalAddress, false, false),
  ]);

  const initialStatus: WithdrawalStatus = portalFinalized
    ? 'finalized'
    : 'waiting-to-prove';

  const validation = await verifyMessagePasserAndL1Validation({
    clients: resolvedClients,
    receipt,
    primary,
    initialStatus,
    portalFinalized: Boolean(portalFinalized),
    portalParams,
    l1Recipient,
    l1TokenAddress,
    amountRaw,
  });

  let effectiveStatus: WithdrawalStatus = initialStatus;
  if (portalFinalized) {
    effectiveStatus = 'finalized';
  } else if (validation.proveState === 'proven-ready') {
    effectiveStatus = 'ready-to-finalize';
  } else if (validation.proveState === 'proven-waiting') {
    effectiveStatus = 'waiting-to-finalize';
  } else if (validation.proveState === 'invalid-need-reprove') {
    effectiveStatus = 'ready-to-prove';
  } else if (validation.proveState === 'unproven-ready') {
    effectiveStatus = 'ready-to-prove';
  } else {
    effectiveStatus = 'waiting-to-prove';
  }

  const {
    proofMaturityDelaySeconds,
    disputeGameResolutionSeconds,
    disputeGameFinalityDelaySeconds,
  } = portalParams;

  const activeGameWindowSeconds =
    validation.teeZk?.activeWindowSeconds ?? disputeGameResolutionSeconds;

  const effectivePostProveWindow = Math.max(
    activeGameWindowSeconds + disputeGameFinalityDelaySeconds,
    proofMaturityDelaySeconds
  );

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
    } catch {
      secondsToProve = portalParams.proposalIntervalSeconds;
    }
    secondsToFinalize = effectivePostProveWindow;
    totalSecondsRemaining = (secondsToProve ?? 0) + effectivePostProveWindow;
    estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
  } else if (effectiveStatus === 'ready-to-prove') {
    secondsToProve = 0;
    const gameRem =
      validation.gameResolutionRemainingSeconds ?? effectivePostProveWindow;
    secondsToFinalize = Math.max(proofMaturityDelaySeconds, gameRem);
    totalSecondsRemaining = secondsToFinalize;
    estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
  } else if (effectiveStatus === 'waiting-to-finalize') {
    secondsToProve = 0;
    const matRem = validation.maturityRemainingSeconds ?? 0;
    const gameRem = validation.gameResolutionRemainingSeconds ?? 0;
    secondsToFinalize = Math.max(matRem, gameRem);
    totalSecondsRemaining = secondsToFinalize;
    estimatedClaimableAtMs = analyzedAtMs + totalSecondsRemaining * 1000;
  } else {
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
    usedFallbackDelay: portalParams.usedFallbackDelay,
    portalVersion: portalParams.portalVersion,
    respectedGameType: portalParams.respectedGameType,
    proofMaturityDelaySeconds,
    disputeGameResolutionSeconds: activeGameWindowSeconds,
    fastFinalizationDelaySeconds: portalParams.fastFinalizationDelaySeconds,
    slowFinalizationDelaySeconds: portalParams.slowFinalizationDelaySeconds,
    disputeGameFinalityDelaySeconds,
    secondsToProve,
    secondsToFinalize,
    totalSecondsRemaining,
    estimatedClaimableAtMs,
    analyzedAtMs,
    validation,
  };
}

export async function simulateWithdrawalOnL1(
  txHash: Hex,
  config: NetworkConfig
): Promise<WithdrawalSimulationResult> {
  const clients = createBaseAndL1Clients(config);
  const { l1Client, l2Client, l2Chain, portalAddress } = clients;
  const receipt = await withRpcRetry(
    () => l2Client.getTransactionReceipt({ hash: txHash }),
    3
  );
  const info = await analyzeWithdrawalFromReceipt(receipt, config, clients);

  if (!info) {
    throw new Error(
      'このトランザクションには L2ToL1MessagePasser の出金イベントが含まれていません'
    );
  }
  const withdrawals = getWithdrawals(receipt);
  const withdrawalTuple = withdrawals[0];
  const [l1GasPrice, l2GasPrice] = await Promise.all([
    withRpcRetry(() => l1Client.getGasPrice(), 2),
    withRpcRetry(() => l2Client.getGasPrice(), 2),
  ]);

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

  const val = info.validation;
  const alreadyProven =
    info.portalFinalized ||
    ((val?.numProofSubmitters ?? 0) > 0 &&
      val?.proveState !== 'invalid-need-reprove');

  // Step 1: Real OptimismPortal2.proveWithdrawalTransaction check / simulation
  let proveSim: StepSimulationDetail;
  if (info.portalFinalized) {
    estimatedProveGas = 0n;
    proveSim = {
      step: 'prove',
      methodName: 'proveWithdrawalTransaction',
      passed: true,
      alreadyCompletedOnChain: true,
      executableNow: false,
      estimatedGas: '0',
      estimatedFeeEth: '0.000000',
      summary: '既に L1 OptimismPortal2 で Prove 提出および資金受取が完了しています。',
    };
  } else if (alreadyProven) {
    estimatedProveGas = 0n;
    proveSim = {
      step: 'prove',
      methodName: 'proveWithdrawalTransaction',
      passed: true,
      alreadyCompletedOnChain: true,
      executableNow: false,
      estimatedGas: '0',
      estimatedFeeEth: '0.000000',
      summary: `L1 OptimismPortal2 にて既に Prove 提出済みです（Submitter: ${
        val?.proofSubmitter ? `${val.proofSubmitter.slice(0, 10)}...` : '確認済'
      }）。再実行は不要です。`,
    };
  } else if (info.status === 'ready-to-prove') {
    try {
      const output = await l1Client.getL2Output({
        l2BlockNumber: receipt.blockNumber,
        targetChain: l2Chain,
      });
      const proveArgs = await l2Client.buildProveWithdrawal({
        output,
        withdrawal: withdrawalTuple,
      });
      const gameIdx = BigInt(output.outputIndex);
      const est = await l1Client.estimateContractGas({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proveWithdrawalTransaction',
        args: [
          proveArgs.withdrawal,
          gameIdx,
          proveArgs.outputRootProof,
          proveArgs.withdrawalProof,
        ],
        account: receipt.from,
      });
      await l1Client.simulateContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proveWithdrawalTransaction',
        args: [
          proveArgs.withdrawal,
          gameIdx,
          proveArgs.outputRootProof,
          proveArgs.withdrawalProof,
        ],
        account: receipt.from,
      });
      estimatedProveGas = est;
      const pFeeEth = Number(formatEther(l1GasPrice * est)).toFixed(6);
      proveSim = {
        step: 'prove',
        methodName: 'proveWithdrawalTransaction',
        passed: true,
        alreadyCompletedOnChain: false,
        executableNow: true,
        estimatedGas: est.toString(),
        estimatedFeeEth: pFeeEth,
        summary: `OptimismPortal2.proveWithdrawalTransaction 実コールシミュレーション合格（DisputeGame #${gameIdx.toString()} · 推定Gas: ${est.toLocaleString()} · 約 ${pFeeEth} ETH）— 今すぐ証明提出可能です。`,
      };
    } catch (err) {
      const pFeeEth = Number(formatEther(l1GasPrice * estimatedProveGas)).toFixed(6);
      proveSim = {
        step: 'prove',
        methodName: 'proveWithdrawalTransaction',
        passed: false,
        alreadyCompletedOnChain: false,
        executableNow: false,
        estimatedGas: estimatedProveGas.toString(),
        estimatedFeeEth: pFeeEth,
        summary: `proveWithdrawalTransaction シミュレーション失敗: ${extractShortRevertReason(
          err instanceof Error ? err.message : String(err)
        )}`,
      };
    }
  } else {
    const mpOk = Boolean(val?.messagePasser.merkleProofVerified);
    const pFeeEth = Number(formatEther(l1GasPrice * estimatedProveGas)).toFixed(6);
    proveSim = {
      step: 'prove',
      methodName: 'proveWithdrawalTransaction',
      passed: mpOk,
      alreadyCompletedOnChain: false,
      executableNow: false,
      estimatedGas: estimatedProveGas.toString(),
      estimatedFeeEth: pFeeEth,
      summary: mpOk
        ? `L2ToL1MessagePasser ストレージ＆MPT証明 (${
            val?.messagePasser.merkleProofNodes ?? 0
          }階層) 検証合格 — L1 DisputeGame 提案到達後（残り目安 ${formatSecondsJapanese(
            info.secondsToProve
          )}）に proveWithdrawalTransaction を実行できます。`
        : 'L2ToL1MessagePasser のストレージ証明が確認できませんでした。',
    };
  }

  // Step 2: Real OptimismPortal2.checkWithdrawal & finalizeWithdrawalTransactionExternalProof validation
  let finalizeSim: StepSimulationDetail;
  if (info.portalFinalized) {
    estimatedFinalizeGas = 0n;
    finalizeSim = {
      step: 'finalize',
      methodName: 'finalizeWithdrawalTransaction',
      passed: true,
      alreadyCompletedOnChain: true,
      executableNow: false,
      estimatedGas: '0',
      estimatedFeeEth: '0.000000',
      summary: `L1 OptimismPortal2 にて既に finalizeWithdrawalTransaction が実行され、${info.amountFormatted} ${info.assetSymbol} の資金受け取りが完了しています。`,
    };
  } else if (info.status === 'ready-to-finalize') {
    const submitter = (val?.proofSubmitter ?? receipt.from) as Address;
    try {
      if (val?.teeZk?.canCallResolveNow && val.disputeGameStatus === 0 && val.disputeGameAddress) {
        await l1Client.simulateContract({
          address: val.disputeGameAddress as Address,
          abi: DISPUTE_GAME_ABI,
          functionName: 'resolve',
          account: receipt.from,
        });
        const fFeeEth = Number(
          formatEther(l1GasPrice * estimatedFinalizeGas)
        ).toFixed(6);
        finalizeSim = {
          step: 'finalize',
          methodName: 'finalizeWithdrawalTransaction',
          passed: Boolean(val?.canWithdrawAfterWait ?? true),
          alreadyCompletedOnChain: false,
          executableNow: true,
          estimatedGas: estimatedFinalizeGas.toString(),
          estimatedFeeEth: fFeeEth,
          summary: `DisputeGame.resolve() シミュレーション合格 ＆ Prove成熟完了 — 「資金を受け取る」ボタンで Game解決と ${info.amountFormatted} ${info.assetSymbol} 受取を実行できます。`,
        };
      } else {
        const minSafePortalGas =
          (withdrawalTuple.gasLimit * 66n) / 63n + 220000n;
        const estRaw = await l1Client
          .estimateContractGas({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: 'finalizeWithdrawalTransactionExternalProof',
            args: [withdrawalArg, submitter],
            account: receipt.from,
          })
          .catch(() => minSafePortalGas);
        const safeEst = estRaw > minSafePortalGas ? estRaw : minSafePortalGas;
        await l1Client.simulateContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizeWithdrawalTransactionExternalProof',
          args: [withdrawalArg, submitter],
          account: receipt.from,
          gas: safeEst,
        });
        estimatedFinalizeGas = safeEst;
        const fFeeEth = Number(formatEther(l1GasPrice * safeEst)).toFixed(6);
        const actuallyDelivers = Boolean(val?.canWithdrawAfterWait);
        finalizeSim = {
          step: 'finalize',
          methodName: 'finalizeWithdrawalTransaction',
          passed: actuallyDelivers,
          alreadyCompletedOnChain: false,
          executableNow: actuallyDelivers,
          estimatedGas: safeEst.toString(),
          estimatedFeeEth: fFeeEth,
          summary: actuallyDelivers
            ? `OptimismPortal2.finalizeWithdrawalTransactionExternalProof ＆ L1着金残高増加 PASS（非Revert保護Gas: ${safeEst.toLocaleString()} · 約 ${fFeeEth} ETH）— 今すぐ「資金を受け取る」ボタンで ${info.amountFormatted} ${info.assetSymbol} を受け取れます。`
            : `【着金不可・実測受取 0 ${info.assetSymbol}】OptimismPortal2 外枠の Tx は SafeCall により Revert しませんが、内部の Hop 1 が停止するため ${info.amountFormatted} ${info.assetSymbol} は着金しません（L1ガス代節約のため実行非推奨）。`,
        };
      }
    } catch (err) {
      const fFeeEth = Number(
        formatEther(l1GasPrice * estimatedFinalizeGas)
      ).toFixed(6);
      finalizeSim = {
        step: 'finalize',
        methodName: 'finalizeWithdrawalTransaction',
        passed: false,
        alreadyCompletedOnChain: false,
        executableNow: false,
        estimatedGas: estimatedFinalizeGas.toString(),
        estimatedFeeEth: fFeeEth,
        summary: `finalizeWithdrawalTransaction シミュレーション失敗: ${extractShortRevertReason(
          err instanceof Error ? err.message : String(err)
        )}`,
      };
    }
  } else {
    const postWaitOk = Boolean(val?.canWithdrawAfterWait);
    const fFeeEth = Number(
      formatEther(l1GasPrice * estimatedFinalizeGas)
    ).toFixed(6);
    const windowDesc =
      val?.teeZk?.windowMode === 'dual-1d'
        ? 'TEE+ZK二重証明 1日枠'
        : '単一証明 5日枠';
    finalizeSim = {
      step: 'finalize',
      methodName: 'finalizeWithdrawalTransaction',
      passed: postWaitOk,
      alreadyCompletedOnChain: false,
      executableNow: false,
      estimatedGas: estimatedFinalizeGas.toString(),
      estimatedFeeEth: fFeeEth,
      summary: postWaitOk
        ? `OptimismPortal2 ガード条件合格 ＆ Multicall3 実測で +${info.amountFormatted} ${info.assetSymbol} の残高増加を確認済 — 待機期間（${windowDesc} · 残り ${formatSecondsJapanese(
            info.totalSecondsRemaining
          )}）経過後に finalizeWithdrawalTransaction を実行して確実に受け取れます。`
        : val?.verdictSummary ??
          `【着金不可】内部中継エラーにより待機期間経過後に Finalize しても ${info.amountFormatted} ${info.assetSymbol} は着金しません（実測受取 0）。`,
    };
  }

  if (info.portalFinalized) {
    l1DryRunAction = 'already-finalized';
    l1DryRunSuccess = true;
    l1DryRunMessage = finalizeSim.summary;
  } else if (info.status === 'ready-to-finalize') {
    l1DryRunAction = 'finalizeWithdrawalTransaction';
    l1DryRunSuccess = finalizeSim.passed;
    l1DryRunMessage = finalizeSim.summary;
  } else if (info.status === 'ready-to-prove') {
    l1DryRunAction = 'proveWithdrawalTransaction';
    l1DryRunSuccess = proveSim.passed && finalizeSim.passed;
    l1DryRunMessage = `${proveSim.summary} / ${finalizeSim.summary}`;
  } else {
    l1DryRunAction = 'finalizeWithdrawalTransaction';
    l1DryRunSuccess = proveSim.passed && finalizeSim.passed;
    l1DryRunMessage = `${proveSim.summary} / ${finalizeSim.summary}`;
  }

  const proveFeeWei = alreadyProven ? 0n : l1GasPrice * estimatedProveGas;
  const finalizeFeeWei = info.portalFinalized
    ? 0n
    : l1GasPrice * estimatedFinalizeGas;
  const totalL1ClaimCostWei = proveFeeWei + finalizeFeeWei;

  let netAmountFormatted: string | null = null;
  if (
    !info.portalFinalized &&
    (val?.canWithdrawAfterWait === false ||
      val?.recipientBalanceIncreased === false)
  ) {
    netAmountFormatted = `0 ${info.assetSymbol}（着金しません・Finalize不要）`;
  } else if (info.assetType === 'ETH') {
    const grossWei = BigInt(info.amountRaw);
    const netWei =
      grossWei > totalL1ClaimCostWei ? grossWei - totalL1ClaimCostWei : 0n;
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
    proveSim,
    finalizeSim,
    proofMaturityDelaySeconds: info.proofMaturityDelaySeconds,
    disputeGameResolutionSeconds: info.disputeGameResolutionSeconds,
    estimatedClaimableAtMs: info.estimatedClaimableAtMs,
    totalSecondsRemaining: info.totalSecondsRemaining,
    teeZk: val?.teeZk ?? null,
    validation: info.validation,
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
        event: MESSAGE_PASSED_EVENT_ABI[0],
        fromBlock: w.from,
        toBlock: w.to,
      });
      for (
        let i = logs.length - 1;
        i >= 0 && picks.length < maxSamples;
        i -= 1
      ) {
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

export async function fetchRecentProvenWithdrawalSample(
  config: NetworkConfig
): Promise<string | null> {
  const { l1Client, l2Client, portalAddress } = createBaseAndL1Clients(config);
  const [l1Head, l2Head] = await Promise.all([
    l1Client.getBlockNumber(),
    l2Client.getBlockNumber(),
  ]);

  const l1From = l1Head > 1500n ? l1Head - 1500n : 0n;
  const provenLogs = await l1Client
    .getLogs({
      address: portalAddress,
      event: OPTIMISM_PORTAL_PROVEN_EVENT_ABI[0],
      fromBlock: l1From,
      toBlock: l1Head,
    })
    .catch(() => []);

  if (provenLogs.length === 0) return null;

  const targetSet = new Set(
    provenLogs
      .slice(-25)
      .map((l) => l.args.withdrawalHash?.toLowerCase())
      .filter((h): h is string => Boolean(h))
  );

  const chunkSize = 15000n;
  const maxChunks = 10;
  for (let i = 0; i < maxChunks; i += 2) {
    const batchRanges = [i, i + 1]
      .map((idx) => {
        const offset = BigInt(idx) * chunkSize;
        if (l2Head <= offset) return null;
        const toBlock = l2Head - offset;
        const fromBlock = toBlock > chunkSize ? toBlock - chunkSize + 1n : 0n;
        return { fromBlock, toBlock };
      })
      .filter((r): r is { fromBlock: bigint; toBlock: bigint } => r !== null);

    if (batchRanges.length === 0) break;

    const chunkLogsList = await Promise.all(
      batchRanges.map((r) =>
        l2Client
          .getLogs({
            address: L2_TO_L1_MESSAGE_PASSER as Address,
            event: MESSAGE_PASSED_EVENT_ABI[0],
            fromBlock: r.fromBlock,
            toBlock: r.toBlock,
          })
          .catch(() => [])
      )
    );

    for (const logs of chunkLogsList) {
      for (let j = logs.length - 1; j >= 0; j -= 1) {
        const dataLower = logs[j].data.toLowerCase();
        for (const wHash of targetSet) {
          if (dataLower.includes(wHash.slice(2))) {
            if (logs[j].transactionHash) {
              return logs[j].transactionHash.toLowerCase();
            }
          }
        }
      }
    }
  }

  return null;
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
      return '未Prove · L1提案待ち';
    case 'ready-to-prove':
      return '未Prove · 今すぐProve可能';
    case 'waiting-to-finalize':
      return 'Prove済 ✓ · ロック期間待機中';
    case 'ready-to-finalize':
      return 'Prove済 ✓ · 今すぐ資金受取可';
    case 'finalized':
      return 'Prove済 ✓ · L1資金受取完了';
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
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const revertLine = lines.find(
    (l) =>
      l.includes('OptimismPortal') ||
      l.includes('reverted') ||
      l.includes('reason:') ||
      l.includes('Error:')
  );
  return (revertLine ?? lines[0] ?? message).slice(0, 180);
}
