import { api, db } from 'sdk';
import { eq, and, count } from 'sdk/db';
import { users, settings, scheduledDeletions, files } from '../schema.js';
import {
  OWNER_ID,
  ADMIN_IDS,
  DB_CHANNEL_ID,
  FSUB_CHANNELS,
  PROTECT_CONTENT,
  AUTO_DELETE_SECONDS,
  PROMO_BUTTON,
  SHORTENER_API_KEY,
  SHORTENER_API_URL,
  VERIFY_EXPIRE_HOURS,
  CUSTOM_CAPTION,
} from '../lib/config.js';
import { sendLog } from '../lib/logger.js';
import { sweepExpiredDeletions } from '../lib/sweeper.js';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function renderCaption(template, fileName, fileSize) {
  const tpl = template || CUSTOM_CAPTION || '{filename} [{filesize}]';
  return tpl
    .replace(/{filename}/gi, fileName || 'Unknown')
    .replace(/{filesize}/gi, formatBytes(fileSize || 0));
}

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeCode(str) {
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    let b1 = str.charCodeAt(i);
    let b2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    let b3 = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += b64chars[b1 >> 2];
    out += b64chars[((b1 & 3) << 4) | (b2 >> 4)];
    if (i + 1 < str.length) out += b64chars[((b2 & 15) << 2) | (b3 >> 6)];
    if (i + 2 < str.length) out += b64chars[b3 & 63];
  }
  return out;
}

function decodeCode(str) {
  try {
    let map = {};
    for (let i = 0; i < b64chars.length; i++) map[b64chars[i]] = i;
    let bytes = [];
    let len = str.length;
    for (let i = 0; i < len; i += 4) {
      let c1 = map[str[i]], c2 = map[str[i + 1]];
      let c3 = i + 2 < len ? map[str[i + 2]] : 0;
      let c4 = i + 3 < len ? map[str[i + 3]] : 0;
      bytes.push((c1 << 2) | (c2 >> 4));
      if (i + 2 < len) bytes.push(((c2 & 15) << 4) | (c3 >> 2));
      if (i + 3 < len) bytes.push(((c3 & 3) << 6) | c4);
    }
    let res = '';
    for (let i = 0; i < bytes.length; i++) res += String.fromCharCode(bytes[i]);
    if (res.startsWith('file_') || res.startsWith('batch_')) return res;
  } catch (err) {}
  return str;
}

const inviteLinkCache = new Map();

async function getChannelInviteLink(chatId) {
  if (inviteLinkCache.has(chatId)) return inviteLinkCache.get(chatId);
  try {
    const chat = await api.getChat({ chat_id: chatId });
    const link = chat.username ? `https://t.me/${chat.username}` : (chat.invite_link ?? await api.exportChatInviteLink({ chat_id: chatId }));
    if (link) inviteLinkCache.set(chatId, link);
    return link;
  } catch (err) {
    return null;
  }
}

const userCooldowns = new Map();
function checkAntiSpam(userId, cooldownMs = 2000) {
  const now = Date.now();
  const entry = userCooldowns.get(userId);

  if (userCooldowns.size > 5000) {
    const cutoff = now - 60000;
    for (const [k, v] of userCooldowns) {
      if (v.lastTime < cutoff) userCooldowns.delete(k);
    }
  }

  if (entry && (now - entry.lastTime < cooldownMs)) {
    const shouldWarn = !entry.warned;
    entry.warned = true;
    return { limited: true, shouldWarn };
  }

  userCooldowns.set(userId, { lastTime: now, warned: false });
  return { limited: false, shouldWarn: false };
}

async function checkAllFSubs(userId) {
  const channelsToCheck = FSUB_CHANNELS || [];
  if (channelsToCheck.length === 0) return { ok: true, missing: [] };

  const missing = [];
  for (const item of channelsToCheck) {
    const channelId = typeof item === 'object' ? item.id : item;
    const channelName = typeof item === 'object' ? item.name : null;
    const explicitLink = typeof item === 'object' ? item.link : null;

    try {
      const member = await api.getChatMember({ chat_id: channelId, user_id: userId });
      const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);

      if (!isMember) {
        const link = explicitLink || await getChannelInviteLink(channelId);
        missing.push({ id: channelId, name: channelName, link });
      }
    } catch (err) {}
  }
  return { ok: missing.length === 0, missing };
}

async function getShortlink(longUrl, apiUrl, apiKey) {
  const url = apiUrl || SHORTENER_API_URL;
  const key = apiKey || SHORTENER_API_KEY;
  if (!key) return null;
  try {
    const endpoint = `${url}?api=${encodeURIComponent(key)}&url=${encodeURIComponent(longUrl)}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    return data.shortenedUrl ?? data.url ?? null;
  } catch (err) {
    return null;
  }
}

export default async function (message) {
  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const userId = message.from?.id ?? chatId;
  const isOwner = (Array.isArray(ADMIN_IDS) && ADMIN_IDS.includes(userId)) || userId === OWNER_ID;
  const isAdmin = isOwner || (Array.isArray(ADMIN_IDS) && ADMIN_IDS.includes(userId));

  try {
    await sweepExpiredDeletions();

    if (!isAdmin) {
      const spam = checkAntiSpam(userId, 2000);
      if (spam.limited) {
        if (spam.shouldWarn) {
          await api.sendMessage({ chat_id: chatId, text: '⏳ <b>Too fast!</b> Please wait 2 seconds between requests.', parse_mode: 'HTML' });
        }
        return;
      }
    }

    const botInfo = await api.getMe();
    const botUsername = botInfo.username;

    let userRecord = await db.select().from(users).where(eq(users.tgId, userId)).get();
    if (userRecord?.isBanned && !isOwner) {
      await api.sendMessage({ chat_id: chatId, text: '⛔ You have been banned from accessing this bot.' });
      return;
    }

    if (!userRecord && message.from) {
      await db.insert(users).values({
        tgId: message.from.id,
        chatId: chatId,
        username: message.from.username ?? null,
        firstName: message.from.first_name ?? null,
      }).onConflictDoNothing().run();

      userRecord = await db.select().from(users).where(eq(users.tgId, userId)).get();

      await sendLog(
        `👤 <b>#NewUser Started Bot</b>\n` +
        `• Name: <b>${message.from.first_name ?? 'User'}</b>\n` +
        `• Username: ${message.from.username ? '@' + message.from.username : 'None'}\n` +
        `• ID: <code>${message.from.id}</code>`
      );
    }

    if (isAdmin) {
      if (message.text === '/stats') {
        const totalUsers = await db.select({ count: count() }).from(users).get();
        const bannedUsers = await db.select({ count: count() }).from(users).where(eq(users.isBanned, true)).get();
        const totalFiles = await db.select({ count: count() }).from(files).get();
        const pendingDeletions = await db.select({ count: count() }).from(scheduledDeletions).get();

        const total = totalUsers?.count ?? 0;
        const banned = bannedUsers?.count ?? 0;

        await api.sendMessage({
          chat_id: chatId,
          text: `📊 <b>File Store Statistics</b>\n\n• Total users: <b>${total}</b>\n• Active users: <b>${total - banned}</b>\n• Banned users: <b>${banned}</b>\n• Total Files: <b>${totalFiles?.count ?? 0}</b>\n• Pending Deletions: <b>${pendingDeletions?.count ?? 0}</b>\n• Protection: <b>${PROTECT_CONTENT ? 'ON' : 'OFF'}</b>\n• Auto-Delete: <b>${AUTO_DELETE_SECONDS}s</b>\n• FSub Channels: <b>${FSUB_CHANNELS.length}</b>`,
          parse_mode: 'HTML',
        });
        return;
      }

      if (message.text?.startsWith('/ban')) {
        const targetId = parseInt(message.text.split(' ')[1], 10);
        if (!targetId || isNaN(targetId)) {
          await api.sendMessage({ chat_id: chatId, text: 'Usage: <code>/ban &lt;user_id&gt;</code>', parse_mode: 'HTML' });
          return;
        }
        if (targetId === OWNER_ID) {
          await api.sendMessage({ chat_id: chatId, text: '❌ Cannot ban owner.' });
          return;
        }
        await db.update(users).set({ isBanned: true }).where(eq(users.tgId, targetId)).run();
        await api.sendMessage({ chat_id: chatId, text: `✅ User <code>${targetId}</code> has been banned.`, parse_mode: 'HTML' });
        return;
      }

      if (message.text?.startsWith('/unban')) {
        const targetId = parseInt(message.text.split(' ')[1], 10);
        if (!targetId || isNaN(targetId)) {
          await api.sendMessage({ chat_id: chatId, text: 'Usage: <code>/unban &lt;user_id&gt;</code>', parse_mode: 'HTML' });
          return;
        }
        await db.update(users).set({ isBanned: false }).where(eq(users.tgId, targetId)).run();
        await api.sendMessage({ chat_id: chatId, text: `✅ User <code>${targetId}</code> has been unbanned.`, parse_mode: 'HTML' });
        return;
      }

      if (message.text?.startsWith('/broadcast')) {
        if (!message.reply_to_message) {
          await api.sendMessage({ chat_id: chatId, text: '⚠️ Please reply to the message you want to broadcast with <code>/broadcast</code>.', parse_mode: 'HTML' });
          return;
        }

        const allUsers = await db.select({ tgId: users.tgId }).from(users).where(eq(users.isBanned, false)).all();
        const broadcastMsg = await api.sendMessage({ chat_id: chatId, text: `🚀 Starting broadcast to ${allUsers.length} users...` });

        let success = 0;
        let failed = 0;

        for (const u of allUsers) {
          try {
            await api.copyMessage({
              chat_id: u.tgId,
              from_chat_id: chatId,
              message_id: message.reply_to_message.message_id,
            });
            success++;
          } catch (err) {
            failed++;
          }
        }

        await api.editMessageText({
          chat_id: chatId,
          message_id: broadcastMsg.message_id,
          text: `📢 <b>Broadcast Completed!</b>\n\n• Sent: <b>${success}</b>\n• Failed: <b>${failed}</b>\n• Total: <b>${allUsers.length}</b>`,
          parse_mode: 'HTML',
        });
        return;
      }

      if (message.text?.startsWith('/delete')) {
        const targetId = parseInt(message.text.split(' ')[1], 10);
        if (!targetId || isNaN(targetId)) {
          await api.sendMessage({ chat_id: chatId, text: 'Usage: <code>/delete &lt;db_message_id&gt;</code>', parse_mode: 'HTML' });
          return;
        }

        try {
          await api.deleteMessage({ chat_id: DB_CHANNEL_ID, message_id: targetId });
        } catch (err) {}

        await db.delete(files).where(eq(files.id, targetId)).run();
        await api.sendMessage({ chat_id: chatId, text: `🗑️ File <code>${targetId}</code> deleted from database.`, parse_mode: 'HTML' });
        return;
      }

      if (message.text?.startsWith('/setstart')) {
        const customText = message.text.replace('/setstart', '').trim();
        if (!customText) {
          await api.sendMessage({ chat_id: chatId, text: 'Usage: <code>/setstart &lt;your_welcome_message&gt;</code>', parse_mode: 'HTML' });
          return;
        }
        await db.insert(settings).values({ key: 'start_message', value: customText })
          .onConflictDoUpdate({ target: settings.key, set: { value: customText } }).run();
        await api.sendMessage({ chat_id: chatId, text: '✅ Custom start message saved!' });
        return;
      }
    }

    if (message.text?.startsWith('/batch')) {
      const globalCheck = await checkAllFSubs(userId);
      if (!globalCheck.ok) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ You must join our official channels before you can generate links.' });
        return;
      }

      const parts = message.text.trim().split(/\s+/);
      const startId = parseInt(parts[1], 10);
      const endId = parseInt(parts[2], 10);

      if (isNaN(startId) || isNaN(endId) || startId > endId) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'Usage: <code>/batch &lt;first_channel_id&gt; &lt;last_channel_id&gt;</code>\nExample: <code>/batch 12 18</code>',
          parse_mode: 'HTML',
        });
        return;
      }

      const encoded = encodeCode(`batch_${startId}_${endId}`);
      const link = `https://t.me/${botUsername}?start=${encoded}`;
      await api.sendMessage({
        chat_id: chatId,
        text: `📦 <b>Batch Link Created!</b>\n\n• Range: <code>${startId}</code> to <code>${endId}</code>\n• Total: <b>${endId - startId + 1} files</b>\n\n🔗 <b>Your Share Link:</b>\n<code>${link}</code>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Open Batch Link', url: link }],
            [{ text: '📥 Save to Saved Messages', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('📦 Batch Files')}` }],
          ],
        },
      });

      await sendLog(
        `📦 <b>Batch Link Generated</b>\n` +
        `• Range: <code>${startId}</code> to <code>${endId}</code> (${endId - startId + 1} files)\n` +
        `• User: <code>${userId}</code> (${message.from?.first_name ?? 'User'})`
      );
      return;
    }

    const isMedia = message.document || message.video || message.audio || message.photo || message.voice || message.video_note || message.animation;
    if (isMedia) {
      const globalCheck = await checkAllFSubs(userId);
      if (!globalCheck.ok) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ You must join our official channels before you can generate links.' });
        return;
      }

      if (!DB_CHANNEL_ID || DB_CHANNEL_ID === 0) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Database channel is not configured.' });
        return;
      }

      try {
        const stored = await api.copyMessage({
          chat_id: DB_CHANNEL_ID,
          from_chat_id: chatId,
          message_id: message.message_id,
        });

        const media = message.document || message.video || message.audio || message.animation || (message.photo ? message.photo[message.photo.length - 1] : null);
        const fileName = message.document?.file_name || media?.file_name || (message.video ? 'video.mp4' : (message.audio ? 'audio.mp3' : (message.photo ? 'photo.jpg' : 'file')));
        const fileSize = media?.file_size || 0;

        await db.insert(files).values({
          id: stored.message_id,
          fileName,
          fileSize,
        }).onConflictDoNothing().run();

        const encoded = encodeCode(`file_${stored.message_id}`);
        const link = `https://t.me/${botUsername}?start=${encoded}`;

        await api.sendMessage({
          chat_id: chatId,
          text: `📁 <b>File Stored Successfully!</b>\n\n• Name: <b>${fileName}</b>\n• Size: <code>${formatBytes(fileSize)}</code>\n• Message ID: <code>${stored.message_id}</code>\n\n🔗 <b>Your Share Link:</b>\n<code>${link}</code>`,
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 Share Link', url: link }],
              [{ text: '📥 Save to Saved Messages', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('📁 Stored File')}` }],
            ],
          },
        });

        await sendLog(
          `📁 <b>New File Stored</b>\n` +
          `• ID: <code>${stored.message_id}</code>\n` +
          `• Name: <b>${fileName}</b>\n` +
          `• Size: <code>${formatBytes(fileSize)}</code>\n` +
          `• User: <code>${userId}</code> (${message.from?.first_name ?? 'User'})`
        );
      } catch (err) {
        await api.sendMessage({ chat_id: chatId, text: '❌ Failed to store file. Make sure the bot is an Admin in the DB channel.' });
      }
      return;
    }

    if (message.text?.startsWith('/start')) {
      const rawParam = message.text.split(' ')[1]?.trim();

      if (rawParam?.startsWith('verify_')) {
        const parts = rawParam.split('_');
        const token = parts[1];
        const hours = parseInt(parts[2], 10) || VERIFY_EXPIRE_HOURS;

        if (userRecord && userRecord.verifyToken === token) {
          const expiresAt = Math.floor(Date.now() / 1000) + (hours * 3600);
          await db.update(users).set({ verifiedUntil: expiresAt, verifyToken: null }).where(eq(users.tgId, userId)).run();
          await api.sendMessage({
            chat_id: chatId,
            text: `✅ <b>Verification Successful!</b>\n\nYou now have unlimited access to files for the next <b>${hours} hours</b>. Click on your file link again to download!`,
            parse_mode: 'HTML',
          });
          return;
        }
        await api.sendMessage({ chat_id: chatId, text: '❌ Invalid or expired verification token.' });
        return;
      }

      const decoded = rawParam ? decodeCode(rawParam) : null;
      const isFileRequest = decoded?.startsWith('file_') || decoded?.startsWith('batch_');

      let targetMsgId = null;
      let batchStart = null;
      let batchEnd = null;

      if (decoded?.startsWith('file_')) {
        const parts = decoded.split('_');
        targetMsgId = parseInt(parts[1], 10);
      } else if (decoded?.startsWith('batch_')) {
        const parts = decoded.split('_');
        batchStart = parseInt(parts[1], 10);
        batchEnd = parseInt(parts[2], 10);
      }

      const fsubCheck = await checkAllFSubs(userId);
      if (!fsubCheck.ok) {
        const tryAgainUrl = rawParam
          ? `https://t.me/${botUsername}?start=${rawParam}`
          : `https://t.me/${botUsername}?start`;

        const buttons = fsubCheck.missing
          .filter((ch) => Boolean(ch.link))
          .map((ch, idx) => [
            { text: `📢 Join ${ch.name ?? `Channel ${idx + 1}`}`, url: ch.link }
          ]);
        buttons.push([{ text: '🔄 Try Again', url: tryAgainUrl }]);

        await api.sendMessage({
          chat_id: chatId,
          text: '⚠️ <b>Access Restricted</b>\n\nYou must join our channel(s) before accessing content. Join below and click <b>Try Again</b>:',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });
        return;
      }

      const shortenerKey = SHORTENER_API_KEY;
      const shortenerUrl = SHORTENER_API_URL;
      const verifyHours = VERIFY_EXPIRE_HOURS;

      if (isFileRequest && shortenerKey) {
        const now = Math.floor(Date.now() / 1000);
        const isVerified = (userRecord?.verifiedUntil ?? 0) > now;

        if (!isVerified) {
          const token = Math.random().toString(36).substring(2, 10);
          await db.update(users).set({ verifyToken: token }).where(eq(users.tgId, userId)).run();

          const verifyUrl = `https://t.me/${botUsername}?start=verify_${token}_${verifyHours}`;
          const shortUrl = await getShortlink(verifyUrl, shortenerUrl, shortenerKey);

          if (shortUrl) {
            await api.sendMessage({
              chat_id: chatId,
              text: `🔒 <b>Access Token Required!</b>\n\nTo access this file, complete our short ad link to unlock all files for <b>${verifyHours} hours</b>:\n\n1. Click the button below\n2. Complete the shortlink steps\n3. Return here and your token will be activated!`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔗 Click Here to Verify (Free)', url: shortUrl }],
                  [{ text: '🔄 Check Verification', url: `https://t.me/${botUsername}?start=${rawParam}` }],
                ],
              },
            });
            return;
          }
        }
      }

      const effectiveAutoDelete = Math.min(Math.max(AUTO_DELETE_SECONDS || 600, 60), 43200);
      const deleteAt = Math.floor(Date.now() / 1000) + effectiveAutoDelete;
      const effectiveProtect = PROTECT_CONTENT === false ? false : true;

      const promoMarkup = PROMO_BUTTON?.url ? {
        inline_keyboard: [[{ text: PROMO_BUTTON.text, url: PROMO_BUTTON.url }]]
      } : undefined;

      const autoDelNoticeText = effectiveAutoDelete >= 3600
        ? `${effectiveAutoDelete / 3600} hours`
        : `${Math.round(effectiveAutoDelete / 60)} minutes`;

      const fileShareLink = `https://t.me/${botUsername}?start=${rawParam}`;
      const saveNoticeMarkup = {
        inline_keyboard: [
          [{ text: '📥 Save to Saved Messages', url: `https://t.me/share/url?url=${encodeURIComponent(fileShareLink)}&text=${encodeURIComponent('💾 Saved File')}` }]
        ]
      };

      if (targetMsgId) {
        try {
          const fileRec = await db.select().from(files).where(eq(files.id, targetMsgId)).get();
          const customCaption = renderCaption(CUSTOM_CAPTION, fileRec?.fileName, fileRec?.fileSize);

          const sent = await api.copyMessage({
            chat_id: chatId,
            from_chat_id: DB_CHANNEL_ID,
            message_id: targetMsgId,
            protect_content: effectiveProtect,
            caption: customCaption,
            reply_markup: promoMarkup || saveNoticeMarkup,
          });

          await db.insert(scheduledDeletions).values({
            chatId: chatId,
            messageId: sent.message_id,
            deleteAt: deleteAt,
          }).run();

          const notice = await api.sendMessage({
            chat_id: chatId,
            text: `⏳ <i>This file will self-destruct in ${autoDelNoticeText} to prevent copyright issues. Save/forward it to your Saved Messages now.</i>`,
            parse_mode: 'HTML',
            reply_markup: saveNoticeMarkup,
          });

          await db.insert(scheduledDeletions).values({
            chatId: chatId,
            messageId: notice.message_id,
            deleteAt: deleteAt,
          }).run();

          await sendLog(
            `📥 <b>File Delivered</b>\n` +
            `• DB Message ID: <code>${targetMsgId}</code>\n` +
            `• Name: <b>${fileRec?.fileName ?? 'Unknown'}</b>\n` +
            `• Recipient: <code>${userId}</code> (${message.from?.first_name ?? 'User'})`
          );
        } catch (err) {
          await api.sendMessage({ chat_id: chatId, text: '❌ This file is unavailable or has been removed.' });
        }
        return;
      }

      if (batchStart && batchEnd && batchStart <= batchEnd) {
        await api.sendMessage({ chat_id: chatId, text: `⏳ Delivering ${batchEnd - batchStart + 1} files...` });
        for (let id = batchStart; id <= batchEnd; id++) {
          try {
            const fileRec = await db.select().from(files).where(eq(files.id, id)).get();
            const customCaption = renderCaption(CUSTOM_CAPTION, fileRec?.fileName, fileRec?.fileSize);

            const sent = await api.copyMessage({
              chat_id: chatId,
              from_chat_id: DB_CHANNEL_ID,
              message_id: id,
              protect_content: effectiveProtect,
              caption: customCaption,
              reply_markup: promoMarkup || saveNoticeMarkup,
            });

            await db.insert(scheduledDeletions).values({
              chatId: chatId,
              messageId: sent.message_id,
              deleteAt: deleteAt,
            }).run();
          } catch (err) {}
        }

        const notice = await api.sendMessage({
          chat_id: chatId,
          text: `⏳ <i>These files will self-destruct in ${autoDelNoticeText} to prevent copyright issues. Save them now.</i>`,
          parse_mode: 'HTML',
          reply_markup: saveNoticeMarkup,
        });
        await db.insert(scheduledDeletions).values({
          chatId: chatId,
          messageId: notice.message_id,
          deleteAt: deleteAt,
        }).run();

        await sendLog(
          `📦 <b>Batch Delivered</b>\n` +
          `• Range: <code>${batchStart} - ${batchEnd}</code>\n` +
          `• Recipient: <code>${userId}</code> (${message.from?.first_name ?? 'User'})`
        );
        return;
      }

      const custom = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'start_message')).get();
      await api.sendMessage({
        chat_id: chatId,
        text: custom?.value ?? '👋 <b>Welcome!</b>\n\nClick on any file link to download files directly through this bot.\n\nSend files to store them and get shareable links.',
        parse_mode: 'HTML',
      });
      return;
    }
  } catch (err) {
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: '⚠️ An unexpected error occurred while processing your request. Please try again later.',
      });
    } catch (e) {}
  }
}
