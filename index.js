const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const port = process.env.PORT || 10000;

// بخش Express: گوش دادن به پورت برای اینکه Render سرویس را زنده تشخیص دهد
app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.send('OK'));

app.listen(port, '0.0.0.0', () => {
  console.log(`Web server listening on port ${port}`);
});

// بخش ربات تلگرام
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('خطا: متغیر محیطی TELEGRAM_TOKEN تنظیم نشده است');
} else {
  const bot = new TelegramBot(token, { polling: true });

  // پاسخ به دستور /start
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚧 ربات در حال تعمیرات است. لطفاً بعداً مراجعه کنید.');
  });

  console.log('ربات تلگرام در حال اجراست...');
}
