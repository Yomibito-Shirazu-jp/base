import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import { adminAuth } from './src/lib/firebase-admin.ts';
import { getOrCreateUser } from './src/db/users.ts';
import {
  appendChatMessagesForUser,
  clearChatMessagesForUser,
  clearVerificationRunsForUser,
  clearVerifiedTxsForUser,
  getChatMessagesForUser,
  getVerificationRunsForUser,
  getVerifiedTxsByHashes,
  getVerifiedTxsForUsers,
  getWorkspaceForUser,
  purgePartialVerifiedTxsForUsers,
  saveVerificationRunForUser,
  upsertVerifiedTxsForUser,
  upsertWorkspaceForUser,
  type VerifiedTxInput,
} from './src/db/repositories.ts';
import {
  runGroundedProtocolSearch,
  runMultiTurnAuditChat,
  type GeminiChatModel,
} from './src/lib/gemini.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_getProof',
  'eth_getCode',
  'eth_call',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionCount',
  'net_version',
]);

const ALLOWED_BUNDLER_METHODS = new Set([
  ...ALLOWED_METHODS,
  'eth_sendUserOperation',
  'eth_estimateUserOperationGas',
  'eth_getUserOperationByHash',
  'eth_getUserOperationReceipt',
  'eth_supportedEntryPoints',
  'pm_sponsorUserOperation',
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
  'pm_validateSponsorshipPolicies',
  'pimlico_getUserOperationGasPrice',
  'pimlico_getUserOperationStatus',
  'pimlico_sendCompressedUserOperation',
  'rundler_maxPriorityFeePerGas',
  'alchemy_requestGasAndPaymasterAndData',
  'alchemy_requestPaymasterAndData',
]);

interface JsonRpcItem {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

function getEnvTrimmed(...names: string[]): string {
  for (const name of names) {
    const val = process.env[name];
    if (val && val.trim()) return val.trim();
  }
  return '';
}

function resolveServerAlchemyRpc(chainId: number): string | null {
  const key = getEnvTrimmed('alchemy_api_key', 'ALCHEMY_API_KEY');
  if (!key) return null;
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key;
  }
  switch (chainId) {
    case 1:
      return `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(key)}`;
    case 11155111:
      return `https://eth-sepolia.g.alchemy.com/v2/${encodeURIComponent(key)}`;
    case 8453:
      return `https://base-mainnet.g.alchemy.com/v2/${encodeURIComponent(key)}`;
    case 84532:
      return `https://base-sepolia.g.alchemy.com/v2/${encodeURIComponent(key)}`;
    default:
      return null;
  }
}

function resolveServerPimlicoUrl(chainId: number): string | null {
  const apiKey = getEnvTrimmed('pimlico_api_key', 'PIMLICO_API_KEY');
  const directUrl =
    chainId === 1
      ? getEnvTrimmed('pimlico_rpc_eth', 'PIMLICO_RPC_ETH')
      : chainId === 8453
      ? getEnvTrimmed('pimlico_rpc_base', 'PIMLICO_RPC_BASE')
      : '';

  if (directUrl) {
    if (
      apiKey &&
      !apiKey.startsWith('http') &&
      directUrl.includes('pimlico.io') &&
      !directUrl.includes('apikey=')
    ) {
      const sep = directUrl.includes('?') ? '&' : '?';
      return `${directUrl}${sep}apikey=${encodeURIComponent(apiKey)}`;
    }
    return directUrl;
  }

  if (apiKey) {
    if (apiKey.startsWith('http://') || apiKey.startsWith('https://')) {
      return apiKey;
    }
    return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(
      apiKey
    )}`;
  }

  return null;
}

function getUpstreamUrls(chainKey: string): string[] {
  switch (chainKey) {
    case 'base-mainnet':
      return [
        getEnvTrimmed('BASE_MAINNET_RPC_URL'),
        resolveServerAlchemyRpc(8453),
        'https://mainnet.base.org',
        'https://base-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'eth-mainnet':
      return [
        getEnvTrimmed('ETH_MAINNET_RPC_URL'),
        resolveServerAlchemyRpc(1),
        'https://ethereum-rpc.publicnode.com',
        'https://eth.drpc.org',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'base-sepolia':
      return [
        getEnvTrimmed('BASE_SEPOLIA_RPC_URL'),
        resolveServerAlchemyRpc(84532),
        'https://sepolia.base.org',
        'https://base-sepolia-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'eth-sepolia':
      return [
        getEnvTrimmed('ETH_SEPOLIA_RPC_URL'),
        resolveServerAlchemyRpc(11155111),
        'https://ethereum-sepolia-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    default:
      return [];
  }
}

function validateRpcPayload(
  body: unknown,
  allowedSet: Set<string> = ALLOWED_METHODS
): boolean {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > 100) return false;
  for (const item of items) {
    if (!item || typeof item !== 'object') return false;
    const rpc = item as JsonRpcItem;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return false;
    if (!allowedSet.has(rpc.method)) return false;
  }
  return true;
}

function injectPaymasterPolicyIntoRpcBody(
  provider: 'pimlico' | 'alchemy',
  body: unknown,
  enablePolicy: boolean
): unknown {
  if (!enablePolicy) return body;

  const pimlicoPolicy = getEnvTrimmed('pimlico_Policy_ID', 'PIMLICO_POLICY_ID');
  const alchemyPolicy = getEnvTrimmed('alchemy_Policy_eth', 'ALCHEMY_POLICY_ETH');

  const transformItem = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = { ...(raw as JsonRpcItem) };
    if (!Array.isArray(item.params)) return item;
    const params = [...item.params];

    if (
      item.method === 'pm_getPaymasterStubData' ||
      item.method === 'pm_getPaymasterData'
    ) {
      const existingCtx =
        params[3] && typeof params[3] === 'object'
          ? (params[3] as Record<string, unknown>)
          : {};
      if (provider === 'pimlico' && pimlicoPolicy && !existingCtx.sponsorshipPolicyId) {
        params[3] = { ...existingCtx, sponsorshipPolicyId: pimlicoPolicy };
      } else if (provider === 'alchemy' && alchemyPolicy && !existingCtx.policyId) {
        params[3] = { ...existingCtx, policyId: alchemyPolicy };
      }
      item.params = params;
    } else if (item.method === 'pm_sponsorUserOperation' && provider === 'pimlico') {
      const existingCtx =
        params[2] && typeof params[2] === 'object'
          ? (params[2] as Record<string, unknown>)
          : {};
      if (pimlicoPolicy && !existingCtx.sponsorshipPolicyId) {
        params[2] = { ...existingCtx, sponsorshipPolicyId: pimlicoPolicy };
        item.params = params;
      }
    }
    return item;
  };

  return Array.isArray(body) ? body.map(transformItem) : transformItem(body);
}

async function resolveOptionalUserId(req: Request): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await adminAuth.verifyIdToken(token);
    const dbUser = await getOrCreateUser(decoded.uid, decoded.email ?? '');
    return dbUser.id;
  } catch {
    return null;
  }
}

const GLOBAL_VERIFIED_CACHE_UID = '__global_verified_cache__';
const GLOBAL_VERIFIED_CACHE_EMAIL = 'verified-cache@system.local';

async function resolveCacheUserIds(req: Request): Promise<number[]> {
  const [optionalUserId, globalUser] = await Promise.all([
    resolveOptionalUserId(req),
    getOrCreateUser(GLOBAL_VERIFIED_CACHE_UID, GLOBAL_VERIFIED_CACHE_EMAIL),
  ]);
  if (optionalUserId !== null && optionalUserId !== globalUser.id) {
    return [optionalUserId, globalUser.id];
  }
  return [globalUser.id];
}

function isValidPayloadJsonRecord(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  const rel = p.reliability as Record<string, unknown> | undefined;
  if (rel?.tier === 'partial') return false;
  if (p.errorReason) return false;

  const finality = String(p.finality || '');
  if (
    finality === 'rpc_error' ||
    finality === 'not_found' ||
    finality === 'invalid'
  ) {
    return false;
  }

  const execStatus = String(p.executionStatus || '');
  if (execStatus === 'unknown' || execStatus === 'pending') {
    return false;
  }

  const caveat = typeof rel?.caveat === 'string' ? rel.caveat : '';
  const hasWithdrawalSignal = Boolean(
    p.withdrawal ||
      p.hasWithdrawalLog === true ||
      caveat.includes('L2ToL1MessagePasser') ||
      caveat.includes('OptimismPortal2')
  );

  if (hasWithdrawalSignal) {
    const w = p.withdrawal as Record<string, unknown> | null | undefined;
    if (!w || typeof w !== 'object') return false;
    if (!w.validation || typeof w.validation !== 'object') return false;
    if (w.usedFallbackDelay === true) return false;
    const val = w.validation as Record<string, unknown>;
    if (w.portalFinalized !== true && val.portalTopLevelFinalizePassed === undefined) {
      return false;
    }
    if (
      w.portalFinalized !== true &&
      (val.recipientBalanceIncreased === false ||
        val.outerPortalRelaySimulated === false) &&
      val.canWithdrawAfterWait === true
    ) {
      return false;
    }
    const wData = typeof w.data === 'string' ? w.data.toLowerCase() : '';
    if (
      wData.startsWith('0xd764ad0b') &&
      (!Array.isArray(val.cdmHops) || val.cdmHops.length === 0)
    ) {
      return false;
    }
    const recipLower =
      typeof w.l1Recipient === 'string' ? w.l1Recipient.toLowerCase() : '';
    if (
      w.assetType === 'MESSAGE' &&
      (recipLower === '0x866e82a600a1414e583f7f13623f1ac5d58b0afa' ||
        recipLower === '0x58cc85b8d04ea49cc6dbad3fbffd00fb78839fc9')
    ) {
      return false;
    }
  }

  return true;
}

function isValidDbTxInput(item: VerifiedTxInput): boolean {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item.txHash)) {
    return false;
  }
  if (item.reliabilityTier === 'partial') return false;
  if (
    item.finality === 'rpc_error' ||
    item.finality === 'not_found' ||
    item.finality === 'invalid'
  ) {
    return false;
  }
  if (
    item.executionStatus === 'unknown' ||
    item.executionStatus === 'pending'
  ) {
    return false;
  }
  if (item.isWithdrawal && !(item.payloadJson as Record<string, unknown>)?.withdrawal) {
    return false;
  }
  return isValidPayloadJsonRecord(item.payloadJson);
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '4mb' }));

  app.get('/api/rpc/status', (_req: Request, res: Response) => {
    res.json({
      baseMainnetConfigured: Boolean(
        getEnvTrimmed('BASE_MAINNET_RPC_URL') || resolveServerAlchemyRpc(8453)
      ),
      ethMainnetConfigured: Boolean(
        getEnvTrimmed('ETH_MAINNET_RPC_URL') || resolveServerAlchemyRpc(1)
      ),
    });
  });

  app.get('/api/aa/status', (_req: Request, res: Response) => {
    res.json({
      pimlicoEthConfigured: Boolean(resolveServerPimlicoUrl(1)),
      pimlicoSepoliaConfigured: Boolean(resolveServerPimlicoUrl(11155111)),
      pimlicoBaseConfigured: Boolean(resolveServerPimlicoUrl(8453)),
      pimlicoPolicyConfigured: Boolean(
        getEnvTrimmed('pimlico_Policy_ID', 'PIMLICO_POLICY_ID')
      ),
      alchemyEthConfigured: Boolean(resolveServerAlchemyRpc(1)),
      alchemySepoliaConfigured: Boolean(resolveServerAlchemyRpc(11155111)),
      alchemyPolicyConfigured: Boolean(
        getEnvTrimmed('alchemy_Policy_eth', 'ALCHEMY_POLICY_ETH')
      ),
    });
  });

  app.post('/api/bundler/:provider/:chainId', async (req: Request, res: Response) => {
    const providerParam = String(req.params.provider || '').toLowerCase();
    const chainId = Number(req.params.chainId || 1);
    if (
      (providerParam !== 'pimlico' && providerParam !== 'alchemy') ||
      !Number.isInteger(chainId) ||
      chainId <= 0
    ) {
      res.status(400).json({ error: 'Invalid bundler provider or chainId' });
      return;
    }

    if (!validateRpcPayload(req.body, ALLOWED_BUNDLER_METHODS)) {
      res
        .status(400)
        .json({ error: 'Invalid or disallowed Bundler/Paymaster JSON-RPC method' });
      return;
    }

    const upstreamUrl =
      providerParam === 'pimlico'
        ? resolveServerPimlicoUrl(chainId)
        : resolveServerAlchemyRpc(chainId) ||
          (chainId === 1 ? getEnvTrimmed('ETH_MAINNET_RPC_URL') : null);

    if (!upstreamUrl) {
      res.status(503).json({
        error: `サーバー側の ${
          providerParam === 'pimlico' ? 'Pimlico' : 'Alchemy'
        } Secret (Chain ${chainId}) が未設定です`,
      });
      return;
    }

    const enablePolicy = req.query.policy !== '0';
    const transformedBody = injectPaymasterPolicyIntoRpcBody(
      providerParam,
      req.body,
      enablePolicy
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transformedBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await upstreamRes.json().catch(() => null);
      if (!upstreamRes.ok) {
        res.status(upstreamRes.status).json(
          data ?? { error: `Bundler upstream HTTP ${upstreamRes.status}` }
        );
        return;
      }
      res.status(200).json(data);
    } catch (err) {
      clearTimeout(timeout);
      res.status(502).json({
        error:
          err instanceof Error ? err.message : 'Bundler proxy request failed',
      });
    }
  });

  app.post('/api/rpc/:chain', async (req: Request, res: Response) => {
    const chainParam = String(req.params.chain || '');
    const upstreamUrls = getUpstreamUrls(chainParam);

    if (upstreamUrls.length === 0) {
      res.status(404).json({ error: `Unsupported RPC target: ${chainParam}` });
      return;
    }

    if (!validateRpcPayload(req.body)) {
      res.status(400).json({ error: 'Invalid or disallowed JSON-RPC method/payload' });
      return;
    }

    let lastErrorMessage = 'Upstream RPC request failed';
    for (const url of upstreamUrls) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const upstreamResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!upstreamResponse.ok) {
          lastErrorMessage = `Upstream HTTP ${upstreamResponse.status}`;
          continue;
        }

        const data = await upstreamResponse.json();
        res.status(200).json(data);
        return;
      } catch (err) {
        clearTimeout(timeout);
        lastErrorMessage = err instanceof Error ? err.message : 'Upstream fetch error';
      }
    }

    res.status(502).json({ error: lastErrorMessage });
  });

  // Authenticated Cloud Sync Endpoints
  app.get('/api/user/me', requireAuth, async (req: AuthRequest, res: Response) => {
    res.json({
      uid: req.user?.uid ?? '',
      email: req.user?.email ?? '',
    });
  });

  app.get('/api/tx-cache', async (req: Request, res: Response) => {
    try {
      const networkId = String(req.query.networkId || 'base-mainnet');
      const chainId = Number(req.query.chainId || 8453);
      const userIds = await resolveCacheUserIds(req);
      await purgePartialVerifiedTxsForUsers(userIds);
      const rows = await getVerifiedTxsForUsers(userIds, networkId, chainId);
      const seen = new Set<string>();
      const cleanPayloads: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const key = r.txHash.toLowerCase();
        if (seen.has(key)) continue;
        if (!isValidPayloadJsonRecord(r.payloadJson)) continue;
        seen.add(key);
        cleanPayloads.push(r.payloadJson);
      }
      res.json({
        items: cleanPayloads,
      });
    } catch (error) {
      console.error('GET /api/tx-cache failed:', error);
      res.status(500).json({ error: 'Failed to load saved transactions' });
    }
  });

  app.post('/api/tx-cache/lookup', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        networkId?: string;
        chainId?: number;
        hashes?: string[];
      };
      const networkId = String(body?.networkId || 'base-mainnet');
      const chainId = Number(body?.chainId || 8453);
      const hashes = Array.isArray(body?.hashes) ? body.hashes.slice(0, 500) : [];
      if (hashes.length === 0) {
        res.json({ items: [] });
        return;
      }

      const userIds = await resolveCacheUserIds(req);
      const rows = await getVerifiedTxsByHashes(
        userIds,
        networkId,
        chainId,
        hashes
      );
      const seen = new Set<string>();
      const cleanPayloads: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const key = r.txHash.toLowerCase();
        if (seen.has(key)) continue;
        if (!isValidPayloadJsonRecord(r.payloadJson)) continue;
        seen.add(key);
        cleanPayloads.push(r.payloadJson);
      }
      res.json({ items: cleanPayloads });
    } catch (error) {
      console.error('POST /api/tx-cache/lookup failed:', error);
      res.status(500).json({ error: 'Failed to look up saved transactions' });
    }
  });

  app.post('/api/tx-cache', async (req: Request, res: Response) => {
    try {
      const body = req.body as { items?: VerifiedTxInput[] };
      const rawItems = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
      const validItems = rawItems.filter(isValidDbTxInput);
      const userIds = await resolveCacheUserIds(req);
      await purgePartialVerifiedTxsForUsers(userIds);
      if (validItems.length === 0) {
        res.json({ savedCount: 0 });
        return;
      }
      let primarySavedCount = 0;
      for (let i = 0; i < userIds.length; i += 1) {
        const saved = await upsertVerifiedTxsForUser(userIds[i], validItems);
        if (i === 0) primarySavedCount = saved.length;
      }
      res.json({ savedCount: primarySavedCount });
    } catch (error) {
      console.error('POST /api/tx-cache failed:', error);
      res.status(500).json({ error: 'Failed to save transactions' });
    }
  });

  app.delete('/api/tx-cache', async (req: Request, res: Response) => {
    try {
      const networkId = req.query.networkId ? String(req.query.networkId) : undefined;
      const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
      const userIds = await resolveCacheUserIds(req);
      for (const uid of userIds) {
        await clearVerifiedTxsForUser(uid, networkId, chainId);
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/tx-cache failed:', error);
      res.status(500).json({ error: 'Failed to clear saved transactions' });
    }
  });

  app.get('/api/runs', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const rows = await getVerificationRunsForUser(req.dbUserId!);
      res.json({
        runs: rows.map((r) => ({
          id: r.runKey,
          createdAt: r.createdAt.getTime(),
          networkId: r.networkId,
          networkName: r.networkName,
          counts: r.countsJson,
          snapshot: r.snapshotJson,
          results: r.resultsJson,
        })),
      });
    } catch (error) {
      console.error('GET /api/runs failed:', error);
      res.status(500).json({ error: 'Failed to load verification history' });
    }
  });

  app.post('/api/runs', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const run = req.body as {
        id: string;
        networkId: string;
        networkName: string;
        counts: Record<string, number>;
        snapshot: Record<string, unknown>;
        results: Array<Record<string, unknown>>;
      };
      if (!run || !run.id || !run.networkId) {
        res.status(400).json({ error: 'Invalid run payload' });
        return;
      }
      await saveVerificationRunForUser(req.dbUserId!, {
        runKey: run.id,
        networkId: run.networkId,
        networkName: run.networkName,
        countsJson: run.counts,
        snapshotJson: run.snapshot,
        resultsJson: Array.isArray(run.results) ? run.results.slice(0, 500) : [],
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('POST /api/runs failed:', error);
      res.status(500).json({ error: 'Failed to save verification run' });
    }
  });

  app.delete('/api/runs', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      await clearVerificationRunsForUser(req.dbUserId!);
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/runs failed:', error);
      res.status(500).json({ error: 'Failed to clear verification history' });
    }
  });

  app.get('/api/workspace', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const ws = await getWorkspaceForUser(req.dbUserId!);
      if (!ws) {
        res.json({ workspace: null });
        return;
      }
      res.json({
        workspace: {
          activeTab: ws.activeTab,
          networkId: ws.networkId,
          customRpcUrl: ws.customRpcUrl,
          rawInput: ws.rawInput,
          withdrawalRawInput: ws.withdrawalRawInput,
          stateJson: ws.stateJson,
          updatedAt: ws.updatedAt.getTime(),
        },
      });
    } catch (error) {
      console.error('GET /api/workspace failed:', error);
      res.status(500).json({ error: 'Failed to load workspace state' });
    }
  });

  app.post('/api/workspace', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body as {
        activeTab?: string;
        networkId?: string;
        customRpcUrl?: string;
        rawInput?: string;
        withdrawalRawInput?: string;
        stateJson?: Record<string, unknown>;
      };
      const saved = await upsertWorkspaceForUser(req.dbUserId!, {
        activeTab: String(body?.activeTab || 'verify'),
        networkId: String(body?.networkId || 'base-mainnet'),
        customRpcUrl: String(body?.customRpcUrl || ''),
        rawInput: String(body?.rawInput || ''),
        withdrawalRawInput: String(body?.withdrawalRawInput || ''),
        stateJson:
          body?.stateJson && typeof body.stateJson === 'object'
            ? body.stateJson
            : {},
      });
      res.json({ updatedAt: saved.updatedAt.getTime() });
    } catch (error) {
      console.error('POST /api/workspace failed:', error);
      res.status(500).json({ error: 'Failed to save workspace state' });
    }
  });

  // Gemini Multi-turn Audit Chat & Google Search Grounding Endpoints
  app.get('/api/ai/chat/history', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const sessionId = String(req.query.sessionId || 'default');
      const rows = await getChatMessagesForUser(req.dbUserId!, sessionId);
      res.json({
        messages: rows.map((m) => ({
          id: String(m.id),
          role: m.role,
          modelUsed: m.modelUsed,
          content: m.content,
          groundingSources: m.groundingSourcesJson ?? [],
          createdAt: m.createdAt.getTime(),
        })),
      });
    } catch (error) {
      console.error('GET /api/ai/chat/history failed:', error);
      res.status(500).json({ error: 'Failed to load chat history' });
    }
  });

  app.delete('/api/ai/chat/history', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const sessionId = String(req.query.sessionId || 'default');
      await clearChatMessagesForUser(req.dbUserId!, sessionId);
      res.json({ ok: true });
    } catch (error) {
      console.error('DELETE /api/ai/chat/history failed:', error);
      res.status(500).json({ error: 'Failed to clear chat history' });
    }
  });

  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        sessionId?: string;
        model?: GeminiChatModel;
        message?: string;
        history?: Array<{ role: 'user' | 'model'; content: string }>;
        contextSummary?: string;
        useGoogleSearch?: boolean;
      };

      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) {
        res.status(400).json({ error: 'メッセージを入力してください' });
        return;
      }

      const result = await runMultiTurnAuditChat({
        model: body.model,
        history: Array.isArray(body.history) ? body.history : [],
        message,
        contextSummary: body.contextSummary,
        useGoogleSearch: body.useGoogleSearch,
      });

      const optionalUserId = await resolveOptionalUserId(req);
      if (optionalUserId !== null) {
        const sessionId = String(body.sessionId || 'default');
        await appendChatMessagesForUser(optionalUserId, sessionId, [
          {
            role: 'user',
            modelUsed: result.modelUsed,
            content: message,
          },
          {
            role: 'model',
            modelUsed: result.modelUsed,
            content: result.text,
            groundingSourcesJson: result.groundingSources,
          },
        ]).catch((err) => {
          console.error('Non-fatal chat persistence error:', err);
        });
      }

      res.json(result);
    } catch (error) {
      console.error('POST /api/ai/chat failed:', error);
      const message =
        error instanceof Error ? error.message : 'Geminiチャット応答の生成に失敗しました';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/ai/search', async (req: Request, res: Response) => {
    try {
      const body = req.body as { query?: string };
      const query = typeof body?.query === 'string' ? body.query.trim() : '';
      if (!query) {
        res.status(400).json({ error: '検索クエリを入力してください' });
        return;
      }

      const result = await runGroundedProtocolSearch(query);
      res.json(result);
    } catch (error) {
      console.error('POST /api/ai/search failed:', error);
      const message =
        error instanceof Error ? error.message : 'Google Search Grounding 照会に失敗しました';
      res.status(500).json({ error: message });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found');
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Base Finality server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
