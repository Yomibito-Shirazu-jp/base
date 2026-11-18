export function FinalityGuideSection() {
  return (
    <section className="space-y-6 max-w-4xl">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <h2 className="text-xl font-bold text-slate-900">
          Base (OP Stack) オンチェーン・ファイナライズ検証の仕組み
        </h2>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">
          本ツールは外部のエクスプローラーAPIや中央集権型インデクサーに依存せず、Base L2ノード（op-geth / op-node）および Ethereum L1 ノードの標準 JSON-RPC をブラウザから直接バッチ呼び出しして、トランザクションの確定性を検証します。
        </p>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-amber-700">Stage 1 · Unsafe Head</div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">L2 シーケンサー承認</h3>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              <span className="font-mono text-slate-800">eth_getBlockByNumber("latest")</span>{' '}
              以下かつ <span className="font-mono text-slate-800">safe</span>{' '}
              より新しいブロック。約2秒で生成されますが、L1へのバッチ投稿前のため理論上のリオーグ余地があります。
            </p>
          </div>

          <div className="border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-sky-700">Stage 2 · Safe Head</div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">L1 バッチ投稿・導出済み</h3>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              <span className="font-mono text-slate-800">eth_getBlockByNumber("safe")</span>{' '}
              以下のブロック。L2バッチがEthereum L1のBlobまたはCalldataに書き込まれ、L1から一意に再構成可能な状態です。
            </p>
          </div>

          <div className="border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-emerald-700">Stage 3 · Finalized Head</div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">Ethereum L1 コンセンサス確定</h3>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              <span className="font-mono text-slate-800">eth_getBlockByNumber("finalized")</span>{' '}
              以下のブロック。バッチを格納したL1ブロックがCasper FFGにより確定（約13〜15分）し、不可逆となります。
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          使用しているオンチェーン JSON-RPC メソッドとコントラクト
        </h3>
        <dl className="divide-y divide-slate-100 text-xs sm:text-sm">
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">eth_getBlockByNumber</dt>
            <dd className="sm:col-span-2 text-slate-600">
              <span className="font-mono text-slate-800">"finalized"</span> /{' '}
              <span className="font-mono text-slate-800">"safe"</span> /{' '}
              <span className="font-mono text-slate-800">"latest"</span>{' '}
              タグをバッチ取得し、各トランザクションの収録ブロック番号と比較してファイナリティ段階を算出します。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              eth_getTransactionReceipt
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              EVMの実行成否（<span className="font-mono text-slate-800">status: 0x1 / 0x0</span>）およびOP Stack固有の{' '}
              <span className="font-mono text-slate-800">l1Fee</span>（L1データ投稿手数料）を直接読み取ります。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              L1Block Predeploy (0x4200...0015)
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              対象L2ブロック時点で参照していたEthereum L1 Originブロック番号（
              <span className="font-mono text-slate-800">number()</span>）を{' '}
              <span className="font-mono text-slate-800">eth_call</span>{' '}
              で読み取り、L1側のFinalizedブロックとも照合します。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-medium text-slate-900">出金 (L2 → L1) に関する補足</dt>
            <dd className="sm:col-span-2 text-slate-600">
              通常の入金・スワップ・送金等の確定確認には{' '}
              <strong className="text-slate-800">Finalized (約13〜15分)</strong>{' '}
              で十分な不可逆性を持ちます。ただし、ネイティブブリッジ（OptimismPortal2）経由のL2→L1出金をL1側で最終クレームする操作には、別途7日間のFault Proofチャレンジ期間が必要です。
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
