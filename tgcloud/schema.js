import { table, integer, text, boolean, sql } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tgId: integer('tg_id').notNull().unique(),
  chatId: integer('chat_id').notNull(),
  username: text('username'),
  firstName: text('first_name'),
  isBanned: boolean('is_banned').default(false),
  verifiedUntil: integer('verified_until').default(0),
  verifyToken: text('verify_token'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const scheduledDeletions = table('scheduled_deletions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  deleteAt: integer('delete_at').notNull(),
});

export const files = table('files', {
  id: integer('id').primaryKey(),
  fileName: text('file_name'),
  fileSize: integer('file_size'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
