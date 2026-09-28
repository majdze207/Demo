#!/usr/bin/env bash
# =========================================================================
#  Setup PostgreSQL Database
#  ينشئ المستخدم وقاعدة البيانات إذا لم تكونا موجودتين
#  يعمل على Termux و Linux و macOS
# =========================================================================

set -e

# ---------- الألوان ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  🗄️  PostgreSQL Setup${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

# ---------- المتغيرات ----------
DB_USER="${DB_USER:-mlm_user}"
DB_NAME="${DB_NAME:-mlm_casino}"

# ---------- اكتشاف البيئة ----------
if [ -n "$PREFIX" ] && [ -d "$PREFIX/var/lib/postgresql" ]; then
  # Termux
  PG_DATA="$PREFIX/var/lib/postgresql"
  IS_TERMUX=true
  echo -e "${YELLOW}📱 البيئة: Termux (Android)${NC}"
else
  # Linux / macOS
  PG_DATA="/var/lib/postgresql"
  IS_TERMUX=false
  echo -e "${YELLOW}💻 البيئة: Linux / macOS${NC}"
fi

# ---------- 1. فحص PostgreSQL ----------
echo -e "\n${BLUE}[1/4]${NC} فحص PostgreSQL..."

if pg_isready -q 2>/dev/null; then
  echo -e "${GREEN}✅ PostgreSQL يعمل${NC}"
else
  echo -e "${YELLOW}⚠️  PostgreSQL لا يعمل. محاولة التشغيل...${NC}"
  if [ "$IS_TERMUX" = true ]; then
    pg_ctl -D "$PG_DATA" start
    sleep 3
  else
    echo -e "${RED}❌ على Linux/macOS، ابدأ PostgreSQL يدوياً:${NC}"
    echo "   Linux:  sudo systemctl start postgresql"
    echo "   macOS:  brew services start postgresql"
    exit 1
  fi
fi

# ---------- 2. إنشاء المستخدم ----------
echo -e "\n${BLUE}[2/4]${NC} فحص المستخدم '$DB_USER'..."

if psql -U "$DB_USER" -d postgres -c "SELECT 1" >/dev/null 2>&1; then
  echo -e "${GREEN}✅ المستخدم موجود${NC}"
else
  echo -e "${YELLOW}🔧 إنشاء المستخدم...${NC}"
  createuser -s "$DB_USER" 2>/dev/null || {
    echo -e "${YELLOW}⚠️  فشل createuser، محاولة عبر psql...${NC}"
    psql -U postgres -c "CREATE USER $DB_USER WITH SUPERUSER;" 2>/dev/null || true
  }
  echo -e "${GREEN}✅ تم إنشاء المستخدم${NC}"
fi

# ---------- 3. إنشاء قاعدة البيانات ----------
echo -e "\n${BLUE}[3/4]${NC} فحص قاعدة البيانات '$DB_NAME'..."

if psql -U "$DB_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  echo -e "${GREEN}✅ قاعدة البيانات موجودة${NC}"
else
  echo -e "${YELLOW}🔧 إنشاء قاعدة البيانات...${NC}"
  createdb -O "$DB_USER" "$DB_NAME"
  echo -e "${GREEN}✅ تم إنشاء قاعدة البيانات${NC}"
fi

# ---------- 4. التحقق ----------
echo -e "\n${BLUE}[4/4]${NC} التحقق النهائي..."
RESULT=$(psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT current_database() || ' | ' || current_user")
echo -e "${GREEN}✅ $RESULT${NC}"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✨ تم إعداد قاعدة البيانات بنجاح${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}📌 الخطوة التالية:${NC}"
echo -e "   ${BLUE}npm run migrate${NC}    (تطبيق الـ schema)"
echo ""

