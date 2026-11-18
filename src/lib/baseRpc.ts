import type { Hex } from 'viem';
import {
  BlockHeadInfo,
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  NetworkConfig,
  NetworkId,
  ParsedHashBatch,
  RawReceiptData,
  RawTxData,
  ReliabilityInfo,
  VerifiedTransactionResult,
} from '../types/finality';
import {
  L2_TO_L1_MESSAGE_PASSER,
  analyzeWithdrawalFromTxHash,
} from './withdrawalAnalyzer';

export const NETWORK_PRESETS: Record<Exclude<NetworkId, 'custom'>, NetworkConfig> = {
  'base-mainnet': {
    id: 'base-mainnet',
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrls: ['/api/rpc/base-mainnet', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    l1RpcUrls: ['/api/rpc/eth-mainnet', 'https://ethereum-rpc.publicnode.com'],
    explorerUrl: 'https://basescan.org',
    l1ExplorerUrl: 'https://etherscan.io',
  },
  'base-sepolia': {
    id: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrls: ['/api/rpc/base-sepolia', 'https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
    l1RpcUrls: ['/api/rpc/eth-sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'],
    explorerUrl: 'https://sepolia.basescan.org',
    l1ExplorerUrl: 'https://sepolia.etherscan.io',
  },
};

// OP Stack L1Block predeploy address on Base
const L1_BLOCK_PREDEPLOY = '0x4200000000000000000000000000000000000015';
// Function selectors on L1Block: number() and timestamp()
const L1_BLOCK_NUMBER_SELECTOR = '0x8381f58a';
const L1_BLOCK_TIMESTAMP_SELECTOR = '0xb80777ea';

const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH_EXTRACT_REGEX = /0x[0-9a-fA-F]{64}/g;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface RpcBlock {
  number: string;
  hash: string;
  timestamp: string;
  transactions?: Array<string | RawTxData>;
}

const NON_TX_HASH_KEYS = new Set([
  'blockhash',
  'parenthash',
  'stateroot',
  'transactionsroot',
  'receiptsroot',
  'parentbeaconblockroot',
  'mixhash',
  'sha3uncles',
  'withdrawalsroot',
  'logsbloom',
  'input',
  'data',
  'chainheads',
]);

const PREFERRED_TX_HASH_KEYS = new Set([
  'txhash',
  'tx_hash',
  'transactionhash',
  'transaction_hash',
  'hash',
]);

function collectHashesFromJsonValue(
  value: unknown,
  parentKey: string | null,
  onHashFound: (hash: string) => void
): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    const keyLower = parentKey?.toLowerCase() ?? '';
    if (keyLower && NON_TX_HASH_KEYS.has(keyLower)) {
      return;
    }
    const matches = value.match(TX_HASH_EXTRACT_REGEX);
    if (matches) {
      for (const m of matches) {
        onHashFound(m.toLowerCase());
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHashesFromJsonValue(item, parentKey, onHashFound);
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keyLower = parentKey?.toLowerCase() ?? '';

    // Skip chainHeads metadata block objects (latest / safe / finalized)
    if (keyLower === 'chainheads') {
      return;
    }

    // If this object looks like a block header containing a `transactions` array, skip its block `hash`
    if (Array.isArray(obj.transactions) && ('number' in obj || 'parentHash' in obj)) {
      collectHashesFromJsonValue(obj.transactions, 'transactions', onHashFound);
      return;
    }

    // If the object has explicit tx hash properties, prefer them and avoid picking up sibling blockHash/etc.
    let foundPreferred = false;
    for (const [k, v] of Object.entries(obj)) {
      if (PREFERRED_TX_HASH_KEYS.has(k.toLowerCase()) && typeof v === 'string' && TX_HASH_REGEX.test(v.trim())) {
        onHashFound(v.trim().toLowerCase());
        foundPreferred = true;
      }
    }

    if (foundPreferred) {
      return;
    }

    for (const [k, v] of Object.entries(obj)) {
      if (NON_TX_HASH_KEYS.has(k.toLowerCase())) continue;
      collectHashesFromJsonValue(v, k, onHashFound);
    }
  }
}

export function parseTxHashes(rawInput: string): ParsedHashBatch {
  const seen = new Set<string>();
  const seenInvalid = new Set<string>();
  const validHashes: string[] = [];
  const invalidTokens: string[] = [];
  let duplicateCount = 0;

  const pushValid = (hash: string) => {
    const normalized = hash.toLowerCase();
    if (seen.has(normalized)) {
      duplicateCount += 1;
    } else {
      seen.add(normalized);
      validHashes.push(normalized);
    }
  };

  const trimmed = rawInput.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsedJson = JSON.parse(trimmed) as unknown;
      let totalFound = 0;
      collectHashesFromJsonValue(parsedJson, null, (hash) => {
        totalFound += 1;
        pushValid(hash);
      });
      return {
        validHashes,
        invalidTokens: [],
        duplicateCount,
        totalLinesOrTokens: totalFound,
      };
    } catch {
      // Fall through to line/token parsing if not strictly valid JSON
    }
  }

  const lines = rawInput
    .split(/[\r\n,;|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const token of lines) {
    // Check if token itself is a valid 32-byte hash
    if (TX_HASH_REGEX.test(token)) {
      pushValid(token);
      continue;
    }

    // Try extracting hashes from explorer URLs or JSON/CSV fragments
    const matches = token.match(TX_HASH_EXTRACT_REGEX);
    if (matches && matches.length > 0) {
      for (const m of matches) {
        pushValid(m);
      }
      continue;
    }

    // Ignore obvious CSV header names like "tx_hash" or "transactionHash"
    const lower = token.toLowerCase();
    if (
      lower === 'txhash' ||
      lower === 'tx_hash' ||
      lower === 'transactionhash' ||
      lower === 'transaction_hash' ||
      lower === 'hash'
    ) {
      continue;
    }

    if (!seenInvalid.has(token)) {
      seenInvalid.add(token);
      invalidTokens.push(token);
    }
  }

  return {
    validHashes,
    invalidTokens,
    duplicateCount,
    totalLinesOrTokens: lines.length,
  };
}

export function hexToNumber(hex: string | null | undefined): number | null {
  if (!hex || hex === '0x') return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatWeiToEth(wei: bigint, maxDecimals = 8): string {
  if (wei === 0n) return '0';
  const negative = wei < 0n;
  const absWei = negative ? -wei : wei;
  const divisor = 10n ** 18n;
  const whole = absWei / divisor;
  const remainder = absWei % divisor;

  if (remainder === 0n) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  const fracPadded = remainder.toString().padStart(18, '0').slice(0, maxDecimals);
  const fracTrimmed = fracPadded.replace(/0+$/, '');
  if (!fracTrimmed) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }
  return `${negative ? '-' : ''}${whole.toString()}.${fracTrimmed}`;
}

async function postJsonRpcBatch(
  rpcUrls: string[],
  requests: JsonRpcRequest[],
  timeoutMs = 15000
): Promise<{ responses: Map<number, JsonRpcResponse>; endpointUsed: string }> {
  let lastError: Error | null = null;

  for (const url of rpcUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const data = (await response.json()) as JsonRpcResponse[] | JsonRpcResponse;
      const list = Array.isArray(data) ? data : [data];
      const map = new Map<number, JsonRpcResponse>();
      for (const item of list) {
        if (item && typeof item.id === 'number') {
          map.set(item.id, item);
        }
      }

      return { responses: map, endpointUsed: url };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('すべてのRPCエンドポイントへの接続に失敗しました');
}

function parseBlockHead(
  blockRes: JsonRpcResponse<RpcBlock> | undefined,
  l1NumberRes?: JsonRpcResponse<string>,
  l1TimestampRes?: JsonRpcResponse<string>
): BlockHeadInfo | null {
  if (!blockRes || !blockRes.result) return null;
  const num = hexToNumber(blockRes.result.number);
  const ts = hexToNumber(blockRes.result.timestamp);
  if (num === null || ts === null) return null;

  return {
    number: num,
    hash: blockRes.result.hash,
    timestamp: ts,
    l1OriginNumber: l1NumberRes?.result ? hexToNumber(l1NumberRes.result) : null,
    l1OriginTimestamp: l1TimestampRes?.result ? hexToNumber(l1TimestampRes.result) : null,
  };
}

export async function fetchChainHeadSnapshot(
  config: NetworkConfig
): Promise<ChainHeadSnapshot> {
  const requests: JsonRpcRequest[] = [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: ['safe', false] },
    { jsonrpc: '2.0', id: 4, method: 'eth_getBlockByNumber', params: ['finalized', false] },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'eth_call',
      params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_NUMBER_SELECTOR }, 'latest'],
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'eth_call',
      params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_TIMESTAMP_SELECTOR }, 'latest'],
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'eth_call',
      params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_NUMBER_SELECTOR }, 'finalized'],
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'eth_call',
      params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_TIMESTAMP_SELECTOR }, 'finalized'],
    },
  ];

  const l2Promise = postJsonRpcBatch(config.rpcUrls, requests);

  const l1Promise =
    config.l1RpcUrls.length > 0
      ? postJsonRpcBatch(
          config.l1RpcUrls,
          [
            { jsonrpc: '2.0', id: 101, method: 'eth_getBlockByNumber', params: ['latest', false] },
            { jsonrpc: '2.0', id: 102, method: 'eth_getBlockByNumber', params: ['finalized', false] },
          ],
          10000
        ).catch(() => null)
      : Promise.resolve(null);

  const [{ responses, endpointUsed }, l1Result] = await Promise.all([l2Promise, l1Promise]);

  const chainIdRes = responses.get(1) as JsonRpcResponse<string> | undefined;
  const chainId = chainIdRes?.result ? hexToNumber(chainIdRes.result) : config.chainId;

  const latest = parseBlockHead(
    responses.get(2) as JsonRpcResponse<RpcBlock> | undefined,
    responses.get(5) as JsonRpcResponse<string> | undefined,
    responses.get(6) as JsonRpcResponse<string> | undefined
  );
  const safe = parseBlockHead(responses.get(3) as JsonRpcResponse<RpcBlock> | undefined);
  const finalized = parseBlockHead(
    responses.get(4) as JsonRpcResponse<RpcBlock> | undefined,
    responses.get(7) as JsonRpcResponse<string> | undefined,
    responses.get(8) as JsonRpcResponse<string> | undefined
  );

  let l1LatestNumber: number | null = null;
  let l1FinalizedNumber: number | null = null;
  let l1Endpoint: string | null = null;

  if (l1Result) {
    l1Endpoint = l1Result.endpointUsed;
    const l1LatestBlock = l1Result.responses.get(101) as JsonRpcResponse<RpcBlock> | undefined;
    const l1FinalizedBlock = l1Result.responses.get(102) as JsonRpcResponse<RpcBlock> | undefined;
    l1LatestNumber = l1LatestBlock?.result ? hexToNumber(l1LatestBlock.result.number) : null;
    l1FinalizedNumber = l1FinalizedBlock?.result
      ? hexToNumber(l1FinalizedBlock.result.number)
      : null;
  }

  const isProxyPath = endpointUsed.startsWith('/api/rpc/');
  let isServerProxy = isProxyPath;
  if (isProxyPath) {
    try {
      const statusRes = await fetch('/api/rpc/status');
      if (statusRes.ok) {
        const statusJson = (await statusRes.json()) as {
          baseMainnetConfigured?: boolean;
          ethMainnetConfigured?: boolean;
        };
        if (config.id === 'base-mainnet') {
          isServerProxy = Boolean(statusJson.baseMainnetConfigured);
        }
      }
    } catch {
      // Keep default isProxyPath boolean
    }
  }

  return {
    networkId: config.id,
    networkName: config.name,
    chainId,
    rpcEndpointUsed: endpointUsed,
    isServerProxy,
    fetchedAt: Date.now(),
    latest,
    safe,
    finalized,
    l1Head: {
      latestNumber: l1LatestNumber,
      finalizedNumber: l1FinalizedNumber,
      rpcEndpointUsed: l1Endpoint,
    },
  };
}

export function computeReliability(
  row: Omit<VerifiedTransactionResult, 'reliability'>,
  snapshot: ChainHeadSnapshot
): ReliabilityInfo {
  if (row.finality === FinalityStage.INVALID) {
    return {
      tier: 'partial',
      label: '形式不正・照合対象外',
      basis: ['入力ハッシュ構文検証 (32-byte hex)'],
      caveat: row.errorReason ?? '有効なトランザクションハッシュ形式ではありません',
    };
  }

  if (row.finality === FinalityStage.RPC_ERROR) {
    return {
      tier: 'partial',
      label: 'RPC取得エラー',
      basis: ['Base L2 JSON-RPC照会失敗'],
      caveat: row.errorReason ?? '再実行ボタンで該当ハッシュのみ再照会できます',
    };
  }

  if (row.finality === FinalityStage.NOT_FOUND) {
    return {
      tier: 'partial',
      label: 'オンチェーン未検出',
      basis: [
        `Base L2 JSON-RPC (${snapshot.isServerProxy ? 'Server Archive Proxy' : 'Public/Custom RPC'})`,
      ],
      caveat:
        row.errorReason ??
        '指定ネットワーク上に存在しないか、ネットワーク選択が異なる可能性があります',
    };
  }

  const hasWithdrawalLog = Boolean(
    row.rawReceipt?.logs?.some((l) => l.address?.toLowerCase() === L2_TO_L1_MESSAGE_PASSER)
  );

  const basis: string[] = [
    `L2 Receipt & Tx (${snapshot.isServerProxy ? 'Archive Proxy' : 'JSON-RPC'})`,
    'L2 Head基準値 (finalized / safe / latest)',
  ];
  if (row.l1OriginBlock !== null) {
    basis.push('L1Block Predeploy (0x4200...0015)');
  }
  if (snapshot.l1Head.finalizedNumber !== null) {
    basis.push('Ethereum L1 Finalized Head');
  }

  if (hasWithdrawalLog) {
    if (!row.withdrawal) {
      return {
        tier: 'partial',
        label: '部分照合 (L1未照会)',
        basis,
        caveat:
          'L2ToL1MessagePasser ログを検出しましたが、L1 OptimismPortal2 の状態取得に失敗しました。再実行してください。',
      };
    }

    basis.push('L1 OptimismPortal2.finalizedWithdrawals');
    basis.push('L1 OptimismPortal2 遅延設定・状態照会');

    if (snapshot.l1Head.finalizedNumber === null) {
      return {
        tier: 'partial',
        label: '部分照合 (L1ヘッド未取得)',
        basis,
        caveat: 'L1 RPC の確定ヘッドに接続できなかったため一部比較が省略されています。',
      };
    }

    if (row.withdrawal.usedFallbackDelay) {
      return {
        tier: 'estimated_pending',
        label: '一部推定を含む (フォールバック値使用)',
        basis,
        caveat:
          'L1の一部タイムスタンプ/遅延呼び出しでフォールバック値を使用したため、残り時間は概算です（finalizedWithdrawals は実測済み）。',
      };
    }

    if (
      row.withdrawal.status === 'finalized' ||
      row.withdrawal.status === 'ready-to-finalize'
    ) {
      return {
        tier: 'verified_onchain',
        label: 'オンチェーン実測確定',
        basis,
        caveat: null,
      };
    }

    return {
      tier: 'estimated_pending',
      label: '一部推定・待機指標を含む',
      basis,
      caveat:
        'L1 finalizedWithdrawals と契約設定は実測済みですが、出金可能予定日時は DisputeGame 提出・成熟進行に基づく推定です。',
    };
  }

  if (row.l1OriginBlock === null || snapshot.l1Head.finalizedNumber === null) {
    const caveats: string[] = [];
    if (row.l1OriginBlock === null) {
      caveats.push('過去ブロックの L1 Origin 参照には Archive RPC が必要です');
    }
    if (snapshot.l1Head.finalizedNumber === null) {
      caveats.push('Ethereum L1 Finalized Head の取得がタイムアウト/失敗しました');
    }
    return {
      tier: 'partial',
      label: '部分照合',
      basis,
      caveat: caveats.join(' / '),
    };
  }

  if (row.finality === FinalityStage.FINALIZED) {
    return {
      tier: 'verified_onchain',
      label: 'オンチェーン実測確定',
      basis,
      caveat: null,
    };
  }

  return {
    tier: 'estimated_pending',
    label: '実測済み (L1確定進行中)',
    basis,
    caveat:
      '現在の L2/L1 ノード基準で確定状態を実測済みですが、Finalized 到達までの所要時間は L1 バッチ投稿間隔により変動します。',
  };
}

export async function verifyTransactionsBatch(
  parsed: ParsedHashBatch,
  config: NetworkConfig,
  onProgress?: (completed: number, total: number, phase: string) => void
): Promise<{ snapshot: ChainHeadSnapshot; results: VerifiedTransactionResult[] }> {
  const totalCount = parsed.validHashes.length + parsed.invalidTokens.length;
  onProgress?.(0, totalCount, '最新のL2/L1ヘッド状態を取得中...');

  const snapshot = await fetchChainHeadSnapshot(config);
  const activeRpcUrls = [
    snapshot.rpcEndpointUsed,
    ...config.rpcUrls.filter((u) => u !== snapshot.rpcEndpointUsed),
  ];

  // Chunk valid hashes into batches of 15 (30 RPC calls per HTTP POST)
  const CHUNK_SIZE = 15;
  const txMap = new Map<string, RawTxData | null>();
  const receiptMap = new Map<string, RawReceiptData | null>();
  const errorMap = new Map<string, string>();

  let processedValid = 0;

  for (let i = 0; i < parsed.validHashes.length; i += CHUNK_SIZE) {
    const chunk = parsed.validHashes.slice(i, i + CHUNK_SIZE);
    const batchRequests: JsonRpcRequest[] = [];

    chunk.forEach((hash, idx) => {
      batchRequests.push({
        jsonrpc: '2.0',
        id: idx * 2 + 1,
        method: 'eth_getTransactionByHash',
        params: [hash],
      });
      batchRequests.push({
        jsonrpc: '2.0',
        id: idx * 2 + 2,
        method: 'eth_getTransactionReceipt',
        params: [hash],
      });
    });

    onProgress?.(
      processedValid,
      totalCount,
      `トランザクション検証中 (${Math.min(i + chunk.length, parsed.validHashes.length)} / ${parsed.validHashes.length})...`
    );

    try {
      const { responses } = await postJsonRpcBatch(activeRpcUrls, batchRequests);
      chunk.forEach((hash, idx) => {
        const txRes = responses.get(idx * 2 + 1) as JsonRpcResponse<RawTxData | null> | undefined;
        const rcRes = responses.get(idx * 2 + 2) as
          | JsonRpcResponse<RawReceiptData | null>
          | undefined;

        if (txRes?.error) {
          errorMap.set(hash, txRes.error.message);
        } else {
          txMap.set(hash, txRes?.result ?? null);
        }

        if (rcRes?.error) {
          if (!errorMap.has(hash)) {
            errorMap.set(hash, rcRes.error.message);
          }
        } else {
          receiptMap.set(hash, rcRes?.result ?? null);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RPCリクエストに失敗しました';
      for (const hash of chunk) {
        errorMap.set(hash, msg);
      }
    }

    processedValid += chunk.length;
  }

  // Collect unique L2 block numbers to fetch block timestamps and L1 origin anchor
  const uniqueBlockHexes = new Set<string>();
  for (const hash of parsed.validHashes) {
    const tx = txMap.get(hash);
    const rc = receiptMap.get(hash);
    const blockHex = rc?.blockNumber ?? tx?.blockNumber;
    if (blockHex && blockHex !== '0x') {
      uniqueBlockHexes.add(blockHex);
    }
  }

  const blockTimestamps = new Map<string, number>();
  const blockL1Origins = new Map<string, number>();
  const uniqueBlocksList = Array.from(uniqueBlockHexes);

  if (uniqueBlocksList.length > 0) {
    onProgress?.(
      processedValid,
      totalCount,
      `対象ブロック (${uniqueBlocksList.length}件) のタイムスタンプとL1アンカーを取得中...`
    );

    const BLOCK_CHUNK = 15;
    for (let i = 0; i < uniqueBlocksList.length; i += BLOCK_CHUNK) {
      const slice = uniqueBlocksList.slice(i, i + BLOCK_CHUNK);
      const blockReqs: JsonRpcRequest[] = [];

      slice.forEach((blockHex, idx) => {
        blockReqs.push({
          jsonrpc: '2.0',
          id: idx * 2 + 1,
          method: 'eth_getBlockByNumber',
          params: [blockHex, false],
        });
        blockReqs.push({
          jsonrpc: '2.0',
          id: idx * 2 + 2,
          method: 'eth_call',
          params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_NUMBER_SELECTOR }, blockHex],
        });
      });

      try {
        const { responses } = await postJsonRpcBatch(activeRpcUrls, blockReqs);
        slice.forEach((blockHex, idx) => {
          const blkRes = responses.get(idx * 2 + 1) as JsonRpcResponse<RpcBlock> | undefined;
          const l1Res = responses.get(idx * 2 + 2) as JsonRpcResponse<string> | undefined;

          if (blkRes?.result?.timestamp) {
            const ts = hexToNumber(blkRes.result.timestamp);
            if (ts !== null) blockTimestamps.set(blockHex, ts);
          }
          if (l1Res && !l1Res.error && l1Res.result && l1Res.result !== '0x') {
            const l1Num = hexToNumber(l1Res.result);
            if (l1Num !== null) blockL1Origins.set(blockHex, l1Num);
          }
        });
      } catch {
        // Non-fatal: block metadata fallback remains null
      }
    }
  }

  const results: VerifiedTransactionResult[] = [];
  let rowIndex = 1;

  for (const hash of parsed.validHashes) {
    const rpcErr = errorMap.get(hash);
    const tx = txMap.get(hash) ?? null;
    const rc = receiptMap.get(hash) ?? null;

    if (rpcErr && !tx && !rc) {
      const baseRow: Omit<VerifiedTransactionResult, 'reliability'> = {
        index: rowIndex++,
        inputToken: hash,
        hash,
        finality: FinalityStage.RPC_ERROR,
        executionStatus: ExecutionStatus.UNKNOWN,
        blockNumber: null,
        blockHash: null,
        blockTimestamp: null,
        txIndex: null,
        from: null,
        to: null,
        nonce: null,
        valueEth: null,
        confirmations: null,
        blocksToSafe: null,
        blocksToFinalized: null,
        l1OriginBlock: null,
        l1OriginIsFinalized: null,
        gasUsed: null,
        l2FeeEth: null,
        l1FeeEth: null,
        totalFeeEth: null,
        logsCount: null,
        txType: null,
        errorReason: rpcErr,
        rawTx: null,
        rawReceipt: null,
        withdrawal: null,
      };
      results.push({ ...baseRow, reliability: computeReliability(baseRow, snapshot) });
      continue;
    }

    if (!tx && !rc) {
      const baseRow: Omit<VerifiedTransactionResult, 'reliability'> = {
        index: rowIndex++,
        inputToken: hash,
        hash,
        finality: FinalityStage.NOT_FOUND,
        executionStatus: ExecutionStatus.UNKNOWN,
        blockNumber: null,
        blockHash: null,
        blockTimestamp: null,
        txIndex: null,
        from: null,
        to: null,
        nonce: null,
        valueEth: null,
        confirmations: null,
        blocksToSafe: null,
        blocksToFinalized: null,
        l1OriginBlock: null,
        l1OriginIsFinalized: null,
        gasUsed: null,
        l2FeeEth: null,
        l1FeeEth: null,
        totalFeeEth: null,
        logsCount: null,
        txType: null,
        errorReason: '指定ネットワークのオンチェーン上に該当ハッシュが見つかりません',
        rawTx: null,
        rawReceipt: null,
        withdrawal: null,
      };
      results.push({ ...baseRow, reliability: computeReliability(baseRow, snapshot) });
      continue;
    }

    const blockHex = rc?.blockNumber ?? tx?.blockNumber ?? null;
    const blockNumber = hexToNumber(blockHex);
    const blockHash = rc?.blockHash ?? tx?.blockHash ?? null;

    let finality: FinalityStage;
    if (blockNumber === null) {
      finality = FinalityStage.PENDING;
    } else if (snapshot.finalized && blockNumber <= snapshot.finalized.number) {
      finality = FinalityStage.FINALIZED;
    } else if (snapshot.safe && blockNumber <= snapshot.safe.number) {
      finality = FinalityStage.SAFE;
    } else {
      finality = FinalityStage.UNSAFE;
    }

    let executionStatus: ExecutionStatus;
    if (blockNumber === null || !rc) {
      executionStatus = ExecutionStatus.PENDING;
    } else if (rc.status === '0x1') {
      executionStatus = ExecutionStatus.SUCCESS;
    } else if (rc.status === '0x0') {
      executionStatus = ExecutionStatus.REVERTED;
    } else {
      // System deposit txs on OP Stack without explicit status field default to success when included
      executionStatus = ExecutionStatus.SUCCESS;
    }

    const confirmations =
      blockNumber !== null && snapshot.latest
        ? Math.max(0, snapshot.latest.number - blockNumber)
        : null;

    const blocksToSafe =
      blockNumber !== null && snapshot.safe
        ? Math.max(0, blockNumber - snapshot.safe.number)
        : null;

    const blocksToFinalized =
      blockNumber !== null && snapshot.finalized
        ? Math.max(0, blockNumber - snapshot.finalized.number)
        : null;

    const l1OriginBlock = blockHex ? (blockL1Origins.get(blockHex) ?? null) : null;
    const l1OriginIsFinalized =
      l1OriginBlock !== null && snapshot.l1Head.finalizedNumber !== null
        ? l1OriginBlock <= snapshot.l1Head.finalizedNumber
        : null;

    let l2FeeEth: string | null = null;
    let l1FeeEth: string | null = null;
    let totalFeeEth: string | null = null;
    let gasUsedStr: string | null = null;

    if (rc?.gasUsed) {
      const gasUsedBig = BigInt(rc.gasUsed);
      gasUsedStr = gasUsedBig.toString();
      const effectiveGasPrice = rc.effectiveGasPrice ? BigInt(rc.effectiveGasPrice) : 0n;
      const l2FeeWei = gasUsedBig * effectiveGasPrice;
      const l1FeeWei = rc.l1Fee ? BigInt(rc.l1Fee) : 0n;
      const totalWei = l2FeeWei + l1FeeWei;

      l2FeeEth = formatWeiToEth(l2FeeWei, 8);
      l1FeeEth = formatWeiToEth(l1FeeWei, 8);
      totalFeeEth = formatWeiToEth(totalWei, 8);
    }

    const baseRow: Omit<VerifiedTransactionResult, 'reliability'> = {
      index: rowIndex++,
      inputToken: hash,
      hash,
      finality,
      executionStatus,
      blockNumber,
      blockHash,
      blockTimestamp: blockHex ? (blockTimestamps.get(blockHex) ?? null) : null,
      txIndex: hexToNumber(tx?.transactionIndex),
      from: tx?.from ?? null,
      to: tx?.to ?? null,
      nonce: hexToNumber(tx?.nonce),
      valueEth: tx?.value ? formatWeiToEth(BigInt(tx.value), 6) : null,
      confirmations,
      blocksToSafe,
      blocksToFinalized,
      l1OriginBlock,
      l1OriginIsFinalized,
      gasUsed: gasUsedStr,
      l2FeeEth,
      l1FeeEth,
      totalFeeEth,
      logsCount: rc?.logs ? rc.logs.length : null,
      txType: tx?.type ?? null,
      errorReason: null,
      rawTx: tx,
      rawReceipt: rc,
      withdrawal: null,
    };
    results.push({ ...baseRow, reliability: computeReliability(baseRow, snapshot) });
  }

  for (const invalid of parsed.invalidTokens) {
    const baseRow: Omit<VerifiedTransactionResult, 'reliability'> = {
      index: rowIndex++,
      inputToken: invalid,
      hash: invalid,
      finality: FinalityStage.INVALID,
      executionStatus: ExecutionStatus.UNKNOWN,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      txIndex: null,
      from: null,
      to: null,
      nonce: null,
      valueEth: null,
      confirmations: null,
      blocksToSafe: null,
      blocksToFinalized: null,
      l1OriginBlock: null,
      l1OriginIsFinalized: null,
      gasUsed: null,
      l2FeeEth: null,
      l1FeeEth: null,
      totalFeeEth: null,
      logsCount: null,
      txType: null,
      errorReason: '64桁の16進Txハッシュ形式 (0x...) ではありません',
      rawTx: null,
      rawReceipt: null,
      withdrawal: null,
    };
    results.push({ ...baseRow, reliability: computeReliability(baseRow, snapshot) });
  }

  // Enrich any L2 -> L1 withdrawal transactions with live OptimismPortal2 remaining time & amount
  const withdrawalCandidates = results.filter((r) =>
    r.rawReceipt?.logs?.some((l) => l.address?.toLowerCase() === L2_TO_L1_MESSAGE_PASSER)
  );

  if (withdrawalCandidates.length > 0) {
    onProgress?.(
      totalCount,
      totalCount,
      `L2→L1 出金Tx (${withdrawalCandidates.length}件) のL1残存時間と金額を照会中...`
    );
    await Promise.all(
      withdrawalCandidates.map(async (item) => {
        try {
          const info = await analyzeWithdrawalFromTxHash(item.hash as Hex, config);
          item.withdrawal = info;
        } catch {
          // Non-fatal: keep withdrawal null if L1 query fails
        }
        item.reliability = computeReliability(item, snapshot);
      })
    );
  }

  onProgress?.(totalCount, totalCount, '検証完了');
  return { snapshot, results };
}

/**
 * Fetches live real transaction hashes directly from the chain's finalized, safe,
 * and latest blocks so users can immediately test batch verification across all 3 finality stages.
 */
export async function fetchLiveOnChainSamples(config: NetworkConfig): Promise<string[]> {
  const { responses } = await postJsonRpcBatch(config.rpcUrls, [
    { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', true] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['safe', true] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: ['latest', true] },
  ]);

  const picks: string[] = [];
  const seen = new Set<string>();

  const extractFromBlock = (res: JsonRpcResponse<RpcBlock> | undefined, maxCount: number) => {
    const txs = res?.result?.transactions;
    if (!Array.isArray(txs)) return;
    // Prefer non-system user transactions (type !== '0x7e') first, then fallback
    const userTxs = txs.filter(
      (t): t is RawTxData => typeof t === 'object' && t !== null && t.type !== '0x7e'
    );
    const pool =
      userTxs.length > 0
        ? userTxs
        : txs.filter((t): t is RawTxData => typeof t === 'object' && t !== null);

    let count = 0;
    for (const tx of pool) {
      if (count >= maxCount) break;
      const h = tx.hash?.toLowerCase();
      if (h && !seen.has(h)) {
        seen.add(h);
        picks.push(h);
        count += 1;
      }
    }
  };

  extractFromBlock(responses.get(1) as JsonRpcResponse<RpcBlock> | undefined, 3);
  extractFromBlock(responses.get(2) as JsonRpcResponse<RpcBlock> | undefined, 2);
  extractFromBlock(responses.get(3) as JsonRpcResponse<RpcBlock> | undefined, 2);

  return picks;
}
