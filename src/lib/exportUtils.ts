import {
  ChainHeadSnapshot,
  ExecutionStatus,
  FinalityStage,
  VerifiedTransactionResult,
} from '../types/finality';

export function shortenHex(hex: string, head = 10, tail = 8): string {
  if (!hex || hex.length <= head + tail + 3) return hex;
  return `${hex.slice(0, head)}...${hex.slice(-tail)}`;
}

export function formatUnixTimestamp(unixSec: number | null): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDurationRough(blocksRemaining: number): string {
  if (blocksRemaining <= 0) return '確定済み';
  // Base L2 block time is ~2 seconds
  const seconds = blocksRemaining * 2;
  if (seconds < 60) return `約 ${seconds}秒`;
  const minutes = Math.ceil(seconds / 60);
  return `約 ${minutes}分`;
}

export function getFinalityLabel(stage: FinalityStage): string {
  switch (stage) {
    case FinalityStage.FINALIZED:
      return 'Finalized (L1確定)';
    case FinalityStage.SAFE:
      return 'Safe (L1バッチ済)';
    case FinalityStage.UNSAFE:
      return 'Unsafe (L2承認のみ)';
    case FinalityStage.PENDING:
      return 'Pending (待機中)';
    case FinalityStage.NOT_FOUND:
      return 'Not Found (未検出)';
    case FinalityStage.INVALID:
      return 'Invalid (形式不正)';
    case FinalityStage.RPC_ERROR:
      return 'RPC Error';
  }
}

export function getExecutionLabel(status: ExecutionStatus): string {
  switch (status) {
    case ExecutionStatus.SUCCESS:
      return 'Success';
    case ExecutionStatus.REVERTED:
      return 'Reverted';
    case ExecutionStatus.PENDING:
      return 'Pending';
    case ExecutionStatus.UNKNOWN:
      return '—';
  }
}

function escapeCsvField(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportResultsAsCsv(
  results: VerifiedTransactionResult[],
  snapshot: ChainHeadSnapshot
): void {
  const headers = [
    'Index',
    'TxHash',
    'FinalityStage',
    'ExecutionStatus',
    'L2BlockNumber',
    'L2BlockTimestampISO',
    'Confirmations',
    'BlocksToFinalized',
    'L1OriginBlock',
    'From',
    'To',
    'ValueETH',
    'WithdrawalStatus',
    'WithdrawalAmount',
    'WithdrawalAsset',
    'WithdrawalRemainingSeconds',
    'WithdrawalClaimableAtISO',
    'TotalFeeETH',
    'L1FeeETH',
    'L2FeeETH',
    'GasUsed',
    'ReferenceFinalizedBlock',
    'ReferenceSafeBlock',
    'ReferenceLatestBlock',
    'RpcEndpoint',
    'ErrorReason',
  ];

  const rows = results.map((r) => [
    r.index,
    r.hash,
    getFinalityLabel(r.finality),
    getExecutionLabel(r.executionStatus),
    r.blockNumber ?? '',
    r.blockTimestamp ? new Date(r.blockTimestamp * 1000).toISOString() : '',
    r.confirmations ?? '',
    r.blocksToFinalized ?? '',
    r.l1OriginBlock ?? '',
    r.from ?? '',
    r.to ?? '',
    r.valueEth ?? '',
    r.withdrawal?.status ?? '',
    r.withdrawal?.amountFormatted ?? '',
    r.withdrawal?.assetSymbol ?? '',
    r.withdrawal?.totalSecondsRemaining ?? '',
    r.withdrawal?.estimatedClaimableAtMs
      ? new Date(r.withdrawal.estimatedClaimableAtMs).toISOString()
      : '',
    r.totalFeeEth ?? '',
    r.l1FeeEth ?? '',
    r.l2FeeEth ?? '',
    r.gasUsed ?? '',
    snapshot.finalized?.number ?? '',
    snapshot.safe?.number ?? '',
    snapshot.latest?.number ?? '',
    snapshot.rpcEndpointUsed,
    r.errorReason ?? '',
  ]);

  const csvContent =
    '\uFEFF' +
    [headers, ...rows].map((row) => row.map(escapeCsvField).join(',')).join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `base-finality-${snapshot.networkId}-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportResultsAsJson(
  results: VerifiedTransactionResult[],
  snapshot: ChainHeadSnapshot
): void {
  const seenHashes = new Set<string>();
  const dedupedResults = results.filter((r) => {
    const key = r.hash.toLowerCase();
    if (seenHashes.has(key)) return false;
    seenHashes.add(key);
    return true;
  });

  const payload = {
    schema: 'base-onchain-finality-audit/v1',
    verifiedAt: new Date(snapshot.fetchedAt).toISOString(),
    network: {
      id: snapshot.networkId,
      name: snapshot.networkName,
      chainId: snapshot.chainId,
      rpcEndpointUsed: snapshot.rpcEndpointUsed,
    },
    chainHeads: {
      latest: snapshot.latest,
      safe: snapshot.safe,
      finalized: snapshot.finalized,
      l1Head: snapshot.l1Head,
    },
    transactions: dedupedResults.map((r) => ({
      index: r.index,
      hash: r.hash,
      finality: r.finality,
      executionStatus: r.executionStatus,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash,
      blockTimestamp: r.blockTimestamp,
      confirmations: r.confirmations,
      blocksToSafe: r.blocksToSafe,
      blocksToFinalized: r.blocksToFinalized,
      l1OriginBlock: r.l1OriginBlock,
      l1OriginIsFinalized: r.l1OriginIsFinalized,
      from: r.from,
      to: r.to,
      valueEth: r.valueEth,
      withdrawal: r.withdrawal,
      totalFeeEth: r.totalFeeEth,
      l1FeeEth: r.l1FeeEth,
      l2FeeEth: r.l2FeeEth,
      gasUsed: r.gasUsed,
      errorReason: r.errorReason,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `base-finality-proof-${snapshot.networkId}-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildTsvSummary(
  results: VerifiedTransactionResult[],
  snapshot: ChainHeadSnapshot
): string {
  const header = `TxHash\tFinality\tExecution\tL2Block\tConfirmations\tWithdrawalAmount\tWithdrawalStatus\tTotalFeeETH`;
  const lines = results.map(
    (r) =>
      `${r.hash}\t${getFinalityLabel(r.finality)}\t${getExecutionLabel(r.executionStatus)}\t${r.blockNumber ?? '-'}\t${r.confirmations ?? '-'}\t${
        r.withdrawal ? `${r.withdrawal.amountFormatted} ${r.withdrawal.assetSymbol}` : '-'
      }\t${r.withdrawal?.status ?? '-'}\t${r.totalFeeEth ?? '-'}`
  );
  const meta = `# Base Finality Snapshot (${snapshot.networkName}) | Finalized=#${snapshot.finalized?.number ?? '-'} | Safe=#${snapshot.safe?.number ?? '-'} | Latest=#${snapshot.latest?.number ?? '-'}`;
  return [meta, header, ...lines].join('\n');
}
