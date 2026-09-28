#!/usr/bin/env bash
# =========================================================================
#  Apply Schema to PostgreSQL
#  يطبّق ملف schema.sql على قاعدة البيانات
# =========================================================================

set -e

# ---------- الألوان ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  📦 Database Migration${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

# ---------- الانتقال لمجلد المشروع ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ---------- تحميل .env ----------
if [ -f .env ]; then
  echo -e "${GREEN}✅ تم تحميل .env${NC}"
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo -e "${RED}❌ ملف .env غير موجود${NC}"
  echo -e "${YELLOW}   انسخه من .env.example أولاً:${NC}"
  echo -e "   ${BLUE}cp .env.example .env${NC}"
  exit 1
fi

# ---------- التحقق من DATABASE_URL ----------
if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}❌ DATABASE_URL غير معرّف في .env${NC}"
  exit 1
fi

# ---------- التحقق من schema.sql ----------
SCHEMA_FILE="src/db/schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo -e "${RED}❌ ملف $SCHEMA_FILE غير موجود${NC}"
  exit 1
fi

SCHEMA_SIZE=$(wc -c < "$SCHEMA_FILE")
echo -e "${BLUE}[1/3]${NC} ملف Schema: $SCHEMA_FILE ($SCHEMA_SIZE بايت)"

# ---------- اختبار الاتصال ----------
echo -e "${BLUE}[2/3]${NC} اختبار الاتصال بقاعدة البيانات..."

if ! psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
  echo -e "${RED}❌ فشل الاتصال بقاعدة البيانات${NC}"
  echo -e "${YELLOW}   تحقق من DATABASE_URL في .env${NC}"
  exit 1
fi

DB_INFO=$(psql "$DATABASE_URL" -tAc "SELECT current_database() || ' | ' || current_user || ' | ' || version()")
echo -e "${GREEN}✅ متصل: $DB_INFO${NC}"

# ---------- تطبيق Schema ----------
echo -e "\n${BLUE}[3/3]${NC} تطبيق Schema..."

psql "$DATABASE_URL" -f "$SCHEMA_FILE" > .migrate.log 2>&1 || {
  echo -e "${RED}❌ فشل تطبيق الـ schema${NC}"
  echo ""
  tail -30 .migrate.log
  exit 1
}

# ---------- الإحصائيات ----------
echo ""
TABLE_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")
INDEX_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public'")
TRIGGER_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='public'")
VIEW_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM information_schema.views WHERE table_schema='public'")

echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✨ تم تطبيق Schema بنجاح${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "   📊 الجداول:    ${GREEN}$TABLE_COUNT${NC}"
echo -e "   📊 الفهارس:    ${GREEN}$INDEX_COUNT${NC}"
echo -e "   📊 Triggers:   ${GREEN}$TRIGGER_COUNT${NC}"
echo -e "   📊 Views:      ${GREEN}$VIEW_COUNT${NC}"
echo ""

