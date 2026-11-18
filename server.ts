import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
]);

interface JsonRpcItem {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

function getUpstreamUrls(chainKey: string): string[] {
  switch (chainKey) {
    case 'base-mainnet':
      return [
        process.env.BASE_MAINNET_RPC_URL,
        'https://mainnet.base.org',
        'https://base-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'eth-mainnet':
      return [
        process.env.ETH_MAINNET_RPC_URL,
        'https://ethereum-rpc.publicnode.com',
        'https://eth.drpc.org',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'base-sepolia':
      return [
        process.env.BASE_SEPOLIA_RPC_URL,
        'https://sepolia.base.org',
        'https://base-sepolia-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    case 'eth-sepolia':
      return [
        process.env.ETH_SEPOLIA_RPC_URL,
        'https://ethereum-sepolia-rpc.publicnode.com',
      ].filter((u): u is string => Boolean(u && u.trim()));
    default:
      return [];
  }
}

function validateRpcPayload(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > 100) return false;
  for (const item of items) {
    if (!item || typeof item !== 'object') return false;
    const rpc = item as JsonRpcItem;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return false;
    if (!ALLOWED_METHODS.has(rpc.method)) return false;
  }
  return true;
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/rpc/status', (_req: Request, res: Response) => {
    res.json({
      baseMainnetConfigured: Boolean(process.env.BASE_MAINNET_RPC_URL?.trim()),
      ethMainnetConfigured: Boolean(process.env.ETH_MAINNET_RPC_URL?.trim()),
    });
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
