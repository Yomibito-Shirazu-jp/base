export function FinalityGuideSection() {
  return (
    <section className="space-y-6 max-w-4xl">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <h2 className="text-xl font-bold text-slate-900">
          Base (OP Stack) オンチェーン検証アーキテクチャ
        </h2>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">
          Base では、通常のL2トランザクション確定（Casper FFG バッチ確定）と、Ethereum L1 で資産を引き出すブリッジ出金検証（OptimismPortal2）はスマートコントラクト上まったく独立した仕組みで動作します。本ツールはそれぞれの実システムと同一のオンチェーン条件のみを直接照会します。
        </p>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-amber-700">Stage 1 · Unsafe Head</div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">L2 シーケンサー承認</h3>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              <span className="font-mono text-slate-800">eth_getBlockByNumber("latest")</span>{' '}
              以下かつ <span className="font-mono text-slate-800">safe</span>{' '}
              より新しいブロック。約2秒で生成されますが、L1へのバッチ投稿前の段階です。
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
              以下のブロック。バッチを格納したL1ブロックがCasper FFGにより確定（約13〜15分）し、通常の送金・スワップは不可逆となります。
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          L2 → L1 出金検証（OptimismPortal2.sol &amp; AggregateVerifier）の実コントラクト4要件
        </h3>
        <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
          出金検証では L2 の Safe / Finalized ヘッドや L1Block Predeploy などの無関係な項目は一切使用せず、実際に L1 で資産を引き出すコントラクト実装（<span className="font-mono text-slate-800">OptimismPortal2</span>）と完全に同一の4要件のみを検証します。
        </p>
        <dl className="divide-y divide-slate-100 text-xs sm:text-sm">
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              1. L2ToL1MessagePasser (0x4200...0016)
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              <span className="font-mono text-slate-800">sentMessages[withdrawalHash] == true</span>{' '}
              の記録および <span className="font-mono text-slate-800">eth_getProof</span>{' '}
              によるストレージスロット（<span className="font-mono text-slate-800">keccak256(abi.encode(hash, 0)) == 1</span>）の Merkle Patricia Trie 証明を検証します。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              2. OptimismPortal2 ガード要件
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              <span className="font-mono text-slate-800">!paused()</span>、呼び出し先{' '}
              <span className="font-mono text-slate-800">target != address(OptimismPortal2)</span>、および二重受け取り防止{' '}
              <span className="font-mono text-slate-800">finalizedWithdrawals[withdrawalHash] == false</span>{' '}
              を確認します。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              3. DisputeGameFactory &amp; AggregateVerifier (TEE / ZK)
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              <span className="font-mono text-slate-800">provenWithdrawals</span> に紐づく{' '}
              <span className="font-mono text-slate-800">DisputeGameProxy</span> について、
              <span className="font-mono text-slate-800">!disputeGameBlacklist</span>・
              <span className="font-mono text-slate-800">wasRespectedGameTypeWhenCreated</span>・ゲーム勝敗ステータス、およびマルチプルーフ証明状態（<strong>単一証明: 5日 = 432,000秒 ／ TEE + ZK 二重証明: 1日 = 86,400秒</strong>）を照合します。
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <dt className="font-mono font-medium text-slate-900">
              4. checkWithdrawal &amp; Finalize 実行検証
            </dt>
            <dd className="sm:col-span-2 text-slate-600">
              Prove 提出からの成熟待機（<span className="font-mono text-slate-800">proofMaturityDelaySeconds = 86,400秒 (1日)</span>）およびゲーム解決後の{' '}
              <span className="font-mono text-slate-800">OptimismPortal2.checkWithdrawal(withdrawalHash, proofSubmitter)</span>{' '}
              と <span className="font-mono text-slate-800">finalizeWithdrawalTransactionExternalProof</span>{' '}
              のオンチェーン通過可否を直接検証します。
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
