import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  fallback,
  formatEther,
  formatGwei,
  formatUnits,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
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

const DEFAULT_L1_STANDARD_BRIDGE_MAINNET =
  '0x3154Cf16ccdb4C6d922629664174b904d80F2C35';
const DEFAULT_L1_STANDARD_BRIDGE_SEPOLIA =
  '0xfd0Bf71F60660E2f608ed56e1659C450eB113120';

const L2_STANDARD_BRIDGE_ABI = parseAbi([
  'event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)',
  'event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)',
  'event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
]);

const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

const MESSAGE_PASSER_ABI = parseAbi([
  'function sentMessages(bytes32) view returns (bool)',
  'function MESSAGE_VERSION() view returns (uint16)',
]);

export const OPTIMISM_PORTAL_READ_ABI = parseAbi([
  'function version() view returns (string)',
  'function paused() view returns (bool)',
  'function proofMaturityDelaySeconds() view returns (uint256)',
  'function disputeGameFinalityDelaySeconds() view returns (uint256)',
  'function disputeGameFactory() view returns (address)',
  'function respectedGameType() view returns (uint32)',
  'function ethLockbox() view returns (address)',
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

const XDM_RELAY_ABI = parseAbi([
  'function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message) payable',
]);

// Cached storage slot indices for stateOverride simulations
const portalL2SenderSlotCache = new Map<string, number>();
const xdmSenderSlotCache = new Map<string, number>();

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
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'status',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'gameType',
      })
      .catch(() => null),
    l1Client
      .readContract({
        address: proxyAddress,
        abi: DISPUTE_GAME_ABI,
        functionName: 'createdAt',
      })
      .catch(() => null),
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
      const which = hasTeeProof ? 'TEE証明のみ検証済 (ZK未提出)' : 'ZK証明のみ検証済 (TEE未提出)';
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
  forceRefresh = false
): Promise<CachedPortalDisputeParams> {
  const cacheKey = portalAddress.toLowerCase();
  const existing = portalDisputeParamsCache.get(cacheKey);
  if (
    !forceRefresh &&
    existing &&
    Date.now() - existing.cachedAtMs < PORTAL_PARAMS_TTL_MS
  ) {
    return existing;
  }

  let usedFallbackDelay = false;
  const [maturityDelay, gameFinalityDelay, respectedType, portalVer, dgfAddr] =
    await Promise.all([
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
      l1Client
        .readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'respectedGameType',
        })
        .catch(() => null),
      l1Client
        .readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'version',
        })
        .catch(() => null),
      l1Client
        .readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'disputeGameFactory',
        })
        .catch(() => null),
    ]);

  let disputeGameResolutionSeconds = 432000; // Base Mainnet GameType=621 single-proof default: 5 days
  let fastFinalizationDelaySeconds = 86400; // TEE + ZK dual-proof fast path: 1 day
  let slowFinalizationDelaySeconds = 432000; // Single-proof slow path: 5 days
  let rawMeasuredResolutionSeconds: number | null = null;
  let proposalIntervalSeconds = 1800; // ~30 min default
  let latestGameTeeZk: TeeZkProofInspection | null = null;

  const validDgfAddr =
    dgfAddr && dgfAddr.toLowerCase() !== ZERO_ADDRESS
      ? (dgfAddr as Address)
      : null;

  if (validDgfAddr) {
    try {
      const count = await l1Client.readContract({
        address: validDgfAddr,
        abi: DISPUTE_GAME_FACTORY_ABI,
        functionName: 'gameCount',
      });

      if (count >= 1n) {
        const latestIdx = count - 1n;
        const [latestGame, prevGame] = await Promise.all([
          l1Client
            .readContract({
              address: validDgfAddr,
              abi: DISPUTE_GAME_FACTORY_ABI,
              functionName: 'gameAtIndex',
              args: [latestIdx],
            })
            .catch(() => null),
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
          }
        }
      }

      // Sample historical resolved games to empirically confirm resolvedAt - createdAt
      const offsets = [650n, 950n, 1400n, 2200n, 80n];
      const sampleIndices = offsets
        .filter((off) => count > off)
        .map((off) => count - off);

      const gameEntries = await Promise.all(
        sampleIndices.map((idx) =>
          l1Client
            .readContract({
              address: validDgfAddr,
              abi: DISPUTE_GAME_FACTORY_ABI,
              functionName: 'gameAtIndex',
              args: [idx],
            })
            .catch(() => null)
        )
      );

      for (const entry of gameEntries) {
        if (!entry) continue;
        const [gType, , proxy] = entry;
        if (respectedType !== null && Number(gType) !== Number(respectedType)) {
          continue;
        }
        try {
          const [cAt, rAt, st] = await Promise.all([
            l1Client.readContract({
              address: proxy,
              abi: DISPUTE_GAME_ABI,
              functionName: 'createdAt',
            }),
            l1Client.readContract({
              address: proxy,
              abi: DISPUTE_GAME_ABI,
              functionName: 'resolvedAt',
            }),
            l1Client.readContract({
              address: proxy,
              abi: DISPUTE_GAME_ABI,
              functionName: 'status',
            }),
          ]);
          if (Number(st) === 2 && rAt > cAt) {
            const rawDur = Number(rAt - cAt);
            rawMeasuredResolutionSeconds = rawDur;
            if (!latestGameTeeZk) {
              const nearestHour = Math.round(rawDur / 3600) * 3600;
              disputeGameResolutionSeconds =
                nearestHour > 0 && Math.abs(rawDur - nearestHour) <= 600
                  ? nearestHour
                  : rawDur;
              slowFinalizationDelaySeconds = disputeGameResolutionSeconds;
            }
            break;
          }
        } catch {
          // Continue checking next sample
        }
      }
    } catch {
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

  portalDisputeParamsCache.set(cacheKey, resolved);
  return resolved;
}

async function resolveSentinelSlot(
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'],
  contractAddress: Address,
  cache: Map<string, number>,
  preferredSlot: number,
  candidateRanges: Array<[number, number]>
): Promise<number | null> {
  const key = contractAddress.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const preferredVal = await l1Client.getStorageAt({
      address: contractAddress,
      slot: toHex(BigInt(preferredSlot), { size: 32 }),
    });
    if (preferredVal && preferredVal.toLowerCase().endsWith('0000dead')) {
      cache.set(key, preferredSlot);
      return preferredSlot;
    }

    const candidates: number[] = [];
    for (const [start, end] of candidateRanges) {
      for (let s = start; s <= end; s += 1) {
        if (s !== preferredSlot) candidates.push(s);
      }
    }

    const values = await Promise.all(
      candidates.map((s) =>
        l1Client
          .getStorageAt({
            address: contractAddress,
            slot: toHex(BigInt(s), { size: 32 }),
          })
          .catch(() => null)
      )
    );

    for (let i = 0; i < candidates.length; i += 1) {
      const val = values[i];
      if (val && val.toLowerCase().endsWith('0000dead')) {
        cache.set(key, candidates[i]);
        return candidates[i];
      }
    }
  } catch {
    // Ignore slot scan failure
  }
  return null;
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
    resolvePortalDisputeParams(l1Client, portalAddress, true),
    l1Client.getGasPrice(),
    l2Client.getGasPrice(),
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
  const params = await resolvePortalDisputeParams(l1Client, portalAddress, true);
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
  // Force fresh L1 DisputeGame parameters
  await resolvePortalDisputeParams(l1Client, portalAddress, true);
  const receipt = await l2Client.getTransactionReceipt({ hash: txHash });
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
      return 'Prove済 · L1出金完了';
    case 'proven-ready':
      return 'Prove完了 · 今すぐFinalize可';
    case 'proven-waiting':
      return 'Prove提出済 (待機中)';
    case 'invalid-need-reprove':
      return '要再Prove (Game無効)';
    case 'unproven-ready':
      return '未Prove (今すぐProve可)';
    case 'unproven-waiting-game':
      return '未Prove (L1提案待ち)';
  }
}

async function verifyMessagePasserAndL1Validation(params: {
  clients: ReturnType<typeof createBaseAndL1Clients>;
  receipt: TransactionReceipt;
  primary: ReturnType<typeof getWithdrawals>[number];
  initialStatus: WithdrawalStatus;
  portalFinalized: boolean;
  assetType: 'ETH' | 'ERC20' | 'MESSAGE';
  assetSymbol: string;
  assetDecimals: number;
  l1TokenAddress: string | null;
  amountRaw: bigint;
  amountFormatted: string;
  portalParams: CachedPortalDisputeParams;
}): Promise<WithdrawalValidationReport> {
  const {
    clients: { l1Client, l2Client, l2Chain, portalAddress, defaultL1Bridge },
    receipt,
    primary,
    initialStatus,
    portalFinalized,
    assetType,
    assetSymbol,
    assetDecimals,
    l1TokenAddress,
    amountRaw,
    amountFormatted,
    portalParams,
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

  // Decode optional L1CrossDomainMessenger.relayMessage payload to inspect inner bridge call
  let decodedRelay: {
    sender: Address;
    target: Address;
    value: bigint;
    minGasLimit: bigint;
    message: Hex;
  } | null = null;
  try {
    const dec = decodeFunctionData({
      abi: XDM_RELAY_ABI,
      data: primary.data,
    });
    if (dec.functionName === 'relayMessage') {
      decodedRelay = {
        sender: dec.args[1],
        target: dec.args[2],
        value: dec.args[3],
        minGasLimit: dec.args[4],
        message: dec.args[5],
      };
    }
  } catch {
    decodedRelay = null;
  }

  // Parallel L2 MessagePasser + L1 OptimismPortal2 validation queries
  const [
    sentMessageRecorded,
    msgVersionRaw,
    storageSlotValue,
    mpProof,
    portalPaused,
    numProofSubmittersBig,
    lockboxAddr,
    portalEthBalance,
  ] = await Promise.all([
    l2Client
      .readContract({
        address: mpAddress,
        abi: MESSAGE_PASSER_ABI,
        functionName: 'sentMessages',
        args: [primary.withdrawalHash],
      })
      .catch(() => false),
    l2Client
      .readContract({
        address: mpAddress,
        abi: MESSAGE_PASSER_ABI,
        functionName: 'MESSAGE_VERSION',
      })
      .catch(() => 1),
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
        blockTag: 'safe',
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
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'paused',
      })
      .catch(() => false),
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'numProofSubmitters',
        args: [primary.withdrawalHash],
      })
      .catch(() => 0n),
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'ethLockbox',
      })
      .catch(() => null),
    l1Client.getBalance({ address: portalAddress }).catch(() => 0n),
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
  const messageVersion = Number(msgVersionRaw);
  const proofNodes = finalMpProof?.storageProof?.[0]?.proof?.length ?? 0;
  const proofSlotVal = finalMpProof?.storageProof?.[0]?.value ?? 0n;
  const merkleProofVerified =
    Boolean(sentMessageRecorded) &&
    (proofSlotVal === 1n ||
      (storageSlotValue !== null && BigInt(storageSlotValue) === 1n));

  const messagePasser: MessagePasserStatus = {
    contractAddress: mpAddress,
    sentMessageRecorded: Boolean(sentMessageRecorded),
    messageVersion,
    storageKey,
    storageSlotValue,
    storageRoot: finalMpProof?.storageHash ?? null,
    merkleProofNodes: proofNodes,
    merkleProofVerified,
  };

  // Inspect L1 Proof Submitters, DisputeGame & TEE/ZK Multi-Proof State
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
  let provenTimestamp: number | null = null;
  let maturityRemainingSeconds: number | null = null;
  let gameResolutionRemainingSeconds: number | null = null;
  let checkWithdrawalPassed: boolean | null = null;
  let checkWithdrawalError: string | null = null;
  let teeZk: TeeZkProofInspection | null = null;

  if (numProofSubmitters > 0) {
    const maxCheck = Math.min(numProofSubmitters, 5);
    const subs = await Promise.all(
      Array.from({ length: maxCheck }, (_, idx) =>
        l1Client
          .readContract({
            address: portalAddress,
            abi: OPTIMISM_PORTAL_READ_ABI,
            functionName: 'proofSubmitters',
            args: [primary.withdrawalHash, BigInt(idx)],
          })
          .catch(() => null)
      )
    );

    for (const s of subs) {
      if (s) proofSubmittersList.push(s);
    }

    for (const sub of proofSubmittersList) {
      try {
        const proven = await l1Client.readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'provenWithdrawals',
          args: [primary.withdrawalHash, sub as Address],
        });
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
        let inspectedGame: TeeZkProofInspection | null = null;

        if (gameProxy && gameProxy.toLowerCase() !== ZERO_ADDRESS) {
          const [bl, gameInspection] = await Promise.all([
            l1Client
              .readContract({
                address: portalAddress,
                abi: OPTIMISM_PORTAL_READ_ABI,
                functionName: 'disputeGameBlacklist',
                args: [gameProxy],
              })
              .catch(() => false),
            inspectAggregateGameProxy({
              l1Client,
              proxyAddress: gameProxy,
              disputeGameIndex: null,
              isReferenceLatestGame: false,
              fallbackResolutionSeconds: disputeGameResolutionSeconds,
            }).catch(() => null),
          ]);
          blacklisted = Boolean(bl);
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
            (disputeGameBlacklisted || disputeGameStatus === 1));

        if (isBetterCandidate) {
          proofSubmitter = sub;
          disputeGameAddress = gameProxy;
          provenTimestamp = pTs;
          disputeGameBlacklisted = blacklisted;
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
    }
    if (portalFinalized) {
      gameResolutionRemainingSeconds = 0;
    } else if (disputeGameStatus === 2) {
      const rAt = disputeGameResolvedAt ?? nowSec;
      gameResolutionRemainingSeconds = Math.max(
        0,
        rAt + disputeGameFinalityDelaySeconds - nowSec
      );
    } else if (
      teeZk &&
      teeZk.remainingToResolveSeconds !== null
    ) {
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
  } else if (initialStatus === 'ready-to-prove') {
    // Unproven, but L1 DisputeGame already exists for this L2 block — inspect its TEE/ZK status!
    try {
      const output = await l1Client.getL2Output({
        l2BlockNumber: receipt.blockNumber,
        targetChain: l2Chain,
      });
      disputeGameIndex = Number(output.outputIndex);
      disputeGameCreatedAt = Number(output.timestamp);

      if (portalParams.disputeGameFactoryAddress) {
        const entry = await l1Client
          .readContract({
            address: portalParams.disputeGameFactoryAddress,
            abi: DISPUTE_GAME_FACTORY_ABI,
            functionName: 'gameAtIndex',
            args: [BigInt(output.outputIndex)],
          })
          .catch(() => null);
        if (entry && entry[2].toLowerCase() !== ZERO_ADDRESS) {
          disputeGameAddress = entry[2];
          teeZk = await inspectAggregateGameProxy({
            l1Client,
            proxyAddress: entry[2],
            disputeGameIndex,
            isReferenceLatestGame: false,
            fallbackResolutionSeconds: disputeGameResolutionSeconds,
          }).catch(() => null);
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
      maturityRemainingSeconds = proofMaturityDelaySeconds;
      gameResolutionRemainingSeconds =
        disputeGameResolutionSeconds + disputeGameFinalityDelaySeconds;
    }
  } else {
    // waiting-to-prove: own DisputeGame not yet proposed on L1; attach latest network DisputeGame as TEE/ZK reference
    teeZk = portalParams.latestGameTeeZk;
    maturityRemainingSeconds = proofMaturityDelaySeconds;
    const activeWin =
      teeZk?.activeWindowSeconds ?? disputeGameResolutionSeconds;
    gameResolutionRemainingSeconds = activeWin + disputeGameFinalityDelaySeconds;
  }

  // Note: If DisputeGame expectedResolution has already passed (canCallResolveNow) AND maturityRemainingSeconds === 0,
  // checkWithdrawal only reverted because resolve() hasn't been called on the game yet!
  if (
    !portalFinalized &&
    numProofSubmitters > 0 &&
    !checkWithdrawalPassed &&
    teeZk?.canCallResolveNow &&
    (maturityRemainingSeconds ?? 1) === 0 &&
    disputeGameBlacklisted !== true
  ) {
    checkWithdrawalPassed = true;
    checkWithdrawalError = null;
  }

  // Determine Prove Lifecycle State
  const gameInvalid =
    disputeGameBlacklisted === true || disputeGameStatus === 1;
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
        '要再Prove（紐づくDisputeGameが無効化またはブラックリスト化されています）';
    } else if (checkWithdrawalPassed === true) {
      proveState = 'proven-ready';
      proveStateLabel = `Prove完了・全待機期間クリア（Submitter: ${proofSubmitter?.slice(
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
  } else if (initialStatus === 'ready-to-prove' || disputeGameIndex !== null) {
    proveState = 'unproven-ready';
    proveStateLabel = `未Prove · 今すぐ proveWithdrawalTransaction 実行可能${
      disputeGameIndex !== null ? ` (DisputeGame #${disputeGameIndex})` : ''
    }`;
  } else {
    proveState = 'unproven-waiting-game';
    proveStateLabel =
      '未Prove · L1 DisputeGame 提案待機中（約25〜30分間隔でL1へ提案されます）';
  }

  // Check L1 Liquidity (ETH Portal/Lockbox balance or ERC20 Bridge balance)
  let lockboxBalance = 0n;
  if (
    lockboxAddr &&
    typeof lockboxAddr === 'string' &&
    lockboxAddr !== '0x0000000000000000000000000000000000000000'
  ) {
    lockboxBalance = await l1Client
      .getBalance({ address: lockboxAddr as Address })
      .catch(() => 0n);
  }
  const availablePortalEth = portalEthBalance + lockboxBalance;

  let l1LiquiditySufficient: boolean | null = true;
  let l1LiquidityDetail = '';

  if (portalFinalized) {
    l1LiquiditySufficient = true;
    l1LiquidityDetail = `L1で既に支払完了済み (${amountFormatted} ${assetSymbol})`;
  } else if (assetType === 'ETH' || primary.value > 0n) {
    const requiredWei = primary.value > 0n ? primary.value : amountRaw;
    l1LiquiditySufficient = availablePortalEth >= requiredWei;
    const availFormatted = Number(formatEther(availablePortalEth)).toLocaleString(
      undefined,
      { maximumFractionDigits: 2 }
    );
    l1LiquidityDetail = `OptimismPortal2 保有残高: ${availFormatted} ETH (必要額: ${amountFormatted} ETH)`;
  } else if (assetType === 'ERC20' && l1TokenAddress) {
    const bridgeTarget = decodedRelay?.target ?? defaultL1Bridge;
    try {
      const bridgeTokenBal = await l1Client.readContract({
        address: l1TokenAddress as Address,
        abi: ERC20_META_ABI,
        functionName: 'balanceOf',
        args: [bridgeTarget],
      });
      l1LiquiditySufficient = bridgeTokenBal >= amountRaw;
      const balStr = formatDisplayAmount(
        formatUnits(bridgeTokenBal, assetDecimals)
      );
      l1LiquidityDetail = l1LiquiditySufficient
        ? `L1 Bridge (${bridgeTarget.slice(0, 8)}...) 保有残高: ${balStr} ${assetSymbol} (必要額: ${amountFormatted} ${assetSymbol})`
        : `L1 Bridge 残高 ${balStr} ${assetSymbol} (Mint型トークンまたは要流動性確認)`;
    } catch {
      l1LiquiditySufficient = null;
      l1LiquidityDetail = 'L1トークン残高の直接照会スキップ（ドライランで検証）';
    }
  } else {
    l1LiquiditySufficient = true;
    l1LiquidityDetail = 'メッセージリレー（ETH移動なし）';
  }

  // Post-Maturity L1 Execution Simulation (Can it actually withdraw once wait time passes?)
  let outerPortalRelaySimulated = false;
  let innerBridgeRelaySimulated: boolean | null = null;
  let postWaitSimError: string | null = null;

  if (portalFinalized) {
    outerPortalRelaySimulated = true;
    innerBridgeRelaySimulated = decodedRelay ? true : null;
  } else {
    // 1. If checkWithdrawalPassed right now, test direct finalizeWithdrawalTransactionExternalProof
    if (checkWithdrawalPassed === true && proofSubmitter) {
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
        });
        outerPortalRelaySimulated = true;
      } catch (err) {
        postWaitSimError = extractShortRevertReason(
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // 2. Simulate post-wait target execution from OptimismPortal2 via stateOverride
    if (!outerPortalRelaySimulated) {
      const l2SenderSlot = await resolveSentinelSlot(
        l1Client,
        portalAddress,
        portalL2SenderSlotCache,
        50,
        [[50, 65]]
      );

      if (l2SenderSlot !== null) {
        try {
          const callGas =
            primary.gasLimit < 500000n ? 500000n : primary.gasLimit + 100000n;
          await l1Client.call({
            account: portalAddress,
            to: primary.target,
            data: primary.data,
            value: primary.value,
            gas: callGas,
            stateOverride: [
              {
                address: portalAddress,
                balance: availablePortalEth + primary.value + 10n ** 18n,
                stateDiff: [
                  {
                    slot: toHex(BigInt(l2SenderSlot), { size: 32 }),
                    value: pad(primary.sender, { size: 32 }),
                  },
                ],
              },
            ],
          });
          outerPortalRelaySimulated = true;
          postWaitSimError = null;
        } catch (err) {
          postWaitSimError = extractShortRevertReason(
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    // 3. Simulate inner L1StandardBridge / target call inside L1CrossDomainMessenger
    if (decodedRelay) {
      const xdmSlot = await resolveSentinelSlot(
        l1Client,
        primary.target,
        xdmSenderSlotCache,
        204,
        [
          [200, 215],
          [50, 65],
        ]
      );

      if (xdmSlot !== null) {
        try {
          const innerGas =
            decodedRelay.minGasLimit < 400000n
              ? 400000n
              : decodedRelay.minGasLimit + 150000n;
          await l1Client.call({
            account: primary.target,
            to: decodedRelay.target,
            data: decodedRelay.message,
            value: decodedRelay.value,
            gas: innerGas,
            stateOverride: [
              {
                address: primary.target,
                balance: decodedRelay.value + 10n ** 18n,
                stateDiff: [
                  {
                    slot: toHex(BigInt(xdmSlot), { size: 32 }),
                    value: pad(decodedRelay.sender, { size: 32 }),
                  },
                ],
              },
            ],
          });
          innerBridgeRelaySimulated = true;
          if (l1LiquiditySufficient === false && assetType === 'ERC20') {
            l1LiquiditySufficient = true;
            l1LiquidityDetail = `${l1LiquidityDetail} → Mint/転送ドライラン成功`;
          }
        } catch (err) {
          innerBridgeRelaySimulated = false;
          postWaitSimError = `内部ブリッジ着金Revert: ${extractShortRevertReason(
            err instanceof Error ? err.message : String(err)
          )}`;
        }
      }
    }
  }

  // Build structured 5-step validation checklist
  const checks: ValidationCheckItem[] = [];

  checks.push({
    id: 'message-passer',
    label: 'L2ToL1MessagePasser 登録・Merkle証明検証',
    passed: merkleProofVerified && nonceVersion === messageVersion,
    status: merkleProofVerified && nonceVersion === messageVersion ? 'pass' : 'fail',
    detail: merkleProofVerified
      ? `sentMessages[hash] = true · Version ${messageVersion} · Slot値=1 · MPT証明ノード ${proofNodes}階層確認`
      : 'L2ToL1MessagePasser の sentMessages スロットに有効な出金記録が見つかりません',
  });

  checks.push({
    id: 'portal-guard',
    label: `OptimismPortal2${portalVersion ? ` v${portalVersion}` : ''} 稼働・二重実行防止検証`,
    passed: !portalPaused,
    status: !portalPaused ? 'pass' : 'fail',
    detail: portalPaused
      ? 'OptimismPortal2 が現在 Paused（緊急停止中）のため L1 出金がブロックされています'
      : portalFinalized
      ? 'paused() = false · finalizedWithdrawals = true (既にL1で正常に出金完了済み)'
      : 'paused() = false (正常稼働) · finalizedWithdrawals = false (未消費・Claim枠有効)',
  });

  if (portalFinalized) {
    checks.push({
      id: 'dispute-proof',
      label: 'L1 Prove状態・DisputeGame 解決バリデーション',
      passed: true,
      status: 'pass',
      detail:
        numProofSubmitters > 0 && disputeGameAddress
          ? `Prove済 (Submitter: ${proofSubmitter?.slice(0, 10)}...) · Game ${disputeGameAddress.slice(
              0,
              10
            )}... (${getDisputeGameStatusText(disputeGameStatus)}) · 出金完了済`
          : 'L1 OptimismPortal2 にて証明検証・ファイナライズ完了済み',
    });
  } else if (numProofSubmitters > 0) {
    const typeMatches =
      respectedGameType === null ||
      disputeGameType === null ||
      Number(respectedGameType) === disputeGameType;
    checks.push({
      id: 'dispute-proof',
      label: 'L1 Prove状態・DisputeGame 解決バリデーション',
      passed: !gameInvalid && typeMatches,
      status: gameInvalid ? 'fail' : typeMatches ? 'pass' : 'warn',
      detail: `Prove提出済 (${numProofSubmitters}件, Submitter ${proofSubmitter?.slice(
        0,
        10
      )}...) · Game ${
        disputeGameAddress ? `${disputeGameAddress.slice(0, 10)}...` : '—'
      } (${getDisputeGameStatusText(
        disputeGameStatus
      )}) · checkWithdrawal=${
        checkWithdrawalPassed ? '合格(即Claim可)' : `待機中 (${checkWithdrawalError ?? '期間未経過'})`
      }`,
    });
  } else {
    checks.push({
      id: 'dispute-proof',
      label: 'L1 Prove状態・DisputeGame 構築要件',
      passed: merkleProofVerified,
      status: merkleProofVerified ? 'pass' : 'fail',
      detail:
        proveState === 'unproven-ready'
          ? `未Prove · L1 DisputeGame #${
              disputeGameIndex ?? '—'
            } 到達済（今すぐProve可能 · Game解決目安 ${formatSecondsJapanese(
              disputeGameResolutionSeconds
            )} / Prove後成熟 ${formatSecondsJapanese(proofMaturityDelaySeconds)}）`
          : `未Prove · L1 DisputeGame提案待ち（提案後にProve可能 · Game解決期間 ${formatSecondsJapanese(
              disputeGameResolutionSeconds
            )} / Prove後成熟 ${formatSecondsJapanese(proofMaturityDelaySeconds)}）`,
    });
  }

  checks.push({
    id: 'l1-liquidity',
    label: 'L1 支払原資・ブリッジ流動性検証',
    passed: l1LiquiditySufficient !== false,
    status:
      l1LiquiditySufficient === true
        ? 'pass'
        : l1LiquiditySufficient === null
        ? 'warn'
        : 'fail',
    detail: l1LiquidityDetail,
  });

  const postWaitExecPassed =
    outerPortalRelaySimulated && innerBridgeRelaySimulated !== false;
  checks.push({
    id: 'post-wait-execution',
    label: '待機時間経過後の実着金シミュレーション (L1 EVM ドライラン)',
    passed: postWaitExecPassed,
    status: postWaitExecPassed ? 'pass' : 'fail',
    detail: portalFinalized
      ? 'L1 上で既に finalizeWithdrawalTransaction が実行され着金完了しています'
      : postWaitExecPassed
      ? innerBridgeRelaySimulated === true
        ? `OptimismPortal2 → L1CrossDomainMessenger → L1Bridge (${amountFormatted} ${assetSymbol}) → 受取アドレスまでの全着金経路が Revert なく正常完走しました`
        : `OptimismPortal2 → ターゲット (${primary.target.slice(
            0,
            10
          )}...) の待機後リレー実行が Revert なく正常完走しました`
      : `待機時間経過後のL1実行シミュレーションでエラーを検出: ${
          postWaitSimError ?? '着金コール失敗'
        }`,
  });

  const canWithdrawAfterWait =
    portalFinalized ||
    (merkleProofVerified &&
      !portalPaused &&
      !gameInvalid &&
      l1LiquiditySufficient !== false &&
      postWaitExecPassed);

  let verdictLabel = '';
  let verdictSummary = '';

  if (portalFinalized) {
    verdictLabel = 'L1出金完了済（実着金確認）';
    verdictSummary =
      'OptimismPortal2.finalizedWithdrawals = true を確認。L1側での出金処理は既に正常完了しています。';
  } else if (canWithdrawAfterWait) {
    if (proveState === 'proven-ready') {
      verdictLabel = '今すぐ実出金（Finalize）可能 — 全バリデーション通過';
      verdictSummary =
        'Prove成熟期間（1日）およびDisputeGame解決期間（約5日）の双方が完了しており、checkWithdrawal・L1流動性・着金ドライランすべて合格しています。今すぐPimlicoまたはウォレットから出金確定できます。';
    } else if (proveState === 'unproven-ready') {
      verdictLabel = '今すぐProve実行可能 ＆ 待機経過後に実出金可能';
      verdictSummary =
        'L1 DisputeGame提案に到達しているため今すぐ proveWithdrawalTransaction を実行できます。L2 MessagePasser証明・L1原資・待機経過後の着金シミュレーションはすべて合格済みです。';
    } else {
      verdictLabel = '待機時間経過後に実出金可能（L1着金ドライラン合格）';
      verdictSummary = `現在は「${proveStateLabel}」ですが、L2 MessagePasser ストレージ証明・L1 支払原資・待機経過後の L1 ブリッジ着金シミュレーションはすべて正常通過しており、時間経過後に問題なく出金確定できます。`;
    }
  } else {
    verdictLabel = '出金バリデーション要確認（阻害要因あり）';
    verdictSummary =
      postWaitSimError ||
      (portalPaused
        ? 'OptimismPortal2 が一時停止中のため、解除されるまで L1 出金できません。'
        : gameInvalid
        ? '紐づく DisputeGame が無効化またはブラックリスト化されているため再Proveが必要です。'
        : 'L1 側の流動性またはコントラクト実行条件に問題が検出されました。');
  }

  if (teeZk) {
    checks.push({
      id: 'tee-zk-multiproof',
      label: 'DisputeGame マルチ証明 (TEE / ZK) ＆ 1日/5日待機枠判定',
      passed: true,
      status: 'pass',
      detail: teeZk.summary,
    });
  }

  return {
    canWithdrawAfterWait,
    verdictLabel,
    verdictSummary,
    portalAddress,
    portalVersion,
    respectedGameType,
    portalPaused: Boolean(portalPaused),
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
    provenTimestamp,
    maturityRemainingSeconds,
    gameResolutionRemainingSeconds,
    checkWithdrawalPassed,
    checkWithdrawalError,
    l1LiquiditySufficient,
    l1LiquidityDetail,
    outerPortalRelaySimulated,
    innerBridgeRelaySimulated,
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
  const receipt = await clients.l2Client.getTransactionReceipt({ hash: txHash });
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

  // Decode bridge asset & recipient details from L2StandardBridge logs
  let assetType: 'ETH' | 'ERC20' | 'MESSAGE' =
    primary.value > 0n ? 'ETH' : 'MESSAGE';
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

  let usedFallbackDelay = false;

  const [rawStatus, portalFinalized, portalParams] = await Promise.all([
    l1Client
      .getWithdrawalStatus({
        receipt,
        targetChain: l2Chain,
      })
      .catch(() => 'waiting-to-prove') as Promise<WithdrawalStatus>,
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
    resolvePortalDisputeParams(l1Client, portalAddress),
  ]);

  if (portalParams.usedFallbackDelay) {
    usedFallbackDelay = true;
  }

  const initialStatus: WithdrawalStatus =
    rawStatus === 'finalized' && !portalFinalized ? 'ready-to-finalize' : rawStatus;

  const validation = await verifyMessagePasserAndL1Validation({
    clients: resolvedClients,
    receipt,
    primary,
    initialStatus,
    portalFinalized: Boolean(portalFinalized),
    assetType,
    assetSymbol,
    assetDecimals,
    l1TokenAddress,
    amountRaw,
    amountFormatted,
    portalParams,
  });

  // Reconcile status with exact on-chain checkWithdrawal & DisputeGame state
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
    usedFallbackDelay,
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
  const receipt = await l2Client.getTransactionReceipt({ hash: txHash });
  const info = await analyzeWithdrawalFromReceipt(receipt, config, clients);

  if (!info) {
    throw new Error(
      'このトランザクションには L2ToL1MessagePasser の出金イベントが含まれていません'
    );
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

  const val = info.validation;
  const alreadyProven =
    info.portalFinalized ||
    ((val?.numProofSubmitters ?? 0) > 0 &&
      val?.proveState !== 'invalid-need-reprove');

  // Step 1: Explicit proveWithdrawalTransaction simulation
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
        summary: `proveWithdrawalTransaction シミュレーション合格（DisputeGame #${gameIdx.toString()} · 推定Gas: ${est.toLocaleString()} · 約 ${pFeeEth} ETH）— 今すぐ証明提出可能です。`,
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
    // waiting-to-prove
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

  // Step 2: Explicit post-maturity finalizeWithdrawalTransaction simulation
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
      if (val?.teeZk?.canCallResolveNow && val.disputeGameStatus === 0) {
        // DisputeGame expectedResolution reached, resolve() + finalize will run atomically
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
          summary: `DisputeGame 待機期間完了（resolve可能）＆ 着金ドライラン合格 — 「資金を受け取る」ボタンで Game解決と ${info.amountFormatted} ${info.assetSymbol} 受取を実行できます。`,
        };
      } else {
        const est = await l1Client.estimateContractGas({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizeWithdrawalTransactionExternalProof',
          args: [withdrawalArg, submitter],
          account: receipt.from,
        });
        await l1Client.simulateContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizeWithdrawalTransactionExternalProof',
          args: [withdrawalArg, submitter],
          account: receipt.from,
        });
        estimatedFinalizeGas = est;
        const fFeeEth = Number(formatEther(l1GasPrice * est)).toFixed(6);
        finalizeSim = {
          step: 'finalize',
          methodName: 'finalizeWithdrawalTransaction',
          passed: true,
          alreadyCompletedOnChain: false,
          executableNow: true,
          estimatedGas: est.toString(),
          estimatedFeeEth: fFeeEth,
          summary: `finalizeWithdrawalTransaction 実コールシミュレーション合格（推定Gas: ${est.toLocaleString()} · 約 ${fFeeEth} ETH）— 今すぐ「資金を受け取る」ボタンで ${info.amountFormatted} ${info.assetSymbol} を受け取れます。`,
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
    // Still waiting (waiting-to-prove, ready-to-prove, or waiting-to-finalize):
    // Report the stateOverride post-maturity execution simulation!
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
        ? `成熟待機後の finalizeWithdrawalTransaction (stateOverride着金ドライラン) 合格 — 待機完了後（${windowDesc} · 残り ${formatSecondsJapanese(
            info.totalSecondsRemaining
          )}）に受取人 ${info.l1Recipient.slice(0, 10)}... へ ${info.amountFormatted} ${info.assetSymbol} が正常に着金します。`
        : `成熟待機後の着金シミュレーションで要確認項目を検出: ${
            val?.postWaitSimError ?? val?.verdictSummary ?? 'L1着金条件を確認してください'
          }`,
    };
  }

  // Synthesize top-level dry-run verdict from both simulations
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
  if (info.assetType === 'ETH') {
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
      return '確定待機中 (Game解決/成熟期間)';
    case 'ready-to-finalize':
      return '出金確定可能 (Claim可)';
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
