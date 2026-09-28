#!/usr/bin/env bash
# =========================================================================
#  Reset Database (DANGER!)
#  يحذف كل البيانات ويعيد تطبيق schema من جديد
# =========================================================================

set -e

# ---------- الألوان ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${RED}═══════════════════════════════════════════════════${NC}"
echo -e "${RED}  ⚠️   تحذير — DANGER ZONE   ⚠️${NC}"
echo -e "${RED}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${RED}هذا الأمر سيمسح كل البيانات في قاعدة البيانات:${NC}"
echo -e "   - كل المستخدمين"
echo -e "   - كل الأرصدة"
echo -e "   - كل الرهانات"
echo -e "   - كل السجلات"
echo ""

# ---------- الانتقال لمجلد المشروع ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ---------- تحميل .env ----------
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo -e "${RED}❌ ملف .env غير موجود${NC}"
  exit 1
fi

# ---------- التأكيد الأمني ----------
echo -e "${YELLOW}للتأكيد، اكتب بالضبط:${NC} ${RED}YES${NC} ${YELLOW}ثم اضغط Enter${NC}"
read -p "> " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
  echo -e "\n${GREEN}✅ تم الإلغاء — لا شيء تغيّر${NC}\n"
  exit 0
fi

# ---------- استخراج اسم DB ----------
DB_NAME=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')
DB_USER=$(echo "$DATABASE_URL" | sed -E 's|.*://([^:]+).*|\1|')

echo ""
echo -e "${YELLOW}🗑️  حذف قاعدة البيانات $DB_NAME...${NC}"

# ---------- إنهاء الاتصالات النشطة ----------
psql "$DATABASE_URL" -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
" >/dev/null 2>&1 || true

# ---------- حذف وإنشاء من جديد ----------
psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null
psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null

echo -e "${GREEN}✅ تم إعادة إنشاء قاعدة البيانات${NC}"

# ---------- تطبيق Schema ----------
echo -e "\n${YELLOW}📦 تطبيق Schema...${NC}"

psql "$DATABASE_URL" -f src/db/schema.sql > .reset.log 2>&1

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✅ تم تطبيق Schema بنجاح${NC}"

  TABLE_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")

  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✨ قاعدة البيانات جاهزة من جديد${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
  echo -e "   📊 عدد الجداول: ${GREEN}$TABLE_COUNT${NC}"
  echo ""
else
  echo -e "${RED}❌ فشل تطبيق Schema${NC}"
  tail -20 .reset.log
  exit 1
fi

