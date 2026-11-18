import {
  type Address,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem';
import { NetworkConfig, WithdrawalAddressCheckItem } from '../types/finality';
import { createBaseAndL1Clients } from './withdrawalAnalyzer';

const L1_USDT_MAINNET = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address;
const L1_USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;

const TOKEN_AUDIT_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function isBlackListed(address _maker) view returns (bool)',
  'function isBlacklisted(address _account) view returns (bool)',
]);

export const PRESET_24_WITHDRAWAL_ADDRESSES = [
  '0x12241AA491DFaD9e2F0bF5E7F718235F0313A0E7',
  '0xaB26677A2f6239E1f50F8ce5ab32eEa938EEf0B5',
  '0x11e068bB3c3531c8bbB2b8EDD9B8E88F8BB49ADd',
  '0x8cfE888696D5c8ea29BDb3152B2A790Cdb2d0966',
  '0x4FD9F3A47fb5B341B33888524760A531Ebb1b0e0',
  '0xB7F96bfAe31f79DfDC86a308c5969d679c9f0a52',
  '0xE5bB802c7163503aB0eE1732975F1FbA1dFfB611',
  '0x8Cf331d1DD602EE9f1Eb259449c2597E89CcfeB9',
  '0xf960C5F6BBEe1b970E7145767e28E984825165D4',
  '0xA9b4141A7dE4BD85Ac4F8E414971A1d63aE23A29',
  '0x447651A27C18745B6B0F3ac0E0a0931eD0Ea285D',
  '0x7376A27B75FbF91d78Dd643634Ca7A65170d5151',
  '0x62ba4b4F5D165cDb8d96F9Ac590F676855C0294c',
  '0xa31Bcf77C66Db70814Be11DCC6cAcA7749039DdF',
  '0xF6Ae11ca05e6B0A7D69b7040290999F950918411',
  '0x3DfeC96Cf2806E813c17A7a2cE702a40C964b506',
  '0x2831a73887cc02F1E3ffD3C28061DCaF34BCbcbe',
  '0x5b57b56724b6Cc9516E7A45c65d98f67907d117C',
  '0x534A6ecb23B16fB7F05C338C92EE039b8586CFbD',
  '0xD6E79F6f59D5AA89a5993287Cef4f65BdE674D6f',
  '0x2d5f11f3ea2D40A79855d001e45CAFd25dfea051',
  '0x6044299347456fa3534dA4164a860B9e827fBE02',
  '0x934eaB444aC6eDa48af7FA2f89333757DBfBed52',
  '0x715924E12A2e4Cc2C59AFf61d44B98DC2b18dc72',
];

export function parseAddressBatchInput(rawInput: string): string[] {
  const matches = rawInput.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(isAddress(m) ? getAddress(m) : m);
    }
  }
  return unique;
}

function classifyBytecode(bytecode: string | undefined): {
  kind: 'EOA' | 'EIP-7702' | 'Contract';
  info: string | null;
} {
  if (!bytecode || bytecode === '0x') {
    return { kind: 'EOA', info: null };
  }
  const lower = bytecode.toLowerCase();
  if (lower.startsWith('0xef0100') && lower.length === 48) {
    const delegated = getAddress(`0x${lower.slice(8)}`);
    return {
      kind: 'EIP-7702',
      info: `委任先: ${delegated}`,
    };
  }
  const byteLen = Math.max(0, (bytecode.length - 2) / 2);
  return {
    kind: 'Contract',
    info: `${byteLen.toLocaleString()} bytes`,
  };
}

function formatCompactEth(wei: bigint): string {
  const num = Number(formatEther(wei));
  if (num === 0) return '0';
  if (num >= 0.0001) {
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return '<0.0001';
}

function formatCompactUnits(raw: bigint, decimals: number): string {
  const num = Number(formatUnits(raw, decimals));
  if (num === 0) return '0';
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export async function verifyWithdrawalAddressesBatch(
  rawAddresses: string[],
  config: NetworkConfig,
  onProgress?: (completed: number, total: number) => void
): Promise<WithdrawalAddressCheckItem[]> {
  const { l1Client, l2Client, l1Chain, defaultL1Bridge } =
    createBaseAndL1Clients(config);
  const isMainnetL1 = l1Chain.id === 1;

  const results: WithdrawalAddressCheckItem[] = new Array(rawAddresses.length);
  const concurrency = 6;
  let completed = 0;

  for (let start = 0; start < rawAddresses.length; start += concurrency) {
    const slice = rawAddresses.slice(start, start + concurrency);
    await Promise.all(
      slice.map(async (rawAddr, offset) => {
        const idx = start + offset;
        if (!isAddress(rawAddr)) {
          results[idx] = {
            index: idx + 1,
            address: rawAddr,
            isValidAddress: false,
            l1Kind: 'Invalid',
            l2Kind: 'Invalid',
            l1DelegateOrCodeInfo: null,
            l2DelegateOrCodeInfo: null,
            l1Nonce: 0,
            l2Nonce: 0,
            l1EthBalance: '0',
            l2EthBalance: '0',
            l1UsdtBalance: '0',
            l1UsdcBalance: '0',
            l1EthReceivable: false,
            l1UsdtBlacklisted: false,
            l1UsdcBlacklisted: false,
            status: 'blocked',
            notes: ['無効なアドレス形式です'],
          };
          completed += 1;
          onProgress?.(completed, rawAddresses.length);
          return;
        }

        const addr = getAddress(rawAddr);
        const [
          l1Code,
          l2Code,
          l1Nonce,
          l2Nonce,
          l1Bal,
          l2Bal,
          ethRecvOk,
          usdtBal,
          usdcBal,
          usdtBl,
          usdcBl,
        ] = await Promise.all([
          l1Client.getCode({ address: addr }).catch(() => '0x' as const),
          l2Client.getCode({ address: addr }).catch(() => '0x' as const),
          l1Client.getTransactionCount({ address: addr }).catch(() => 0),
          l2Client.getTransactionCount({ address: addr }).catch(() => 0),
          l1Client.getBalance({ address: addr }).catch(() => 0n),
          l2Client.getBalance({ address: addr }).catch(() => 0n),
          l1Client
            .call({
              account: defaultL1Bridge,
              to: addr,
              value: 1n,
              gas: 100000n,
              stateOverride: [
                {
                  address: defaultL1Bridge,
                  balance: 10n * 10n ** 18n,
                },
              ],
            })
            .then(() => true)
            .catch(() => false),
          isMainnetL1
            ? l1Client
                .readContract({
                  address: L1_USDT_MAINNET,
                  abi: TOKEN_AUDIT_ABI,
                  functionName: 'balanceOf',
                  args: [addr],
                })
                .catch(() => 0n)
            : Promise.resolve(0n),
          isMainnetL1
            ? l1Client
                .readContract({
                  address: L1_USDC_MAINNET,
                  abi: TOKEN_AUDIT_ABI,
                  functionName: 'balanceOf',
                  args: [addr],
                })
                .catch(() => 0n)
            : Promise.resolve(0n),
          isMainnetL1
            ? l1Client
                .readContract({
                  address: L1_USDT_MAINNET,
                  abi: TOKEN_AUDIT_ABI,
                  functionName: 'isBlackListed',
                  args: [addr],
                })
                .catch(() => false)
            : Promise.resolve(false),
          isMainnetL1
            ? l1Client
                .readContract({
                  address: L1_USDC_MAINNET,
                  abi: TOKEN_AUDIT_ABI,
                  functionName: 'isBlacklisted',
                  args: [addr],
                })
                .catch(() => false)
            : Promise.resolve(false),
        ]);

        const l1Class = classifyBytecode(l1Code);
        const l2Class = classifyBytecode(l2Code);

        const notes: string[] = [];
        let status: 'safe' | 'caution' | 'blocked' = 'safe';

        if (!ethRecvOk) {
          status = 'blocked';
          notes.push('L1コントラクトへのETH送金 (receive/fallback) が Revert します');
        }
        if (usdtBl) {
          status = 'blocked';
          notes.push('Ethereum L1 USDT ブラックリスト該当 (isBlackListed = true)');
        }
        if (usdcBl) {
          status = 'blocked';
          notes.push('Ethereum L1 USDC ブラックリスト該当 (isBlacklisted = true)');
        }

        if (l1Class.kind === 'EIP-7702') {
          if (status === 'safe') status = 'caution';
          notes.push(
            `L1側に EIP-7702 コード委任あり (${l1Class.info}) · ETH/ERC20着金は可能ですが本人の意図した委任か要確認`
          );
        } else if (l1Class.kind === 'Contract' && l2Class.kind === 'EOA') {
          if (status === 'safe') status = 'caution';
          notes.push('L1がスマートコントラクト・Base L2がEOA（同一アドレス運用か要確認）');
        } else if (l1Class.kind === 'EOA' && l2Class.kind === 'Contract') {
          if (status === 'safe') status = 'caution';
          notes.push(
            'Base L2スマートウォレット (AA) でL1側が未デプロイEOA（L2出金時に _to を明示指定しているか確認推奨）'
          );
        }

        if (notes.length === 0) {
          notes.push(
            'L1/L2 純粋EOA · ETH受取OK · USDT/USDCブラックリスト該当なし（着金阻害なし）'
          );
        }

        results[idx] = {
          index: idx + 1,
          address: addr,
          isValidAddress: true,
          l1Kind: l1Class.kind,
          l2Kind: l2Class.kind,
          l1DelegateOrCodeInfo: l1Class.info,
          l2DelegateOrCodeInfo: l2Class.info,
          l1Nonce,
          l2Nonce,
          l1EthBalance: formatCompactEth(l1Bal),
          l2EthBalance: formatCompactEth(l2Bal),
          l1UsdtBalance: formatCompactUnits(usdtBal, 6),
          l1UsdcBalance: formatCompactUnits(usdcBal, 6),
          l1EthReceivable: ethRecvOk,
          l1UsdtBlacklisted: Boolean(usdtBl),
          l1UsdcBlacklisted: Boolean(usdcBl),
          status,
          notes,
        };

        completed += 1;
        onProgress?.(completed, rawAddresses.length);
      })
    );
  }

  return results;
}
