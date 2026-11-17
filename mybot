from telegram import Update
from telegram.ext import Application, MessageHandler, filters, ContextTypes

# توکن ربات رو از BotFather بگیر و اینجا بذار
TOKEN = "YOUR_BOT_TOKEN_HERE"

async def update_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🤖 ربات در حال آپدیت است، لطفاً منتظر باشید...")

def main():
    app = Application.builder().token(TOKEN).build()
    
    # هر پیامی که فرستاده بشه (متن، عکس، فایل و...) پاسخ می‌گیره
    app.add_handler(MessageHandler(filters.ALL, update_message))
    
    print("ربات روشن شد...")
    app.run_polling()

if __name__ == "__main__":
    main()
