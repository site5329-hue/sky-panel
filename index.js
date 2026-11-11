
import os
import json
import sqlite3
import secrets
import string
import asyncio
from pathlib import Path

import requests
from cryptography.fernet import Fernet
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ================= CONFIG =================

BOT_TOKEN = os.environ["BOT_TOKEN"]
ADMIN_IDS = {
    int(x.strip())
    for x in os.environ["ADMIN_IDS"].split(",")
    if x.strip()
}

FERNET_KEY = os.environ["FERNET_KEY"].encode()
cipher = Fernet(FERNET_KEY)

DB_PATH = os.environ.get("DB_PATH", "zes.sqlite3")
CF_API = "https://api.cloudflare.com/client/v4"

VERSION = "1.2.2"

# ================= DATABASE =================

def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()

    con.executescript("""
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT UNIQUE,
        email TEXT,
        token TEXT
    );

    CREATE TABLE IF NOT EXISTS panels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        worker_name TEXT UNIQUE,
        database_id TEXT,
        database_name TEXT,
        panel_url TEXT
    );
    """)

    con.commit()
    con.close()


def encrypt_token(token):
    return cipher.encrypt(token.encode()).decode()


def decrypt_token(token):
    return cipher.decrypt(token.encode()).decode()


def get_account(account_id):
    con = db()
    row = con.execute(
        "SELECT * FROM accounts WHERE account_id=?",
        (account_id,)
    ).fetchone()
    con.close()

    if not row:
        return None

    return dict(row)


def get_accounts():
    con = db()
    rows = con.execute(
        "SELECT * FROM accounts ORDER BY id DESC"
    ).fetchall()
    con.close()
    return [dict(x) for x in rows]


def get_panel(panel_id):
    con = db()
    row = con.execute(
        "SELECT * FROM panels WHERE id=?",
        (panel_id,)
    ).fetchone()
    con.close()
    return dict(row) if row else None


def get_panels(account_id=None):
    con = db()

    if account_id:
        rows = con.execute(
            "SELECT * FROM panels WHERE account_id=? ORDER BY id DESC",
            (account_id,)
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM panels ORDER BY id DESC"
        ).fetchall()

    con.close()
    return [dict(x) for x in rows]


def save_account(account_id, email, token):
    con = db()

    con.execute("""
        INSERT INTO accounts(account_id,email,token)
        VALUES(?,?,?)
        ON CONFLICT(account_id)
        DO UPDATE SET email=excluded.email, token=excluded.token
    """, (account_id, email, encrypt_token(token)))

    con.commit()
    con.close()


def save_panel(account_id, worker, database_id, database_name, url):
    con = db()

    con.execute("""
        INSERT INTO panels(
            account_id,worker_name,database_id,database_name,panel_url
        )
        VALUES(?,?,?,?,?)
    """, (account_id, worker, database_id, database_name, url))

    con.commit()
    con.close()


def remove_panel(panel_id):
    con = db()
    con.execute("DELETE FROM panels WHERE id=?", (panel_id,))
    con.commit()
    con.close()


def panel_count(account_id):
    con = db()
    count = con.execute(
        "SELECT COUNT(*) FROM panels WHERE account_id=?",
        (account_id,)
    ).fetchone()[0]
    con.close()
    return count


# ================= CLOUDFLARE API =================

class Cloudflare:

    def __init__(self, token):
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}"
        }

    def request(self, method, endpoint, **kwargs):
        response = requests.request(
            method,
            CF_API + endpoint,
            headers=self.headers,
            timeout=60,
            **kwargs
        )

        try:
            data = response.json()
        except ValueError:
            raise Exception("Cloudflare پاسخ معتبر نداد.")

        if not response.ok or not data.get("success"):
            errors = data.get("errors", [])
            message = "; ".join(
                x.get("message", "Unknown error")
                for x in errors
            )
            raise Exception(message or f"HTTP {response.status_code}")

        return data.get("result")

    def validate(self):
        user = self.request("GET", "/user")
        accounts = self.request("GET", "/accounts")

        return user, accounts

    def create_database(self, account_id, name):
        result = self.request(
            "POST",
            f"/accounts/{account_id}/d1/database",
            json={"name": name}
        )
        return result["uuid"]

    def initialize_database(self, account_id, database_id):
        sql = """
        CREATE TABLE IF NOT EXISTS panel_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """

        self.request(
            "POST",
            f"/accounts/{account_id}/d1/database/{database_id}/query",
            json={"sql": sql}
        )

    def upload_worker(self, account_id, worker_name, database_id):

        worker_source = WORKER_SOURCE

        metadata = {
            "main_module": "index.js",
            "compatibility_date": "2026-11-11",
            "bindings": [
                {
                    "type": "d1",
                    "name": "DB",
                    "id": database_id
                }
            ]
        }

        files = {
            "metadata": (
                "metadata.json",
                json.dumps(metadata),
                "application/json"
            ),
            "index.js": (
                "index.js",
                worker_source,
                "application/javascript+module"
            )
        }

        self.request(
            "PUT",
            f"/accounts/{account_id}/workers/scripts/{worker_name}",
            files=files
        )

    def enable_subdomain(self, account_id, worker_name):
        self.request(
            "PUT",
            f"/accounts/{account_id}/workers/scripts/{worker_name}/subdomain",
            json={"enabled": True}
        )

    def delete_worker(self, account_id, worker_name):
        self.request(
            "DELETE",
            f"/accounts/{account_id}/workers/scripts/{worker_name}"
        )

    def delete_database(self, account_id, database_id):
        self.request(
            "DELETE",
            f"/accounts/{account_id}/d1/database/{database_id}"
        )

    def create_panel(self, account_id):

        worker_name = "zes-" + secrets.token_hex(5)
        database_name = "zes-db-" + secrets.token_hex(4)

        database_id = self.create_database(
            account_id,
            database_name
        )

        self.initialize_database(account_id, database_id)

        self.upload_worker(
            account_id,
            worker_name,
            database_id
        )

        self.enable_subdomain(account_id, worker_name)

        url = f"https://{worker_name}.workers.dev"

        save_panel(
            account_id,
            worker_name,
            database_id,
            database_name,
            url
        )

        return worker_name, database_id, url

    def redeploy_panel(self, account_id, worker_name, database_id):
        self.upload_worker(account_id, worker_name, database_id)
        self.enable_subdomain(account_id, worker_name)

    def remove_panel_cloudflare(self, account_id, worker_name, database_id):
        self.delete_worker(account_id, worker_name)

        try:
            self.delete_database(account_id, database_id)
        except Exception:
            pass


# ================= WORKER SOURCE =================

WORKER_SOURCE = r'''
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        const headers = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    ...headers,
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type"
                }
            });
        }

        if (url.pathname === "/api/health") {
            return Response.json({
                status: "online",
                version: "1.2.2"
            });
        }

        if (url.pathname === "/api/items" && request.method === "GET") {
            const result = await env.DB.prepare(
                "SELECT * FROM panel_data ORDER BY id DESC LIMIT 100"
            ).all();

            return Response.json(result.results, {headers});
        }

        if (url.pathname === "/api/items" && request.method === "POST") {
            let body;

            try {
                body = await request.json();
            } catch {
                return Response.json(
                    {error: "Invalid JSON"},
                    {status: 400, headers}
                );
            }

            if (!body.item || typeof body.item !== "string") {
                return Response.json(
                    {error: "Invalid item"},
                    {status: 400, headers}
                );
            }

            if (body.item.length > 500) {
                return Response.json(
                    {error: "Item too long"},
                    {status: 400, headers}
                );
            }

            await env.DB.prepare(
                "INSERT INTO panel_data(item) VALUES(?)"
            ).bind(body.item).run();

            return Response.json({success: true}, {headers});
        }

        if (url.pathname === "/") {
            return new Response(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport"
                          content="width=device-width,initial-scale=1">
                    <title>ZES Panel 1.2.2</title>
                    <style>
                        body {
                            background:#101827;
                            color:#fff;
                            font-family:Arial,sans-serif;
                            margin:0;
                            padding:35px 15px;
                        }
                        .card {
                            max-width:550px;
                            margin:auto;
                            padding:25px;
                            border-radius:15px;
                            background:#1d293b;
                        }
                        h1 {color:#55d6be}
                        input,button {
                            box-sizing:border-box;
                            width:100%;
                            padding:13px;
                            margin-top:10px;
                            border:0;
                            border-radius:8px;
                        }
                        button {
                            background:#55d6be;
                            cursor:pointer;
                            font-weight:bold;
                        }
                        .item {
                            background:#29384e;
                            padding:12px;
                            border-radius:8px;
                            margin-top:8px;
                            overflow-wrap:anywhere;
                        }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>ZES 1.2.2</h1>
                        <p>Cloudflare D1 Panel</p>
                        <p id="status">Checking connection...</p>
                        <input id="item" placeholder="Enter an item">
                        <button onclick="addItem()">Add item</button>
                        <div id="items"></div>
                    </div>

                    <script>
                        async function loadItems() {
                            try {
                                const r = await fetch('/api/items');
                                const data = await r.json();

                                document.getElementById('items').innerHTML =
                                    data.map(x =>
                                        '<div class="item"></div>'
                                    ).join('');

                                document.querySelectorAll('.item').forEach(
                                    (el, i) => {
                                        el.textContent = data[i].item;
                                    }
                                );

                                document.getElementById('status').textContent =
                                    'Database connected';
                            } catch {
                                document.getElementById('status').textContent =
                                    'Connection error';
                            }
                        }

                        async function addItem() {
                            const input = document.getElementById('item');

                            if (!input.value.trim()) return;

                            const r = await fetch('/api/items', {
                                method:'POST',
                                headers:{'Content-Type':'application/json'},
                                body:JSON.stringify({item:input.value})
                            });

                            if (r.ok) {
                                input.value = '';
                                loadItems();
                            }
                        }

                        loadItems();
                    </script>
                </body>
                </html>
            `, {
                headers: {"Content-Type": "text/html;charset=UTF-8"}
            });
        }

        return new Response("Not Found", {status:404});
    }
};
'''


# ================= BOT HELPERS =================

def is_admin(user_id):
    return user_id in ADMIN_IDS


def main_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ ساخت پنل", callback_data="create")],
        [InlineKeyboardButton("⚙️ آپدیت و مدیریت پنل‌ها",
                              callback_data="panels")],
        [InlineKeyboardButton("👤 افزودن اکانت",
                              callback_data="add_account")],
        [InlineKeyboardButton("📧 مدیریت اکانت‌ها",
                              callback_data="accounts")]
    ])


def account_keyboard(action):
    accounts = get_accounts()
    buttons = []

    for account in accounts:
        buttons.append([
            InlineKeyboardButton(
                f"📧 {account['email']}",
                callback_data=f"{action}:{account['account_id']}"
            )
        ])

    buttons.append([
        InlineKeyboardButton("🔙 بازگشت", callback_data="home")
    ])

    return InlineKeyboardMarkup(buttons)


# ================= START =================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):

    if not is_admin(update.effective_user.id):
        return

    context.user_data.clear()

    await update.message.reply_text(
        "ZES 1.2.2\n\n"
        "به مدیریت پنل‌های Cloudflare خوش آمدید.",
        reply_markup=main_keyboard()
    )


# ================= ADD ACCOUNT =================

async def receive_token(update: Update, context: ContextTypes.DEFAULT_TYPE):

    if not is_admin(update.effective_user.id):
        return

    if context.user_data.get("state") != "waiting_token":
        return

    token = update.message.text.strip()
    context.user_data.clear()

    msg = await update.message.reply_text(
        "⏳ در حال بررسی توکن Cloudflare..."
    )

    try:
        cf = Cloudflare(token)
        user, accounts = await asyncio.to_thread(cf.validate)

        email = user.get("email", "Unknown")

        if not accounts:
            raise Exception("هیچ اکانتی برای این توکن پیدا نشد.")

        for account in accounts:
            save_account(
                account["id"],
                email,
                token
            )

        await msg.edit_text(
            "✅ اکانت با موفقیت اضافه شد.\n\n"
            f"📧 Email: {email}\n"
            f"👤 Accounts: {len(accounts)}"
        )

    except Exception as e:
        await msg.edit_text(
            "❌ خطا در ثبت اکانت:\n" + str(e)[:800]
        )


# ================= CALLBACKS =================

async def callbacks(update: Update, context: ContextTypes.DEFAULT_TYPE):

    query = update.callback_query

    if not is_admin(query.from_user.id):
        await query.answer("Access denied", show_alert=True)
        return

    await query.answer()

    data = query.data

    if data == "home":
        context.user_data.clear()

        await query.edit_message_text(
            "ZES 1.2.2\n\nمنوی اصلی:",
            reply_markup=main_keyboard()
        )
        return

    if data == "add_account":
        context.user_data["state"] = "waiting_token"

        await query.edit_message_text(
            "🔐 لطفاً Cloudflare API Token را ارسال کنید.\n\n"
            "توکن باید دسترسی لازم برای Workers Scripts، "
            "D1 و مشاهده اکانت‌ها را داشته باشد.\n\n"
            "پس از ثبت، پیام توکن را از تاریخچه چت خود پاک کنید.",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔙 بازگشت", callback_data="home")]
            ])
        )
        return

    if data == "create":
        accounts = get_accounts()

        if not accounts:
            await query.edit_message_text(
                "❌ ابتدا باید یک اکانت Cloudflare اضافه کنید.",
                reply_markup=main_keyboard()
            )
            return

        await query.edit_message_text(
            "اکانتی را انتخاب کنید که Worker روی آن ساخته شود:",
            reply_markup=account_keyboard("build")
        )
        return

    if data.startswith("build:"):

        account_id = data.split(":", 1)[1]
        account = get_account(account_id)

        if not account:
            await query.edit_message_text("اکانت پیدا نشد.")
            return

        msg = await query.edit_message_text(
            "⏳ شروع ساخت پنل...\n\n"
            "1. بررسی اکانت\n"
            "2. ساخت دیتابیس D1\n"
            "3. اتصال دیتابیس\n"
            "4. انتشار Worker\n"
            "5. فعال‌سازی آدرس"
        )

        try:
            cf = Cloudflare(decrypt_token(account["token"]))

            worker, database_id, url = await asyncio.to_thread(
                cf.create_panel,
                account_id
            )

            await msg.edit_text(
                "✅ پنل با موفقیت ساخته شد!\n\n"
                f"📦 Worker: {worker}\n"
                f"🗄 D1 ID: {database_id}\n\n"
                f"🔗 لینک پنل:\n{url}",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🌐 باز کردن پنل", url=url)],
                    [InlineKeyboardButton("🔙 منوی اصلی",
                                          callback_data="home")]
                ])
            )

        except Exception as e:
            await msg.edit_text(
                "❌ ساخت پنل ناموفق بود:\n" + str(e)[:1000]
            )

        return

    if data == "panels":

        accounts = get_accounts()

        if not accounts:
            await query.edit_message_text(
                "ابتدا یک اکانت اضافه کنید.",
                reply_markup=main_keyboard()
            )
            return

        await query.edit_message_text(
            "اکانت موردنظر را انتخاب کنید:",
            reply_markup=account_keyboard("plist")
        )
        return

    if data.startswith("plist:"):

        account_id = data.split(":", 1)[1]
        panels = get_panels(account_id)

        buttons = []

        for panel in panels:
            buttons.append([
                InlineKeyboardButton(
                    "⚙️ " + panel["worker_name"],
                    callback_data=f"panel:{panel['id']}"
                )
            ])

        buttons.append([
            InlineKeyboardButton("🔙 بازگشت", callback_data="panels")
        ])

        text = (
            f"📦 تعداد پنل‌ها: {len(panels)}\n\n"
            "برای مدیریت هر پنل روی آن کلیک کنید."
        )

        await query.edit_message_text(
            text,
            reply_markup=InlineKeyboardMarkup(buttons)
        )
        return

    if data.startswith("panel:"):

        panel_id = int(data.split(":")[1])
        panel = get_panel(panel_id)

        if not panel:
            await query.edit_message_text("پنل پیدا نشد.")
            return

        await query.edit_message_text(
            f"📦 Worker: {panel['worker_name']}\n\n"
            f"🔗 {panel['panel_url']}\n\n"
            "عملیات موردنظر را انتخاب کنید:",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🌐 مشاهده پنل",
                                      url=panel["panel_url"])],
                [InlineKeyboardButton("🔄 انتشار مجدد",
                                      callback_data=f"restart:{panel_id}")],
                [InlineKeyboardButton("🗑 حذف پنل",
                                      callback_data=f"delete:{panel_id}")],
                [InlineKeyboardButton("🔙 بازگشت",
                                      callback_data=f"plist:{panel['account_id']}")]
            ])
        )
        return

    if data.startswith("restart:"):

        panel_id = int(data.split(":")[1])
        panel = get_panel(panel_id)

        if not panel:
            await query.edit_message_text("پنل پیدا نشد.")
            return

        account = get_account(panel["account_id"])

        try:
            cf = Cloudflare(decrypt_token(account["token"]))

            await asyncio.to_thread(
                cf.redeploy_panel,
                panel["account_id"],
                panel["worker_name"],
                panel["database_id"]
            )

            await query.edit_message_text(
                "✅ Worker مجدداً منتشر شد.\n\n"
                f"🔗 {panel['panel_url']}",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🔙 بازگشت",
                                          callback_data=f"panel:{panel_id}")]
                ])
            )

        except Exception as e:
            await query.edit_message_text(
                "❌ خطا:\n" + str(e)[:800]
            )

        return

    if data.startswith("delete:"):

        panel_id = int(data.split(":")[1])
        panel = get_panel(panel_id)

        if not panel:
            await query.edit_message_text("پنل پیدا نشد.")
            return

        await query.edit_message_text(
            "⚠️ آیا از حذف Worker و دیتابیس آن مطمئن هستید؟",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("✅ بله، حذف کن",
                                      callback_data=f"confirm_delete:{panel_id}")],
                [InlineKeyboardButton("❌ لغو",
                                      callback_data=f"panel:{panel_id}")]
            ])
        )
        return

    if data.startswith("confirm_delete:"):

        panel_id = int(data.split(":")[1])
        panel = get_panel(panel_id)

        if not panel:
            await query.edit_message_text("پنل قبلاً حذف شده است.")
            return

        account = get_account(panel["account_id"])

        try:
            cf = Cloudflare(decrypt_token(account["token"]))

            await asyncio.to_thread(
                cf.remove_panel_cloudflare,
                panel["account_id"],
                panel["worker_name"],
                panel["database_id"]
            )

            remove_panel(panel_id)

            await query.edit_message_text(
                "✅ پنل حذف شد.",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton(
                        "🔙 بازگشت",
                        callback_data=f"plist:{panel['account_id']}"
                    )]
                ])
            )

        except Exception as e:
            await query.edit_message_text(
                "❌ خطا در حذف:\n" + str(e)[:800]
            )

        return

    if data == "accounts":

        accounts = get_accounts()

        if not accounts:
            await query.edit_message_text(
                "هیچ اکانتی ثبت نشده است.",
                reply_markup=main_keyboard()
            )
            return

        buttons = []

        for account in accounts:
            buttons.append([
                InlineKeyboardButton(
                    "📧 " + account["email"],
                    callback_data=f"ainfo:{account['account_id']}"
                )
            ])

        buttons.append([
            InlineKeyboardButton("🔙 بازگشت", callback_data="home")
        ])

        await query.edit_message_text(
            "اکانت موردنظر را انتخاب کنید:",
            reply_markup=InlineKeyboardMarkup(buttons)
        )
        return

    if data.startswith("ainfo:"):

        account_id = data.split(":", 1)[1]
        account = get_account(account_id)

        if not account:
            await query.edit_message_text("اکانت پیدا نشد.")
            return

        count = panel_count(account_id)

        await query.edit_message_text(
            "👤 اطلاعات اکانت\n\n"
            f"📧 Email: {account['email']}\n"
            f"🆔 Account ID: {account_id}\n"
            f"📦 تعداد پنل‌ها: {count}",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("📦 مشاهده پنل‌ها",
                                      callback_data=f"plist:{account_id}")],
                [InlineKeyboardButton("🔙 بازگشت",
                                      callback_data="accounts")]
            ])
        )
        return


# ================= ERROR HANDLER =================

async def error_handler(update, context):
    print("BOT ERROR:", context.error)


# ================= MAIN =================

def main():

    init_db()

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .build()
    )

    application.add_handler(CommandHandler("start", start))

    application.add_handler(
        CallbackQueryHandler(callbacks)
    )

    application.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            receive_token
        )
    )

    application.add_error_handler(error_handler)

    print(f"ZES {VERSION} is running...")

    application.run_polling(
        drop_pending_updates=True
    )


if __name__ == "__main__":
    main()
