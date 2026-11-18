import { toHex, type Hex } from 'viem';
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
  MESSAGE_PASSED_TOPIC0,
  analyzeWithdrawalFromReceipt,
  analyzeWithdrawalFromTxHash,
  createBaseAndL1Clients,
  warmPortalDisputeParams,
} from './withdrawalAnalyzer';

function hasMessagePassedLog(
  logs?: Array<{ address?: string; topics?: readonly string[] | string[] }> | null
): boolean {
  return Boolean(
    logs?.some(
      (l) =>
        l.address?.toLowerCase() === L2_TO_L1_MESSAGE_PASSER &&
        l.topics?.[0]?.toLowerCase() === MESSAGE_PASSED_TOPIC0
    )
  );
}

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

// OP Stack L1Block predeploy address on Base (used strictly for general L2 finality tab, NOT withdrawals)
const L1_BLOCK_PREDEPLOY = '0x4200000000000000000000000000000000000015';
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

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const currentIndex = cursor;
        cursor += 1;
        await worker(items[currentIndex], currentIndex);
      }
    }
  );
  await Promise.all(runners);
}

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

    if (keyLower === 'chainheads') {
      return;
    }

    if (Array.isArray(obj.transactions) && ('number' in obj || 'parentHash' in obj)) {
      collectHashesFromJsonValue(obj.transactions, 'transactions', onHashFound);
      return;
    }

    let foundPreferred = false;
    for (const [k, v] of Object.entries(obj)) {
      if (
        PREFERRED_TX_HASH_KEYS.has(k.toLowerCase()) &&
        typeof v === 'string' &&
        TX_HASH_REGEX.test(v.trim())
      ) {
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
    if (TX_HASH_REGEX.test(token)) {
      pushValid(token);
      continue;
    }

    const matches = token.match(TX_HASH_EXTRACT_REGEX);
    if (matches && matches.length > 0) {
      for (const m of matches) {
        pushValid(m);
      }
      continue;
    }

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
      label: 'RPC取得エラー (要再取得)',
      basis: ['JSON-RPC照会失敗'],
      caveat: row.errorReason ?? '再取得ボタンで該当ハッシュのみ再照会できます',
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

  const isWithdrawalCandidate = Boolean(
    row.withdrawal !== null ||
      (row.rawReceipt?.logs
        ? hasMessagePassedLog(row.rawReceipt.logs)
        : row.hasWithdrawalLog === true)
  );

  // Withdrawal transactions are evaluated strictly by real OP Stack withdrawal contracts
  // (L2ToL1MessagePasser + OptimismPortal2 + DisputeGameFactory / AggregateVerifier)
  // without unrelated L2 Casper FFG / L1Block Predeploy checks.
  if (isWithdrawalCandidate) {
    const withdrawalBasis = [
      'L2ToL1MessagePasser (sentMessages & MPT証明)',
      'L1 OptimismPortal2 (provenWithdrawals / checkWithdrawal / finalizedWithdrawals)',
      'L1 DisputeGameFactory / AggregateVerifier (TEE・ZK)',
    ];

    if (
      !row.withdrawal ||
      !row.withdrawal.validation ||
      row.withdrawal.usedFallbackDelay
    ) {
      return {
        tier: 'partial',
        label: '未取得あり (要再取得)',
        basis: ['L2ToL1MessagePasser ログ検出'],
        caveat:
          'L2ToL1MessagePasser ログを検出しましたが、L1 OptimismPortal2 の状態取得が未完了です。未取得項目を再取得します。',
      };
    }

    if (
      row.withdrawal.portalFinalized ||
      row.withdrawal.status === 'ready-to-finalize'
    ) {
      return {
        tier: 'verified_onchain',
        label: 'OptimismPortal2 実測確定',
        basis: withdrawalBasis,
        caveat: null,
      };
    }

    return {
      tier: 'estimated_pending',
      label: 'OptimismPortal2 検証済',
      basis: withdrawalBasis,
      caveat: null,
    };
  }

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
      label: '部分照合 (未取得あり)',
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

/**
 * Dedicated OP Stack Withdrawal-Only batch verifier (`withdrawal-verify` tab).
 * Queries ONLY L2 transaction receipts (`L2ToL1MessagePasser`) + L1 `OptimismPortal2` + `DisputeGameFactory / AggregateVerifier`
 * with bounded concurrency and retry — zero unrelated L2 Safe/Finalized head or L1Block Predeploy calls!
 */
export async function verifyWithdrawalsOnlyBatch(
  parsed: ParsedHashBatch,
  config: NetworkConfig,
  onProgress?: (completed: number, total: number, phase: string) => void
): Promise<{ snapshot: ChainHeadSnapshot; results: VerifiedTransactionResult[] }> {
  const totalCount = parsed.validHashes.length + parsed.invalidTokens.length;
  onProgress?.(0, totalCount, 'L1 OptimismPortal2 & AggregateVerifier 設定を取得中...');

  const clients = createBaseAndL1Clients(config);
  const { l1Client, l2Client } = clients;

  const [, l2LatestBlk, l1LatestNum] = await Promise.all([
    warmPortalDisputeParams(config).catch(() => {}),
    l2Client.getBlock({ blockTag: 'latest' }).catch(() => null),
    l1Client.getBlockNumber().catch(() => null),
  ]);

  const endpointUsed = config.rpcUrls[0] ?? '';
  const snapshot: ChainHeadSnapshot = {
    networkId: config.id,
    networkName: config.name,
    chainId: config.chainId,
    rpcEndpointUsed: endpointUsed,
    isServerProxy: endpointUsed.startsWith('/api/rpc/'),
    fetchedAt: Date.now(),
    latest: l2LatestBlk
      ? {
          number: Number(l2LatestBlk.number),
          hash: l2LatestBlk.hash,
          timestamp: Number(l2LatestBlk.timestamp),
        }
      : null,
    safe: null,
    finalized: null,
    l1Head: {
      latestNumber: l1LatestNum !== null ? Number(l1LatestNum) : null,
      finalizedNumber: l1LatestNum !== null ? Number(l1LatestNum) : null,
      rpcEndpointUsed: config.l1RpcUrls[0] ?? null,
    },
  };

  const validResultsByIdx: Array<VerifiedTransactionResult | null> = new Array(
    parsed.validHashes.length
  ).fill(null);

  let completedCount = 0;

  await runWithConcurrency(parsed.validHashes, 3, async (hash, idx) => {
    onProgress?.(
      completedCount,
      totalCount,
      `出金コントラクト検証中 (${Math.min(completedCount + 1, parsed.validHashes.length)} / ${parsed.validHashes.length})...`
    );

    try {
      let receipt = null;
      let receiptErr: Error | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          receipt = await l2Client.getTransactionReceipt({ hash: hash as Hex });
          receiptErr = null;
          break;
        } catch (err) {
          receiptErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }

      if (!receipt) {
        const txPending = await l2Client
          .getTransaction({ hash: hash as Hex })
          .catch(() => null);

        if (txPending && txPending.blockNumber === null) {
          const pendingRow: Omit<VerifiedTransactionResult, 'reliability'> = {
            index: idx + 1,
            inputToken: hash,
            hash,
            finality: FinalityStage.PENDING,
            executionStatus: ExecutionStatus.PENDING,
            blockNumber: null,
            blockHash: null,
            blockTimestamp: null,
            txIndex: null,
            from: txPending.from,
            to: txPending.to ?? null,
            nonce: txPending.nonce,
            valueEth: formatWeiToEth(txPending.value, 6),
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
            txType: txPending.type ?? null,
            errorReason: null,
            hasWithdrawalLog: false,
            rawTx: null,
            rawReceipt: null,
            withdrawal: null,
          };
          validResultsByIdx[idx] = {
            ...pendingRow,
            reliability: computeReliability(pendingRow, snapshot),
          };
          return;
        }

        const errMsg = receiptErr?.message ?? '';
        const isNotFound =
          errMsg.toLowerCase().includes('not be found') ||
          errMsg.toLowerCase().includes('not found');

        const missingRow: Omit<VerifiedTransactionResult, 'reliability'> = {
          index: idx + 1,
          inputToken: hash,
          hash,
          finality: isNotFound ? FinalityStage.NOT_FOUND : FinalityStage.RPC_ERROR,
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
          errorReason: isNotFound
            ? '指定ネットワークのオンチェーン上に該当ハッシュが見つかりません'
            : errMsg || 'L2 レシートの取得に失敗しました',
          hasWithdrawalLog: false,
          rawTx: null,
          rawReceipt: null,
          withdrawal: null,
        };
        validResultsByIdx[idx] = {
          ...missingRow,
          reliability: computeReliability(missingRow, snapshot),
        };
        return;
      }

      const hasMpLog = hasMessagePassedLog(receipt.logs);

      let withdrawal = null;
      if (hasMpLog && receipt.status !== 'reverted') {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            withdrawal = await analyzeWithdrawalFromReceipt(receipt, config, clients);
            break;
          } catch {
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 500 * attempt));
            }
          }
        }
      }

      const blockNum = Number(receipt.blockNumber);
      const gasUsedBig = receipt.gasUsed;
      const effGasPrice = receipt.effectiveGasPrice ?? 0n;
      const l1FeeBig =
        (receipt as unknown as { l1Fee?: bigint | null }).l1Fee ?? 0n;
      const l2FeeWei = gasUsedBig * effGasPrice;
      const totalFeeWei = l2FeeWei + l1FeeBig;

      const rawRc: RawReceiptData = {
        transactionHash: receipt.transactionHash,
        blockNumber: toHex(receipt.blockNumber),
        blockHash: receipt.blockHash,
        status: receipt.status === 'reverted' ? '0x0' : '0x1',
        gasUsed: toHex(receipt.gasUsed),
        effectiveGasPrice: toHex(effGasPrice),
        l1Fee: toHex(l1FeeBig),
        logs: receipt.logs.map((l) => ({
          address: l.address,
          topics: l.topics as string[],
          data: l.data,
        })),
      };

      const baseRow: Omit<VerifiedTransactionResult, 'reliability'> = {
        index: idx + 1,
        inputToken: hash,
        hash,
        finality: FinalityStage.FINALIZED,
        executionStatus:
          receipt.status === 'reverted'
            ? ExecutionStatus.REVERTED
            : ExecutionStatus.SUCCESS,
        blockNumber: blockNum,
        blockHash: receipt.blockHash,
        blockTimestamp: null,
        txIndex: receipt.transactionIndex,
        from: receipt.from,
        to: receipt.to ?? null,
        nonce: null,
        valueEth: withdrawal?.assetType === 'ETH' ? withdrawal.amountFormatted : null,
        confirmations:
          snapshot.latest !== null
            ? Math.max(0, snapshot.latest.number - blockNum)
            : null,
        blocksToSafe: 0,
        blocksToFinalized: 0,
        l1OriginBlock: null,
        l1OriginIsFinalized: null,
        gasUsed: gasUsedBig.toString(),
        l2FeeEth: formatWeiToEth(l2FeeWei, 8),
        l1FeeEth: formatWeiToEth(l1FeeBig, 8),
        totalFeeEth: formatWeiToEth(totalFeeWei, 8),
        logsCount: receipt.logs.length,
        txType: receipt.type ?? null,
        errorReason: null,
        hasWithdrawalLog: hasMpLog,
        rawTx: null,
        rawReceipt: rawRc,
        withdrawal,
      };

      validResultsByIdx[idx] = {
        ...baseRow,
        reliability: hasMpLog
          ? computeReliability(baseRow, snapshot)
          : {
              tier: 'verified_onchain',
              label: '出金イベントなし (通常L2 Tx)',
              basis: ['L2 Transaction Receipt (MessagePassed イベント照合)'],
              caveat:
                'L2ToL1MessagePasser の MessagePassed (出金) イベントが含まれていないため、L1 OptimismPortal2 出金の対象外です。',
            },
      };
    } finally {
      completedCount += 1;
      onProgress?.(
        completedCount,
        totalCount,
        `出金コントラクト検証済 (${completedCount} / ${parsed.validHashes.length})...`
      );
    }
  });

  const results: VerifiedTransactionResult[] = [];
  for (const r of validResultsByIdx) {
    if (r) results.push(r);
  }

  let nextIdx = results.length + 1;
  for (const invalid of parsed.invalidTokens) {
    const invRow: Omit<VerifiedTransactionResult, 'reliability'> = {
      index: nextIdx++,
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
      hasWithdrawalLog: false,
      rawTx: null,
      rawReceipt: null,
      withdrawal: null,
    };
    results.push({ ...invRow, reliability: computeReliability(invRow, snapshot) });
  }

  onProgress?.(totalCount, totalCount, '出金検証完了');
  return { snapshot, results };
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

  // Collect unique L2 block numbers (skip L1Block predeploy for pure withdrawal txs if desired, or fetch cleanly)
  const uniqueBlockHexes = new Set<string>();
  const nonWithdrawalBlockHexes = new Set<string>();
  for (const hash of parsed.validHashes) {
    const tx = txMap.get(hash);
    const rc = receiptMap.get(hash);
    const blockHex = rc?.blockNumber ?? tx?.blockNumber;
    const isWithdrawal = hasMessagePassedLog(rc?.logs);
    if (blockHex && blockHex !== '0x') {
      uniqueBlockHexes.add(blockHex);
      if (!isWithdrawal) {
        nonWithdrawalBlockHexes.add(blockHex);
      }
    }
  }

  const blockTimestamps = new Map<string, number>();
  const blockL1Origins = new Map<string, number>();
  const uniqueBlocksList = Array.from(uniqueBlockHexes);

  if (uniqueBlocksList.length > 0) {
    onProgress?.(
      processedValid,
      totalCount,
      `対象ブロック (${uniqueBlocksList.length}件) のタイムスタンプを取得中...`
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
        if (nonWithdrawalBlockHexes.has(blockHex)) {
          blockReqs.push({
            jsonrpc: '2.0',
            id: idx * 2 + 2,
            method: 'eth_call',
            params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_NUMBER_SELECTOR }, blockHex],
          });
        }
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
        // Non-fatal: retry missed L1 origins below
      }
    }

    // Retry any missed non-withdrawal L1 origin block once
    const missedOriginBlocks = Array.from(nonWithdrawalBlockHexes).filter(
      (b) => !blockL1Origins.has(b)
    );
    if (missedOriginBlocks.length > 0 && missedOriginBlocks.length <= 30) {
      try {
        const retryReqs: JsonRpcRequest[] = missedOriginBlocks.map((blockHex, idx) => ({
          jsonrpc: '2.0',
          id: idx + 1,
          method: 'eth_call',
          params: [{ to: L1_BLOCK_PREDEPLOY, data: L1_BLOCK_NUMBER_SELECTOR }, blockHex],
        }));
        const { responses } = await postJsonRpcBatch(activeRpcUrls, retryReqs);
        missedOriginBlocks.forEach((blockHex, idx) => {
          const l1Res = responses.get(idx + 1) as JsonRpcResponse<string> | undefined;
          if (l1Res && !l1Res.error && l1Res.result && l1Res.result !== '0x') {
            const l1Num = hexToNumber(l1Res.result);
            if (l1Num !== null) blockL1Origins.set(blockHex, l1Num);
          }
        });
      } catch {
        // Ignore
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
        hasWithdrawalLog: false,
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
        hasWithdrawalLog: false,
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
    const hasWithdrawalLog = hasMessagePassedLog(rc?.logs);

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
      hasWithdrawalLog,
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
      hasWithdrawalLog: false,
      rawTx: null,
      rawReceipt: null,
      withdrawal: null,
    };
    results.push({ ...baseRow, reliability: computeReliability(baseRow, snapshot) });
  }

  const withdrawalCandidates = results.filter(
    (r) =>
      r.hasWithdrawalLog &&
      r.executionStatus !== ExecutionStatus.REVERTED
  );

  if (withdrawalCandidates.length > 0) {
    onProgress?.(
      totalCount,
      totalCount,
      `L2→L1 出金Tx (${withdrawalCandidates.length}件) の OptimismPortal2 状態を照会中...`
    );
    await warmPortalDisputeParams(config).catch(() => {});

    let completedW = 0;
    await runWithConcurrency(withdrawalCandidates, 3, async (item) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const info = await analyzeWithdrawalFromTxHash(item.hash as Hex, config);
          item.withdrawal = info;
          break;
        } catch {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      item.reliability = computeReliability(item, snapshot);
      completedW += 1;
      onProgress?.(
        totalCount,
        totalCount,
        `L2→L1 出金Tx (${completedW}/${withdrawalCandidates.length}件) の OptimismPortal2 照会中...`
      );
    });
  }

  onProgress?.(totalCount, totalCount, '検証完了');
  return { snapshot, results };
}

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
