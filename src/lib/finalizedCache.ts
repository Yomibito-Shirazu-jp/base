import {
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  NetworkId,
  VerifiedTransactionResult,
} from '../types/finality';

const FINALIZED_TX_CACHE_KEY = 'base-finality-tx-cache-v1';
const MAX_CACHED_TXS = 2000;
const MESSAGE_PASSER_LOWER = '0x4200000000000000000000000000000000000016';
const MESSAGE_PASSED_TOPIC0 =
  '0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054';

interface CachedFinalizedEntry {
  cachedAt: number;
  result: VerifiedTransactionResult;
}

type FinalizedCacheStore = Record<string, CachedFinalizedEntry>;

function makeCacheKey(networkId: NetworkId, chainId: number, hash: string): string {
  const scope = networkId === 'custom' ? `custom-${chainId}` : networkId;
  return `${scope}:${hash.toLowerCase()}`;
}

export function hasWithdrawalIndicator(r: VerifiedTransactionResult): boolean {
  const rawLogs = r.rawReceipt?.logs;
  const hasMessagePassedInLogs = rawLogs
    ? rawLogs.some(
        (l) =>
          l.address?.toLowerCase() === MESSAGE_PASSER_LOWER &&
          (!Array.isArray(l.topics) ||
            l.topics.length === 0 ||
            l.topics[0]?.toLowerCase() === MESSAGE_PASSED_TOPIC0)
      )
    : null;

  // If rawReceipt logs are present and contain NO MessagePassed log (e.g. L2ToL1MessagePasser.burn()),
  // and no decoded withdrawal object exists, it is definitively NOT a withdrawal.
  if (hasMessagePassedInLogs === false && !r.withdrawal) {
    return false;
  }

  return Boolean(
    r.withdrawal !== null ||
      r.hasWithdrawalLog === true ||
      hasMessagePassedInLogs === true ||
      r.reliability?.caveat?.includes('L2ToL1MessagePasser') ||
      r.reliability?.caveat?.includes('OptimismPortal2')
  );
}

/**
 * Detects any transaction row where on-chain verification partially failed or is incomplete
 * (e.g., L2 receipt fetched but L1 OptimismPortal2 failed, RPC error, fallback delay used, etc.).
 * Note: Syntax-invalid input tokens (`FinalityStage.INVALID`) are excluded because re-querying RPC cannot fix malformed text.
 */
const L1_CDM_MAINNET_LOWER = '0x866e82a600a1414e583f7f13623f1ac5d58b0afa';

export function isPartiallyFetchedOrBrokenResult(
  r: VerifiedTransactionResult
): boolean {
  if (r.finality === FinalityStage.INVALID) return false;
  if (
    r.finality === FinalityStage.RPC_ERROR ||
    r.finality === FinalityStage.NOT_FOUND
  ) {
    return true;
  }
  if (Boolean(r.errorReason)) return true;
  if (r.reliability?.tier === 'partial') return true;

  if (hasWithdrawalIndicator(r)) {
    if (!r.withdrawal) return true;
    if (!r.withdrawal.validation) return true;
    if (r.withdrawal.usedFallbackDelay) return true;
    // Re-decode legacy rows where L1CrossDomainMessenger payload was not unwrapped (showed "0 Message" & L1CDM as recipient)
    if (
      r.withdrawal.assetType === 'MESSAGE' &&
      r.withdrawal.l1Recipient?.toLowerCase() === L1_CDM_MAINNET_LOWER &&
      r.withdrawal.data &&
      r.withdrawal.data.startsWith('0xd764ad0b')
    ) {
      return true;
    }
    // Re-verify legacy rows that suffered from missing OptimismPortal2.l2Sender stateOverride or pre-3-stage validation
    if (
      !r.withdrawal.portalFinalized &&
      (r.withdrawal.validation.portalTopLevelFinalizePassed === undefined ||
        ((r.withdrawal.validation.recipientBalanceIncreased === false ||
          r.withdrawal.validation.outerPortalRelaySimulated === false) &&
          r.withdrawal.validation.canWithdrawAfterWait === true) ||
        (r.withdrawal.validation.postWaitSimError?.includes('message cannot be replayed') &&
          !r.withdrawal.validation.cdmHops))
    ) {
      return true;
    }
    return false;
  }

  if (
    r.blockNumber !== null &&
    r.l1OriginBlock === null &&
    r.finality === FinalityStage.FINALIZED &&
    r.reliability?.tier !== 'verified_onchain'
  ) {
    return true;
  }

  return false;
}

/**
 * True ONLY when all required on-chain verification fields were cleanly obtained with zero partial failures.
 * Used as the strict gate before persisting records to the database (`verified_txs`).
 */
export function isValidVerifiedResultForDb(r: VerifiedTransactionResult): boolean {
  if (r.finality === FinalityStage.INVALID) return false;
  if (isPartiallyFetchedOrBrokenResult(r)) return false;
  if (
    r.executionStatus === ExecutionStatus.UNKNOWN ||
    r.executionStatus === ExecutionStatus.PENDING
  ) {
    return false;
  }

  if (hasWithdrawalIndicator(r)) {
    return Boolean(
      r.withdrawal &&
        r.withdrawal.validation &&
        !r.withdrawal.usedFallbackDelay
    );
  }

  return (
    r.blockNumber !== null &&
    (r.finality === FinalityStage.FINALIZED ||
      r.finality === FinalityStage.SAFE ||
      r.finality === FinalityStage.UNSAFE)
  );
}

/**
 * True ONLY for 100% immutable records whose state on L2 & L1 can never change again:
 * - Cleanly verified non-withdrawal transactions whose L2 block is `FINALIZED` (`verified_onchain`)
 * - Cleanly verified withdrawal transactions where `OptimismPortal2.finalizedWithdrawals[hash] === true` (`portalFinalized`)
 */
export function isImmutableFinalizedResult(r: VerifiedTransactionResult): boolean {
  if (!isValidVerifiedResultForDb(r)) return false;
  if (r.reliability?.tier !== 'verified_onchain') return false;

  if (hasWithdrawalIndicator(r)) {
    return Boolean(
      r.withdrawal &&
        r.withdrawal.portalFinalized === true &&
        r.withdrawal.validation
    );
  }

  return r.finality === FinalityStage.FINALIZED;
}

function readStore(): FinalizedCacheStore {
  try {
    const raw = localStorage.getItem(FINALIZED_TX_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const rawStore = parsed as FinalizedCacheStore;
    const cleanStore: FinalizedCacheStore = {};
    let evicted = false;

    for (const [k, entry] of Object.entries(rawStore)) {
      if (entry?.result && isImmutableFinalizedResult(entry.result)) {
        cleanStore[k] = entry;
      } else {
        evicted = true;
      }
    }

    if (evicted) {
      writeStore(cleanStore);
    }
    return cleanStore;
  } catch {
    return {};
  }
}

function writeStore(store: FinalizedCacheStore): void {
  try {
    const entries = Object.entries(store);
    if (entries.length > MAX_CACHED_TXS) {
      entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
      const trimmed = Object.fromEntries(entries.slice(0, MAX_CACHED_TXS));
      localStorage.setItem(FINALIZED_TX_CACHE_KEY, JSON.stringify(trimmed));
      return;
    }
    localStorage.setItem(FINALIZED_TX_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage quota errors
  }
}

export function saveFinalizedResultsToCache(
  networkId: NetworkId,
  chainId: number,
  results: VerifiedTransactionResult[]
): number {
  const store = readStore();
  let newlySavedOrUpdated = 0;
  const now = Date.now();

  for (const r of results) {
    if (!isImmutableFinalizedResult(r)) continue;
    const key = makeCacheKey(networkId, chainId, r.hash);
    const compactResult: VerifiedTransactionResult = {
      ...r,
      hasWithdrawalLog: hasWithdrawalIndicator(r),
      rawTx: null,
      rawReceipt: null,
    };
    store[key] = {
      cachedAt: now,
      result: compactResult,
    };
    newlySavedOrUpdated += 1;
  }

  if (newlySavedOrUpdated > 0) {
    writeStore(store);
  }
  return newlySavedOrUpdated;
}

export function lookupFinalizedCache(
  networkId: NetworkId,
  chainId: number,
  hashes: string[],
  latestSnapshot?: ChainHeadSnapshot | null
): {
  cachedMap: Map<string, VerifiedTransactionResult>;
  missingHashes: string[];
} {
  const store = readStore();
  const cachedMap = new Map<string, VerifiedTransactionResult>();
  const missingHashes: string[] = [];

  for (const rawHash of hashes) {
    const hash = rawHash.toLowerCase();
    const key = makeCacheKey(networkId, chainId, hash);
    const entry = store[key];

    if (entry?.result && isImmutableFinalizedResult(entry.result)) {
      const r = entry.result;
      const updatedConfirmations =
        r.blockNumber !== null && latestSnapshot?.latest
          ? Math.max(0, latestSnapshot.latest.number - r.blockNumber)
          : r.confirmations;

      const existingBasis = r.reliability?.basis ?? [
        'オンチェーン検証済みデータ',
      ];
      const cacheTag = '検証済みキャッシュ';
      const basis = existingBasis.includes(cacheTag)
        ? existingBasis
        : [...existingBasis, cacheTag];

      cachedMap.set(hash, {
        ...r,
        confirmations: updatedConfirmations,
        reliability: {
          tier: 'verified_onchain',
          label: r.reliability?.label ?? 'オンチェーン実測確定',
          basis,
          caveat: null,
        },
      });
    } else {
      missingHashes.push(hash);
    }
  }

  return { cachedMap, missingHashes };
}

export function getAllCachedFinalizedResults(
  networkId: NetworkId,
  chainId: number
): VerifiedTransactionResult[] {
  const store = readStore();
  const prefix = `${networkId === 'custom' ? `custom-${chainId}` : networkId}:`;
  const list: VerifiedTransactionResult[] = [];
  for (const [k, entry] of Object.entries(store)) {
    if (k.startsWith(prefix) && entry?.result && isImmutableFinalizedResult(entry.result)) {
      list.push(entry.result);
    }
  }
  return list;
}

export function getFinalizedCacheCount(networkId: NetworkId, chainId: number): number {
  const store = readStore();
  const prefix = `${networkId === 'custom' ? `custom-${chainId}` : networkId}:`;
  let count = 0;
  for (const k of Object.keys(store)) {
    if (k.startsWith(prefix)) count += 1;
  }
  return count;
}

export function clearFinalizedCache(networkId?: NetworkId, chainId?: number): void {
  if (!networkId) {
    try {
      localStorage.removeItem(FINALIZED_TX_CACHE_KEY);
    } catch {
      // Ignore
    }
    return;
  }
  const store = readStore();
  const prefix = `${networkId === 'custom' ? `custom-${chainId ?? 8453}` : networkId}:`;
  for (const k of Object.keys(store)) {
    if (k.startsWith(prefix)) {
      delete store[k];
    }
  }
  writeStore(store);
}
