#!/bin/bash

# ========================================
# SkyPanel - Installation Script
# قدرتمندترین پنل کانفیگ
# ========================================

set -e

# ===== رنگ‌ها =====
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ===== متغیرها =====
PANEL_NAME="SkyPanel"
VERSION="1.0.0"
REPO_URL="https://github.com/skypanel/skypanel"

# ===== تابع چاپ بنر =====
print_banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║                                                  ║${NC}"
  echo -e "${CYAN}║        ⚡ SkyPanel - Installation ⚡             ║${NC}"
  echo -e "${CYAN}║                                                  ║${NC}"
  echo -e "${CYAN}║        قدرتمندترین پنل کانفیگ                    ║${NC}"
  echo -e "${CYAN}║                                                  ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${GREEN}  نسخه: ${VERSION}${NC}"
  echo -e "${GREEN}  مخزن: ${REPO_URL}${NC}"
  echo ""
}

# ===== تابع لاگ =====
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# ===== بررسی روت =====
check_root() {
  if [ "$EUID" -ne 0 ]; then
    log_error "این اسکریپت باید با دسترسی root اجرا شود"
    log_info "از دستور زیر استفاده کنید: sudo bash install.sh"
    exit 1
  fi
  log_success "دسترسی root تایید شد"
}

# ===== بررسی سیستم‌عامل =====
check_os() {
  log_info "بررسی سیستم‌عامل..."

  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VER=$VERSION_ID
  else
    log_error "سیستم‌عامل پشتیبانی نمی‌شود"
    exit 1
  fi

  case $OS in
    ubuntu|debian)
      log_success "سیستم‌عامل: $OS $VER"
      ;;
    centos|fedora|rhel)
      log_success "سیستم‌عامل: $OS $VER"
      ;;
    *)
      log_warning "سیستم‌عامل $OS ممکن است کامل پشتیبانی نشود"
      ;;
  esac
}

# ===== نصب پیش‌نیازها =====
install_dependencies() {
  log_info "نصب پیش‌نیازها..."

  case $OS in
    ubuntu|debian)
      apt-get update -qq
      apt-get install -y -qq curl wget git unzip > /dev/null 2>&1
      ;;
    centos|fedora|rhel)
      yum install -y -q curl wget git unzip > /dev/null 2>&1
      ;;
    *)
      log_warning "نصب پیش‌نیازها برای $OS پشتیبانی نمی‌شود"
      return
      ;;
  esac

  log_success "پیش‌نیازها نصب شدند"
}

# ===== بررسی Node.js =====
check_nodejs() {
  log_info "بررسی Node.js..."

  if command -v node > /dev/null 2>&1; then
    NODE_VERSION=$(node -v)
    log_success "Node.js نصب است: $NODE_VERSION"
  else
    log_warning "Node.js نصب نیست"
    install_nodejs
  fi
}

# ===== نصب Node.js =====
install_nodejs() {
  log_info "نصب Node.js..."

  curl -fsSL https://deb.nodesource.com/setup_18.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1

  if command -v node > /dev/null 2>&1; then
    log_success "Node.js نصب شد: $(node -v)"
  else
    log_error "نصب Node.js با خطا مواجه شد"
    exit 1
  fi
}

# ===== دانلود پروژه =====
download_project() {
  log_info "دانلود پروژه SkyPanel..."

  if [ -d "/opt/skypanel" ]; then
    log_warning "پوشه /opt/skypanel از قبل وجود دارد"
    read -p "آیا می‌خواهید آن را حذف و دوباره نصب کنید؟ (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      rm -rf /opt/skypanel
    else
      log_info "نصب لغو شد"
      exit 0
    fi
  fi

  git clone "$REPO_URL" /opt/skypanel > /dev/null 2>&1

  if [ -d "/opt/skypanel" ]; then
    log_success "پروژه دانلود شد"
  else
    log_error "دانلود پروژه با خطا مواجه شد"
    exit 1
  fi
}

# ===== نصب پکیج‌ها =====
install_packages() {
  log_info "نصب پکیج‌های npm..."

  cd /opt/skypanel

  if [ -f "package.json" ]; then
    npm install --silent > /dev/null 2>&1
    log_success "پکیج‌ها نصب شدند"
  else
    log_warning "فایل package.json یافت نشد"
  fi
}

# ===== ساخت سرویس systemd =====
create_service() {
  log_info "ساخت سرویس systemd..."

  cat > /etc/systemd/system/skypanel.service << EOF
[Unit]
Description=SkyPanel - قدرتمندترین پنل کانفیگ
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/skypanel
ExecStart=/usr/bin/node /opt/skypanel/app.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable skypanel > /dev/null 2>&1

  log_success "سرویس systemd ساخته شد"
}

# ===== راه‌اندازی سرویس =====
start_service() {
  log_info "راه‌اندازی سرویس SkyPanel..."

  systemctl start skypanel

  if systemctl is-active --quiet skypanel; then
    log_success "سرویس SkyPanel در حال اجراست"
  else
    log_error "راه‌اندازی سرویس با خطا مواجه شد"
    exit 1
  fi
}

# ===== نمایش اطلاعات نهایی =====
show_final_info() {
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║                                                  ║${NC}"
  echo -e "${GREEN}║        ✅ نصب با موفقیت انجام شد! ✅             ║${NC}"
  echo -e "${GREEN}║                                                  ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${CYAN}📋 اطلاعات سرویس:${NC}"
  echo -e "  ${GREEN}▸${NC} نام سرویس: ${YELLOW}skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} مسیر نصب: ${YELLOW}/opt/skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} فایل سرویس: ${YELLOW}/etc/systemd/system/skypanel.service${NC}"
  echo ""
  echo -e "${CYAN}🎮 دستورات مدیریت:${NC}"
  echo -e "  ${GREEN}▸${NC} شروع: ${YELLOW}systemctl start skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} توقف: ${YELLOW}systemctl stop skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} ری‌استارت: ${YELLOW}systemctl restart skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} وضعیت: ${YELLOW}systemctl status skypanel${NC}"
  echo -e "  ${GREEN}▸${NC} لاگ‌ها: ${YELLOW}journalctl -u skypanel -f${NC}"
  echo ""
  echo -e "${CYAN}📢 لینک‌های ما:${NC}"
  echo -e "  ${GREEN}▸${NC} کانال تلگرام: ${YELLOW}https://t.me/skypanell${NC}"
  echo -e "  ${GREEN}▸${NC} ربات تلگرام: ${YELLOW}https://t.me/Myskypanel_bot${NC}"
  echo ""
  echo -e "${GREEN}🌟 از SkyPanel لذت ببرید! 🌟${NC}"
  echo ""
}

# ===== تابع اصلی =====
main() {
  print_banner
  check_root
  check_os
  install_dependencies
  check_nodejs
  download_project
  install_packages
  create_service
  start_service
  show_final_info
}

# ===== اجرا =====
main "$@"
