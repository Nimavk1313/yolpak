// bot.js
const TelegramBot = require("node-telegram-bot-api");

// Initialize Telegram Bot from environment variables
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: {
        interval: 300,
    },
});

// Fix for a deprecated promise cancellation warning
process.env.NTBA_FIX_319 = 1;

module.exports = bot;