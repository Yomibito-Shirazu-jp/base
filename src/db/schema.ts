import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const verifiedTxs = pgTable(
  'verified_txs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    networkId: text('network_id').notNull(),
    chainId: integer('chain_id').notNull(),
    txHash: text('tx_hash').notNull(),
    finality: text('finality').notNull(),
    executionStatus: text('execution_status').notNull(),
    blockNumber: integer('block_number'),
    l1OriginBlock: integer('l1_origin_block'),
    isWithdrawal: boolean('is_withdrawal').default(false).notNull(),
    portalFinalized: boolean('portal_finalized'),
    reliabilityTier: text('reliability_tier').notNull(),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('verified_txs_user_net_hash_idx').on(
      table.userId,
      table.networkId,
      table.chainId,
      table.txHash
    ),
  ]
);

export const verificationRuns = pgTable(
  'verification_runs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    runKey: text('run_key').notNull(),
    networkId: text('network_id').notNull(),
    networkName: text('network_name').notNull(),
    countsJson: jsonb('counts_json').$type<Record<string, number>>().notNull(),
    snapshotJson: jsonb('snapshot_json').$type<Record<string, unknown>>().notNull(),
    resultsJson: jsonb('results_json').$type<Array<Record<string, unknown>>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('verification_runs_user_run_key_idx').on(table.userId, table.runKey),
  ]
);

export const userWorkspaces = pgTable('user_workspaces', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  activeTab: text('active_tab').notNull(),
  networkId: text('network_id').notNull(),
  customRpcUrl: text('custom_rpc_url').notNull(),
  rawInput: text('raw_input').notNull(),
  withdrawalRawInput: text('withdrawal_raw_input').notNull(),
  stateJson: jsonb('state_json').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  sessionId: text('session_id').notNull(),
  role: text('role').notNull(),
  modelUsed: text('model_used').notNull(),
  content: text('content').notNull(),
  groundingSourcesJson: jsonb('grounding_sources_json').$type<
    Array<{ title: string; uri: string }>
  >(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  verifiedTxs: many(verifiedTxs),
  verificationRuns: many(verificationRuns),
  chatMessages: many(chatMessages),
  workspace: one(userWorkspaces, {
    fields: [users.id],
    references: [userWorkspaces.userId],
  }),
}));

export const userWorkspacesRelations = relations(userWorkspaces, ({ one }) => ({
  user: one(users, {
    fields: [userWorkspaces.userId],
    references: [users.id],
  }),
}));

export const verifiedTxsRelations = relations(verifiedTxs, ({ one }) => ({
  user: one(users, {
    fields: [verifiedTxs.userId],
    references: [users.id],
  }),
}));

export const verificationRunsRelations = relations(verificationRuns, ({ one }) => ({
  user: one(users, {
    fields: [verificationRuns.userId],
    references: [users.id],
  }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  user: one(users, {
    fields: [chatMessages.userId],
    references: [users.id],
  }),
}));
