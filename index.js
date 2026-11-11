const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

// کلید: باید از process.env.PORT استفاده شود، Render به طور خودکار این متغیر را تزریق می‌کند
// 10000 فقط برای اجرای محلی است، Render به طور پیش‌فرض از 10000 استفاده می‌کند
const port = process.env.PORT || 10000;

app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.send('OK'));

// کلید: باید روی 0.0.0.0 گوش داده شود، نه localhost یا 127.0.0.1
app.listen(port, '0.0.0.0', () => {
  console.log(`Web server listening on port ${port}`);
});

// بخش ربات تلگرام
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('خطا: متغیر محیطی TELEGRAM_TOKEN تنظیم نشده است');
} else {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚧 ربات در حال تعمیرات است. لطفاً بعداً مراجعه کنید.');
  });

  console.log('ربات تلگرام در حال اجراست...');
}
