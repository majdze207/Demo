# 🎰 CryptoPlay — Crypto MLM + Casino Platform

> منصة Web3 متكاملة تجمع التسويق الشبكي (MLM) بألعاب حظ مشفرة قابلة للتحقق
> A full-stack Web3 platform combining MLM with provably fair crypto casino games

---

## 📖 نظرة عامة | Overview

**CryptoPlay** منصة ويب متكاملة تدمج نظام التسويق الشبكي (MLM) بألعاب حظ مشفرة (Provably Fair)، مع ميزات شاملة للمستخدمين والإدارة.

**Tech Stack:** Node.js + Express + TypeScript + PostgreSQL + Next.js 15 + React 18 + Tailwind CSS + ethers.js

---

## ✨ الميزات | Features

### 👤 المستخدمون | Users
- تسجيل/دخول بالبريد الإلكتروني (bcrypt + JWT)
- باقات ترقية: $5 / $10 / $20 / $50
- نظام إحالات L1 + L2 + activity bonus

### 🎲 الألعاب | Games
- **Dice** — رهان Over/Under (HMAC-SHA512 Provably Fair)
- **Mystery Boxes** — صناديق باحتمالات مرجّحة
- **Prediction** — Up/Down على BNB/BTC/ETH (أسعار Binance الحية)
- **Bonus Wheel** — عجلة مجانية كل 24 ساعة
- **Weekly Lottery** — تذاكر $5، فائز واحد

### 💰 الدفع | Payments
- إيداع USDT BEP-20 على BSC مع تحقق آلي
- سحب بشروط (رصيد ≥ 10 + 3 إحالات)
- حدود يومية/شهرية ($500/$5000)
- رسوم سحب تدريجية (3%)

### 🎁 المكافآت | Rewards
- Daily Airdrop (5 USDT)
- Daily Missions (4 مهام)
- Login Streak (7 أيام)
- Weekly Leaderboard

### 🎮 Demo Mode
- 1000 USDT وهمي
- منفصل عن الرصيد الحقيقي

### 🛡️ Admin Panel
- إحصائيات GGR + Top Winners/Losers
- إدارة مستخدمين + طلبات سحب
- Kill Switches للألعاب
- Audit Log كامل
