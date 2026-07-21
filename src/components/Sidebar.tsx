import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Activity, BarChart3, CalendarClock, ListTree, Radio, Settings, ToggleLeft, ToggleRight } from 'lucide-react';
import { trackingService } from '../services/trackingService';
import dataService from '../services/dataService';
import type { TrackingOverview } from '../services/ipc/settingsIpc';
import traceLogo from '../assets/trace-logo.jpeg';
import { useToast } from './ui/Toast';

const navItems = [
  { label: '今日执行', hint: '当前节奏与下一步', path: '/today', icon: Activity },
  { label: '时间线', hint: '逐条修正记录', path: '/timeline', icon: ListTree },
  { label: '周期复盘', hint: '对比趋势与偏差', path: '/review', icon: BarChart3 },
  { label: '设置', hint: '追溯与 AI 选项', path: '/settings', icon: Settings },
];

export default function Sidebar() {
  const [isTracking, setIsTracking] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [overview, setOverview] = useState<TrackingOverview | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = trackingService.subscribe(setIsTracking);
    void trackingService.sync().catch((error) => {
      console.error(error);
      toast('读取追溯状态失败', 'error');
    });
    return unsubscribe;
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    async function loadOverview() {
      try {
        const next = await dataService.getTrackingOverview();
        if (!cancelled) setOverview(next);
      } catch (error) {
        console.error(error);
      }
    }

    void loadOverview();
    const timerId = window.setInterval(() => {
      void loadOverview();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, []);

  const captureLabel = useMemo(() => formatRelativeTime(overview?.lastCaptureAtMs), [overview?.lastCaptureAtMs]);
  const isCalendarPermissionError = useMemo(() => {
    const value = overview?.lastCalendarSyncError;
    return Boolean(
      value
        && (
          value.includes('没有权限')
          || value.includes('未获授权')
          || value.includes('(-1743)')
          || value.includes('(-10004)')
          || value.toLowerCase().includes('not authorized')
        ),
    );
  }, [overview?.lastCalendarSyncError]);
  const isCalendarTransientError = useMemo(() => {
    const value = overview?.lastCalendarSyncError;
    return Boolean(
      value
        && (
          value.includes('Calendar 响应超时')
          || value.includes('Calendar 没有响应')
          || value.includes('应用程序没有运行')
          || value.includes('(-600)')
        ),
    );
  }, [overview?.lastCalendarSyncError]);
  const captureIsRecent = useMemo(() => {
    if (!overview?.lastCaptureAtMs) return false;
    return Date.now() - overview.lastCaptureAtMs <= 90_000;
  }, [overview?.lastCaptureAtMs]);
  const liveTraceLabel = useMemo(() => {
    if (!isTracking) return '追溯已暂停';
    if (overview?.activeIgnored) return `${overview.activeApp || '当前应用'} 暂未记录`;
    if (captureIsRecent) return overview?.currentBlockTitle || overview?.activeTitle || '正在记录当前活动';
    return '等待有效活动';
  }, [captureIsRecent, isTracking, overview]);
  const liveTraceDescription = useMemo(() => {
    if (!isTracking) return '不会写入新记录。';
    if (overview?.activeIgnored) return '当前应用暂时没有进入追溯规则。切到其他应用后会继续记录。';
    if (captureIsRecent && overview?.activeApp) {
      return `${overview.activeApp}${overview.activeTitle ? ` · ${overview.activeTitle}` : ''}`;
    }
    if (overview?.activeApp) {
      return `已开启追溯，但最近还没有形成有效捕获。当前前台：${overview.activeApp}`;
    }
    return '已开启追溯，但当前还没有读取到前台活动窗口。';
  }, [captureIsRecent, isTracking, overview]);
  const calendarLabel = useMemo(() => {
    if (!overview?.calendarSyncEnabled) return '未同步到日历';
    if (isCalendarPermissionError) return '需要日历权限';
    if (isCalendarTransientError) return '日历稍后重试';
    if (overview.lastCalendarSyncError) return '上次日历同步失败';
    if (overview.calendarSyncRunning) return '正在写入日历';
    if (overview.calendarPending) {
      const pendingMinutes = Math.max(0, overview.minCalendarMinutes - overview.currentBlockMinutes);
      return pendingMinutes > 0.05
        ? `待写入，还差 ${pendingMinutes.toFixed(1)} 分钟`
        : '达到写入条件，等待同步';
    }
    if (overview.lastCalendarWriteCount > 0) return `最近一次写入 ${overview.lastCalendarWriteCount} 条`;
    return '已开启自动日历同步';
  }, [isCalendarPermissionError, isCalendarTransientError, overview]);

  async function handleTrackingToggle() {
    if (trackingBusy) return;
    setTrackingBusy(true);
    try {
      await trackingService.toggle();
    } catch (error) {
      console.error(error);
      toast('切换追溯状态失败', 'error');
    } finally {
      setTrackingBusy(false);
    }
  }

  return (
    <aside className="w-[272px] shrink-0 h-screen border-r border-[var(--color-border-light)] bg-[rgba(255,255,255,0.48)] backdrop-blur-2xl flex flex-col">
      <div className="px-5 py-6 border-b border-[var(--color-border-light)]">
        <div className="flex items-center gap-4">
          <img
            src={traceLogo}
            alt="Trace"
            className="w-11 h-11 rounded-[16px] object-cover border border-[var(--color-border-light)] shadow-[var(--shadow-soft)]"
          />
          <div>
            <div className="text-[18px] font-semibold tracking-[-0.02em]">Trace</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">calm replay for your workday</div>
          </div>
        </div>
      </div>

      <nav className="px-4 py-5 space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `group flex items-center gap-3 px-4 py-3 rounded-2xl transition ${
                  isActive
                    ? 'bg-[var(--color-bg-surface-1)] text-[var(--color-text-primary)] shadow-[var(--shadow-soft)] border border-[var(--color-border-light)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.58)] hover:text-[var(--color-text-primary)]'
                }`
              }
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-bg-surface-2)] text-[var(--color-text-secondary)] group-hover:text-[var(--color-accent)]">
                <Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">{item.label}</span>
                <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">{item.hint}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>

      <div className="px-4 pb-3">
        <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.92),rgba(255,255,255,0.96))] p-4 shadow-[var(--shadow-soft)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-green-hover)]">
              <Radio size={14} />
              Live Trace
            </div>
            <div
              className={`h-2.5 w-2.5 rounded-full ${
                !isTracking
                  ? 'bg-[var(--color-text-muted)]'
                  : captureIsRecent
                    ? 'bg-[var(--color-green-hover)] animate-pulse'
                    : 'bg-[var(--color-lemon)]'
              }`}
            />
          </div>
          <div className="mt-3 text-sm font-semibold leading-6">
            {liveTraceLabel}
          </div>
          <div className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {liveTraceDescription}
          </div>
          <div className="mt-4 grid gap-2">
            <StatusLine
              icon={Activity}
              label="最近捕获"
              value={captureLabel}
            />
            <StatusLine
              icon={CalendarClock}
              label="日历同步"
              value={calendarLabel}
              tone={overview?.lastCalendarSyncError ? 'danger' : 'default'}
            />
          </div>
          {overview?.todayActivityCount ? (
            <div className="mt-4 rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-3 py-2 text-xs text-[var(--color-text-secondary)]">
              今日已形成 {overview.todayActivityCount} 条记录，累计 {Math.round(overview.todayCapturedMinutes)} 分钟。
            </div>
          ) : null}
        </div>
      </div>

      <div className="p-4 pt-0">
        <button
          onClick={() => void handleTrackingToggle()}
          disabled={trackingBusy}
          className="w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] shadow-[var(--shadow-soft)] disabled:opacity-60"
        >
          <div className="text-left">
            <div className="text-[13px] font-semibold">{trackingBusy ? '切换中' : isTracking ? '追溯开关已开启' : '追溯已暂停'}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              {isTracking ? captureIsRecent ? '最近已捕获活动窗口' : '等待有效前台活动' : '不会写入新记录'}
            </div>
          </div>
          {isTracking ? <ToggleRight className="text-[var(--color-green-hover)]" /> : <ToggleLeft className="text-[var(--color-text-muted)]" />}
        </button>
      </div>
    </aside>
  );
}

function StatusLine({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-white/60 px-3 py-2">
      <Icon size={14} className={tone === 'danger' ? 'text-[var(--color-coral-hover)]' : 'text-[var(--color-text-secondary)]'} />
      <div className="min-w-0">
        <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
        <div className={`text-xs leading-5 ${tone === 'danger' ? 'text-[var(--color-coral-hover)]' : 'text-[var(--color-text-secondary)]'}`}>{value}</div>
      </div>
    </div>
  );
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '还没有捕获到记录';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 10) return '刚刚';
  if (deltaSeconds < 60) return `${deltaSeconds} 秒前`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  return `${Math.round(deltaMinutes / 60)} 小时前`;
}
