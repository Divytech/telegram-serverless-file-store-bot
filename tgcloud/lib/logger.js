import { api } from 'sdk';
import { LOG_CHANNEL_ID } from './config.js';

export async function sendLog(text) {
  if (!LOG_CHANNEL_ID || LOG_CHANNEL_ID === 0) return;
  try {
    await api.sendMessage({
      chat_id: LOG_CHANNEL_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {}
}
