// =========================================================================
//  frontend.tsx — COMPLETE FINAL FRONTEND
//  Full UI with progressive jackpot pools, betting wheel, no fairness UI
// =========================================================================
'use client';

import React, { useEffect, useMemo, useRef, useState, createContext, useContext, ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import axios from 'axios';
import { create } from 'zustand';
import { useQuery, useMutation, useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Sparkles, Clock, Trophy, Dices, TrendingUp, TrendingDown, Gift,
  Copy, CheckCircle2, XCircle, AlertCircle, Loader2, LayoutDashboard,
  Users, Wallet, ArrowDownToLine, Ticket, User, LogOut, Menu, X,
  Shield, Bell, ArrowRight, ShieldCheck, RefreshCw, Award, Calendar,
  Mail, Target, Flame, Zap, ExternalLink, Activity, Settings,
  DollarSign, Ban, PlayCircle, BarChart3, FileText, Home,
  Gamepad2, Coins, History, Plus, Minus, Trash2,
} from 'lucide-react';
import clsx, { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// =========================================================================
//  SECTION 1: UTILS
// =========================================================================
const cn = (...i: ClassValue[]) => twMerge(clsx(i));
const fmtUsdt = (n: number | string, d = 2) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} USDT`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US',
    { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const pkgLabel = (p: string) =>
  (({ none: 'No Package', p1_5: 'Starter $5', p2_10: 'Bronze $10',
      p3_20: 'Silver $20', p4_50: 'Gold $50' } as any)[p] || p);
const gameLabel = (g: string) =>
  (({ dice: 'Dice', mystery_box: 'Mystery Box', prediction: 'Prediction',
      bonus_wheel: 'Bonus Wheel' } as any)[g] || g);

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
const api = axios.create({ baseURL: API_URL, timeout: 20_000 });
api.interceptors.request.use((cfg) => {
  if (typeof window !== 'undefined') {
    const t = localStorage.getItem('token');
    if (t) cfg.headers.Authorization = `Bearer ${t}`;
  }
  return cfg;
});
api.interceptors.response.use((r) => r, (err) => {
  const s = err.response?.status;
  const url = err.config?.url || '';
  const isAuth = url.includes('/auth/login') || url.includes('/auth/register');
  if (s === 401 && !isAuth && typeof window !== 'undefined') {
    localStorage.removeItem('token'); localStorage.removeItem('user');
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
  }
  return Promise.reject(err);
});
const extractError = (err: any): string =>
  err?.response?.data?.error || err?.message || 'Something went wrong';

const idemKey = () =>
  (typeof crypto !== 'undefined' && (crypto as any).randomUUID
    ? (crypto as any).randomUUID()
    : `${Date.now()}-${Math.random()}`);

// =========================================================================
//  SECTION 2: TYPES + STORE
// =========================================================================
interface User {
  id: string; email: string; username?: string | null;
  referral_code: string; package: string; status: string;
  balance: number; demo_balance: number;
  total_deposited: number; total_withdrawn: number; total_wagered?: number;
  active_ref_count: number; wallet_address?: string | null;
  last_bonus_spin?: string | null; last_demo_reset?: string | null;
  streak_count?: number; last_login_date?: string | null;
  xp?: number; level?: number; created_at?: string;
}

interface AuthState {
  user: User | null; token: string | null;
  loading: boolean; hydrated: boolean;
  isDemo: boolean;
  toggleDemo: () => void;
  login: (e: string, p: string) => Promise<void>;
  register: (p: { email: string; password: string; username?: string; referralCode?: string }) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  setUser: (u: User) => void;
  hydrate: () => void;
}

const useAuthStore = create<AuthState>((set, get) => ({
  user: null, token: null, loading: false, hydrated: false,
  isDemo: false,
  toggleDemo: () => {
    const v = !get().isDemo;
    if (typeof window !== 'undefined') localStorage.setItem('isDemo', v ? '1' : '0');
    set({ isDemo: v });
  },
  hydrate: () => {
    if (typeof window === 'undefined') return;
    const t = localStorage.getItem('token');
    const u = localStorage.getItem('user');
    const d = localStorage.getItem('isDemo') === '1';
    if (t && u) try { set({ token: t, user: JSON.parse(u), hydrated: true, isDemo: d }); }
                  catch { localStorage.clear(); set({ hydrated: true }); }
    else set({ hydrated: true, isDemo: d });
  },
  login: async (email, password) => {
    set({ loading: true });
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      set({ token: data.token, user: data.user });
    } catch (e) { throw new Error(extractError(e)); }
    finally { set({ loading: false }); }
  },
  register: async (payload) => {
    set({ loading: true });
    try {
      const { data } = await api.post('/auth/register', payload);
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      set({ token: data.token, user: data.user });
    } catch (e) { throw new Error(extractError(e)); }
    finally { set({ loading: false }); }
  },
  logout: () => {
    localStorage.removeItem('token'); localStorage.removeItem('user');
    localStorage.removeItem('isDemo');
    set({ user: null, token: null, isDemo: false });
    if (typeof window !== 'undefined') window.location.href = '/login';
  },
  refreshMe: async () => {
    try {
      const { data } = await api.get('/auth/me');
      localStorage.setItem('user', JSON.stringify(data.user));
      set({ user: data.user });
    } catch { set({ user: null, token: null }); localStorage.clear(); }
  },
  setUser: (u) => { localStorage.setItem('user', JSON.stringify(u)); set({ user: u }); },
}));

// =========================================================================
//  SECTION 3: UI PRIMITIVES
// =========================================================================
export const Button = React.forwardRef<HTMLButtonElement, any>(
  ({ variant = 'primary', size = 'md', loading, fullWidth, className, children, disabled, ...rest }, ref) => {
    const variants: any = {
      primary: 'bg-brand-500 hover:bg-brand-600 text-surface-900 font-semibold shadow-glow',
      secondary: 'bg-surface-700 hover:bg-surface-600 text-white border border-surface-600',
      ghost: 'bg-transparent hover:bg-surface-700 text-white/80',
      danger: 'bg-red-600 hover:bg-red-700 text-white',
      success: 'bg-emerald-500 hover:bg-emerald-600 text-white',
    };
    const sizes: any = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3 text-base' };
    return (
      <button ref={ref} disabled={disabled || loading}
        className={cn('inline-flex items-center justify-center gap-2 rounded-lg transition',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          variants[variant], sizes[size], fullWidth && 'w-full', className)}
        {...rest}>
        <Loader2 className={cn('w-4 h-4 animate-spin', !loading && 'hidden')} />
        {children}
      </button>
    );
  });
Button.displayName = 'Button';

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('bg-surface-800 border border-surface-700 rounded-2xl p-5', className)}>{children}</div>
);
export const CardTitle = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <div className="mb-4">
    <h3 className="text-lg font-semibold text-white">{children}</h3>
    {sub && <p className="text-sm text-white/50 mt-1">{sub}</p>}
  </div>
);
export const Input = React.forwardRef<HTMLInputElement, any>(
  ({ label, error, className, ...rest }, ref) => (
    <div className="space-y-1.5">
      {label && <label className="block text-sm text-white/70">{label}</label>}
      <input ref={ref} className={cn(
        'w-full bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5',
        'text-white placeholder:text-white/30 focus:outline-none focus:border-brand-500 transition',
        error && 'border-red-500', className)} {...rest} />
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  ));
Input.displayName = 'Input';

export const Badge = ({ children, color = 'gray' }: { children: ReactNode; color?: string }) => {
  const colors: any = {
    brand: 'bg-brand-500/15 text-brand-500 border-brand-500/30',
    green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    gray: 'bg-surface-700 text-white/70 border-surface-600',
    purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  };
  return <span className={cn('inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border',
    colors[color] || colors.gray)}>{children}</span>;
};

export const Spinner = ({ className = '' }: { className?: string }) => (
  <div className={cn('flex items-center justify-center p-8', className)}>
    <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
  </div>
);

export const Modal = ({ open, onClose, title, children, size = 'md' }: any) => {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  const widths: any = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className={cn('relative w-full bg-surface-800 border border-surface-700 rounded-2xl p-6 max-h-[90vh] overflow-y-auto', widths[size])}>
        <div className="flex items-center justify-between mb-4">
          {title && <h3 className="text-lg font-semibold text-white">{title}</h3>}
          <button onClick={onClose} className="text-white/50 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
};

// =========================================================================
//  SECTION 4: TOAST
// =========================================================================
type Kind = 'success' | 'error' | 'info';
interface T { id: number; kind: Kind; msg: string; }
const ToastCtx = createContext<{ push: (k: Kind, m: string) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [list, setList] = useState<T[]>([]);
  const push = (kind: Kind, msg: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, kind, msg }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4000);
  };
  const icons: any = {
    success: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
    error: <XCircle className="w-5 h-5 text-red-400" />,
    info: <AlertCircle className="w-5 h-5 text-blue-400" />,
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed top-4 right-4 z-[100] space-y-2">
        {list.map((t) => (
          <div key={t.id} className="flex items-start gap-3 bg-surface-800 border border-surface-700
                                     rounded-lg p-3 min-w-[280px] shadow-lg">
            {icons[t.kind]}
            <p className="text-sm text-white flex-1">{t.msg}</p>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
};

// =========================================================================
//  SECTION 5: CONFETTI
// =========================================================================
const Confetti = ({ active }: { active: boolean }) => {
  const [pieces, setPieces] = useState<any[]>([]);
  useEffect(() => {
    if (!active) return;
    const colors = ['#f5b301', '#22c55e', '#3b82f6', '#ef4444', '#a855f7'];
    const p = Array.from({ length: 60 }, () => ({
      id: Math.random(),
      x: Math.random() * 100,
      color: colors[Math.floor(Math.random() * colors.length)],
      delay: Math.random() * 0.4,
      duration: 1.8 + Math.random() * 1.2,
      size: 6 + Math.random() * 8,
      rot: Math.random() * 360,
    }));
    setPieces(p);
    const t = setTimeout(() => setPieces([]), 3500);
    return () => clearTimeout(t);
  }, [active]);
  if (!pieces.length) return null;
  return (
    <div className="fixed inset-0 z-[60] pointer-events-none overflow-hidden">
      {pieces.map((p) => (
        <div key={p.id}
          style={{
            position: 'absolute',
            left: `${p.x}%`,
            top: '-20px',
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: '2px',
            transform: `rotate(${p.rot}deg)`,
            animation: `confetti-fall ${p.duration}s ease-in ${p.delay}s forwards`,
          }} />
      ))}
      <style>{`
        @keyframes confetti-fall {
          to { transform: translateY(110vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
};

// =========================================================================
//  SECTION 6: DEMO TOGGLE
// =========================================================================
export const DemoToggle = () => {
  const { isDemo, toggleDemo } = useAuthStore();
  const { push } = useToast();
  const handleToggle = () => {
    toggleDemo();
    push('info', isDemo ? 'Switched to Real Money Mode' : 'Switched to Demo Mode');
  };
  return (
    <button onClick={handleToggle}
      className={cn('flex items-center gap-2 px-3 py-1.5 rounded-lg transition border',
        isDemo ? 'bg-purple-500/15 border-purple-500/40 text-purple-400'
               : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400')}>
      {isDemo ? <><PlayCircle className="w-4 h-4" /><span className="text-xs font-semibold hidden sm:inline">DEMO</span></>
              : <><Coins className="w-4 h-4" /><span className="text-xs font-semibold hidden sm:inline">REAL</span></>}
      <div className={cn('w-8 h-4 rounded-full transition relative',
        isDemo ? 'bg-purple-500' : 'bg-emerald-500')}>
        <div className={cn('absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all',
          isDemo ? 'left-4' : 'left-0.5')} />
      </div>
    </button>
  );
};

// =========================================================================
//  SECTION 7: LAYOUT
// =========================================================================
const NAV = [
  { href: '/dashboard',   label: 'Dashboard',     icon: LayoutDashboard },
  { href: '/referrals',   label: 'Referrals',     icon: Users },
  { href: '/wallet',      label: 'Wallet',        icon: Wallet },
  { href: '/withdraw',    label: 'Withdraw',      icon: ArrowDownToLine },
  { href: '/dice',        label: 'Dice',          icon: Dices },
  { href: '/boxes',       label: 'Mystery Box',   icon: Gift },
  { href: '/prediction',  label: 'Prediction',    icon: TrendingUp },
  { href: '/lottery',     label: 'Weekly Lottery', icon: Ticket },
  { href: '/bonus',       label: 'Bonus Wheel',   icon: Sparkles },
  { href: '/missions',    label: 'Daily Missions', icon: Target },
  { href: '/history',     label: 'Bet History',   icon: History },
  { href: '/faq',         label: 'Help & FAQ',    icon: FileText },
  { href: '/profile',     label: 'Profile',       icon: User },
];

export const Sidebar = () => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);
  const content = (
    <>
      <div className="px-5 py-5 border-b border-surface-700 flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center font-bold text-surface-900">C</div>
        <span className="font-bold">CryptoPlay</span>
        {isDemo && <Badge color="purple">DEMO</Badge>}
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV.map((it) => {
          const active = pathname === it.href || pathname.startsWith(it.href + '/');
          return (
            <Link key={it.href} href={it.href} onClick={() => setOpen(false)}
              className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition',
                active ? 'bg-brand-500/15 text-brand-500 font-medium'
                       : 'text-white/70 hover:text-white hover:bg-surface-700')}>
              <it.icon className="w-4 h-4" />{it.label}
            </Link>
          );
        })}
      </nav>
      {user?.email === 'admin@cryptoplay.io' && (
        <Link href="/admin" className="mx-3 mb-3 flex items-center gap-3 px-3 py-2.5
                                       rounded-lg text-sm bg-red-500/10 text-red-400">
          <Shield className="w-4 h-4" /> Admin Panel
        </Link>
      )}
    </>
  );
  return (
    <>
      <button onClick={() => setOpen(true)} className="lg:hidden fixed top-4 left-4 z-40 p-2
        bg-surface-800 border border-surface-700 rounded-lg"><Menu className="w-5 h-5" /></button>
      <aside className="hidden lg:flex flex-col w-64 bg-surface-800 border-r border-surface-700">{content}</aside>
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
          <aside className="relative flex flex-col w-64 bg-surface-800 border-r border-surface-700">
            <button onClick={() => setOpen(false)} className="absolute top-4 right-4 text-white/50">
              <X className="w-5 h-5" /></button>
            {content}
          </aside>
        </div>
      )}
    </>
  );
};

const NotificationsBell = () => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications?limit=20')).data,
    refetchInterval: 30_000,
  });
  const markRead = useMutation({
    mutationFn: async (id?: string) =>
      (await api.post(id ? `/notifications/${id}/read` : `/notifications/read-all`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const iconMap: any = {
    success: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    warning: <AlertCircle className="w-4 h-4 text-yellow-400" />,
    info: <Bell className="w-4 h-4 text-blue-400" />,
  };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="p-2 text-white/60 hover:text-white relative">
        <Bell className="w-5 h-5" />
        {data?.unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-red-500 rounded-full
                           text-[10px] font-bold text-white flex items-center justify-center px-1">
            {data.unread > 9 ? '9+' : data.unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)]
                          bg-surface-800 border border-surface-700 rounded-xl shadow-2xl z-50 max-h-[70vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
              <h3 className="font-semibold text-sm">Notifications</h3>
              {data?.unread > 0 && (
                <button onClick={() => markRead.mutate(undefined)}
                  className="text-xs text-brand-500 hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {!data?.notifications?.length && (
                <p className="text-sm text-white/40 text-center py-8">No notifications yet.</p>
              )}
              {data?.notifications?.map((n: any) => (
                <div key={n.id}
                  onClick={() => { if (!n.is_read) markRead.mutate(n.id); }}
                  className={cn('px-4 py-3 border-b border-surface-700/50 cursor-pointer hover:bg-surface-700/30',
                    !n.is_read && 'bg-brand-500/5')}>
                  <div className="flex items-start gap-3">
                    {iconMap[n.type] || iconMap.info}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{n.title}</p>
                      <p className="text-xs text-white/50 mt-0.5">{n.body}</p>
                      <p className="text-xs text-white/30 mt-1">{fmtDate(n.created_at)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export const Navbar = () => {
  const { user, logout, isDemo } = useAuthStore();
  const balanceToShow = isDemo ? (user?.demo_balance ?? 1000) : (user?.balance ?? 0);
  return (
    <header className="h-16 bg-surface-800 border-b border-surface-700 flex items-center
                       px-4 md:px-6 gap-2 md:gap-4 sticky top-0 z-30">
      <div className="lg:hidden w-10" />
      <div className="flex-1" />
      <DemoToggle />
      {user?.streak_count !== undefined && user.streak_count > 0 && (
        <div className="hidden md:flex items-center gap-1 bg-orange-500/10 border border-orange-500/30
                        rounded-lg px-2.5 py-1.5">
          <Flame className="w-4 h-4 text-orange-400" />
          <span className="text-xs text-orange-400 font-semibold">{user.streak_count}d</span>
        </div>
      )}
      {user && (
        <div className={cn('hidden sm:flex items-center gap-2 rounded-lg px-3 py-1.5',
          isDemo ? 'bg-purple-500/15' : 'bg-surface-700')}>
          <span className="text-xs text-white/50">{isDemo ? 'DEMO' : 'Balance'}</span>
          <span className={cn('text-sm font-semibold',
            isDemo ? 'text-purple-400' : 'text-brand-500')}>
            {fmtUsdt(balanceToShow)}
          </span>
        </div>
      )}
      {user && !isDemo && (
        <Badge color={user.package === 'none' ? 'gray' : 'brand'}>{pkgLabel(user.package)}</Badge>
      )}
      <NotificationsBell />
      <div className="flex items-center gap-2">
        <div className="hidden sm:flex flex-col items-end">
          <span className="text-sm font-medium">{user?.username || 'User'}</span>
          <span className="text-xs text-white/40 truncate max-w-[140px]">{user?.email}</span>
        </div>
        <button onClick={logout} className="p-2 text-white/60 hover:text-red-400"><LogOut className="w-5 h-5" /></button>
      </div>
    </header>
  );
};

export const BottomNav = () => {
  const pathname = usePathname();
  const items = [
    { href: '/dashboard', label: 'Home',    icon: Home },
    { href: '/dice',      label: 'Games',   icon: Gamepad2 },
    { href: '/history',   label: 'History', icon: History },
    { href: '/bonus',     label: 'Bonus',   icon: Gift },
    { href: '/profile',   label: 'Profile', icon: User },
  ];
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface-800/95 backdrop-blur-md
                    border-t border-surface-700 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-16">
        {items.map((it) => {
          const active = pathname === it.href || pathname.startsWith(it.href + '/');
          return (
            <Link key={it.href} href={it.href}
              className={cn('flex flex-col items-center gap-1 px-3 py-2 transition flex-1',
                active ? 'text-brand-500' : 'text-white/50')}>
              <it.icon className={cn('w-5 h-5', active && 'drop-shadow-[0_0_6px_rgba(245,179,1,0.6)]')} />
              <span className="text-[10px] font-medium">{it.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
};

export const DashboardLayout = ({ children }: { children: ReactNode }) => {
  const { user, hydrated, hydrate } = useAuthStore();
  const router = useRouter();
  useEffect(() => { hydrate(); }, [hydrate]);
  useEffect(() => { if (hydrated && !user) router.replace('/login'); }, [hydrated, user, router]);
  if (!hydrated || !user) return <Spinner className="min-h-screen" />;
  return (
    <div className="min-h-screen flex bg-surface-900">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Navbar />
        <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-x-hidden pb-24 lg:pb-8">{children}</main>
        <BottomNav />
      </div>
    </div>
  );
};

// =========================================================================
//  SECTION 8: LIVE FEED
// =========================================================================
export const LiveWinnersFeed = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['live-winners'],
    queryFn: async () => (await api.get('/live/winners')).data.feed,
    refetchInterval: 10_000,
  });
  if (isLoading) return <Card><Spinner /></Card>;
  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <h3 className="font-semibold">Live Winners</h3>
      </div>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {(!data || data.length === 0) && (
          <p className="text-sm text-white/40 text-center py-6">No winners yet.</p>
        )}
        {data?.map((w: any) => (
          <div key={w.id} className="flex items-center justify-between
                                     bg-surface-700/40 rounded-lg p-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium truncate">{w.username}</p>
              <p className="text-xs text-white/40">{gameLabel(w.game)}</p>
            </div>
            <div className="text-right">
              <p className="text-emerald-400 font-semibold">+{fmtUsdt(w.profit)}</p>
              <p className="text-xs text-white/40">bet {fmtUsdt(w.bet_amount)}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

// =========================================================================
//  SECTION 9: LANDING / AUTH
// =========================================================================
export const LandingPage = () => {
  const features = [
    { icon: Sparkles,    title: 'Premium Games',    desc: 'Dice, Mystery Boxes, Price Prediction, Bonus Wheel and more.' },
    { icon: PlayCircle,  title: 'Demo Mode',        desc: 'Practice with 1,000 free DEMO USDT. Zero risk, full feature set.' },
    { icon: Trophy,      title: 'Referral Rewards', desc: 'Earn up to 18% L1 + 5% L2 + activity bonus on every referral.' },
    { icon: Ticket,      title: 'Weekly Lottery',   desc: '5 USDT tickets. Winner takes 85% of the pool.' },
    { icon: Target,      title: 'Daily Missions',   desc: 'Complete tasks, earn USDT and XP rewards.' },
    { icon: TrendingUp,  title: 'Live Prediction',  desc: 'UP/DOWN on BNB, BTC, ETH — settled by Binance prices.' },
  ];
  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-900 to-surface-800">
      <nav className="container mx-auto px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center font-bold text-surface-900">C</div>
          <span className="font-bold text-lg">CryptoPlay</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-white/70 hover:text-white px-4 py-2">Sign In</Link>
          <Link href="/register" className="text-sm bg-brand-500 hover:bg-brand-600 text-surface-900
                                            font-semibold px-5 py-2 rounded-lg">Get Started</Link>
        </div>
      </nav>
      <section className="container mx-auto px-6 pt-16 pb-24 text-center">
        <div className="inline-flex items-center gap-2 bg-brand-500/10 border border-brand-500/30
                        rounded-full px-4 py-1.5 text-xs text-brand-500 mb-6">
          <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" /> Live on Binance Smart Chain
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
          Play. Refer. <span className="text-brand-500">Earn.</span>
        </h1>
        <p className="text-lg text-white/60 max-w-2xl mx-auto mb-10">
          Web3 platform with premium games, MLM commissions, weekly lotteries, daily missions, and demo practice mode.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/register" className="inline-flex items-center gap-2 bg-brand-500
            hover:bg-brand-600 text-surface-900 font-semibold px-8 py-3.5 rounded-lg shadow-glow transition group">
            Start Earning Now <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition" />
          </Link>
          <Link href="/faq" className="inline-flex items-center gap-2 bg-surface-700
            hover:bg-surface-600 text-white font-semibold px-8 py-3.5 rounded-lg">
            How It Works
          </Link>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mt-24 text-left">
          {features.map((f, i) => (
            <div key={i} className="bg-surface-800 border border-surface-700 rounded-2xl p-6
                                    hover:border-brand-500/50 transition">
              <f.icon className="w-8 h-8 text-brand-500 mb-4" />
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-white/50">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t border-surface-700 py-8 text-center text-sm text-white/40">
        © {new Date().getFullYear()} CryptoPlay.
      </footer>
    </div>
  );
};

export const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, loading } = useAuthStore();
  const { push } = useToast();
  const router = useRouter();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      push('success', 'Welcome back!');
      router.push('/dashboard');
    } catch (err: any) { push('error', err.message); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-4
                    bg-gradient-to-br from-surface-900 to-surface-800">
      <div className="w-full max-w-md bg-surface-800 border border-surface-700 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-1 text-center">Welcome Back</h1>
        <p className="text-white/50 text-sm text-center mb-8">Sign in to your account</p>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Email" type="email" value={email}
            onChange={(e: any) => setEmail(e.target.value)} required />
          <Input label="Password" type="password" value={password}
            onChange={(e: any) => setPassword(e.target.value)} required />
          <Button type="submit" fullWidth size="lg" loading={loading}>Sign In</Button>
        </form>
        <p className="text-sm text-white/50 text-center mt-6">
          No account? <Link href="/register" className="text-brand-500 hover:underline">Create one</Link>
        </p>
      </div>
    </div>
  );
};

export const RegisterPage = () => {
  const [form, setForm] = useState({ email: '', password: '', username: '', referralCode: '' });
  const { register, loading } = useAuthStore();
  const { push } = useToast();
  const router = useRouter();
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const ref = new URLSearchParams(window.location.search).get('ref');
      if (ref) setForm((f) => ({ ...f, referralCode: ref }));
    }
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await register({
        email: form.email, password: form.password,
        username: form.username || undefined,
        referralCode: form.referralCode || undefined,
      });
      push('success', 'Account created!');
      router.push('/dashboard');
    } catch (err: any) { push('error', err.message); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-4
                    bg-gradient-to-br from-surface-900 to-surface-800">
      <div className="w-full max-w-md bg-surface-800 border border-surface-700 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-1 text-center">Create Account</h1>
        <p className="text-white/50 text-sm text-center mb-8">No KYC. Join in 30 seconds.</p>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Email" type="email" value={form.email}
            onChange={(e: any) => setForm({ ...form, email: e.target.value })} required />
          <Input label="Username (optional)" value={form.username}
            onChange={(e: any) => setForm({ ...form, username: e.target.value })} />
          <Input label="Password" type="password" value={form.password}
            onChange={(e: any) => setForm({ ...form, password: e.target.value })} required />
          <Input label="Referral Code (optional)" value={form.referralCode}
            onChange={(e: any) => setForm({ ...form, referralCode: e.target.value })} />
          <Button type="submit" fullWidth size="lg" loading={loading}>Create Account</Button>
        </form>
        <p className="text-sm text-white/50 text-center mt-6">
          Already registered? <Link href="/login" className="text-brand-500 hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
};

// =========================================================================
//  SECTION 10: DASHBOARD
// =========================================================================
export const DashboardPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const isDemo = useAuthStore((s) => s.isDemo);
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    refetchInterval: 20_000,
  });
  const u = data?.user || user;
  const balanceToShow = isDemo ? (u.demo_balance ?? 1000) : u.balance;
  const stats = [
    { label: isDemo ? 'Demo Balance' : 'Balance', value: fmtUsdt(balanceToShow),
      icon: isDemo ? PlayCircle : Wallet },
    { label: 'Active Refs',   value: u.active_ref_count,           icon: Users },
    { label: 'Total Wagered', value: fmtUsdt(u.total_wagered || 0), icon: Activity },
    { label: 'Streak',        value: `${u.streak_count || 0} days`, icon: Flame },
  ];
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {isDemo && (
        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3
                        flex items-center gap-2 text-purple-400 text-sm">
          <PlayCircle className="w-5 h-5 shrink-0" />
          <span>Demo Mode is ON. Results do not affect your real balance, referrals, or withdrawals.</span>
        </div>
      )}
      <div>
        <h1 className="text-3xl font-bold mb-1">Welcome back{u.username ? `, ${u.username}` : ''}</h1>
        <p className="text-white/50">Your performance overview.</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Card key={i}>
            <s.icon className="w-5 h-5 text-white/40 mb-3" />
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-white/50 mt-1">{s.label}</p>
          </Card>
        ))}
      </div>
      {!isDemo && u.package === 'none' && (
        <Card className="border-brand-500/40 bg-gradient-to-r from-brand-500/10 to-transparent">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h3 className="font-semibold mb-1">Activate Your Account</h3>
              <p className="text-sm text-white/60">Buy a package to unlock your referral link.</p>
            </div>
            <Link href="/wallet"><Button>Choose Package</Button></Link>
          </div>
        </Card>
      )}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {u.package !== 'none' ? (
            <Card>
              <CardTitle sub="Share this link — earn up to 18% L1 + 5% L2 + activity bonus.">
                Your Referral Link
              </CardTitle>
              <div className="flex gap-2">
                <input readOnly
                  value={`${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${u.referral_code}`}
                  className="flex-1 bg-surface-900 border border-surface-700 rounded-lg px-3 py-2
                             text-sm text-white/80 font-mono min-w-0" />
                <Button variant="secondary" onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/register?ref=${u.referral_code}`);
                }}>Copy</Button>
              </div>
            </Card>
          ) : (
            <Card className="border-yellow-500/40 bg-yellow-500/5">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-6 h-6 text-yellow-400 shrink-0" />
                <div>
                  <h3 className="font-semibold mb-1">Referral Link Locked</h3>
                  <p className="text-sm text-white/60">
                    Buy a package to unlock your referral link and start earning commissions.
                  </p>
                </div>
              </div>
            </Card>
          )}
          <div className="grid md:grid-cols-3 gap-4">
            <QuickAction href="/dice" title="Play Dice" desc="Premium tiered gameplay" />
            <QuickAction href="/bonus" title="Bonus Wheel" desc="Bet or spin free daily" />
            <QuickAction href="/missions" title="Daily Missions" desc="Earn USDT + XP" />
          </div>
        </div>
        <LiveWinnersFeed />
      </div>
    </div>
  );
};
const QuickAction = ({ href, title, desc }: any) => (
  <Link href={href}>
    <Card className="hover:border-brand-500/60 cursor-pointer transition">
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-xs text-white/50">{desc}</p>
    </Card>
  </Link>
);

// =========================================================================
//  SECTION 11: BET HISTORY
// =========================================================================
export const BetHistoryPage = () => {
  const [game, setGame] = useState('');
  const [isDemo, setIsDemo] = useState<string>('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['bet-history', game, isDemo, status, page],
    queryFn: async () => (await api.get(
      `/bets/history?game=${game}&isDemo=${isDemo}&status=${status}&page=${page}&limit=20`
    )).data,
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Bet History</h1>
        <p className="text-white/50">All your bets across games with filters.</p>
      </div>
      <Card>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm text-white/70 mb-1.5">Game</label>
            <select value={game} onChange={(e) => { setGame(e.target.value); setPage(1); }}
              className="w-full bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5
                         text-white focus:outline-none focus:border-brand-500">
              <option value="">All Games</option>
              <option value="dice">Dice</option>
              <option value="mystery_box">Mystery Box</option>
              <option value="prediction">Prediction</option>
              <option value="bonus_wheel">Bonus Wheel</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-white/70 mb-1.5">Mode</label>
            <select value={isDemo} onChange={(e) => { setIsDemo(e.target.value); setPage(1); }}
              className="w-full bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5
                         text-white focus:outline-none focus:border-brand-500">
              <option value="">All</option>
              <option value="false">Real Money</option>
              <option value="true">Demo</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-white/70 mb-1.5">Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className="w-full bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5
                         text-white focus:outline-none focus:border-brand-500">
              <option value="">All</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="refunded">Refunded</option>
              <option value="pending">Pending</option>
            </select>
          </div>
        </div>
      </Card>
      {isLoading ? <Spinner /> : (
        <Card>
          {!data?.bets?.length ? (
            <p className="text-sm text-white/40 text-center py-12">No bets match your filters.</p>
          ) : (
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm">
                <thead className="text-white/40 border-b border-surface-700">
                  <tr>
                    <th className="text-left py-2">Game</th>
                    <th className="text-left py-2">Mode</th>
                    <th className="text-right py-2">Bet</th>
                    <th className="text-right py-2">Payout</th>
                    <th className="text-left py-2">Status</th>
                    <th className="text-left py-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bets.map((b: any) => (
                    <tr key={b.id} className="border-b border-surface-700/50">
                      <td className="py-2.5">{gameLabel(b.game)}</td>
                      <td className="py-2.5">
                        <Badge color={b.is_demo ? 'purple' : 'green'}>
                          {b.is_demo ? 'DEMO' : 'REAL'}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right font-mono">{fmtUsdt(b.bet_amount)}</td>
                      <td className={cn('py-2.5 text-right font-mono',
                        b.status === 'won' ? 'text-emerald-400'
                        : b.status === 'lost' ? 'text-red-400' : 'text-white/60')}>
                        {fmtUsdt(b.payout)}
                      </td>
                      <td className="py-2.5">
                        <Badge color={b.status === 'won' ? 'green'
                          : b.status === 'lost' ? 'red' : 'gray'}>{b.status}</Badge>
                      </td>
                      <td className="py-2.5 text-white/50 text-xs">{fmtDate(b.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-surface-700">
            <Button size="sm" variant="secondary" disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="text-xs text-white/40">Page {page}</span>
            <Button size="sm" variant="secondary"
              disabled={!data?.bets || data.bets.length < 20}
              onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </Card>
      )}
    </div>
  );
};

// =========================================================================
//  SECTION 12: DICE GAME — with Jackpot Pool
// =========================================================================
export const DiceGame = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const isDemo = useAuthStore((s) => s.isDemo);
  const { push } = useToast();
  const qc = useQueryClient();
  const [betAmount, setBetAmount] = useState(1);
  const [target, setTarget] = useState(50);
  const [condition, setCondition] = useState<'over'|'under'>('over');
  const [lastResult, setLastResult] = useState<any>(null);
  const [idKey, setIdKey] = useState(idemKey());
  const [confetti, setConfetti] = useState(false);
  const [poolAmount, setPoolAmount] = useState(0);

  useQuery({
    queryKey: ['pool-dice'],
    queryFn: async () => {
      try {
        const r = await api.get('/pools/dice');
        setPoolAmount(Number(r.data.pool || 0));
      } catch {}
      return null;
    },
    refetchInterval: 15_000,
  });

  const { data: vipData } = useQuery({
    queryKey: ['vip-tiers'],
    queryFn: async () => (await api.get('/vip/tiers')).data.tiers,
  });

  const currentTier = vipData?.find((t: any) => t.package === user.package);
  const houseEdge = isDemo
    ? currentTier?.demo_house_edges?.dice ?? 0.06
    : currentTier?.house_edges?.dice ?? 0.15;

  const { winChance, multiplier } = useMemo(() => {
    const chance = condition === 'over' ? 100 - target : target;
    const mult = chance > 0 ? (100 / chance) * (1 - houseEdge) : 0;
    return { winChance: chance, multiplier: +mult.toFixed(4) };
  }, [target, condition, houseEdge]);
  const potentialWin = +(betAmount * multiplier).toFixed(2);
  const currentBalance = isDemo ? user.demo_balance : user.balance;

  const rollMutation = useMutation({
    mutationFn: async () => (await api.post('/dice/roll',
      { betAmount, target, condition, isDemo },
      { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: (data) => {
      setLastResult(data);
      if (isDemo) setUser({ ...user, demo_balance: data.newBalance });
      else setUser({ ...user, balance: data.newBalance });
      qc.invalidateQueries({ queryKey: ['live-winners'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['pool-dice'] });
      setIdKey(idemKey());
      if (data.isWin) {
        push('success', `Won ${fmtUsdt(data.payout)}!`);
        if (!isDemo && data.payout >= 5) {
          setConfetti(true);
          setTimeout(() => setConfetti(false), 3000);
        }
      } else {
        push('error', `Rolled ${data.roll}.`);
      }
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  return (
    <>
      <Confetti active={confetti} />
      <div className="grid lg:grid-cols-3 gap-6 max-w-7xl mx-auto">
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <div className="text-center mb-6">
              <div className="text-xs text-white/40 mb-2">Latest Roll</div>
              <div className={cn('text-6xl font-bold tabular-nums',
                lastResult ? (lastResult.isWin ? 'text-emerald-400' : 'text-red-400') : 'text-white/20')}>
                {lastResult ? lastResult.roll.toFixed(2) : '—'}
              </div>
              {lastResult && (
                <div className="mt-2">
                  <Badge color={lastResult.isWin ? 'green' : 'red'}>
                    {lastResult.isWin ? `+${fmtUsdt(lastResult.profit)}` : fmtUsdt(lastResult.profit)}
                  </Badge>
                </div>
              )}
            </div>
            <div className="relative h-16 rounded-xl bg-surface-900 mb-2 overflow-hidden">
              <div className="absolute inset-y-0 bg-brand-500/20"
                style={condition === 'over' ? { left: `${target}%`, right: 0 }
                                            : { left: 0, right: `${100 - target}%` }} />
              {lastResult && (
                <div className="absolute inset-y-0 w-1 bg-white shadow-glow transition-all duration-500"
                  style={{ left: `${lastResult.roll}%` }} />
              )}
              <div className="absolute bottom-1 inset-x-2 flex justify-between text-[10px] text-white/30">
                <span>0</span><span>50</span><span>100</span>
              </div>
            </div>
            <div className="space-y-3 mt-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/50">Win Chance: <span className="text-white">{winChance.toFixed(2)}%</span></span>
                <span className="text-white/50">Multiplier: <span className="text-brand-500 font-bold">{multiplier}×</span></span>
              </div>
              <input type="range" min={2} max={98} value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="w-full accent-brand-500" />
              <div className="flex items-center justify-between text-xs text-white/40">
                <span>Target: {target}</span>
                <button className="flex items-center gap-1 hover:text-white"
                  onClick={() => setCondition(condition === 'over' ? 'under' : 'over')}>
                  {condition === 'over'
                    ? <><TrendingUp className="w-3 h-3" /> Over</>
                    : <><TrendingDown className="w-3 h-3" /> Under</>}
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>
          </Card>
          <Card>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <Input type="number" label={`Bet (${isDemo ? 'DEMO' : ''} USDT)`} value={betAmount}
                onChange={(e: any) => setBetAmount(Number(e.target.value))} />
              <div>
                <label className="block text-sm text-white/70 mb-1.5">Potential Win</label>
                <div className="bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5
                                text-brand-500 font-semibold tabular-nums">{fmtUsdt(potentialWin)}</div>
              </div>
            </div>
            <div className="flex gap-2 mb-4 flex-wrap">
              {[1, 5, 10, 50].map((v) => (
                <button key={v} onClick={() => setBetAmount(v)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-surface-700 hover:bg-surface-600">{v}</button>
              ))}
              <button onClick={() => setBetAmount(Math.max(0.01, currentBalance))}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-700 hover:bg-surface-600">Max</button>
            </div>
            <Button fullWidth size="lg" loading={rollMutation.isPending}
              disabled={currentBalance < betAmount}
              onClick={() => rollMutation.mutate()}>
              <Dices className="w-5 h-5" /> Roll Dice {isDemo && '(Demo)'}
            </Button>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Trophy className="w-5 h-5 text-brand-500" />
              <h3 className="font-semibold">Jackpot Pool</h3>
            </div>
            <div className="bg-gradient-to-br from-brand-500/20 to-transparent rounded-lg p-4 text-center mb-3">
              <p className="text-xs text-white/50 mb-1">Current Pool</p>
              <p className="text-3xl font-bold text-brand-500">
                {fmtUsdt(poolAmount)}
              </p>
            </div>
            <p className="text-xs text-white/50 leading-relaxed">
              A portion of every bet goes into the pool. Win the jackpot to claim it all!
            </p>
          </Card>
          {lastResult && (
            <Card>
              <h4 className="text-sm font-semibold mb-3">Last Roll Details</h4>
              <dl className="space-y-2 text-xs">
                <Row k="Roll" v={lastResult.roll.toFixed(2)} />
                <Row k="Target" v={`${lastResult.condition === 'over' ? '>' : '<'} ${lastResult.target}`} />
                <Row k="Result" v={lastResult.isWin ? 'WIN' : 'LOSS'} />
              </dl>
            </Card>
          )}
        </div>
      </div>
    </>
  );
};
const Row = ({ k, v }: any) => (
  <div className="flex justify-between">
    <dt className="text-white/40">{k}</dt>
    <dd className="font-mono text-white/90">{v}</dd>
  </div>
);

// =========================================================================
//  SECTION 13: BOXES — with Jackpot Pool
// =========================================================================
export const BoxesPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const isDemo = useAuthStore((s) => s.isDemo);
  const { push } = useToast();
  const qc = useQueryClient();
  const [opening, setOpening] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [idKey, setIdKey] = useState(idemKey());
  const [confetti, setConfetti] = useState(false);
  const [boxPool, setBoxPool] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ['boxes'],
    queryFn: async () => (await api.get('/boxes')).data.boxes,
  });

  useQuery({
    queryKey: ['pool-boxes'],
    queryFn: async () => {
      try {
        const r = await api.get('/pools/boxes');
        setBoxPool(Number(r.data.pool || 0));
      } catch {}
      return null;
    },
    refetchInterval: 15_000,
  });

  const openMutation = useMutation({
    mutationFn: async (boxId: string) => (await api.post(`/boxes/${boxId}/open`,
      { isDemo }, { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: (data) => {
      setResult(data);
      if (isDemo) setUser({ ...user, demo_balance: data.newBalance });
      else setUser({ ...user, balance: data.newBalance });
      qc.invalidateQueries({ queryKey: ['live-winners'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['pool-boxes'] });
      setIdKey(idemKey());
      if (data.isJackpot) {
        push('success', `🎉 JACKPOT! Won ${fmtUsdt(data.prizeAmount)}!`);
        setConfetti(true);
        setTimeout(() => setConfetti(false), 5000);
      } else if (data.isWin && !isDemo && data.prizeAmount >= 5) {
        setConfetti(true);
        setTimeout(() => setConfetti(false), 3000);
      }
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  const handleOpen = (box: any) => {
    setOpening(box); setResult(null); openMutation.mutate(box.id);
  };
  const currentBalance = isDemo ? user.demo_balance : user.balance;

  if (isLoading) return <Spinner />;
  return (
    <>
      <Confetti active={confetti} />
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold mb-1">Mystery Boxes</h1>
            <p className="text-white/50">Open a box — jackpots up to 100×.</p>
          </div>
          <Card className="bg-gradient-to-br from-brand-500/20 to-transparent border-brand-500/40">
            <div className="flex items-center gap-3">
              <Trophy className="w-6 h-6 text-brand-500" />
              <div>
                <p className="text-xs text-white/50">Jackpot Pool</p>
                <p className="text-xl font-bold text-brand-500">{fmtUsdt(boxPool)}</p>
              </div>
            </div>
          </Card>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.map((box: any) => (
            <Card key={box.id} className="text-center">
              <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-brand-500
                              to-brand-700 flex items-center justify-center mb-4 shadow-glow">
                <Gift className="w-10 h-10 text-surface-900" />
              </div>
              <h3 className="font-semibold text-lg mb-1">{box.name}</h3>
              <p className="text-2xl font-bold text-brand-500 mb-4">{fmtUsdt(box.price_usdt)}</p>
              <div className="text-center text-xs text-white/40 py-3 mb-4">
                Mystery awaits...
              </div>
              <Button fullWidth onClick={() => handleOpen(box)}
                disabled={currentBalance < box.price_usdt}>
                {currentBalance < box.price_usdt
                  ? 'Insufficient'
                  : `Open Box ${isDemo ? '(Demo)' : ''}`}
              </Button>
            </Card>
          ))}
        </div>
        <Modal open={!!opening} onClose={() => { setOpening(null); setResult(null); }}
               title={result?.isJackpot ? '🎉 JACKPOT!' : result?.isWin ? '🎉 You Won!' : 'Opened'}>
          {openMutation.isPending && <Spinner />}
          {result && (
            <div className="text-center space-y-4">
              <div className={cn('w-24 h-24 mx-auto rounded-full flex items-center justify-center',
                result.isWin ? 'bg-brand-500 animate-pulse-glow' : 'bg-surface-700')}>
                <Sparkles className={cn('w-12 h-12',
                  result.isWin ? 'text-surface-900' : 'text-white/30')} />
              </div>
              <div>
                <p className="text-sm text-white/50 mb-1">{result.outcome}</p>
                <p className={cn('text-3xl font-bold',
                  result.isWin ? 'text-brand-500' : 'text-white/40')}>
                  {result.isWin ? fmtUsdt(result.prizeAmount) : 'No prize'}
                </p>
              </div>
              <Button fullWidth onClick={() => { setOpening(null); setResult(null); }}>
                Continue
              </Button>
            </div>
          )}
        </Modal>
      </div>
    </>
  );
};

// =========================================================================
//  SECTION 14: PREDICTION
// =========================================================================
export const PredictionPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const { push } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any>(null);
  const [side, setSide] = useState<'up'|'down'>('up');
  const [amount, setAmount] = useState(1);
  const [idKey, setIdKey] = useState(idemKey());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get('/prediction/markets')).data.markets || [],
    refetchInterval: 5_000,
  });

  const betMutation = useMutation({
    mutationFn: async () => (await api.post(`/prediction/markets/${selected.id}/bet`,
      { side, amount }, { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: () => {
      push('success', `Bet ${side.toUpperCase()} ${fmtUsdt(amount)}`);
      setUser({ ...user, balance: user.balance - amount });
      setSelected(null); setIdKey(idemKey());
      qc.invalidateQueries({ queryKey: ['markets'] });
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Price Prediction</h1>
          <p className="text-white/50">Live markets from Binance public prices.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => refetch()}>Refresh</Button>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((m: any) => (
          <MarketCard key={m.id} market={m}
            onBet={(s: any) => { setSide(s); setSelected(m); setAmount(1); }} />
        ))}
        {data?.length === 0 && (
          <p className="text-white/40 col-span-full text-center py-12">No open markets.</p>
        )}
      </div>
      <Modal open={!!selected} onClose={() => setSelected(null)} title="Place Prediction">
        {selected && (
          <div className="space-y-4">
            <div className="bg-surface-900 rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-white/50">Symbol</span><span>{selected.symbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Open Price</span>
                <span className="font-mono">${selected.open_price.toFixed(2)}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setSide('up')}
                className={cn('p-4 rounded-xl border-2 transition',
                  side === 'up' ? 'border-emerald-500 bg-emerald-500/10' : 'border-surface-700')}>
                <TrendingUp className={cn('w-6 h-6 mx-auto mb-2',
                  side === 'up' ? 'text-emerald-400' : 'text-white/40')} />
                <p className="font-semibold">UP</p>
              </button>
              <button onClick={() => setSide('down')}
                className={cn('p-4 rounded-xl border-2 transition',
                  side === 'down' ? 'border-red-500 bg-red-500/10' : 'border-surface-700')}>
                <TrendingDown className={cn('w-6 h-6 mx-auto mb-2',
                  side === 'down' ? 'text-red-400' : 'text-white/40')} />
                <p className="font-semibold">DOWN</p>
              </button>
            </div>
            <Input type="number" label="Amount (USDT)" value={amount}
              onChange={(e: any) => setAmount(Number(e.target.value))} />
            <Button fullWidth size="lg" loading={betMutation.isPending}
              disabled={user.balance < amount}
              onClick={() => betMutation.mutate()}>
              Confirm {side.toUpperCase()}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
};
const MarketCard = ({ market, onBet }: any) => {
  const [sec, setSec] = useState(() =>
    Math.max(0, Math.floor((new Date(market.closes_at).getTime() - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setSec(Math.max(0,
      Math.floor((new Date(market.closes_at).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [market.closes_at]);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  const total = Number(market.total_up) + Number(market.total_down);
  const upPct = total > 0 ? (Number(market.total_up) / total) * 100 : 50;
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{market.symbol}</span>
          <span className="text-xs text-white/40">{market.duration_seconds}s</span>
        </div>
        <div className={cn('flex items-center gap-1 text-xs',
          sec < 30 ? 'text-red-400' : 'text-white/40')}>
          <Clock className="w-3 h-3" /> {m}:{s}
        </div>
      </div>
      <div className="mb-4">
        <p className="text-xs text-white/40 mb-1">Open Price</p>
        <p className="text-2xl font-bold font-mono">${market.open_price.toFixed(2)}</p>
      </div>
      <div className="flex rounded-full overflow-hidden h-2 bg-surface-900 mb-4">
        <div className="bg-emerald-500" style={{ width: `${upPct}%` }} />
        <div className="bg-red-500 flex-1" />
      </div>
      <div className="flex justify-between text-xs mb-4">
        <span className="text-emerald-400">UP {fmtUsdt(market.total_up)}</span>
        <span className="text-red-400">DOWN {fmtUsdt(market.total_down)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" onClick={() => onBet('up')}
          className="bg-emerald-500 hover:bg-emerald-600 text-white shadow-none">
          <TrendingUp className="w-4 h-4" /> UP
        </Button>
        <Button size="sm" onClick={() => onBet('down')}
          className="bg-red-500 hover:bg-red-600 text-white shadow-none">
          <TrendingDown className="w-4 h-4" /> DOWN
        </Button>
      </div>
    </Card>
  );
};

// =========================================================================
//  SECTION 15: LOTTERY
// =========================================================================
export const LotteryPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const { push } = useToast();
  const qc = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const [idKey, setIdKey] = useState(idemKey());

  const { data, isLoading } = useQuery({
    queryKey: ['lottery-round'],
    queryFn: async () => (await api.get('/lottery/current')).data,
    refetchInterval: 15_000,
  });

  const buyMutation = useMutation({
    mutationFn: async () => (await api.post('/lottery/buy',
      { quantity }, { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: (d) => {
      push('success', `Bought ${d.ticketNumbers.length} tickets!`);
      setUser({ ...user, balance: user.balance - d.totalCost });
      setIdKey(idemKey());
      qc.invalidateQueries({ queryKey: ['lottery-round'] });
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  if (isLoading) return <Spinner />;
  const round = data?.round;
  const totalCost = +(Number(round?.ticket_price || 5) * quantity).toFixed(2);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Weekly Lottery</h1>
        <p className="text-white/50">5 USDT ticket. Winner takes 85% of the pool.</p>
      </div>
      <Card className="bg-gradient-to-br from-brand-500/15 to-transparent border-brand-500/40">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wider">Round #{round?.round_number}</p>
            <p className="text-3xl font-bold text-brand-500 mt-1">
              {fmtUsdt(round?.prize_pool || 0)}
            </p>
            <p className="text-xs text-white/40 mt-1">Prize Pool</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-white/60">Ends</p>
            <p className="font-mono">{round?.end_at ? fmtDate(round.end_at) : '—'}</p>
            <p className="text-xs text-white/40 mt-1">{round?.tickets_sold} tickets sold</p>
          </div>
        </div>
      </Card>
      <Card>
        <CardTitle sub={`Ticket price: ${fmtUsdt(round?.ticket_price || 5)}`}>
          Buy Tickets
        </CardTitle>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-white/70 mb-2">Quantity</label>
            <div className="flex gap-2">
              {[1, 3, 5, 10, 25].map((n) => (
                <button key={n} onClick={() => setQuantity(n)}
                  className={cn('flex-1 py-2.5 rounded-lg text-sm transition',
                    quantity === n ? 'bg-brand-500 text-surface-900 font-semibold'
                                   : 'bg-surface-700 hover:bg-surface-600')}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-surface-900 rounded-lg p-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-white/50">Total Cost</span>
              <span className="font-semibold text-brand-500">{fmtUsdt(totalCost)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-white/40">Your Balance</span>
              <span>{fmtUsdt(user.balance)}</span>
            </div>
          </div>
          <Button fullWidth size="lg" loading={buyMutation.isPending}
            disabled={user.balance < totalCost}
            onClick={() => buyMutation.mutate()}>
            <Ticket className="w-5 h-5" /> Buy {quantity} Ticket{quantity > 1 ? 's' : ''}
          </Button>
        </div>
      </Card>
      <Card>
        <CardTitle>Recent Winners</CardTitle>
        {(!data?.recent_winners || data.recent_winners.length === 0) ? (
          <p className="text-sm text-white/40 text-center py-6">No winners yet.</p>
        ) : (
          <div className="space-y-2">
            {data.recent_winners.map((w: any) => (
              <div key={w.id} className="flex items-center justify-between
                                         bg-surface-700/40 rounded-lg p-3">
                <div>
                  <p className="text-sm font-medium">Round #{w.round_number}</p>
                  <p className="text-xs text-white/40">
                    Ticket #{w.winning_ticket} · {fmtDate(w.drawn_at)}
                  </p>
                </div>
                <Badge color="green">+{fmtUsdt(w.prize_pool)}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

// =========================================================================
//  SECTION 16: MISSIONS
// =========================================================================
export const MissionsPage = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const [idKey, setIdKey] = useState(idemKey());

  const { data, isLoading } = useQuery({
    queryKey: ['missions'],
    queryFn: async () => (await api.get('/missions')).data,
    refetchInterval: 30_000,
  });

  const claimMutation = useMutation({
    mutationFn: async (missionId: string) =>
      (await api.post(`/missions/${missionId}/claim`, {},
        { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: (d) => {
      push('success', `Claimed ${fmtUsdt(d.reward_usdt)} + ${d.reward_xp} XP!`);
      setIdKey(idemKey());
      qc.invalidateQueries({ queryKey: ['missions'] });
      useAuthStore.getState().refreshMe();
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  if (isLoading) return <Spinner />;
  const { missions = [], streak = { count: 0, rewards: [] } } = data || {};
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Daily Missions</h1>
        <p className="text-white/50">Complete tasks. Earn USDT and XP rewards.</p>
      </div>
      <Card className="bg-gradient-to-br from-orange-500/15 to-transparent border-orange-500/40">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <Flame className="w-10 h-10 text-orange-400" />
            <div>
              <p className="text-3xl font-bold text-orange-400">{streak.count} days</p>
              <p className="text-xs text-white/40">Current Streak</p>
            </div>
          </div>
          <div className="flex gap-1 flex-wrap">
            {streak.rewards?.map((r: number, i: number) => (
              <div key={i} className={cn('px-2 py-1 rounded text-xs font-mono',
                i < streak.count ? 'bg-orange-500/20 text-orange-400'
                                 : 'bg-surface-700/50 text-white/40')}>
                D{i + 1}: ${r}
              </div>
            ))}
          </div>
        </div>
      </Card>
      <div className="grid md:grid-cols-2 gap-4">
        {missions.map((m: any) => {
          const pct = Math.min(100, (m.progress / m.target_count) * 100);
          const completed = !!m.completed_at;
          const claimed = !!m.claimed_at;
          return (
            <Card key={m.id}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold mb-1">{m.title}</h3>
                  <p className="text-xs text-white/50">{m.description}</p>
                </div>
                <div className="text-right shrink-0 ml-2">
                  <p className="text-sm font-semibold text-brand-500">{fmtUsdt(m.reward_usdt)}</p>
                  <p className="text-xs text-white/40">+{m.reward_xp} XP</p>
                </div>
              </div>
              <div className="mb-3">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-white/40">Progress</span>
                  <span>{Math.min(m.progress, m.target_count)} / {m.target_count}</span>
                </div>
                <div className="h-2 bg-surface-900 rounded-full overflow-hidden">
                  <div className={cn('h-full transition-all',
                    completed ? 'bg-emerald-500' : 'bg-brand-500')}
                    style={{ width: `${pct}%` }} />
                </div>
              </div>
              <Button fullWidth size="sm" disabled={!completed || claimed}
                variant={claimed ? 'secondary' : 'primary'}
                loading={claimMutation.isPending && claimMutation.variables === m.id}
                onClick={() => claimMutation.mutate(m.id)}>
                {claimed ? <><CheckCircle2 className="w-4 h-4" /> Claimed</>
                 : completed ? 'Claim Reward' : 'In Progress'}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// =========================================================================
//  SECTION 17: REFERRALS
// =========================================================================
export const ReferralsPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const { push } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['mlm-tree'],
    queryFn: async () => (await api.get('/mlm/tree')).data,
  });
  if (isLoading) return <Spinner />;
  const { level1 = [], level2 = [], earnings = [] } = data || {};
  const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${user.referral_code}`;
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Referrals</h1>
        <p className="text-white/50">Commission rates lock to YOUR package at each referral's join date.</p>
      </div>
      <Card>
        <CardTitle sub="Share with friends. You earn L1 + L2 on every purchase they make.">
          Invite Link
        </CardTitle>
        <div className="flex gap-2 mb-4">
          <input readOnly value={link}
            className="flex-1 bg-surface-900 border border-surface-700
                       rounded-lg px-3 py-2 text-sm font-mono text-white/80 min-w-0" />
          <Button onClick={() => { navigator.clipboard.writeText(link); push('success', 'Copied'); }}>
            <Copy className="w-4 h-4" /> Copy
          </Button>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {[
            { label: 'L1 Subscription', key: 'subscription', lvl: 1 },
            { label: 'L2 Subscription', key: 'subscription', lvl: 2 },
            { label: 'Activity Bonus',  key: 'activity',     lvl: 1 },
          ].map((x, i) => {
            const row = earnings.find((e: any) =>
              e.kind === x.key && Number(e.level) === x.lvl);
            return (
              <div key={i} className="flex items-center justify-between
                                       bg-surface-700/50 rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-brand-500" />
                  <span className="text-sm">{x.label}</span>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{fmtUsdt(row?.total || 0)}</p>
                  <p className="text-xs text-white/40">{row?.count || 0} events</p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <Card>
        <CardTitle>Level 1 Referrals ({level1.length})</CardTitle>
        <RefTable rows={level1} />
      </Card>
      <Card>
        <CardTitle>Level 2 Referrals ({level2.length})</CardTitle>
        <RefTable rows={level2} />
      </Card>
    </div>
  );
};
const RefTable = ({ rows }: { rows: any[] }) => {
  if (!rows.length)
    return <p className="text-sm text-white/40 text-center py-6">No referrals yet.</p>;
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-sm">
        <thead className="text-white/40 border-b border-surface-700">
          <tr>
            <th className="text-left py-2">User</th>
            <th className="text-left py-2">Package</th>
            <th className="text-left py-2">Status</th>
            <th className="text-left py-2">Joined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-surface-700/50 last:border-0">
              <td className="py-2.5">{r.username || r.email}</td>
              <td className="py-2.5"><Badge color="brand">{pkgLabel(r.package)}</Badge></td>
              <td className="py-2.5">
                <Badge color={r.status === 'active' ? 'green' : 'gray'}>{r.status}</Badge>
              </td>
              <td className="py-2.5 text-white/50">{fmtDate(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// =========================================================================
//  SECTION 18: WALLET
// =========================================================================
const PACKAGES = [
  { id: 'p1_5',  price: 5,  l1: 8,  l2: 5, act: 2.5 },
  { id: 'p2_10', price: 10, l1: 10, l2: 5, act: 3   },
  { id: 'p3_20', price: 20, l1: 13, l2: 5, act: 5   },
  { id: 'p4_50', price: 50, l1: 18, l2: 5, act: 7.5 },
];

export const WalletPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const { push } = useToast();
  const qc = useQueryClient();
  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState('');
  const [idKey, setIdKey] = useState(idemKey());
  const [adminWallet] = useState('0x0000000000000000000000000000000000000000');

  const { data: deposits } = useQuery({
    queryKey: ['deposit-history'],
    queryFn: async () => (await api.get('/deposit/history')).data.deposits,
    refetchInterval: 15_000,
  });

  const submitPayment = useMutation({
    mutationFn: async ({ pkg, hash }: { pkg: string; hash: string }) =>
      (await api.post('/payment/purchase-package', { package: pkg, txHash: hash },
        { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: () => {
      push('success', 'Package activated!');
      setSelectedPkg(null); setTxHash(''); setIdKey(idemKey());
      useAuthStore.getState().refreshMe();
      qc.invalidateQueries({ queryKey: ['deposit-history'] });
    },
    onError: (err) => { push('error', extractError(err)); setIdKey(idemKey()); },
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Wallet</h1>
        <p className="text-white/50">Deposit USDT (BEP-20). Full-price upgrades only.</p>
      </div>
      <Card className="bg-gradient-to-br from-brand-500/15 to-transparent border-brand-500/40">
        <p className="text-sm text-white/60 mb-1">Current Balance</p>
        <p className="text-4xl font-bold text-brand-500">{fmtUsdt(user.balance)}</p>
        <p className="text-xs text-white/40 mt-2">
          Current package: <span className="text-white">{pkgLabel(user.package)}</span>
        </p>
      </Card>
      <Card>
        <CardTitle sub="Full price on upgrade. New rates apply to referrals joining after upgrade.">
          Packages
        </CardTitle>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          {PACKAGES.map((p) => (
            <div key={p.id}
              className={cn('bg-surface-700/50 border rounded-xl p-4 transition cursor-pointer',
                user.package === p.id ? 'border-brand-500 shadow-glow'
                                      : 'border-surface-600 hover:border-brand-500/50')}
              onClick={() => { setSelectedPkg(p.id); setTxHash(''); }}>
              <p className="text-xs text-white/40 mb-1">{pkgLabel(p.id)}</p>
              <p className="text-2xl font-bold text-brand-500 mb-3">${p.price}</p>
              <div className="text-xs text-white/60 space-y-1 mb-4">
                <div>L1: <span className="text-white">{p.l1}%</span></div>
                <div>L2: <span className="text-white">{p.l2}%</span></div>
                <div>Activity: <span className="text-white">{p.act}%</span></div>
              </div>
              <Button size="sm" fullWidth disabled={user.package === p.id}>
                {user.package === p.id ? 'Active' : 'Buy / Upgrade'}
              </Button>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardTitle sub="Recent deposit intents.">Deposit History</CardTitle>
        {!deposits || deposits.length === 0 ? (
          <p className="text-sm text-white/40 text-center py-6">No deposits yet.</p>
        ) : (
          <div className="space-y-2">
            {deposits.slice(0, 5).map((d: any) => (
              <div key={d.id} className="flex items-center justify-between
                                         bg-surface-700/40 rounded-lg p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs truncate">{d.tx_hash}</p>
                  <p className="text-xs text-white/40">{fmtDate(d.created_at)}</p>
                </div>
                <div className="text-right ml-2 shrink-0">
                  <p className="font-semibold">{fmtUsdt(d.amount_usdt)}</p>
                  <Badge color={d.status === 'confirmed' ? 'green'
                    : d.status === 'rejected' ? 'red' : 'brand'}>{d.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Modal open={!!selectedPkg} onClose={() => setSelectedPkg(null)} title="Complete Payment">
        {selectedPkg && (
          <div className="space-y-4">
            <div className="bg-surface-900 rounded-lg p-3 text-sm">
              <p className="text-white/50 mb-1">Send exactly</p>
              <p className="font-bold text-brand-500 text-lg">
                {fmtUsdt(PACKAGES.find((p) => p.id === selectedPkg)!.price)}
              </p>
              <p className="text-white/50 mt-3 mb-1">To (USDT BEP-20 on BSC):</p>
              <div className="flex gap-2 items-center">
                <code className="text-xs bg-surface-800 px-2 py-1.5 rounded flex-1 break-all">
                  {adminWallet}
                </code>
                <Button size="sm" variant="secondary"
                  onClick={() => navigator.clipboard.writeText(adminWallet)}>
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
            </div>
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-xs text-yellow-300">
              ⚠️ Send USDT BEP-20 only. Wrong network = permanent loss.
            </div>
            <Input label="Transaction Hash" placeholder="0x..."
              value={txHash} onChange={(e: any) => setTxHash(e.target.value)} />
            <Button fullWidth size="lg" loading={submitPayment.isPending}
              disabled={!txHash || txHash.length < 10}
              onClick={() => submitPayment.mutate({ pkg: selectedPkg, hash: txHash })}>
              <CheckCircle2 className="w-4 h-4" /> Verify Payment
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
};

// =========================================================================
//  SECTION 19: WITHDRAW
// =========================================================================
export const WithdrawPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const { push } = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(10);
  const [walletAddress, setWalletAddress] = useState(user.wallet_address || '');
  const [idKey, setIdKey] = useState(idemKey());

  const { data: eligibility } = useQuery({
    queryKey: ['wd-elig'],
    queryFn: async () => (await api.get('/withdraw/eligibility')).data,
  });
  const { data: history } = useQuery({
    queryKey: ['wd-hist'],
    queryFn: async () => (await api.get('/withdraw/history')).data.withdrawals,
  });

  const create = useMutation({
    mutationFn: async () => (await api.post('/withdraw/request',
      { amount, walletAddress: walletAddress || undefined },
      { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: () => {
      push('success', 'Withdrawal requested.');
      setUser({ ...user, balance: user.balance - amount });
      setIdKey(idemKey());
      qc.invalidateQueries({ queryKey: ['wd-hist'] });
      qc.invalidateQueries({ queryKey: ['wd-elig'] });
    },
    onError: (e) => { push('error', extractError(e)); setIdKey(idemKey()); },
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => (await api.post(`/withdraw/${id}/cancel`)).data,
    onSuccess: (d) => {
      push('success', `Refunded ${fmtUsdt(d.refunded)}`);
      useAuthStore.getState().refreshMe();
      qc.invalidateQueries({ queryKey: ['wd-hist'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  const hasPending = history?.some((w: any) => w.status === 'pending');
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Withdraw</h1>
        <p className="text-white/50">USDT (BEP-20). 3% fee (min $1, max $10).</p>
      </div>
      <Card>
        <CardTitle sub="Both conditions required.">Eligibility</CardTitle>
        <div className="space-y-3">
          <ReqRow ok={Number(user.balance) >= 10} label="Balance ≥ 10 USDT"
            detail={`Current: ${fmtUsdt(user.balance)}`} />
          <ReqRow ok={user.active_ref_count >= 3} label="3 active referrals"
            detail={`Current: ${user.active_ref_count}`} />
        </div>
        {eligibility?.limits && (
          <div className="mt-4 pt-4 border-t border-surface-700 grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-white/40 mb-1">Daily Limit</p>
              <p>{fmtUsdt(eligibility.limits.daily_used)} / {fmtUsdt(eligibility.limits.daily_max)}</p>
            </div>
            <div>
              <p className="text-white/40 mb-1">Monthly Limit</p>
              <p>{fmtUsdt(eligibility.limits.monthly_used)} / {fmtUsdt(eligibility.limits.monthly_max)}</p>
            </div>
          </div>
        )}
      </Card>
      <Card>
        <CardTitle>Request</CardTitle>
        {hasPending && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3
                          text-xs text-yellow-300 mb-4">
            Pending withdrawal in queue.
          </div>
        )}
        <div className="space-y-4">
          <Input type="number" label="Amount (USDT)" value={amount}
            onChange={(e: any) => setAmount(Number(e.target.value))} />
          <Input label="Wallet Address" value={walletAddress}
            onChange={(e: any) => setWalletAddress(e.target.value)} />
          <Button fullWidth size="lg" loading={create.isPending}
            disabled={!eligibility?.ok || hasPending || amount < 10 || amount > user.balance}
            onClick={() => create.mutate()}>Request Withdrawal</Button>
        </div>
      </Card>
      <Card>
        <CardTitle>History</CardTitle>
        {!history?.length ? (
          <p className="text-sm text-white/40 text-center py-6">No withdrawals yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((w: any) => (
              <div key={w.id} className="flex items-center justify-between
                                         bg-surface-700/40 rounded-lg p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{fmtUsdt(w.amount_usdt)}</p>
                  <p className="text-xs text-white/40 truncate">{fmtDate(w.created_at)}
                    {w.fee_usdt > 0 && ` · fee ${fmtUsdt(w.fee_usdt)}`}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <Badge color={w.status === 'confirmed' ? 'green'
                    : w.status === 'rejected' ? 'red' : 'brand'}>{w.status}</Badge>
                  {w.status === 'pending' && (
                    <button onClick={() => cancel.mutate(w.id)}
                      className="text-xs text-red-400 hover:underline">Cancel</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
const ReqRow = ({ ok, label, detail }: any) => (
  <div className="flex items-center gap-3">
    {ok ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
        : <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
    <div className="flex-1 min-w-0">
      <p className={cn('text-sm', ok ? 'text-white' : 'text-white/70')}>{label}</p>
      <p className="text-xs text-white/40 truncate">{detail}</p>
    </div>
  </div>
);

// =========================================================================
//  SECTION 20: BONUS WHEEL — with betting + jackpot pool
// =========================================================================
export const BonusWheelPage = () => {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const isDemo = useAuthStore((s) => s.isDemo);
  const { push } = useToast();
  const qc = useQueryClient();
  const [betAmount, setBetAmount] = useState(1);
  const [poolAmount, setPoolAmount] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [lastPrize, setLastPrize] = useState<number | null>(null);
  const [idKey, setIdKey] = useState(idemKey());
  const [confetti, setConfetti] = useState(false);
  const accRot = useRef(0);

  const { data: cfgData } = useQuery({
    queryKey: ['bonus-config'],
    queryFn: async () => (await api.get('/bonus/config')).data,
  });
  const { data: statusData } = useQuery({
    queryKey: ['bonus-status'],
    queryFn: async () => (await api.get('/bonus/status')).data,
    refetchInterval: 30_000,
  });

  useQuery({
    queryKey: ['pool-wheel'],
    queryFn: async () => {
      try {
        const r = await api.get('/pools/wheel');
        setPoolAmount(Number(r.data.pool || 0));
      } catch {}
      return null;
    },
    refetchInterval: 15_000,
  });

  const segments = cfgData?.config?.segments || [];
  const minBet = cfgData?.config?.min_bet ?? 1;
  const maxBet = cfgData?.config?.max_bet ?? 10;

  const spinMutation = useMutation({
    mutationFn: async ({ betAmount: ba, useFreeSpin }: { betAmount: number; useFreeSpin: boolean }) =>
      (await api.post('/bonus/spin', { betAmount: ba, useFreeSpin, isDemo },
        { headers: { 'Idempotency-Key': idKey } })).data,
    onSuccess: (data) => {
      const total = segments.reduce((s: number, x: any) => s + (x.weight || 1), 0);
      let cum = 0;
      for (let i = 0; i < data.segmentIndex; i++) cum += segments[i].weight || 1;
      const seg = segments[data.segmentIndex];
      const mid = ((cum + (seg?.weight || 1) / 2) / total) * 360;
      const extra = 360 * 5 + (360 - mid);
      accRot.current += extra;
      setRotation(accRot.current);
      setLastPrize(data.prize);
      setTimeout(() => {
        setSpinning(false);
        setUser({ ...user, balance: data.newBalance });
        setIdKey(idemKey());
        if (data.isJackpot) {
          push('success', `🎉 JACKPOT! Won ${fmtUsdt(data.prize)}!`);
          setConfetti(true);
          setTimeout(() => setConfetti(false), 5000);
        } else if (data.prize > 0) {
          push('success', `Won ${fmtUsdt(data.prize)}!`);
          if (data.prize >= 1) {
            setConfetti(true);
            setTimeout(() => setConfetti(false), 3000);
          }
        } else push('info', 'No prize this time.');
        qc.invalidateQueries({ queryKey: ['bonus-status'] });
        qc.invalidateQueries({ queryKey: ['notifications'] });
        qc.invalidateQueries({ queryKey: ['pool-wheel'] });
      }, 5_100);
    },
    onError: (err) => { setSpinning(false); push('error', extractError(err)); setIdKey(idemKey()); },
  });

  const handleSpin = (useFreeSpin: boolean) => {
    if (spinning) return;
    if (useFreeSpin && !statusData?.canSpin) return;
    const curBal = isDemo ? user.demo_balance : user.balance;
    if (!useFreeSpin && curBal < betAmount) {
      push('error', 'Insufficient balance');
      return;
    }
    setSpinning(true); setLastPrize(null);
    spinMutation.mutate({ betAmount, useFreeSpin });
  };

  const radius = 180, center = radius;
  const polar = (cx: number, cy: number, r: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const arcPath = (s: number, e: number, r: number) => {
    const a = polar(center, center, r, s), b = polar(center, center, r, e);
    const large = e - s > 180 ? 1 : 0;
    return `M ${center} ${center} L ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y} Z`;
  };
  const arcs = useMemo(() => {
    const total = segments.reduce((s: number, x: any) => s + (x.weight || 1), 0);
    let cum = 0;
    return segments.map((seg: any) => {
      const ang = ((seg.weight || 1) / total) * 360;
      const start = cum; cum += ang;
      return { ...seg, startAngle: start, endAngle: cum };
    });
  }, [segments]);

  return (
    <>
      <Confetti active={confetti} />
      <div className="grid lg:grid-cols-3 gap-6 max-w-7xl mx-auto">
        <div className="lg:col-span-2">
          <Card>
            <div className="relative flex flex-col items-center py-6">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
                <div className="w-0 h-0 border-l-[14px] border-l-transparent
                                border-r-[14px] border-r-transparent
                                border-t-[22px] border-t-brand-500
                                drop-shadow-[0_0_10px_rgba(245,179,1,0.8)]" />
              </div>
              <svg viewBox="0 0 360 360"
                style={{
                  transform: `rotate(${rotation}deg)`,
                  transition: 'transform 5s cubic-bezier(0.17, 0.67, 0.16, 1)',
                  filter: 'drop-shadow(0 0 20px rgba(245, 179, 1, 0.35))',
                  maxWidth: '100%', height: 'auto', width: '360px',
                }}>
                {arcs.map((a: any, i: number) => {
                  const mid = (a.startAngle + a.endAngle) / 2;
                  const pos = polar(center, center, radius * 0.68, mid);
                  return (
                    <g key={i}>
                      <path d={arcPath(a.startAngle, a.endAngle, radius - 8)}
                        fill={a.color} stroke="#0a0a0f" strokeWidth="2" />
                      <text x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle"
                        fill="#fff" fontSize="13" fontWeight="600"
                        transform={`rotate(${mid} ${pos.x} ${pos.y})`}>{a.label}</text>
                    </g>
                  );
                })}
                <circle cx={center} cy={center} r={radius * 0.22}
                  fill="#0a0a0f" stroke="#f5b301" strokeWidth="3" />
                <text x={center} y={center} textAnchor="middle" dominantBaseline="middle"
                  fill="#f5b301" fontSize="14" fontWeight="700">SPIN</text>
              </svg>
              {lastPrize !== null && !spinning && (
                <div className="mt-6 text-center">
                  <p className="text-xs text-white/50 mb-1">You won</p>
                  <p className={cn('text-4xl font-bold',
                    lastPrize > 0 ? 'text-brand-500' : 'text-white/40')}>
                    {lastPrize > 0 ? fmtUsdt(lastPrize) : 'No prize'}
                  </p>
                </div>
              )}
              <div className="mt-8 w-full max-w-sm">
                <div className="space-y-3">
                  {statusData?.canSpin && (
                    <Button fullWidth size="sm" variant="secondary"
                      onClick={() => handleSpin(true)}
                      loading={spinning} disabled={spinning}>
                      <Gift className="w-4 h-4" /> Free Spin (Daily)
                    </Button>
                  )}
                  <div className="bg-surface-900 rounded-lg p-3 space-y-2">
                    <label className="block text-xs text-white/60">Bet Amount (USDT)</label>
                    <div className="flex gap-2">
                      {[1, 2, 5, 10].map((v) => (
                        <button key={v} onClick={() => setBetAmount(v)}
                          disabled={v > maxBet || v < minBet}
                          className={cn('flex-1 py-2 rounded text-sm transition',
                            betAmount === v ? 'bg-brand-500 text-surface-900 font-semibold'
                                            : 'bg-surface-700 hover:bg-surface-600',
                            (v > maxBet || v < minBet) && 'opacity-40 cursor-not-allowed')}>
                          {v}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-white/40">
                      Range: {fmtUsdt(minBet)} – {fmtUsdt(maxBet)}
                    </p>
                  </div>
                  <Button fullWidth size="lg" onClick={() => handleSpin(false)}
                    loading={spinning} disabled={spinning || (isDemo ? user.demo_balance : user.balance) < betAmount}
                    className="shadow-glow">
                    <Sparkles className="w-5 h-5" />
                    {spinning ? 'Spinning...' : `Spin for ${fmtUsdt(betAmount)}`}
                  </Button>
                  {!statusData?.canSpin && statusData?.nextAt && (
                    <p className="text-xs text-center text-white/40">
                      Next free spin at {new Date(statusData.nextAt).toLocaleTimeString('en-US')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Trophy className="w-5 h-5 text-brand-500" />
              <h3 className="font-semibold">Jackpot Pool</h3>
            </div>
            <div className="bg-gradient-to-br from-brand-500/20 to-transparent rounded-lg p-4 text-center mb-3">
              <p className="text-xs text-white/50 mb-1">Current Pool</p>
              <p className="text-3xl font-bold text-brand-500">{fmtUsdt(poolAmount)}</p>
            </div>
            <p className="text-xs text-white/50 leading-relaxed">
              A portion of every bet goes into the pool. Land the jackpot segment to claim it!
            </p>
          </Card>
        </div>
      </div>
    </>
  );
};

// =========================================================================
//  SECTION 21: PROFILE
// =========================================================================
export const ProfilePage = () => {
  const user = useAuthStore((s) => s.user)!;
  const { push } = useToast();
  const copyCode = () => {
    navigator.clipboard.writeText(user.referral_code);
    push('success', 'Copied');
  };
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold">Profile</h1>
      <Card>
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-500 to-brand-700
                          flex items-center justify-center text-2xl font-bold text-surface-900 shrink-0">
            {(user.username || user.email)[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold truncate">{user.username || 'Anonymous'}</h2>
            <p className="text-sm text-white/50 truncate">{user.email}</p>
          </div>
          <div><Badge color={user.status === 'active' ? 'green' : 'gray'}>{user.status}</Badge></div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <InfoRow icon={Mail} label="Email" value={user.email} />
          <InfoRow icon={Shield} label="Package" value={pkgLabel(user.package)} />
          <InfoRow icon={Award} label="Referrals" value={`${user.active_ref_count} active`} />
          <InfoRow icon={Flame} label="Streak" value={`${user.streak_count || 0} days`} />
          <InfoRow icon={Zap} label="XP" value={String(user.xp || 0)} />
          <InfoRow icon={Calendar} label="Joined"
            value={user.created_at ? fmtDate(user.created_at) : '—'} />
        </div>
      </Card>
      <Card>
        <CardTitle sub="Share with friends.">Referral Code</CardTitle>
        <div className="flex gap-2">
          <div className="flex-1 bg-surface-900 border border-surface-700 rounded-lg px-3 py-2.5
                          font-mono text-brand-500 font-semibold">{user.referral_code}</div>
          <Button onClick={copyCode}><Copy className="w-4 h-4" /> Copy</Button>
        </div>
      </Card>
      <Card>
        <CardTitle>Stats</CardTitle>
        <div className="grid grid-cols-3 gap-4">
          <StatBox label="Balance" value={fmtUsdt(user.balance)} accent />
          <StatBox label="Deposited" value={fmtUsdt(user.total_deposited)} />
          <StatBox label="Withdrawn" value={fmtUsdt(user.total_withdrawn)} />
        </div>
      </Card>
    </div>
  );
};
const InfoRow = ({ icon: Icon, label, value }: any) => (
  <div className="flex items-center gap-3 bg-surface-700/40 rounded-lg p-3">
    <Icon className="w-5 h-5 text-white/40 shrink-0" />
    <div className="min-w-0 flex-1">
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-sm text-white truncate">{value}</p>
    </div>
  </div>
);
const StatBox = ({ label, value, accent }: any) => (
  <div className="bg-surface-700/40 rounded-lg p-4 text-center">
    <p className="text-xs text-white/40 mb-1">{label}</p>
    <p className={cn('text-lg font-bold', accent ? 'text-brand-500' : 'text-white')}>{value}</p>
  </div>
);

// =========================================================================
//  SECTION 22: FAQ
// =========================================================================
export const FAQPage = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['faq'],
    queryFn: async () => (await api.get('/faq')).data.faqs,
  });
  const [openIdx, setOpenIdx] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  const grouped: Record<string, any[]> = {};
  for (const f of (data || [])) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f);
  }
  const catLabels: any = {
    provably_fair: 'Game Fairness',
    packages: 'Packages & MLM',
    withdrawals: 'Withdrawals',
    demo: 'Demo Mode',
    wallet: 'Wallet & Network',
  };
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold mb-1">Help & FAQ</h1>
        <p className="text-white/50">Everything you need to know about the platform.</p>
      </div>
      {Object.entries(grouped).map(([cat, items]) => (
        <Card key={cat}>
          <CardTitle>{catLabels[cat] || cat}</CardTitle>
          <div className="space-y-2">
            {items.map((f) => {
              const isOpen = openIdx === f.id;
              return (
                <div key={f.id} className="bg-surface-700/40 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setOpenIdx(isOpen ? null : f.id)}
                    className="w-full flex items-center justify-between text-left p-3 hover:bg-surface-700/60 transition">
                    <span className="text-sm font-medium pr-2">{f.question}</span>
                    <span className="text-white/40 shrink-0">
                      {isOpen ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 text-sm text-white/60 border-t border-surface-700/50 pt-3">
                      {f.answer}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
};

// =========================================================================
//  SECTION 23: ADMIN PANEL
// =========================================================================
export const AdminPage = () => {
  const [tab, setTab] = useState<'overview'|'users'|'withdrawals'|'settings'|'lottery'|'pools'|'audit'>('overview');
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => (await api.get('/admin/stats')).data.stats,
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Shield className="w-8 h-8 text-red-400" />
        <h1 className="text-3xl font-bold">Admin Panel</h1>
      </div>
      <div className="flex gap-2 border-b border-surface-700 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        {(['overview','users','withdrawals','settings','lottery','pools','audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('px-4 py-2 text-sm font-medium capitalize border-b-2 transition whitespace-nowrap',
              tab === t ? 'border-brand-500 text-brand-500'
                        : 'border-transparent text-white/60 hover:text-white')}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'overview' && <AdminOverview stats={stats} isLoading={isLoading} />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'withdrawals' && <AdminWithdrawals />}
      {tab === 'settings' && <AdminSettings />}
      {tab === 'lottery' && <AdminLottery />}
      {tab === 'pools' && <AdminPools />}
      {tab === 'audit' && <AdminAudit />}
    </div>
  );
};

const AdminOverview = ({ stats, isLoading }: any) => {
  if (isLoading || !stats) return <Spinner />;
  const cards = [
    { label: 'Total Users', value: stats.users?.total ?? 0, sub: `${stats.users?.active ?? 0} active`, icon: Users },
    { label: 'GGR (Total)', value: fmtUsdt(stats.ggr_total ?? 0), sub: 'Gross gaming rev.', icon: BarChart3 },
    { label: 'GGR (24h)', value: fmtUsdt(stats.ggr_daily ?? 0), sub: 'Last 24 hours', icon: Activity },
    { label: 'User Balances', value: fmtUsdt(stats.wallets?.total_balances ?? 0), sub: 'Real funds', icon: Wallet },
    { label: 'Wheel Cost', value: fmtUsdt(stats.wheel_cost_total ?? 0), sub: 'Prizes paid', icon: Sparkles },
    { label: 'Demo Wagered', value: fmtUsdt(stats.demo?.wagered ?? 0),
      sub: `${stats.demo?.count ?? 0} demo bets`, icon: PlayCircle },
    { label: 'Deposits', value: fmtUsdt(stats.wallets?.total_deposited ?? 0), sub: 'Lifetime', icon: DollarSign },
    { label: 'Pending W/D', value: stats.pending_withdrawals ?? 0, sub: 'Awaiting review', icon: Clock },
  ];
  return (
    <div className="space-y-6">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c: any, i: number) => (
          <Card key={i}>
            <c.icon className="w-5 h-5 text-white/40 mb-3" />
            <p className="text-2xl font-bold">{c.value}</p>
            <p className="text-sm text-white/70">{c.label}</p>
            <p className="text-xs text-white/40 mt-1">{c.sub}</p>
          </Card>
        ))}
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardTitle>Top Winners</CardTitle>
          <div className="space-y-2">
            {stats.top_winners?.map((w: any, i: number) => (
              <div key={w.id} className="flex items-center justify-between
                                         bg-surface-700/40 rounded-lg px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <Badge color="green">#{i + 1}</Badge>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {w.username || (w.email || '').split('@')[0]}
                    </p>
                    <p className="text-xs text-white/40 truncate">{w.email}</p>
                  </div>
                </div>
                <p className="font-semibold text-emerald-400 shrink-0">{fmtUsdt(w.net_profit)}</p>
              </div>
            ))}
            {!stats.top_winners?.length && (
              <p className="text-sm text-white/40 text-center py-6">No winners yet.</p>
            )}
          </div>
        </Card>
        <Card>
          <CardTitle>Top Losers</CardTitle>
          <div className="space-y-2">
            {stats.top_losers?.map((w: any, i: number) => (
              <div key={w.id} className="flex items-center justify-between
                                         bg-surface-700/40 rounded-lg px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <Badge color="red">#{i + 1}</Badge>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {w.username || (w.email || '').split('@')[0]}
                    </p>
                    <p className="text-xs text-white/40 truncate">{w.email}</p>
                  </div>
                </div>
                <p className="font-semibold text-red-400 shrink-0">{fmtUsdt(w.net_loss)}</p>
              </div>
            ))}
            {!stats.top_losers?.length && (
              <p className="text-sm text-white/40 text-center py-6">No data yet.</p>
            )}
          </div>
        </Card>
      </div>
      <Card>
        <CardTitle>Daily GGR (Last 30 days)</CardTitle>
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {stats.daily_ggr?.map((d: any) => (
            <div key={d.day} className="flex items-center justify-between text-sm
                                        bg-surface-700/30 rounded-lg px-3 py-2">
              <span className="text-white/60">
                {new Date(d.day).toLocaleDateString('en-US')}
              </span>
              <div className="flex items-center gap-4">
                <span className="text-xs text-white/40">{d.total_bets} bets</span>
                <span className={cn('font-semibold',
                  Number(d.ggr) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {fmtUsdt(d.ggr)}
                </span>
              </div>
            </div>
          ))}
          {!stats.daily_ggr?.length && (
            <p className="text-sm text-white/40 text-center py-6">No data.</p>
          )}
        </div>
      </Card>
    </div>
  );
};

const AdminUsers = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', q],
    queryFn: async () => (await api.get(`/admin/users?q=${encodeURIComponent(q)}`)).data.users,
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: any) =>
      (await api.patch(`/admin/users/${id}/status`, { status })).data,
    onSuccess: () => {
      push('success', 'Status updated');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => push('error', extractError(e)),
  });
  const balanceMutation = useMutation({
    mutationFn: async ({ id, amount, note }: any) =>
      (await api.post(`/admin/users/${id}/balance`, { amount, note })).data,
    onSuccess: () => {
      push('success', 'Balance adjusted');
      setSelected(null); setAmount(0); setNote('');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  return (
    <div className="space-y-4">
      <Input placeholder="Search by email or username" value={q}
        onChange={(e: any) => setQ(e.target.value)} />
      {isLoading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-white/40 border-b border-surface-700">
              <tr>
                <th className="text-left py-2">User</th>
                <th className="text-left py-2 hidden md:table-cell">Package</th>
                <th className="text-left py-2">Balance</th>
                <th className="text-left py-2 hidden lg:table-cell">Demo</th>
                <th className="text-left py-2 hidden lg:table-cell">Refs</th>
                <th className="text-left py-2">Status</th>
                <th className="text-right py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((u: any) => (
                <tr key={u.id} className="border-b border-surface-700/50">
                  <td className="py-2.5 min-w-0">
                    <p className="font-medium truncate">
                      {u.username || (u.email || '').split('@')[0]}
                    </p>
                    <p className="text-xs text-white/40 truncate">{u.email}</p>
                  </td>
                  <td className="py-2.5 hidden md:table-cell">
                    <Badge color="brand">{pkgLabel(u.package)}</Badge>
                  </td>
                  <td className="py-2.5 font-mono text-xs">{fmtUsdt(u.balance)}</td>
                  <td className="py-2.5 hidden lg:table-cell font-mono text-xs text-purple-400">
                    {fmtUsdt(u.demo_balance || 0)}
                  </td>
                  <td className="py-2.5 hidden lg:table-cell">{u.active_ref_count}</td>
                  <td className="py-2.5">
                    <Badge color={u.status === 'active' ? 'green'
                      : u.status === 'banned' ? 'red' : 'gray'}>{u.status}</Badge>
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="secondary" onClick={() => setSelected(u)}>
                        <DollarSign className="w-3 h-3" />
                      </Button>
                      <Button size="sm"
                        variant={u.status === 'banned' ? 'success' : 'danger'}
                        onClick={() => statusMutation.mutate({
                          id: u.id, status: u.status === 'banned' ? 'active' : 'banned',
                        })}>
                        {u.status === 'banned'
                          ? <CheckCircle2 className="w-3 h-3" />
                          : <Ban className="w-3 h-3" />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!selected} onClose={() => setSelected(null)} title="Adjust Balance">
        {selected && (
          <div className="space-y-4">
            <p className="text-sm text-white/60">User: {selected.email}</p>
            <p className="text-sm">Current: <span className="text-brand-500 font-semibold">
              {fmtUsdt(selected.balance)}</span></p>
            <Input label="Amount (positive = credit, negative = debit)" type="number"
              value={amount} onChange={(e: any) => setAmount(Number(e.target.value))} />
            <Input label="Note (optional)" value={note}
              onChange={(e: any) => setNote(e.target.value)} />
            <Button fullWidth loading={balanceMutation.isPending} disabled={!amount}
              onClick={() => balanceMutation.mutate({ id: selected.id, amount, note })}>
              Apply
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
};

const AdminWithdrawals = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState<any>(null);
  const [txHash, setTxHash] = useState('');
  const [note, setNote] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-wd', status],
    queryFn: async () => (await api.get(`/admin/withdrawals?status=${status}`)).data.withdrawals,
  });

  const process = useMutation({
    mutationFn: async ({ id, action }: any) =>
      (await api.post(`/admin/withdrawals/${id}`, { action, txHash, adminNote: note })).data,
    onSuccess: (d) => {
      push('success', `Withdrawal ${d.status}`);
      setSelected(null); setTxHash(''); setNote('');
      qc.invalidateQueries({ queryKey: ['admin-wd'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {['pending','confirmed','rejected'].map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={cn('px-4 py-2 rounded-lg text-sm capitalize',
              status === s ? 'bg-brand-500 text-surface-900 font-semibold'
                           : 'bg-surface-700 hover:bg-surface-600')}>
            {s}
          </button>
        ))}
      </div>
      {isLoading ? <Spinner /> : (
        <div className="space-y-2">
          {!data?.length && (
            <p className="text-sm text-white/40 text-center py-6">None.</p>
          )}
          {data?.map((w: any) => (
            <Card key={w.id}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{fmtUsdt(w.amount_usdt)}</p>
                  <p className="text-xs text-white/40 truncate">
                    {w.email} · {fmtDate(w.created_at)}
                  </p>
                  {Number(w.fee_usdt) > 0 && (
                    <p className="text-xs text-yellow-400">Fee: {fmtUsdt(w.fee_usdt)}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color={w.status === 'confirmed' ? 'green'
                    : w.status === 'rejected' ? 'red' : 'brand'}>{w.status}</Badge>
                  {w.status === 'pending' && (
                    <Button size="sm" onClick={() => setSelected(w)}>Process</Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!selected} onClose={() => setSelected(null)} title="Process Withdrawal">
        {selected && (
          <div className="space-y-4">
            <div className="bg-surface-900 rounded-lg p-3 text-sm">
              <p>Amount: <span className="font-semibold text-brand-500">
                {fmtUsdt(selected.amount_usdt)}</span></p>
              <p className="text-xs text-white/40 mt-1 break-all">
                Wallet: {selected.wallet_address}
              </p>
            </div>
            <Input label="On-chain TxHash (for approval)" value={txHash}
              onChange={(e: any) => setTxHash(e.target.value)} placeholder="0x..." />
            <Input label="Admin Note" value={note}
              onChange={(e: any) => setNote(e.target.value)} />
            <div className="flex gap-2">
              <Button variant="danger" fullWidth loading={process.isPending}
                onClick={() => process.mutate({ id: selected.id, action: 'reject' })}>
                <XCircle className="w-4 h-4" /> Reject
              </Button>
              <Button variant="success" fullWidth loading={process.isPending}
                onClick={() => process.mutate({ id: selected.id, action: 'approve' })}>
                <CheckCircle2 className="w-4 h-4" /> Approve
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

const AdminSettings = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any>(null);
  const [value, setValue] = useState('');
  const [gameTab, setGameTab] = useState<'dice'|'boxes'|'wheel'|'prediction'>('dice');
  const [edgeForm, setEdgeForm] = useState<any>({});

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => (await api.get('/admin/settings')).data.settings,
  });

  const { data: gameCfg, refetch: refetchGame } = useQuery({
    queryKey: ['admin-game-config', gameTab],
    queryFn: async () => (await api.get(`/admin/games/${gameTab}/config`)).data,
  });

  useEffect(() => {
    if (gameCfg?.edges) setEdgeForm({ ...gameCfg.edges });
  }, [gameCfg]);

  const saveSetting = useMutation({
    mutationFn: async () => {
      const parsed = JSON.parse(value);
      return (await api.put(`/admin/settings/${editing.key}`, { value: parsed })).data;
    },
    onSuccess: () => {
      push('success', 'Saved'); setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  const toggleGame = useMutation({
    mutationFn: async (game: string) =>
      (await api.post(`/admin/games/${game}/toggle`)).data,
    onSuccess: () => {
      push('success', 'Toggled');
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  const saveEdge = useMutation({
    mutationFn: async ({ pkg, edge }: { pkg: string; edge: number }) =>
      (await api.put(`/admin/games/${gameTab}/edge`, { package: pkg, edge })).data,
    onSuccess: () => {
      push('success', 'Edge updated');
      refetchGame();
    },
    onError: (e) => push('error', extractError(e)),
  });

  const saveLimits = useMutation({
    mutationFn: async (limits: any) =>
      (await api.put(`/admin/games/${gameTab}/limits`, limits)).data,
    onSuccess: () => {
      push('success', 'Limits updated');
      refetchGame();
    },
    onError: (e) => push('error', extractError(e)),
  });

  if (isLoading) return <Spinner />;
  const games = data?.find((s: any) => s.key === 'games_enabled')?.value || {};
  const pkgs = ['none','p1_5','p2_10','p3_20','p4_50'];

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle sub="Instantly enable/disable games platform-wide.">Kill Switches</CardTitle>
        <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(games).map(([k, v]: any) => (
            <button key={k} onClick={() => toggleGame.mutate(k)}
              className={cn('flex items-center justify-between p-3 rounded-lg border transition',
                v ? 'bg-emerald-500/10 border-emerald-500/40'
                  : 'bg-red-500/10 border-red-500/40')}>
              <span className="capitalize text-sm">{k.replace('_',' ')}</span>
              <Badge color={v ? 'green' : 'red'}>{v ? 'ON' : 'OFF'}</Badge>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle sub="Adjust house edge per game per package.">Per-Game House Edge</CardTitle>
        <div className="flex gap-2 mb-4 flex-wrap">
          {(['dice','boxes','wheel','prediction'] as const).map((g) => (
            <button key={g} onClick={() => setGameTab(g)}
              className={cn('px-3 py-1.5 rounded text-sm capitalize',
                gameTab === g ? 'bg-brand-500 text-surface-900 font-semibold'
                              : 'bg-surface-700 hover:bg-surface-600')}>
              {g}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {pkgs.map((pkg) => (
            <div key={pkg} className="flex items-center gap-3 bg-surface-700/40 rounded-lg p-3">
              <span className="text-sm flex-1">{pkgLabel(pkg)}</span>
              <input type="number" step="0.01" min="0" max="1"
                value={edgeForm[pkg] ?? ''}
                onChange={(e) => setEdgeForm({ ...edgeForm, [pkg]: parseFloat(e.target.value) })}
                className="w-24 bg-surface-900 border border-surface-700 rounded px-2 py-1.5 text-sm text-white" />
              <Button size="sm" variant="secondary"
                onClick={() => saveEdge.mutate({ pkg, edge: parseFloat(edgeForm[pkg]) })}>
                Save
              </Button>
            </div>
          ))}
        </div>
        {gameCfg?.limit && (
          <div className="mt-4 pt-4 border-t border-surface-700 space-y-2">
            <p className="text-sm text-white/60">Bet limits & jackpot contribution</p>
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" label="Min Bet" defaultValue={gameCfg.limit.min_bet}
                onBlur={(e: any) => saveLimits.mutate({ min_bet: parseFloat(e.target.value) })} />
              <Input type="number" label="Max Bet" defaultValue={gameCfg.limit.max_bet}
                onBlur={(e: any) => saveLimits.mutate({ max_bet: parseFloat(e.target.value) })} />
              <Input type="number" step="0.01" label="Jackpot %" defaultValue={gameCfg.limit.jackpot_pct}
                onBlur={(e: any) => saveLimits.mutate({ jackpot_pct: parseFloat(e.target.value) })} />
            </div>
          </div>
        )}
      </Card>

      {data?.filter((s: any) => s.key !== 'games_enabled' && s.key !== 'per_game_edge').map((s: any) => (
        <Card key={s.key}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm text-brand-500">{s.key}</p>
              <pre className="text-xs text-white/50 mt-1 overflow-x-auto max-w-full">
                {JSON.stringify(s.value)}
              </pre>
            </div>
            <Button size="sm" variant="secondary"
              onClick={() => { setEditing(s); setValue(JSON.stringify(s.value, null, 2)); }}>
              <Settings className="w-3 h-3" /> Edit
            </Button>
          </div>
        </Card>
      ))}
      <Modal open={!!editing} onClose={() => setEditing(null)}
             title={`Edit: ${editing?.key}`} size="lg">
        <div className="space-y-4">
          <textarea value={value} onChange={(e) => setValue(e.target.value)}
            className="w-full bg-surface-900 border border-surface-700 rounded-lg p-3
                       text-white font-mono text-xs h-64 focus:outline-none focus:border-brand-500" />
          <Button fullWidth loading={saveSetting.isPending}
            onClick={() => saveSetting.mutate()}>Save</Button>
        </div>
      </Modal>
    </div>
  );
};

const AdminPools = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-pools'],
    queryFn: async () => (await api.get('/admin/pools')).data.pools,
    refetchInterval: 15_000,
  });
  const resetPool = useMutation({
    mutationFn: async (game: string) =>
      (await api.post(`/admin/pools/${game}/reset`)).data,
    onSuccess: () => {
      push('success', 'Pool reset');
      qc.invalidateQueries({ queryKey: ['admin-pools'] });
    },
    onError: (e) => push('error', extractError(e)),
  });
  if (isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle sub="Progressive jackpot pools across all games.">Jackpot Pools</CardTitle>
        <div className="space-y-3">
          {data?.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between bg-surface-700/40 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Trophy className="w-6 h-6 text-brand-500" />
                <div>
                  <p className="font-semibold capitalize">{p.game}</p>
                  <p className="text-xs text-white/40">
                    Contributed: {fmtUsdt(p.total_contributed)} ·
                    Paid: {fmtUsdt(p.total_paid_out)}
                  </p>
                </div>
              </div>
              <div className="text-right flex items-center gap-3">
                <div>
                  <p className="text-xl font-bold text-brand-500">{fmtUsdt(p.current_pool)}</p>
                  <p className="text-xs text-white/40">Current pool</p>
                </div>
                <Button size="sm" variant="danger"
                  onClick={() => { if (confirm(`Reset ${p.game} pool?`)) resetPool.mutate(p.game); }}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const AdminLottery = () => {
  const { push } = useToast();
  const qc = useQueryClient();
  const [endAt, setEndAt] = useState('');
  const [ticketPrice, setTicketPrice] = useState(5);

  const { data, isLoading } = useQuery({
    queryKey: ['lottery-round'],
    queryFn: async () => (await api.get('/lottery/current')).data,
  });

  const draw = useMutation({
    mutationFn: async () => (await api.post('/admin/lottery/force-draw', {})).data,
    onSuccess: (d) => {
      push('success', `Winner drawn! Prize: ${fmtUsdt(d.prizePool || 0)}`);
      qc.invalidateQueries({ queryKey: ['lottery-round'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  const createRound = useMutation({
    mutationFn: async () => (await api.post('/admin/lottery/create-round', {
      endAt, ticketPrice,
    })).data,
    onSuccess: () => {
      push('success', 'Round created');
      setEndAt('');
      qc.invalidateQueries({ queryKey: ['lottery-round'] });
    },
    onError: (e) => push('error', extractError(e)),
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle sub={`Round #${data?.round?.round_number || '—'}`}>Current Round</CardTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <StatBox label="Tickets Sold" value={data?.round?.tickets_sold || 0} />
          <StatBox label="Gross Pool" value={fmtUsdt(data?.round?.gross_pool || 0)} />
          <StatBox label="Prize Pool" value={fmtUsdt(data?.round?.prize_pool || 0)} accent />
          <StatBox label="Platform Cut" value={fmtUsdt(data?.round?.platform_cut || 0)} />
        </div>
        <Button variant="danger" loading={draw.isPending}
          disabled={!data?.round || data.round.tickets_sold === 0}
          onClick={() => { if (confirm('Draw winner now?')) draw.mutate(); }}>
          <PlayCircle className="w-4 h-4" /> Draw Winner Now
        </Button>
      </Card>

      <Card>
        <CardTitle sub="Manually create a new lottery round.">Create New Round</CardTitle>
        <div className="space-y-3">
          <Input label="End Date (ISO)" type="datetime-local" value={endAt}
            onChange={(e: any) => setEndAt(e.target.value)} />
          <Input label="Ticket Price (USDT)" type="number" value={ticketPrice}
            onChange={(e: any) => setTicketPrice(Number(e.target.value))} />
          <Button fullWidth loading={createRound.isPending}
            disabled={!endAt}
            onClick={() => createRound.mutate()}>Create Round</Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Recent Winners</CardTitle>
        {!data?.recent_winners?.length ? (
          <p className="text-sm text-white/40 text-center py-6">No winners yet.</p>
        ) : (
          <div className="space-y-2">
            {data.recent_winners.map((w: any) => (
              <div key={w.id} className="flex justify-between bg-surface-700/40 rounded-lg p-3">
                <div>
                  <p className="text-sm font-medium">Round #{w.round_number}</p>
                  <p className="text-xs text-white/40">Ticket #{w.winning_ticket}</p>
                </div>
                <p className="text-emerald-400 font-semibold">{fmtUsdt(w.prize_pool)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

const AdminAudit = () => {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, action],
    queryFn: async () => (await api.get(
      `/admin/audit?page=${page}&limit=30&action=${encodeURIComponent(action)}`
    )).data,
  });
  return (
    <div className="space-y-4">
      <Input placeholder="Filter by action (e.g. user.balance_adjust)" value={action}
        onChange={(e: any) => { setAction(e.target.value); setPage(1); }} />
      {isLoading ? <Spinner /> : (
        <Card>
          {!data?.logs?.length ? (
            <p className="text-sm text-white/40 text-center py-12">No audit entries.</p>
          ) : (
            <div className="space-y-2">
              {data.logs.map((l: any) => (
                <div key={l.id} className="bg-surface-700/40 rounded-lg p-3 text-xs">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <Badge color="brand">{l.action}</Badge>
                      {l.target_type && (
                        <span className="text-white/40">{l.target_type}</span>
                      )}
                    </div>
                    <span className="text-white/40">{fmtDate(l.created_at)}</span>
                  </div>
                  <p className="text-white/60">by {l.admin_email}</p>
                  {(l.before_state || l.after_state) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2 font-mono text-[10px]">
                      {l.before_state && (
                        <div className="bg-surface-900 rounded p-2 overflow-x-auto">
                          <span className="text-red-400">before: </span>
                          {JSON.stringify(l.before_state)}
                        </div>
                      )}
                      {l.after_state && (
                        <div className="bg-surface-900 rounded p-2 overflow-x-auto">
                          <span className="text-emerald-400">after: </span>
                          {JSON.stringify(l.after_state)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-surface-700">
            <Button size="sm" variant="secondary" disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="text-xs text-white/40">Page {page}</span>
            <Button size="sm" variant="secondary"
              disabled={!data?.logs || data.logs.length < 30}
              onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </Card>
      )}
    </div>
  );
};

// =========================================================================
//  SECTION 24: PROVIDERS + EXPORTS
// =========================================================================
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

export const Providers = ({ children }: { children: ReactNode }) => {
  const hydrate = useAuthStore((s) => s.hydrate);
  useEffect(() => { hydrate(); }, [hydrate]);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
};

export { api, useAuthStore, extractError, fmtUsdt, fmtDate, pkgLabel, cn, idemKey, gameLabel };

// =========================================================
//  END OF frontend.tsx
// =========================================================
