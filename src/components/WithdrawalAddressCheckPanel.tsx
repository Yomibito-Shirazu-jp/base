import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { NetworkConfig, WithdrawalAddressCheckItem } from '../types/finality';
import {
  PRESET_24_WITHDRAWAL_ADDRESSES,
  parseAddressBatchInput,
  verifyWithdrawalAddressesBatch,
} from '../lib/addressChecker';
import { shortenHex } from '../lib/exportUtils';

interface WithdrawalAddressCheckPanelProps {
  networkConfig: NetworkConfig;
}

export function WithdrawalAddressCheckPanel({
  networkConfig,
}: WithdrawalAddressCheckPanelProps) {
  const [rawInput, setRawInput] = useState<string>(() =>
    PRESET_24_WITHDRAWAL_ADDRESSES.join('\n')
  );
  const [items, setItems] = useState<WithdrawalAddressCheckItem[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const parsedAddresses = useMemo(
    () => parseAddressBatchInput(rawInput),
    [rawInput]
  );

  const summaryCounts = useMemo(() => {
    let safe = 0;
    let caution = 0;
    let blocked = 0;
    for (const item of items) {
      if (item.status === 'safe') safe += 1;
      else if (item.status === 'caution') caution += 1;
      else blocked += 1;
    }
    return { total: items.length, safe, caution, blocked };
  }, [items]);

  const handleRunCheck = async (targetList?: string[]) => {
    const list = targetList ?? parsedAddresses;
    if (list.length === 0) return;
    setIsChecking(true);
    setCheckError(null);
    setProgress({ completed: 0, total: list.length });
    try {
      const res = await verifyWithdrawalAddressesBatch(
        list,
        networkConfig,
        (completed, total) => setProgress({ completed, total })
      );
      setItems(res);
    } catch (err) {
      setCheckError(
        err instanceof Error
          ? err.message
          : '出金アドレスのオンチェーン照会に失敗しました'
      );
    } finally {
      setIsChecking(false);
      setProgress(null);
    }
  };

  const handleCopy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopiedAddr(addr);
      setTimeout(() => setCopiedAddr(null), 1500);
    } catch {
      // Ignore clipboard errors
    }
  };

  const handleExportCsv = () => {
    if (items.length === 0) return;
    const header = [
      'index',
      'address',
      'status',
      'l1Kind',
      'l1DelegateOrCodeInfo',
      'l2Kind',
      'l1Nonce',
      'l2Nonce',
      'l1EthBalance',
      'l2EthBalance',
      'l1EthReceivable',
      'l1UsdtBlacklisted',
      'l1UsdcBlacklisted',
      'notes',
    ];
    const rows = items.map((r) =>
      [
        r.index,
        r.address,
        r.status,
        r.l1Kind,
        r.l1DelegateOrCodeInfo ?? '',
        r.l2Kind,
        r.l1Nonce,
        r.l2Nonce,
        r.l1EthBalance,
        r.l2EthBalance,
        r.l1EthReceivable,
        r.l1UsdtBlacklisted,
        r.l1UsdcBlacklisted,
        `"${r.notes.join(' / ').replace(/"/g, '""')}"`,
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `withdrawal-address-audit-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      aria-label="出金先・送信元アドレス オンチェーン一括チェック"
      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <h3 className="text-base font-bold text-slate-900">
            出金アドレス・オンチェーン一括チェック（Ethereum L1 ＆ Base L2）
          </h3>
          <p className="mt-1 text-xs text-slate-600 leading-relaxed">
            L1受取アドレス・送信元アドレスの <strong>EOA / EIP-7702委任 / コントラクト種別</strong>、
            L1 <span className="font-mono text-slate-800">L1StandardBridge</span> からの ETH 受取可否、および
            <strong> USDT / USDC 凍結（ブラックリスト）該当有無</strong> を直接照会します。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              const joined = PRESET_24_WITHDRAWAL_ADDRESSES.join('\n');
              setRawInput(joined);
              handleRunCheck(PRESET_24_WITHDRAWAL_ADDRESSES);
            }}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
            <span>指定24アドレスを読込・再検査</span>
          </button>

          {items.length > 0 && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV出力</span>
            </button>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="withdrawal-address-check-input" className="sr-only">
          チェック対象アドレス一覧
        </label>
        <textarea
          id="withdrawal-address-check-input"
          rows={4}
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          placeholder="0x... 形式の Ethereum / Base アドレスを改行またはカンマ区切りで貼り付け"
          className="w-full px-4 py-3 text-xs font-mono leading-relaxed bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 placeholder:font-sans focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0052FF] focus:border-transparent transition-colors resize-y"
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
          <span>
            抽出アドレス数:{' '}
            <strong className="text-slate-900">
              {parsedAddresses.length.toLocaleString()}件
            </strong>
          </span>
          {progress && isChecking && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[#0052FF] font-medium">
                オンチェーン照会中 ({progress.completed}/{progress.total})
              </span>
            </>
          )}
          {items.length > 0 && !isChecking && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-700 font-medium">
                問題なし: {summaryCounts.safe}件
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-amber-700 font-medium">
                EIP-7702/構成確認: {summaryCounts.caution}件
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-red-700 font-medium">
                着金阻害: {summaryCounts.blocked}件
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {rawInput.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setRawInput('');
                setItems([]);
              }}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>クリア</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleRunCheck()}
            disabled={isChecking || parsedAddresses.length === 0}
            className="inline-flex items-center justify-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-[#0052FF] hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {isChecking ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>L1/L2 オンチェーン照会中...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>アドレスを一括チェック ({parsedAddresses.length}件)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {checkError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-xl px-4 py-3"
        >
          アドレス検査エラー: {checkError}
        </div>
      )}

      {items.length > 0 && (
        <div className="border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 pl-4 pr-2 w-10 text-right tabular-nums">#</th>
                <th className="py-2.5 px-3">アドレス</th>
                <th className="py-2.5 px-3">Ethereum L1 種別</th>
                <th className="py-2.5 px-3">Base L2 種別</th>
                <th className="py-2.5 px-3 text-right">L1 / L2 Nonce</th>
                <th className="py-2.5 px-3 text-right">L1 / L2 ETH残高</th>
                <th className="py-2.5 px-3">着金・凍結チェック</th>
                <th className="py-2.5 pl-2 pr-4">監査判定・備考</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {items.map((row) => (
                <tr key={`${row.index}-${row.address}`} className="hover:bg-slate-50/80">
                  <td className="py-2.5 pl-4 pr-2 text-right font-mono tabular-nums text-slate-400">
                    {row.index}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="font-mono font-medium text-slate-900"
                        title={row.address}
                      >
                        {shortenHex(row.address, 8, 6)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(row.address)}
                        aria-label="アドレスをコピー"
                        className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                      >
                        {copiedAddr === row.address ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {networkConfig.l1ExplorerUrl && (
                        <a
                          href={`${networkConfig.l1ExplorerUrl}/address/${row.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Etherscanで表示"
                          className="p-1 text-slate-400 hover:text-[#0052FF] rounded"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap font-mono">
                    <span
                      className={
                        row.l1Kind === 'EIP-7702'
                          ? 'text-amber-800 font-semibold'
                          : row.l1Kind === 'Contract'
                          ? 'text-[#0052FF] font-semibold'
                          : 'text-slate-800'
                      }
                    >
                      {row.l1Kind}
                    </span>
                    {row.l1DelegateOrCodeInfo && (
                      <div
                        className="text-[11px] text-slate-500 truncate max-w-44"
                        title={row.l1DelegateOrCodeInfo}
                      >
                        {row.l1DelegateOrCodeInfo}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap font-mono text-slate-800">
                    <span>{row.l2Kind}</span>
                    {row.l2DelegateOrCodeInfo && (
                      <div className="text-[11px] text-slate-500">
                        {row.l2DelegateOrCodeInfo}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap text-slate-700">
                    {row.l1Nonce} / {row.l2Nonce}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap text-slate-700">
                    {row.l1EthBalance} / {row.l2EthBalance}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap font-mono text-[11px] text-slate-600">
                    <span>ETH受取: {row.l1EthReceivable ? 'OK' : 'NG'}</span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      凍結: {row.l1UsdtBlacklisted || row.l1UsdcBlacklisted ? 'あり' : 'なし'}
                    </span>
                  </td>
                  <td className="py-2.5 pl-2 pr-4">
                    <div className="flex items-start gap-1.5">
                      {row.status === 'safe' ? (
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
                      ) : row.status === 'caution' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-red-700 shrink-0 mt-0.5" />
                      )}
                      <span
                        className={`leading-relaxed ${
                          row.status === 'safe'
                            ? 'text-emerald-800'
                            : row.status === 'caution'
                            ? 'text-amber-800 font-medium'
                            : 'text-red-800 font-semibold'
                        }`}
                      >
                        {row.notes.join(' / ')}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
