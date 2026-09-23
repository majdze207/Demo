#!/usr/bin/env bash
# =========================================================================
#  start.sh — تشغيل سريع للمشروع
#  يشغّل PostgreSQL + يعرض أوامر التشغيل
# =========================================================================

set -e

# ---------- الألوان ----------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# ---------- الانتقال لمجلد المشروع ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  🚀  CryptoPlay — Startup${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

# ---------- فحص الملفات الأساسية ----------
if [ ! -f backend/.env ]; then
  echo -e "${RED}❌ backend/.env غير موجود${NC}"
  echo -e "${YELLOW}   أنشئه أولاً:${NC}"
  echo -e "   ${BLUE}cp backend/.env.example backend/.env${NC}"
  exit 1
fi

if [ ! -f frontend/.env.local ]; then
  echo -e "${RED}❌ frontend/.env.local غير موجود${NC}"
  echo -e "${YELLOW}   أنشئه أولاً:${NC}"
  echo -e "   ${BLUE}cp frontend/.env.local.example frontend/.env.local${NC}"
  exit 1
fi

# ---------- تشغيل PostgreSQL (Termux) ----------
if [ -n "$PREFIX" ] && [ -d "$PREFIX/var/lib/postgresql" ]; then
  echo -e "${YELLOW}📱 البيئة: Termux${NC}"

  if pg_isready -q 2>/dev/null; then
    echo -e "${GREEN}✅ PostgreSQL يعمل مسبقاً${NC}"
  else
    echo -e "${YELLOW}📦 تشغيل PostgreSQL...${NC}"
    pg_ctl -D "$PREFIX/var/lib/postgresql" start
    sleep 3
  fi
else
  echo -e "${YELLOW}💻 البيئة: Linux / macOS${NC}"
  if pg_isready -q 2>/dev/null; then
    echo -e "${GREEN}✅ PostgreSQL يعمل${NC}"
  else
    echo -e "${RED}⚠️  PostgreSQL لا يعمل. ابدأه يدوياً:${NC}"
    echo -e "   Linux:  ${BLUE}sudo systemctl start postgresql${NC}"
    echo -e "   macOS:  ${BLUE}brew services start postgresql${NC}"
  fi
fi

# ---------- فحص node_modules ----------
if [ ! -d backend/node_modules ]; then
  echo -e "${RED}❌ backend/node_modules غير موجود${NC}"
  echo -e "${YELLOW}   نفّذ:${NC} ${BLUE}cd backend && npm install${NC}"
  exit 1
fi

if [ ! -d frontend/node_modules ]; then
  echo -e "${RED}❌ frontend/node_modules غير موجود${NC}"
  echo -e "${YELLOW}   نفّذ:${NC} ${BLUE}cd frontend && npm install${NC}"
  exit 1
fi

# ---------- عرض الأوامر ----------
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✨ كل شيء جاهز — ابدأ التشغيل${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}افتح جلستي Termux جديدتين (اسحب يسار → NEW SESSION):${NC}"
echo ""
echo -e "  ${BLUE}الجلسة 1 — Backend:${NC}"
echo -e "    ${GREEN}cd $SCRIPT_DIR/backend && npm run dev${NC}"
echo ""
echo -e "  ${BLUE}الجلسة 2 — Frontend:${NC}"
echo -e "    ${GREEN}cd $SCRIPT_DIR/frontend && npm run dev${NC}"
echo ""
echo -e "${YELLOW}ثم افتح المتصفح على:${NC}"
echo -e "    ${GREEN}http://localhost:3000${NC}"
echo ""
echo -e "${YELLOW}Health Check:${NC}"
echo -e "    ${GREEN}curl http://localhost:5000/health${NC}"
echo ""

