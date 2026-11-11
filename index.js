
import os
import re
import json
import html
import uuid
import sqlite3
import asyncio
import logging
from datetime import datetime, timezone

import requests
from cryptography.fernet import Fernet
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup
)
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, ContextTypes, filters
)

# =========================================================
# CONFIG
# =========================================================

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_IDS = {
    int(x.strip())
    for x in os.getenv("ADMIN_IDS", "").split(",")
    if x.strip().isdigit()
}
FERNET_KEY = os.getenv("FERNET_KEY", "")
DB_PATH = os.getenv("DB_PATH", "zes.sqlite3")

API = "https://api.cloudflare.com/client/v4"
VERSION = "zes 1.3.0"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)
log = logging.getLogger("zes")

if not BOT_TOKEN or not ADMIN_IDS or not FERNET_KEY:
    raise RuntimeError(
        "BOT_TOKEN, ADMIN_IDS and FERNET_KEY must be configured."
    )

cipher = Fernet(FERNET_KEY.encode())


# =========================================================
# DATABASE
# =========================================================

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner INTEGER NOT NULL,
                account_id TEXT NOT NULL,
                email TEXT,
                token TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(owner, account_id)
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS panels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                worker_name TEXT NOT NULL,
                database_id TEXT NOT NULL,
                database_name TEXT NOT NULL,
                url TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id)
            )
        """)


def save_account(owner, account_id, email, token):
    encrypted = cipher.encrypt(token.encode()).decode()

    with db() as c:
        c.execute("""
            INSERT INTO accounts
            (owner, account_id, email, token, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner, account_id)
            DO UPDATE SET
                email=excluded.email,
                token=excluded.token
        """, (
            owner,
            account_id,
            email,
            encrypted,
            datetime.now(timezone.utc).isoformat()
        ))


def get_accounts(owner):
    with db() as c:
        return c.execute("""
            SELECT * FROM accounts
            WHERE owner=?
            ORDER BY id DESC
        """, (owner,)).fetchall()


def get_account(account_pk, owner):
    with db() as c:
        return c.execute("""
            SELECT * FROM accounts
            WHERE id=? AND owner=?
        """, (account_pk, owner)).fetchone()


def get_panels(owner):
    with db() as c:
        return c.execute("""
            SELECT p.*, a.email
            FROM panels p
            JOIN accounts a ON a.id=p.account_id
            WHERE p.owner=?
            ORDER BY p.id DESC
        """, (owner,)).fetchall()


def get_panel(panel_id, owner):
    with db() as c:
        return c.execute("""
            SELECT * FROM panels
            WHERE id=? AND owner=?
        """, (panel_id, owner)).fetchone()


def save_panel(owner, account_pk, worker, d1_id, d1_name, url):
    with db() as c:
        cur = c.execute("""
            INSERT INTO panels
            (owner, account_id, worker_name, database_id,
             database_name, url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            owner, account_pk, worker, d1_id, d1_name, url,
            datetime.now(timezone.utc).isoformat()
        ))
        return cur.lastrowid


def delete_panel_local(panel_id, owner):
    with db() as c:
        c.execute(
            "DELETE FROM panels WHERE id=? AND owner=?",
            (panel_id, owner)
        )


# =========================================================
# CLOUDFLARE API
# =========================================================

class Cloudflare:

    def __init__(self, token):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}"
        })

    def request(self, method, endpoint, **kwargs):
        response = self.session.request(
            method,
            API + endpoint,
            timeout=35,
            **kwargs
        )

        try:
            data = response.json()
        except Exception:
            raise RuntimeError(
                f"Cloudflare returned invalid response ({response.status_code})"
            )

        if not response.ok or not data.get("success"):
            errors = data.get("errors", [])
            message = "; ".join(
                str(x.get("message", x)) for x in errors
            ) or f"HTTP {response.status_code}"

            raise RuntimeError(message[:700])

        return data.get("result")

    def validate(self):
        user = self.request("GET", "/user")
        accounts = self.request("GET", "/accounts")

        if not accounts:
            raise RuntimeError("این توکن به هیچ اکانتی دسترسی ندارد.")

        return user, accounts

    def create_database(self, account_id, name):
        return self.request(
            "POST",
            f"/accounts/{account_id}/d1/database",
            json={"name": name}
        )

    def delete_database(self, account_id, database_id):
        return self.request(
            "DELETE",
            f"/accounts/{account_id}/d1/database/{database_id}"
        )

    def create_worker(self, account_id, worker_name, database_id):
        metadata = {
            "main_module": "index.js",
            "compatibility_date": "2025-01-01",
            "bindings": [{
                "type": "d1",
                "name": "DB",
                "id": database_id
            }]
        }

        source = WORKER_SOURCE.encode()

        files = {
            "metadata": (
                "metadata.json",
                json.dumps(metadata),
                "application/json"
            ),
            "index.js": (
                "index.js",
                source,
                "application/javascript+module"
            )
        }

        return self.request(
            "PUT",
            f"/accounts/{account_id}/workers/scripts/{worker_name}",
            files=files
        )

    def delete_worker(self, account_id, worker_name):
        return self.request(
            "DELETE",
            f"/accounts/{account_id}/workers/scripts/{worker_name}"
        )

    def get_subdomain(self, account_id):
        result = self.request(
            "GET",
            f"/accounts/{account_id}/workers/subdomain"
        )
        return result.get("subdomain")

    def enable_subdomain(self, account_id, subdomain):
        return self.request(
            "PUT",
            f"/accounts/{account_id}/workers/subdomain",
            json={"subdomain": subdomain}
        )

    def deploy(self, account_id, worker_name, database_id):
        return self.create_worker(
            account_id, worker_name, database_id
        )


# =========================================================
# WORKER SOURCE
# =========================================================

WORKER_SOURCE = r"""
export default {
  async fetch(request, env) {
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    };

    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS panel_data (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "event TEXT NOT NULL," +
        "created_at TEXT NOT NULL)"
      ).run();

      if (request.method === "POST") {
        return new Response("Method not allowed", {
          status: 405
        });
      }

      await env.DB.prepare(
        "INSERT INTO panel_data (event, created_at) VALUES (?, ?)"
      ).bind(
        "visit",
        new Date().toISOString()
      ).run();

      const result = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM panel_data"
      ).first();

      const total = Number(result?.total || 0);

      return new Response(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZES Panel</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;background:#080d18;color:#eaf0ff;
 font-family:Arial,sans-serif;min-height:100vh;
 display:grid;place-items:center;padding:20px
}
.card{
 width:min(460px,100%);padding:35px;
 border:1px solid #26334d;border-radius:22px;
 background:linear-gradient(145deg,#131f36,#0c1322);
 box-shadow:0 20px 70px #0008
}
h1{margin:0 0 12px;font-size:28px}
p{color:#aab8d0;line-height:2}
.stat{
 margin-top:25px;padding:22px;border-radius:15px;
 background:#0b1425;border:1px solid #26334d
}
.number{font-size:36px;font-weight:bold;color:#65e6b2}
small{color:#91a4c3}
.status{color:#65e6b2}
</style>
</head>
<body>
<div class="card">
<h1>ZES Panel</h1>
<p>پنل با موفقیت اجرا شده و به دیتابیس D1 متصل است.</p>
<div class="status">● وضعیت سرویس: فعال</div>
<div class="stat">
<small>تعداد بازدیدهای ثبت‌شده</small>
<div class="number">${total}</div>
</div>
</div>
</body>
</html>`, { headers });

    } catch (error) {
      return new Response(
        "Panel database error",
        { status: 500 }
      );
    }
  }
};
"""


# =========================================================
# HELPERS
# =========================================================

def is_admin(user_id):
    return user_id in ADMIN_IDS


def home_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🚀 ساخت پنل", callback_data="create")
        ],
        [
            InlineKeyboardButton(
                "🛠 آپدیت و مدیریت پنل‌ها",
                callback_data="manage"
            )
        ],
        [
            InlineKeyboardButton(
                "➕ افزودن اکانت",
                callback_data="add_account"
            )
        ],
        [
            InlineKeyboardButton(
                "👤 اکانت‌های من",
                callback_data="accounts"
            )
        ]
    ])


def account_keyboard(accounts, action):
    rows = []

    for account in accounts:
        label = account["email"] or account["account_id"][:12]

        rows.append([
            InlineKeyboardButton(
                f"☁️ {label}",
                callback_data=f"{action}:{account['id']}"
            )
        ])

    rows.append([
        InlineKeyboardButton("↩️ بازگشت", callback_data="home")
    ])

    return InlineKeyboardMarkup(rows)


async def safe_edit(query, text, reply_markup=None):
    try:
        await query.edit_message_text(
            text,
            reply_markup=reply_markup,
            disable_web_page_preview=True
        )
    except Exception:
        await query.message.reply_text(
            text,
            reply_markup=reply_markup,
            disable_web_page_preview=True
        )


async def run_cf(func, *args):
    return await asyncio.to_thread(func, *args)


# =========================================================
# COMMANDS
# =========================================================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("⛔ دسترسی غیرمجاز")
        return

    context.user_data.clear()

    await update.message.reply_text(
        f"⚡ <b>{VERSION}</b>\n\n"
        "به ربات مدیریت Cloudflare خوش آمدید.\n"
        "یکی از گزینه‌های زیر را انتخاب کنید:",
        parse_mode="HTML",
        reply_markup=home_keyboard()
    )


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text(
        "عملیات لغو شد.",
        reply_markup=home_keyboard()
    )


# =========================================================
# ADD ACCOUNT
# =========================================================

async def add_account_start(query, context):
    context.user_data["waiting_token"] = True

    await safe_edit(
        query,
        "🔐 توکن Cloudflare را ارسال کنید.\n\n"
        "توکن باید دسترسی‌های لازم برای Workers و D1 را داشته باشد.\n"
        "برای لغو /cancel را بفرستید."
    )


async def receive_token(update, context):
    if not context.user_data.get("waiting_token"):
        return

    token = update.message.text.strip()
    context.user_data["waiting_token"] = False

    if len(token) < 20 or len(token) > 500:
        await update.message.reply_text("❌ فرمت توکن معتبر نیست.")
        return

    status = await update.message.reply_text(
        "⏳ در حال بررسی توکن..."
    )

    try:
        cf = Cloudflare(token)
        user, accounts = await run_cf(cf.validate)

        context.user_data["pending_token"] = token
        context.user_data["pending_accounts"] = accounts

        keyboard = []

        for account in accounts:
            name = account.get("name") or account["id"][:12]
            keyboard.append([
                InlineKeyboardButton(
                    f"☁️ {name}",
                    callback_data=f"saveacc:{account['id']}"
                )
            ])

        await status.edit_text(
            "✅ توکن معتبر است.\n"
            "اکانت موردنظر را برای ذخیره انتخاب کنید:",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

    except Exception as e:
        log.exception("Token validation failed")
        await status.edit_text(
            f"❌ خطا در بررسی توکن:\n{html.escape(str(e))}",
            parse_mode="HTML"
        )


# =========================================================
# CREATE PANEL
# =========================================================

async def create_panel(query, context, account_pk):
    owner = query.from_user.id
    account = get_account(account_pk, owner)

    if not account:
        await safe_edit(query, "❌ اکانت پیدا نشد.")
        return

    token = cipher.decrypt(account["token"].encode()).decode()
    cf = Cloudflare(token)

    worker_name = "zes-" + uuid.uuid4().hex[:12]
    database_name = "zesdb-" + uuid.uuid4().hex[:10]

    await safe_edit(
        query,
        "⏳ ساخت پنل شروع شد...\n\n"
        "1. ایجاد دیتابیس D1\n"
        "2. اتصال دیتابیس به Worker\n"
        "3. انتشار Worker\n"
        "4. دریافت لینک پنل"
    )

    database = None
    worker_created = False

    try:
        database = await run_cf(
            cf.create_database,
            account["account_id"],
            database_name
        )

        database_id = database["uuid"]

        await run_cf(
            cf.create_worker,
            account["account_id"],
            worker_name,
            database_id
        )

        worker_created = True

        subdomain = await run_cf(
            cf.get_subdomain,
            account["account_id"]
        )

        if not subdomain:
            raise RuntimeError(
                "برای این اکانت workers.dev فعال نیست. "
                "ابتدا آن را در داشبورد Cloudflare فعال کنید."
            )

        url = f"https://{worker_name}.{subdomain}.workers.dev"

        panel_id = save_panel(
            owner,
            account_pk,
            worker_name,
            database_id,
            database_name,
            url
        )

        await safe_edit(
            query,
            "✅ <b>پنل با موفقیت ساخته شد!</b>\n\n"
            f"🆔 شناسه: <code>{panel_id}</code>\n"
            f"⚙️ Worker: <code>{worker_name}</code>\n"
            f"🗄 دیتابیس: <code>{database_name}</code>\n\n"
            f"🔗 <a href=\"{url}\">{url}</a>\n\n"
            "وضعیت: فعال",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("🏠 منوی اصلی", callback_data="home")
            ]])
        )

    except Exception as e:
        log.exception("Panel creation failed")

        # Roll back resources created during this operation.
        if worker_created:
            try:
                await run_cf(
                    cf.delete_worker,
                    account["account_id"],
                    worker_name
                )
            except Exception:
                log.exception("Worker rollback failed")

        if database:
            try:
                await run_cf(
                    cf.delete_database,
                    account["account_id"],
                    database["uuid"]
                )
            except Exception:
                log.exception("D1 rollback failed")

        await safe_edit(
            query,
            "❌ ساخت پنل ناموفق بود.\n\n"
            f"<code>{html.escape(str(e))}</code>",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("🏠 منوی اصلی", callback_data="home")
            ]])
        )


# =========================================================
# PANEL MANAGEMENT
# =========================================================

async def show_panels(query, owner):
    panels = get_panels(owner)

    if not panels:
        await safe_edit(
            query,
            "📭 هنوز هیچ پنلی نساخته‌اید.",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("↩️ بازگشت", callback_data="home")
            ]])
        )
        return

    rows = []

    for panel in panels:
        rows.append([
            InlineKeyboardButton(
                f"⚙️ {panel['worker_name']}",
                callback_data=f"panel:{panel['id']}"
            )
        ])

    rows.append([
        InlineKeyboardButton("↩️ بازگشت", callback_data="home")
    ])

    await safe_edit(
        query,
        f"🛠 پنل‌های شما: {len(panels)}\n\n"
        "برای مدیریت هر پنل روی آن بزنید:",
        InlineKeyboardMarkup(rows)
    )


async def show_panel_details(query, owner, panel_id):
    panel = get_panel(panel_id, owner)

    if not panel:
        await safe_edit(query, "❌ پنل پیدا نشد.")
        return

    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "🔄 انتشار مجدد",
                callback_data=f"redeploy:{panel_id}"
            )
        ],
        [
            InlineKeyboardButton(
                "🗑 حذف پنل",
                callback_data=f"delete:{panel_id}"
            )
        ],
        [
            InlineKeyboardButton(
                "↩️ بازگشت",
                callback_data="manage"
            )
        ]
    ])

    await safe_edit(
        query,
        "⚙️ <b>مدیریت پنل</b>\n\n"
        f"شناسه: <code>{panel['id']}</code>\n"
        f"Worker: <code>{panel['worker_name']}</code>\n"
        f"D1: <code>{panel['database_name']}</code>\n"
        f"لینک: {panel['url']}",
        keyboard
    )


async def redeploy_panel(query, owner, panel_id):
    panel = get_panel(panel_id, owner)

    if not panel:
        await safe_edit(query, "❌ پنل پیدا نشد.")
        return

    account = get_account(panel["account_id"], owner)

    if not account:
        await safe_edit(query, "❌ اکانت مربوط به پنل پیدا نشد.")
        return

    token = cipher.decrypt(account["token"].encode()).decode()
    cf = Cloudflare(token)

    await safe_edit(query, "⏳ در حال انتشار مجدد Worker...")

    try:
        await run_cf(
            cf.deploy,
            account["account_id"],
            panel["worker_name"],
            panel["database_id"]
        )

        await safe_edit(
            query,
            "✅ Worker با موفقیت مجدداً منتشر شد.\n\n"
            f"🔗 {panel['url']}",
            InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "↩️ مدیریت پنل",
                    callback_data=f"panel:{panel_id}"
                )
            ]])
        )

    except Exception as e:
        log.exception("Redeploy failed")
        await safe_edit(
            query,
            f"❌ خطا:\n<code>{html.escape(str(e))}</code>"
        )


async def delete_panel_confirm(query, owner, panel_id):
    panel = get_panel(panel_id, owner)

    if not panel:
        await safe_edit(query, "❌ پنل پیدا نشد.")
        return

    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "بله، حذف شود",
                callback_data=f"confirmdelete:{panel_id}"
            ),
            InlineKeyboardButton(
                "لغو",
                callback_data=f"panel:{panel_id}"
            )
        ]
    ])

    await safe_edit(
        query,
        "⚠️ آیا مطمئن هستید؟\n\n"
        "با تأیید، Worker و دیتابیس D1 حذف می‌شوند.",
        keyboard
    )


async def delete_panel(query, owner, panel_id):
    panel = get_panel(panel_id, owner)

    if not panel:
        await safe_edit(query, "❌ پنل پیدا نشد.")
        return

    account = get_account(panel["account_id"], owner)

    if not account:
        await safe_edit(query, "❌ اکانت مربوط به پنل پیدا نشد.")
        return

    token = cipher.decrypt(account["token"].encode()).decode()
    cf = Cloudflare(token)

    await safe_edit(query, "⏳ در حال حذف منابع Cloudflare...")

    try:
        await run_cf(
            cf.delete_worker,
            account["account_id"],
            panel["worker_name"]
        )

        await run_cf(
            cf.delete_database,
            account["account_id"],
            panel["database_id"]
        )

        delete_panel_local(panel_id, owner)

        await safe_edit(
            query,
            "✅ پنل و دیتابیس آن حذف شدند.",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("🏠 منوی اصلی", callback_data="home")
            ]])
        )

    except Exception as e:
        log.exception("Delete failed")
        await safe_edit(
            query,
            "❌ حذف کامل انجام نشد.\n"
            "اطلاعات پنل در ربات نگه داشته شده است تا بتوانید دوباره تلاش کنید.\n\n"
            f"<code>{html.escape(str(e))}</code>"
        )


# =========================================================
# ACCOUNTS
# =========================================================

async def show_accounts(query, owner):
    accounts = get_accounts(owner)

    if not accounts:
        await safe_edit(
            query,
            "📭 هیچ اکانتی ثبت نشده است.",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("↩️ بازگشت", callback_data="home")
            ]])
        )
        return

    panels = get_panels(owner)
    rows = []

    for account in accounts:
        count = sum(
            1 for p in panels
            if p["account_id"] == account["id"]
        )

        rows.append(
            f"☁️ <b>{html.escape(account['email'] or 'Cloudflare')}</b>\n"
            f"🆔 <code>{account['account_id']}</code>\n"
            f"📦 تعداد پنل: <b>{count}</b>"
        )

    await safe_edit(
        query,
        "👤 <b>اکانت‌های ثبت‌شده</b>\n\n" + "\n\n".join(rows),
        InlineKeyboardMarkup([[
            InlineKeyboardButton("↩️ بازگشت", callback_data="home")
        ]])
    )


# =========================================================
# CALLBACK ROUTER
# =========================================================

async def callbacks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    owner = query.from_user.id

    if not is_admin(owner):
        await safe_edit(query, "⛔ دسترسی غیرمجاز")
        return

    data = query.data

    if data == "home":
        context.user_data.clear()
        await safe_edit(
            query,
            f"⚡ <b>{VERSION}</b>\n\nمنوی اصلی:",
            home_keyboard()
        )

    elif data == "add_account":
        await add_account_start(query, context)

    elif data == "create":
        accounts = get_accounts(owner)

        if not accounts:
            await safe_edit(
                query,
                "ابتدا یک اکانت Cloudflare اضافه کنید.",
                InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "➕ افزودن اکانت",
                        callback_data="add_account"
                    )
                ]])
            )
        else:
            await safe_edit(
                query,
                "اکانت موردنظر برای ساخت پنل را انتخاب کنید:",
                account_keyboard(accounts, "createacc")
            )

    elif data.startswith("saveacc:"):
        account_id = data.split(":", 1)[1]
        token = context.user_data.get("pending_token")
        accounts = context.user_data.get("pending_accounts", [])

        selected = next(
            (a for a in accounts if a["id"] == account_id),
            None
        )

        if not token or not selected:
            await safe_edit(query, "❌ اطلاعات ثبت اکانت منقضی شده است.")
            return

        save_account(
            owner,
            selected["id"],
            selected.get("name") or selected.get("id"),
            token
        )

        context.user_data.pop("pending_token", None)
        context.user_data.pop("pending_accounts", None)

        await safe_edit(
            query,
            "✅ اکانت با موفقیت ذخیره شد.",
            InlineKeyboardMarkup([[
                InlineKeyboardButton("🏠 منوی اصلی", callback_data="home")
            ]])
        )

    elif data.startswith("createacc:"):
        account_pk = int(data.split(":", 1)[1])
        await create_panel(query, context, account_pk)

    elif data == "manage":
        await show_panels(query, owner)

    elif data == "accounts":
        await show_accounts(query, owner)

    elif data.startswith("panel:"):
        panel_id = int(data.split(":", 1)[1])
        await show_panel_details(query, owner, panel_id)

    elif data.startswith("redeploy:"):
        panel_id = int(data.split(":", 1)[1])
        await redeploy_panel(query, owner, panel_id)

    elif data.startswith("delete:"):
        panel_id = int(data.split(":", 1)[1])
        await delete_panel_confirm(query, owner, panel_id)

    elif data.startswith("confirmdelete:"):
        panel_id = int(data.split(":", 1)[1])
        await delete_panel(query, owner, panel_id)


# =========================================================
# ERROR HANDLER
# =========================================================

async def error_handler(update, context):
    log.error(
        "Unhandled error",
        exc_info=context.error
    )

    try:
        if update and update.effective_message:
            await update.effective_message.reply_text(
                "❌ خطای داخلی رخ داد. دوباره تلاش کنید."
            )
    except Exception:
        pass


# =========================================================
# MAIN
# =========================================================

def main():
    init_db()

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .concurrent_updates(16)
        .build()
    )

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("cancel", cancel))

    application.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            receive_token
        )
    )

    application.add_handler(
        CallbackQueryHandler(callbacks)
    )

    application.add_error_handler(error_handler)

    log.info("%s started", VERSION)

    application.run_polling(
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=True
    )


if __name__ == "__main__":
    main()
