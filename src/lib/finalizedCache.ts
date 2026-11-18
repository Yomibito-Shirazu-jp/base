import {
  ChainHeadSnapshot,
  FinalityStage,
  NetworkId,
  VerifiedTransactionResult,
} from '../types/finality';

const FINALIZED_TX_CACHE_KEY = 'base-finality-tx-cache-v1';
const MAX_CACHED_TXS = 2000;

interface CachedFinalizedEntry {
  cachedAt: number;
  result: VerifiedTransactionResult;
}

type FinalizedCacheStore = Record<string, CachedFinalizedEntry>;

function makeCacheKey(networkId: NetworkId, chainId: number, hash: string): string {
  const scope = networkId === 'custom' ? `custom-${chainId}` : networkId;
  return `${scope}:${hash.toLowerCase()}`;
}

function readStore(): FinalizedCacheStore {
  try {
    const raw = localStorage.getItem(FINALIZED_TX_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as FinalizedCacheStore;
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

/**
 * Only transactions whose L2 finality is FINALIZED AND have no mutable L1 unclaimed withdrawal
 * can be safely served from immutable local cache without refetching.
 */
export function isImmutableFinalizedResult(r: VerifiedTransactionResult): boolean {
  if (r.finality !== FinalityStage.FINALIZED) return false;
  if (r.withdrawal && (!r.withdrawal.portalFinalized || !r.withdrawal.validation)) {
    return false;
  }
  return true;
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
        'L2 Receipt & Tx',
        'L2 Finalized Head',
      ];
      const cacheTag = 'ローカル保存済み Finalized キャッシュ';
      const basis = existingBasis.includes(cacheTag)
        ? existingBasis
        : [...existingBasis, cacheTag];

      cachedMap.set(hash, {
        ...r,
        confirmations: updatedConfirmations,
        reliability: {
          tier: r.reliability?.tier ?? 'verified_onchain',
          label: r.reliability?.label ?? 'オンチェーン実測確定',
          basis,
          caveat: r.reliability?.caveat ?? null,
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
