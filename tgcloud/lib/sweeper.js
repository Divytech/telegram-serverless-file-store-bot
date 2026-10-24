import { api, db } from 'sdk';
import { lte, eq } from 'sdk/db';
import { scheduledDeletions } from '../schema.js';
import { sendLog } from './logger.js';

export async function sweepExpiredDeletions() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const expired = await db.select().from(scheduledDeletions)
      .where(lte(scheduledDeletions.deleteAt, now))
      .limit(50)
      .all();

    if (expired.length === 0) return 0;

    let deletedCount = 0;
    for (const item of expired) {
      try {
        await api.deleteMessage({ chat_id: item.chatId, message_id: item.messageId });
        deletedCount++;
      } catch (err) {}
      await db.delete(scheduledDeletions).where(eq(scheduledDeletions.id, item.id)).run();
    }

    if (deletedCount > 0) {
      await sendLog(
        `🗑️ <b>Auto-Delete Sweep</b>\n` +
        `• Deleted <b>${deletedCount}</b> expired file(s)/notice(s).`
      );
    }
    return deletedCount;
  } catch (err) {
    return 0;
  }
}
