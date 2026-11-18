import {
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  formatGwei,
  http,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  createPaymasterClient,
  entryPoint07Address,
} from 'viem/account-abstraction';
import { getWithdrawals } from 'viem/op-stack';
import { createSmartAccountClient } from 'permissionless';
import {
  toSafeSmartAccount,
  toSimpleSmartAccount,
} from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { NetworkConfig } from '../types/finality';
import {
  DISPUTE_GAME_ABI,
  OPTIMISM_PORTAL_READ_ABI,
  createBaseAndL1Clients,
  inspectAggregateGameProxy,
} from './withdrawalAnalyzer';

export type ExecutionMode = 'pimlico' | 'alchemy' | 'wallet';
export type SmartAccountKind = 'simple' | 'safe';
export type WithdrawalL1Action = 'prove' | 'finalize';

export interface ServerAaStatus {
  pimlicoEthConfigured: boolean;
  pimlicoSepoliaConfigured: boolean;
  pimlicoBaseConfigured: boolean;
  pimlicoPolicyConfigured: boolean;
  alchemyEthConfigured: boolean;
  alchemySepoliaConfigured: boolean;
  alchemyPolicyConfigured: boolean;
}

export interface PimlicoExecutionSettings {
  mode: ExecutionMode;
  usePaymaster: boolean;
  smartAccountKind: SmartAccountKind;
}

export interface PimlicoAccountPreview {
  provider: 'pimlico' | 'alchemy';
  l1ChainId: number;
  l1ChainName: string;
  proxyEndpoint: string;
  ownerAddress: Address;
  smartAccountAddress: Address;
  isDeployed: boolean;
  smartAccountEthBalance: string;
  fastMaxFeeGwei: string;
  sponsorshipPolicyActive: boolean;
  sponsorshipPolicyNote: string;
}

export interface PreparedWithdrawalActionCall {
  action: WithdrawalL1Action;
  portalAddress: Address;
  resolveGameAddress: Address | null;
  l1ChainId: number;
  l1ChainName: string;
  withdrawalHash: Hex;
  callData: Hex;
  functionName: string;
  disputeGameIndex: number | null;
  proofSubmitterUsed: Address | null;
  estimatedGas: bigint | null;
}

export interface L1ExecutionOutcome {
  action: WithdrawalL1Action;
  mode: ExecutionMode;
  l1ChainId: number;
  l1TxHash: Hex;
  userOpHash: Hex | null;
  smartAccountAddress: Address | null;
  callerAddress: Address;
  blockNumber: number | null;
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

export async function fetchServerAaStatus(): Promise<ServerAaStatus> {
  const res = await fetch('/api/aa/status');
  if (!res.ok) {
    throw new Error('サーバー側の Bundler 設定状態の取得に失敗しました');
  }
  return (await res.json()) as ServerAaStatus;
}

function getInjectedProvider(): Eip1193Provider {
  if (typeof window === 'undefined') {
    throw new Error('ブラウザ環境でのみウォレット署名を利用できます');
  }
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth || typeof eth.request !== 'function') {
    throw new Error(
      'ブラウザウォレット (MetaMask / Rabby / Coinbase Wallet 等) が検出されませんでした。ウォレット拡張機能を有効化して再試行してください。'
    );
  }
  return eth;
}

export function buildServerBundlerProxyUrl(
  provider: 'pimlico' | 'alchemy',
  l1ChainId: number,
  usePaymaster: boolean
): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const policyFlag = usePaymaster ? '1' : '0';
  return `${origin}/api/bundler/${provider}/${l1ChainId}?policy=${policyFlag}`;
}

async function ensureInjectedChain(
  provider: Eip1193Provider,
  targetChainId: number
): Promise<Address> {
  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
  })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error('ウォレットのアカウント接続が拒否されました');
  }

  const currentChainHex = (await provider.request({
    method: 'eth_chainId',
  })) as string;
  const currentChainId = parseInt(currentChainHex, 16);

  if (currentChainId !== targetChainId) {
    const targetHex = toHex(targetChainId);
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetHex }],
    });
  }

  return accounts[0] as Address;
}

async function resolveInjectedOwner(
  l1Chain: ReturnType<typeof createBaseAndL1Clients>['l1Chain']
) {
  const provider = getInjectedProvider();
  const connectedAddr = await ensureInjectedChain(provider, l1Chain.id);
  const walletClient = createWalletClient({
    account: connectedAddr,
    chain: l1Chain,
    transport: custom(provider),
  });
  return {
    owner: walletClient,
    ownerAddress: connectedAddr,
  };
}

async function createConfiguredSmartAccount(params: {
  l1Client: ReturnType<typeof createBaseAndL1Clients>['l1Client'];
  l1Chain: ReturnType<typeof createBaseAndL1Clients>['l1Chain'];
  smartAccountKind: SmartAccountKind;
}) {
  const { l1Client, l1Chain, smartAccountKind } = params;
  const { owner, ownerAddress } = await resolveInjectedOwner(l1Chain);

  if (smartAccountKind === 'safe') {
    const safeAccount = await toSafeSmartAccount({
      client: l1Client,
      owners: [owner],
      version: '1.4.1',
      entryPoint: {
        address: entryPoint07Address,
        version: '0.7',
      },
    });
    return { smartAccount: safeAccount, ownerAddress };
  }

  const simpleAccount = await toSimpleSmartAccount({
    client: l1Client,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  });
  return { smartAccount: simpleAccount, ownerAddress };
}

export async function previewPimlicoSmartAccount(
  settings: PimlicoExecutionSettings,
  networkConfig: NetworkConfig,
  aaStatus?: ServerAaStatus | null
): Promise<PimlicoAccountPreview> {
  const provider: 'pimlico' | 'alchemy' =
    settings.mode === 'alchemy' ? 'alchemy' : 'pimlico';
  const { l1Client, l1Chain, portalAddress } =
    createBaseAndL1Clients(networkConfig);

  const proxyUrl = buildServerBundlerProxyUrl(
    provider,
    l1Chain.id,
    settings.usePaymaster
  );

  const { smartAccount, ownerAddress } = await createConfiguredSmartAccount({
    l1Client,
    l1Chain,
    smartAccountKind: settings.smartAccountKind,
  });

  let fastMaxFeeWei = 0n;
  if (provider === 'pimlico') {
    const pimlicoClient = createPimlicoClient({
      chain: l1Chain,
      transport: http(proxyUrl, { timeout: 20000 }),
      entryPoint: {
        address: entryPoint07Address,
        version: '0.7',
      },
    });
    const gasPrices = await pimlicoClient.getUserOperationGasPrice();
    fastMaxFeeWei = gasPrices.fast.maxFeePerGas;
  } else {
    fastMaxFeeWei = await l1Client.getGasPrice();
  }

  const [code, balanceWei] = await Promise.all([
    l1Client.getCode({ address: smartAccount.address }).catch(() => undefined),
    l1Client.getBalance({ address: smartAccount.address }).catch(() => 0n),
  ]);

  const isDeployed = Boolean(code && code !== '0x');
  const policyConfigured =
    provider === 'pimlico'
      ? Boolean(aaStatus?.pimlicoPolicyConfigured)
      : Boolean(aaStatus?.alchemyPolicyConfigured);

  let sponsorshipPolicyNote = '';
  if (settings.usePaymaster && policyConfigured) {
    sponsorshipPolicyNote =
      provider === 'pimlico'
        ? `Pimlico Sponsorship Policy (サーバー設定済) を自動適用 · 対象 ${portalAddress.slice(
            0,
            10
          )}...`
        : `Alchemy Gas Manager Policy (サーバー設定済) を自動適用 · 対象 ${portalAddress.slice(
            0,
            10
          )}...`;
  } else if (settings.usePaymaster) {
    sponsorshipPolicyNote =
      'Paymaster 有効（サーバー側 Verifying Paymaster 設定を使用）';
  } else {
    sponsorshipPolicyNote =
      'Paymaster 無効（Smart Account 自身の ETH 残高から L1 ガス代を支払います）';
  }

  return {
    provider,
    l1ChainId: l1Chain.id,
    l1ChainName: l1Chain.name,
    proxyEndpoint: `/api/bundler/${provider}/${l1Chain.id}`,
    ownerAddress,
    smartAccountAddress: smartAccount.address,
    isDeployed,
    smartAccountEthBalance: Number(formatEther(balanceWei)).toFixed(6),
    fastMaxFeeGwei: Number(formatGwei(fastMaxFeeWei)).toFixed(3),
    sponsorshipPolicyActive: settings.usePaymaster && policyConfigured,
    sponsorshipPolicyNote,
  };
}

export async function prepareWithdrawalActionCall(
  txHash: Hex,
  action: WithdrawalL1Action,
  networkConfig: NetworkConfig
): Promise<PreparedWithdrawalActionCall> {
  const { l1Client, l2Client, l2Chain, l1Chain, portalAddress } =
    createBaseAndL1Clients(networkConfig);

  const receipt = await l2Client.getTransactionReceipt({ hash: txHash });
  const withdrawals = getWithdrawals(receipt);
  if (withdrawals.length === 0) {
    throw new Error(
      'このトランザクションには L2ToL1MessagePasser の出金ログが含まれていません'
    );
  }
  const primary = withdrawals[0];

  const [paused, alreadyFinalized] = await Promise.all([
    l1Client
      .readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'paused',
      })
      .catch(() => false),
    l1Client.readContract({
      address: portalAddress,
      abi: OPTIMISM_PORTAL_READ_ABI,
      functionName: 'finalizedWithdrawals',
      args: [primary.withdrawalHash],
    }),
  ]);

  if (paused) {
    throw new Error(
      'OptimismPortal2 が現在緊急停止中 (paused = true) のため実行できません'
    );
  }
  if (alreadyFinalized) {
    throw new Error(
      'この出金トランザクションは既に Ethereum L1 で資金受け取り完了（finalized）しています'
    );
  }

  const withdrawalTupleArg = {
    nonce: primary.nonce,
    sender: primary.sender,
    target: primary.target,
    value: primary.value,
    gasLimit: primary.gasLimit,
    data: primary.data,
  };

  if (action === 'prove') {
    const output = await l1Client.getL2Output({
      l2BlockNumber: receipt.blockNumber,
      targetChain: l2Chain,
    });
    const proveArgs = await l2Client.buildProveWithdrawal({
      output,
      withdrawal: primary,
    });
    const gameIndex = BigInt(output.outputIndex);

    const callData = encodeFunctionData({
      abi: OPTIMISM_PORTAL_READ_ABI,
      functionName: 'proveWithdrawalTransaction',
      args: [
        proveArgs.withdrawal,
        gameIndex,
        proveArgs.outputRootProof,
        proveArgs.withdrawalProof,
      ],
    });

    const estGas = await l1Client
      .estimateContractGas({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'proveWithdrawalTransaction',
        args: [
          proveArgs.withdrawal,
          gameIndex,
          proveArgs.outputRootProof,
          proveArgs.withdrawalProof,
        ],
        account: receipt.from,
      })
      .catch(() => null);

    return {
      action: 'prove',
      portalAddress,
      resolveGameAddress: null,
      l1ChainId: l1Chain.id,
      l1ChainName: l1Chain.name,
      withdrawalHash: primary.withdrawalHash,
      callData,
      functionName: 'proveWithdrawalTransaction',
      disputeGameIndex: Number(gameIndex),
      proofSubmitterUsed: null,
      estimatedGas: estGas,
    };
  }

  // action === 'finalize': Find valid proofSubmitter via numProofSubmitters & checkWithdrawal
  const numSubsBig = await l1Client.readContract({
    address: portalAddress,
    abi: OPTIMISM_PORTAL_READ_ABI,
    functionName: 'numProofSubmitters',
    args: [primary.withdrawalHash],
  });
  const numSubs = Number(numSubsBig);
  if (numSubs === 0) {
    throw new Error(
      'まだ L1 に出金証明 (proveWithdrawalTransaction) が提出されていません。先に Prove を実行してください。'
    );
  }

  const maturityDelayBig = await l1Client
    .readContract({
      address: portalAddress,
      abi: OPTIMISM_PORTAL_READ_ABI,
      functionName: 'proofMaturityDelaySeconds',
    })
    .catch(() => 86400n);
  const nowSec = Math.floor(Date.now() / 1000);

  let validSubmitter: Address | null = null;
  let resolveGameAddress: Address | null = null;
  let lastCheckError = '';

  const checkLimit = Math.min(numSubs, 8);
  for (let i = 0; i < checkLimit; i += 1) {
    const sub = await l1Client.readContract({
      address: portalAddress,
      abi: OPTIMISM_PORTAL_READ_ABI,
      functionName: 'proofSubmitters',
      args: [primary.withdrawalHash, BigInt(i)],
    });
    try {
      await l1Client.readContract({
        address: portalAddress,
        abi: OPTIMISM_PORTAL_READ_ABI,
        functionName: 'checkWithdrawal',
        args: [primary.withdrawalHash, sub],
      });
      validSubmitter = sub;
      resolveGameAddress = null;
      break;
    } catch (err) {
      lastCheckError = err instanceof Error ? err.message : String(err);
      try {
        const proven = await l1Client.readContract({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'provenWithdrawals',
          args: [primary.withdrawalHash, sub],
        });
        const gameProxy = proven[0];
        const provenTs = Number(proven[1]);
        if (
          gameProxy &&
          gameProxy !== '0x0000000000000000000000000000000000000000' &&
          nowSec >= provenTs + Number(maturityDelayBig)
        ) {
          const teeZk = await inspectAggregateGameProxy({
            l1Client,
            proxyAddress: gameProxy,
            disputeGameIndex: null,
          });
          if (teeZk.canCallResolveNow) {
            validSubmitter = sub;
            resolveGameAddress = gameProxy;
            break;
          }
        }
      } catch {
        // Ignore fallback check failure
      }
    }
  }

  if (!validSubmitter) {
    throw new Error(
      `まだ資金受け取りの待機条件（Prove後1日成熟 ＆ 出金ゲーム解決期間［TEE+ZK両方あり: 1日 / 単一証明: 5日］）を満たしていません: ${lastCheckError.slice(
        0,
        140
      )}`
    );
  }

  const callData = encodeFunctionData({
    abi: OPTIMISM_PORTAL_READ_ABI,
    functionName: 'finalizeWithdrawalTransactionExternalProof',
    args: [withdrawalTupleArg, validSubmitter],
  });

  const estGas = resolveGameAddress
    ? 260000n
    : await l1Client
        .estimateContractGas({
          address: portalAddress,
          abi: OPTIMISM_PORTAL_READ_ABI,
          functionName: 'finalizeWithdrawalTransactionExternalProof',
          args: [withdrawalTupleArg, validSubmitter],
          account: receipt.from,
        })
        .catch(() => null);

  return {
    action: 'finalize',
    portalAddress,
    resolveGameAddress,
    l1ChainId: l1Chain.id,
    l1ChainName: l1Chain.name,
    withdrawalHash: primary.withdrawalHash,
    callData,
    functionName: 'finalizeWithdrawalTransactionExternalProof',
    disputeGameIndex: null,
    proofSubmitterUsed: validSubmitter,
    estimatedGas: estGas,
  };
}

export async function executeWithdrawalOnL1(params: {
  txHash: Hex;
  action: WithdrawalL1Action;
  settings: PimlicoExecutionSettings;
  networkConfig: NetworkConfig;
  onStep?: (stepMessage: string) => void;
}): Promise<L1ExecutionOutcome> {
  const { txHash, action, settings, networkConfig, onStep } = params;
  const { l1Client, l1Chain } = createBaseAndL1Clients(networkConfig);

  onStep?.(
    action === 'prove'
      ? 'L2 Merkle証明および L1 DisputeGame ルート証明を構築中...'
      : 'L1 OptimismPortal2 の checkWithdrawal 条件と資金受け取り引数を検証中...'
  );

  const prepared = await prepareWithdrawalActionCall(
    txHash,
    action,
    networkConfig
  );

  if (settings.mode === 'wallet') {
    onStep?.(
      `${l1Chain.name} ウォレットに接続しトランザクション署名を要求中...`
    );
    const provider = getInjectedProvider();
    const account = await ensureInjectedChain(provider, l1Chain.id);
    const walletClient = createWalletClient({
      account,
      chain: l1Chain,
      transport: custom(provider),
    });

    if (prepared.resolveGameAddress) {
      onStep?.(
        'DisputeGame.resolve() を実行してゲーム解決ステータスを確定中...'
      );
      const resolveData = encodeFunctionData({
        abi: DISPUTE_GAME_ABI,
        functionName: 'resolve',
      });
      const resolveHash = await walletClient.sendTransaction({
        account,
        chain: l1Chain,
        to: prepared.resolveGameAddress,
        data: resolveData,
        value: 0n,
      });
      await l1Client.waitForTransactionReceipt({
        hash: resolveHash,
        timeout: 180_000,
      });
      onStep?.('DisputeGame解決完了 · 続けて finalizeWithdrawalTransaction を送信中...');
    }

    const l1TxHash = await walletClient.sendTransaction({
      account,
      chain: l1Chain,
      to: prepared.portalAddress,
      data: prepared.callData,
      value: 0n,
    });

    onStep?.(
      `L1 トランザクション送信完了 (${l1TxHash.slice(
        0,
        12
      )}...) · ブロック承認を待機中...`
    );
    const txReceipt = await l1Client.waitForTransactionReceipt({
      hash: l1TxHash,
      timeout: 180_000,
    });
    if (txReceipt.status === 'reverted') {
      throw new Error(
        `L1 トランザクションが Revert しました (Tx: ${l1TxHash})`
      );
    }

    return {
      action,
      mode: 'wallet',
      l1ChainId: l1Chain.id,
      l1TxHash,
      userOpHash: null,
      smartAccountAddress: null,
      callerAddress: account,
      blockNumber: Number(txReceipt.blockNumber),
    };
  }

  // ERC-4337 Account Abstraction via Server-Side Bundler & Paymaster Proxy (Pimlico or Alchemy)
  const providerName = settings.mode === 'alchemy' ? 'alchemy' : 'pimlico';
  const proxyUrl = buildServerBundlerProxyUrl(
    providerName,
    l1Chain.id,
    settings.usePaymaster
  );

  onStep?.(
    `${
      providerName === 'pimlico' ? 'Pimlico' : 'Alchemy'
    } Bundler プロキシ接続および ERC-4337 Smart Account を初期化中...`
  );

  const { smartAccount, ownerAddress } = await createConfiguredSmartAccount({
    l1Client,
    l1Chain,
    smartAccountKind: settings.smartAccountKind,
  });

  const calls = prepared.resolveGameAddress
    ? [
        {
          to: prepared.resolveGameAddress,
          value: 0n,
          data: encodeFunctionData({
            abi: DISPUTE_GAME_ABI,
            functionName: 'resolve',
          }),
        },
        {
          to: prepared.portalAddress,
          value: 0n,
          data: prepared.callData,
        },
      ]
    : [
        {
          to: prepared.portalAddress,
          value: 0n,
          data: prepared.callData,
        },
      ];

  if (providerName === 'pimlico') {
    const pimlicoClient = createPimlicoClient({
      chain: l1Chain,
      transport: http(proxyUrl, { timeout: 30000 }),
      entryPoint: {
        address: entryPoint07Address,
        version: '0.7',
      },
    });

    const smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain: l1Chain,
      client: l1Client,
      bundlerTransport: http(proxyUrl, { timeout: 30000 }),
      paymaster: settings.usePaymaster ? pimlicoClient : undefined,
      userOperation: {
        estimateFeesPerGas: async () => {
          const prices = await pimlicoClient.getUserOperationGasPrice();
          return prices.fast;
        },
      },
    });

    onStep?.(
      settings.usePaymaster
        ? 'Pimlico Paymaster スポンサー見積取得 ＆ ウォレット署名を要求中...'
        : `Smart Account (${smartAccount.address.slice(
            0,
            10
          )}...) で UserOperation 署名を要求中...`
    );

    const userOpHash = await smartAccountClient.sendUserOperation({ calls });

    onStep?.(
      `Pimlico Bundler へ UserOperation 送信完了 (${userOpHash.slice(
        0,
        12
      )}...) · L1 バンドル確定を待機中...`
    );

    const uoReceipt = await pimlicoClient.waitForUserOperationReceipt({
      hash: userOpHash,
      timeout: 180_000,
    });

    if (!uoReceipt.success) {
      throw new Error(
        `UserOperation はバンドルされましたが内部実行で失敗しました (L1 Tx: ${uoReceipt.receipt.transactionHash})`
      );
    }

    return {
      action,
      mode: 'pimlico',
      l1ChainId: l1Chain.id,
      l1TxHash: uoReceipt.receipt.transactionHash,
      userOpHash,
      smartAccountAddress: smartAccount.address,
      callerAddress: ownerAddress,
      blockNumber: Number(uoReceipt.receipt.blockNumber),
    };
  }

  // Alchemy ERC-4337 Bundler + ERC-7677 Gas Manager Paymaster Proxy
  const alchemyPaymaster = createPaymasterClient({
    transport: http(proxyUrl, { timeout: 30000 }),
  });

  const alchemySmartAccountClient = createSmartAccountClient({
    account: smartAccount,
    chain: l1Chain,
    client: l1Client,
    bundlerTransport: http(proxyUrl, { timeout: 30000 }),
    paymaster: settings.usePaymaster ? alchemyPaymaster : undefined,
  });

  onStep?.(
    settings.usePaymaster
      ? 'Alchemy Gas Manager スポンサー見積取得 ＆ ウォレット署名を要求中...'
      : `Smart Account (${smartAccount.address.slice(
          0,
          10
        )}...) で UserOperation 署名を要求中...`
  );

  const userOpHash = await alchemySmartAccountClient.sendUserOperation({ calls });

  onStep?.(
    `Alchemy Bundler へ UserOperation 送信完了 (${userOpHash.slice(
      0,
      12
    )}...) · L1 バンドル確定を待機中...`
  );

  const uoReceipt = await alchemySmartAccountClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 180_000,
  });

  if (!uoReceipt.success) {
    throw new Error(
      `UserOperation はバンドルされましたが内部実行で失敗しました (L1 Tx: ${uoReceipt.receipt.transactionHash})`
    );
  }

  return {
    action,
    mode: 'alchemy',
    l1ChainId: l1Chain.id,
    l1TxHash: uoReceipt.receipt.transactionHash,
    userOpHash,
    smartAccountAddress: smartAccount.address,
    callerAddress: ownerAddress,
    blockNumber: Number(uoReceipt.receipt.blockNumber),
  };
}
