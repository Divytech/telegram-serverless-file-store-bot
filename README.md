# Telegram Serverless File Store Bot

A lightweight, serverless Telegram File Store and Batch Share Bot built on Telegram Cloud (`@tgcloud/cli`). Store any file or media, generate shareable links, monetize with URL shorteners, protect files from being forwarded, and enforce channel force-subscriptions.

> [!IMPORTANT]
> **Telegram Serverless Access Required**  
> To host and deploy this bot using `@tgcloud/cli`, your Telegram account and bot must have **Telegram Serverless** access enabled.  
> - Serverless can be toggled via [@BotFather](https://t.me/BotFather) (`/mybots` → select your bot → **Bot Settings** → **Serverless**).  
> - For official information and documentation, visit [Telegram Cloud](https://cloud.telegram.org) and the [Telegram Bot Platform Documentation](https://core.telegram.org/bots).

---

## ✨ Features

- **Single File Storage**: Send any document, video, audio, photo, voice note, or animation to store it and receive a shareable link.
- **Batch File Storage**: Generate a single link to deliver a range of files at once (`/batch <first_id> <last_id>`).
- **Global Force-Subscription (FSub)**: Restrict file downloads until users join your required channel(s).
- **Self-Destruct / Auto-Delete**: Automatically schedules file deletion after delivery to prevent copyright strikes and DMCA bans. Operates opportunistically without requiring external cron servers.
- **Shortener Monetization**: Gate access behind standard URL shortener APIs (Droplink, Shrinkme, GPLinks, etc.) with customizable token expiration (e.g., 24 hours).
- **Content Protection**: Prevent file forwarding, saving, or exporting from the bot (`protect_content`).
- **Custom Captions**: Format delivered file captions using dynamic placeholders (`{filename}`, `{filesize}`).
- **Admin Management**: Full control with `/stats`, `/ban`, `/unban`, `/broadcast`, `/delete`, and `/setstart`.
- **Database & Log Channels**: Store original files securely in a private DB channel and stream activity alerts to an optional Log channel.

---

## 📋 Prerequisites

1. **Telegram Account with Serverless Access**: Ensure your account and bot have serverless deployment permissions enabled.
2. **Telegram Bot Token**: Get a bot token from [@BotFather](https://t.me/BotFather).
3. **Private Database Channel**:
   - Create a private Telegram channel where all uploaded files will be stored.
   - Add your bot to this channel as an **Administrator** with full post/delete permissions.
   - Get the channel's numeric ID (e.g., `-1001234567890`).
4. **Optional Log Channel**: Create a private channel to receive notifications for new users, file uploads, and downloads.
5. **Node.js**: Node.js 18+ installed on your system.

---

## 🚀 Quick Setup & Deployment

### 1. Clone the Repository
```bash
git clone <your-repository-url>
cd telegram-file-store-bot
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure the Bot
Open `tgcloud/lib/config.js` and update your settings:

```javascript
// Numeric Telegram ID of the bot owner (Superuser)
export const OWNER_ID = 123456789;

// List of Admin Telegram IDs who can upload, broadcast, and manage files
export const ADMIN_IDS = [123456789];

// Private Database Channel ID (Must add bot as Admin here)
export const DB_CHANNEL_ID = -1001234567890;

// Log Channel ID (Set to 0 to disable)
export const LOG_CHANNEL_ID = -1001234567890;

// Global Force-Subscription Channels (supports plain IDs or objects with custom names)
// Example:
// export const FSUB_CHANNELS = [-1001234567890];
// OR:
// export const FSUB_CHANNELS = [
//   { id: -1001234567890, name: 'Updates Channel' },
//   { id: -1009876543210, name: 'Main Channel' }
// ];
export const FSUB_CHANNELS = [];

// Content Protection: true disables forwarding and saving files
export const PROTECT_CONTENT = true;

// Auto-Delete delay in seconds (e.g. 600 = 10 minutes)
export const AUTO_DELETE_SECONDS = 600;

// Optional promo button below delivered files (set to null to disable)
export const PROMO_BUTTON = {
  text: '📢 Join Updates Channel',
  url: 'https://t.me/your_channel',
};

// Shortener Monetization (leave empty '' to disable)
export const SHORTENER_API_KEY = '';
export const SHORTENER_API_URL = 'https://droplink.co/api';
export const VERIFY_EXPIRE_HOURS = 24;

// Default caption template ({filename} and {filesize} are replaced automatically)
export const CUSTOM_CAPTION = '{filename} [{filesize}]';
```

### 4. Deploy to Telegram Cloud
Authenticate with Telegram Cloud and deploy:

```bash
npx tgcloud login
npx tgcloud push
```

Run database migrations to initialize tables:
```bash
npx tgcloud migrate --yes
```

Check your webhook and deployment status:
```bash
npx tgcloud status
npx tgcloud webhook info
```

---

## 🛠️ Bot Commands

### User Commands
| Command | Description |
| :--- | :--- |
| `/start` | Starts the bot or delivers the requested file link |
| `/batch <first_id> <last_id>` | Generates a single share link for a range of files in the DB channel |

### Admin Commands (Owner & Admins Only)
| Command | Description |
| :--- | :--- |
| `/stats` | View live bot statistics (users, files, pending deletions) |
| `/ban <user_id>` | Ban a user from using the bot |
| `/unban <user_id>` | Unban a user |
| `/broadcast` | Reply to any message with `/broadcast` to forward it to all users |
| `/delete <message_id>` | Delete a file from both the bot database and DB channel |
| `/setstart <text>` | Set a custom welcome message for `/start` |

---

## 🔒 Security & Privacy

- All sensitive parameters and channel IDs are isolated in `tgcloud/lib/config.js`.
- Never commit your `.tgcloud/` folder or production credentials to public repositories (already ignored in `.gitignore`).
- Content protection blocks downloading or forwarding when `PROTECT_CONTENT = true`.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
