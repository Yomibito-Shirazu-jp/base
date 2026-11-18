export type NetworkId = 'base-mainnet' | 'base-sepolia' | 'custom';

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  chainId: number;
  rpcUrls: string[];
  l1RpcUrls: string[];
  explorerUrl: string;
  l1ExplorerUrl: string;
}

export enum FinalityStage {
  FINALIZED = 'finalized',
  SAFE = 'safe',
  UNSAFE = 'unsafe',
  PENDING = 'pending',
  NOT_FOUND = 'not_found',
  INVALID = 'invalid',
  RPC_ERROR = 'rpc_error',
}

export enum ExecutionStatus {
  SUCCESS = 'success',
  REVERTED = 'reverted',
  PENDING = 'pending',
  UNKNOWN = 'unknown',
}

export interface BlockHeadInfo {
  number: number;
  hash: string;
  timestamp: number;
  l1OriginNumber?: number | null;
  l1OriginTimestamp?: number | null;
}

export interface ChainHeadSnapshot {
  networkId: NetworkId;
  networkName: string;
  chainId: number | null;
  rpcEndpointUsed: string;
  isServerProxy: boolean;
  fetchedAt: number;
  latest: BlockHeadInfo | null;
  safe: BlockHeadInfo | null;
  finalized: BlockHeadInfo | null;
  l1Head: {
    latestNumber: number | null;
    finalizedNumber: number | null;
    rpcEndpointUsed: string | null;
  };
}

export interface RawTxData {
  hash: string;
  from: string;
  to: string | null;
  nonce: string;
  value: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionIndex: string | null;
  type: string;
  input: string;
}

export interface RawReceiptData {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status?: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  l1Fee?: string;
  l1GasUsed?: string;
  l1GasPrice?: string;
  l1BaseFeeScalar?: string;
  l1BlobBaseFeeScalar?: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export type WithdrawalStatus =
  | 'waiting-to-prove'
  | 'ready-to-prove'
  | 'waiting-to-finalize'
  | 'ready-to-finalize'
  | 'finalized';

export type ReliabilityTier = 'verified_onchain' | 'estimated_pending' | 'partial';

export interface ReliabilityInfo {
  tier: ReliabilityTier;
  label: string;
  basis: string[];
  caveat: string | null;
}

export interface WithdrawalInfo {
  withdrawalHash: string;
  nonce: string;
  sender: string;
  target: string;
  l1Recipient: string;
  assetType: 'ETH' | 'ERC20' | 'MESSAGE';
  assetSymbol: string;
  assetDecimals: number;
  l2TokenAddress: string | null;
  l1TokenAddress: string | null;
  amountRaw: string;
  amountFormatted: string;
  valueWei: string;
  gasLimit: string;
  data: string;
  status: WithdrawalStatus;
  portalFinalized: boolean;
  usedFallbackDelay: boolean;
  proofMaturityDelaySeconds: number;
  disputeGameFinalityDelaySeconds: number;
  secondsToProve: number | null;
  secondsToFinalize: number | null;
  totalSecondsRemaining: number | null;
  estimatedClaimableAtMs: number | null;
  analyzedAtMs: number;
}

export interface WithdrawalSimulationResult {
  simulatedAtMs: number;
  withdrawalHash: string;
  status: WithdrawalStatus;
  canClaimNow: boolean;
  canProveNow: boolean;
  l1GasPriceGwei: string;
  l2GasPriceGwei: string;
  estimatedProveGas: string;
  estimatedFinalizeGas: string;
  estimatedProveFeeEth: string;
  estimatedFinalizeFeeEth: string;
  totalL1ClaimCostEth: string;
  netAmountFormatted: string | null;
  l1DryRunAction: 'finalizeWithdrawalTransaction' | 'proveWithdrawalTransaction' | 'already-finalized';
  l1DryRunSuccess: boolean;
  l1DryRunMessage: string;
  proofMaturityDelaySeconds: number;
  estimatedClaimableAtMs: number | null;
  totalSecondsRemaining: number | null;
}

export interface VerifiedTransactionResult {
  index: number;
  inputToken: string;
  hash: string;
  finality: FinalityStage;
  executionStatus: ExecutionStatus;
  blockNumber: number | null;
  blockHash: string | null;
  blockTimestamp: number | null;
  txIndex: number | null;
  from: string | null;
  to: string | null;
  nonce: number | null;
  valueEth: string | null;
  confirmations: number | null;
  blocksToSafe: number | null;
  blocksToFinalized: number | null;
  l1OriginBlock: number | null;
  l1OriginIsFinalized: boolean | null;
  gasUsed: string | null;
  l2FeeEth: string | null;
  l1FeeEth: string | null;
  totalFeeEth: string | null;
  logsCount: number | null;
  txType: string | null;
  errorReason: string | null;
  rawTx: RawTxData | null;
  rawReceipt: RawReceiptData | null;
  withdrawal: WithdrawalInfo | null;
  reliability: ReliabilityInfo;
}

export interface ParsedHashBatch {
  validHashes: string[];
  invalidTokens: string[];
  duplicateCount: number;
  totalLinesOrTokens: number;
}

export interface VerificationRunSummary {
  id: string;
  createdAt: number;
  networkId: NetworkId;
  networkName: string;
  snapshot: ChainHeadSnapshot;
  results: VerifiedTransactionResult[];
  counts: {
    total: number;
    finalized: number;
    safe: number;
    unsafe: number;
    pending: number;
    notFoundOrError: number;
    reverted: number;
  };
}
