import { and, desc, eq } from 'drizzle-orm';
import { db } from './index.ts';
import {
  chatMessages,
  userWorkspaces,
  verificationRuns,
  verifiedTxs,
} from './schema.ts';

export interface VerifiedTxInput {
  networkId: string;
  chainId: number;
  txHash: string;
  finality: string;
  executionStatus: string;
  blockNumber: number | null;
  l1OriginBlock: number | null;
  isWithdrawal: boolean;
  portalFinalized: boolean | null;
  reliabilityTier: string;
  payloadJson: Record<string, unknown>;
}

export interface WorkspaceInput {
  activeTab: string;
  networkId: string;
  customRpcUrl: string;
  rawInput: string;
  withdrawalRawInput: string;
  stateJson: Record<string, unknown>;
}

export async function upsertVerifiedTxsForUser(
  userId: number,
  items: VerifiedTxInput[]
) {
  if (items.length === 0) return [];
  try {
    const saved = [];
    for (const item of items) {
      const normalizedHash = item.txHash.toLowerCase();
      const [row] = await db
        .insert(verifiedTxs)
        .values({
          userId,
          networkId: item.networkId,
          chainId: item.chainId,
          txHash: normalizedHash,
          finality: item.finality,
          executionStatus: item.executionStatus,
          blockNumber: item.blockNumber,
          l1OriginBlock: item.l1OriginBlock,
          isWithdrawal: item.isWithdrawal,
          portalFinalized: item.portalFinalized,
          reliabilityTier: item.reliabilityTier,
          payloadJson: item.payloadJson,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            verifiedTxs.userId,
            verifiedTxs.networkId,
            verifiedTxs.chainId,
            verifiedTxs.txHash,
          ],
          set: {
            finality: item.finality,
            executionStatus: item.executionStatus,
            blockNumber: item.blockNumber,
            l1OriginBlock: item.l1OriginBlock,
            isWithdrawal: item.isWithdrawal,
            portalFinalized: item.portalFinalized,
            reliabilityTier: item.reliabilityTier,
            payloadJson: item.payloadJson,
            updatedAt: new Date(),
          },
        })
        .returning();
      saved.push(row);
    }
    return saved;
  } catch (error) {
    console.error('Database error saving verified txs:', error);
    throw new Error('Failed to save verified transactions.', { cause: error });
  }
}

export async function getVerifiedTxsForUser(
  userId: number,
  networkId: string,
  chainId: number
) {
  try {
    return await db
      .select()
      .from(verifiedTxs)
      .where(
        and(
          eq(verifiedTxs.userId, userId),
          eq(verifiedTxs.networkId, networkId),
          eq(verifiedTxs.chainId, chainId)
        )
      )
      .orderBy(desc(verifiedTxs.updatedAt))
      .limit(500);
  } catch (error) {
    console.error('Database error fetching verified txs:', error);
    throw new Error('Failed to load saved transactions.', { cause: error });
  }
}

export async function clearVerifiedTxsForUser(
  userId: number,
  networkId?: string,
  chainId?: number
) {
  try {
    if (networkId && chainId !== undefined) {
      await db
        .delete(verifiedTxs)
        .where(
          and(
            eq(verifiedTxs.userId, userId),
            eq(verifiedTxs.networkId, networkId),
            eq(verifiedTxs.chainId, chainId)
          )
        );
      return;
    }
    await db.delete(verifiedTxs).where(eq(verifiedTxs.userId, userId));
  } catch (error) {
    console.error('Database error clearing verified txs:', error);
    throw new Error('Failed to clear saved transactions.', { cause: error });
  }
}

export async function saveVerificationRunForUser(
  userId: number,
  run: {
    runKey: string;
    networkId: string;
    networkName: string;
    countsJson: Record<string, number>;
    snapshotJson: Record<string, unknown>;
    resultsJson: Array<Record<string, unknown>>;
  }
) {
  try {
    const [inserted] = await db
      .insert(verificationRuns)
      .values({
        userId,
        runKey: run.runKey,
        networkId: run.networkId,
        networkName: run.networkName,
        countsJson: run.countsJson,
        snapshotJson: run.snapshotJson,
        resultsJson: run.resultsJson,
      })
      .onConflictDoUpdate({
        target: [verificationRuns.userId, verificationRuns.runKey],
        set: {
          networkId: run.networkId,
          networkName: run.networkName,
          countsJson: run.countsJson,
          snapshotJson: run.snapshotJson,
          resultsJson: run.resultsJson,
        },
      })
      .returning();
    return inserted;
  } catch (error) {
    console.error('Database error saving verification run:', error);
    throw new Error('Failed to save verification run.', { cause: error });
  }
}

export async function getVerificationRunsForUser(userId: number) {
  try {
    return await db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.userId, userId))
      .orderBy(desc(verificationRuns.createdAt))
      .limit(25);
  } catch (error) {
    console.error('Database error fetching verification runs:', error);
    throw new Error('Failed to load verification history.', { cause: error });
  }
}

export async function clearVerificationRunsForUser(userId: number) {
  try {
    await db
      .delete(verificationRuns)
      .where(eq(verificationRuns.userId, userId));
  } catch (error) {
    console.error('Database error clearing verification runs:', error);
    throw new Error('Failed to clear verification history.', { cause: error });
  }
}

export async function getWorkspaceForUser(userId: number) {
  try {
    const rows = await db
      .select()
      .from(userWorkspaces)
      .where(eq(userWorkspaces.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database error fetching workspace:', error);
    throw new Error('Failed to load saved workspace.', { cause: error });
  }
}

export async function upsertWorkspaceForUser(
  userId: number,
  input: WorkspaceInput
) {
  try {
    const [saved] = await db
      .insert(userWorkspaces)
      .values({
        userId,
        activeTab: input.activeTab,
        networkId: input.networkId,
        customRpcUrl: input.customRpcUrl,
        rawInput: input.rawInput,
        withdrawalRawInput: input.withdrawalRawInput,
        stateJson: input.stateJson,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userWorkspaces.userId,
        set: {
          activeTab: input.activeTab,
          networkId: input.networkId,
          customRpcUrl: input.customRpcUrl,
          rawInput: input.rawInput,
          withdrawalRawInput: input.withdrawalRawInput,
          stateJson: input.stateJson,
          updatedAt: new Date(),
        },
      })
      .returning();
    return saved;
  } catch (error) {
    console.error('Database error saving workspace:', error);
    throw new Error('Failed to save workspace state.', { cause: error });
  }
}

export async function appendChatMessagesForUser(
  userId: number,
  sessionId: string,
  entries: Array<{
    role: 'user' | 'model';
    modelUsed: string;
    content: string;
    groundingSourcesJson?: Array<{ title: string; uri: string }>;
  }>
) {
  try {
    const inserted = [];
    for (const entry of entries) {
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          sessionId,
          role: entry.role,
          modelUsed: entry.modelUsed,
          content: entry.content,
          groundingSourcesJson: entry.groundingSourcesJson ?? null,
        })
        .returning();
      inserted.push(row);
    }
    return inserted;
  } catch (error) {
    console.error('Database error saving chat messages:', error);
    throw new Error('Failed to save chat history.', { cause: error });
  }
}

export async function getChatMessagesForUser(userId: number, sessionId: string) {
  try {
    return await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.sessionId, sessionId)
        )
      )
      .orderBy(chatMessages.id)
      .limit(100);
  } catch (error) {
    console.error('Database error fetching chat messages:', error);
    throw new Error('Failed to fetch chat history.', { cause: error });
  }
}

export async function clearChatMessagesForUser(userId: number, sessionId: string) {
  try {
    await db
      .delete(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.sessionId, sessionId)
        )
      );
  } catch (error) {
    console.error('Database error clearing chat messages:', error);
    throw new Error('Failed to clear chat history.', { cause: error });
  }
}
