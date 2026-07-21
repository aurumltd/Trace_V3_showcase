import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivitySquare, BarChart3, CalendarRange, Clock3, Layers3, RefreshCw, Sparkles, Target } from 'lucide-react';
import dataService, { mergeActivitiesPreservingStable, type Activity, type ActivityCategory, type WeekContext } from '../services/dataService';
import { useToast } from '../components/ui/Toast';
import { useAppStore } from '../store/useAppStore';
import {
  alignWorkblocksWithContext,
  aggregateWorkblocks,
  buildDailyDigest,
  findMissedCalendarEvents,
  formatMinutes,
  formatPercent,
} from '../utils/workblocks';

type RangePreset = 'today' | 'thisWeek' | 'last30' | 'custom';

type CategoryStat = {
  category: ActivityCategory;
  minutes: number;
  ratio: number;
};

type AppStat = {
  name: string;
  minutes: number;
};

type MainlineStat = {
  label: string;
  value: string;
  helper: string;
};

const CATEGORY_COLORS: Record<ActivityCategory, string> = {
  开发: 'var(--color-green)',
  工作: 'var(--color-blue)',
  学习: 'var(--color-purple)',
  会议: 'var(--color-lemon)',
  沟通: 'var(--color-coral)',
  浏览网页: '#9bb7ab',
  整理文件: '#83a892',
  提醒事项: '#79c0a2',
  休息: '#d2b37d',
  娱乐: '#e59cbc',
  其他: '#b8c5be',
};

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(base: Date, offsetDays: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + offsetDays);
  return next;
}

function getPresetRange(preset: RangePreset): { start: string; end: string } {
  const today = new Date();
  const todayValue = dateKey(today);
  if (preset === 'today') return { start: todayValue, end: todayValue };
  if (preset === 'last30') return { start: dateKey(shiftDate(today, -29)), end: todayValue };
  const weekStart = shiftDate(today, 1 - (today.getDay() || 7));
  return { start: dateKey(weekStart), end: dateKey(shiftDate(weekStart, 6)) };
}

function getPreviousRange(start: string, end: string): { start: string; end: string } {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const spanDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const prevEnd = shiftDate(startDate, -1);
  const prevStart = shiftDate(prevEnd, -(spanDays - 1));
  return { start: dateKey(prevStart), end: dateKey(prevEnd) };
}

function compareDelta(current: number, previous: number, formatter: (value: number) => string): string {
  const delta = current - previous;
  if (Math.abs(delta) < 0.1) return '与上一周期基本持平';
  return delta > 0 ? `较上一周期增加 ${formatter(delta)}` : `较上一周期减少 ${formatter(Math.abs(delta))}`;
}

function getCategoryStats(activities: Activity[]): CategoryStat[] {
  const totalMinutes = activities.reduce((sum, activity) => sum + activity.duration, 0);
  const minutesByCategory = new Map<ActivityCategory, number>();
  for (const activity of activities) {
    minutesByCategory.set(activity.category, (minutesByCategory.get(activity.category) || 0) + activity.duration);
  }
  return [...minutesByCategory.entries()]
    .map(([category, minutes]) => ({
      category,
      minutes,
      ratio: totalMinutes > 0 ? (minutes / totalMinutes) * 100 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

function getTopApps(activities: Activity[]): AppStat[] {
  const appMap = new Map<string, number>();
  for (const activity of activities) {
    appMap.set(activity.name, (appMap.get(activity.name) || 0) + activity.duration);
  }
  return [...appMap.entries()]
    .map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5);
}

function getMainlineCategory(stats: CategoryStat[]): CategoryStat | null {
  const preferred = stats.find((item) => ['开发', '工作', '学习'].includes(item.category));
  if (preferred) return preferred;
  return stats.find((item) => item.category !== '娱乐' && item.category !== '休息') || stats[0] || null;
}

function isLowValueCategory(category: ActivityCategory): boolean {
  return category === '娱乐' || category === '休息';
}

function buildHourlySeries(activities: Activity[]): number[] {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const activity of activities) {
    let cursor = new Date(activity.startTime).getTime();
    const end = new Date(activity.endTime).getTime();
    while (cursor < end) {
      const bucketDate = new Date(cursor);
      const bucketIndex = bucketDate.getHours();
      const nextBoundary = new Date(bucketDate);
      nextBoundary.setMinutes(60, 0, 0);
      const sliceEnd = Math.min(end, nextBoundary.getTime());
      const sliceMinutes = Math.max(0, (sliceEnd - cursor) / 60_000);
      buckets[bucketIndex] += sliceMinutes;
      cursor = sliceEnd;
    }
  }
  return buckets;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function truncateLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function Card({
  icon,
  title,
  meta,
  children,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  meta?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[30px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-5 shadow-[var(--shadow-card)] backdrop-blur-xl ${className}`}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-[18px] bg-[var(--color-bg-surface-3)] text-[var(--color-accent)]">
            {icon}
          </div>
          <div>
            <div className="text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</div>
            {meta ? <div className="text-xs text-[var(--color-text-muted)]">{meta}</div> : null}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function MiniStat({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-[28px] font-semibold leading-none tracking-[-0.03em] text-[var(--color-text-primary)]">{value}</div>
      <div className="mt-2 text-xs text-[var(--color-text-secondary)]">{helper}</div>
    </div>
  );
}

function DonutChart({ value, secondary, label }: { value: number; secondary: number; label: string }) {
  const primary = Math.max(0, Math.min(100, value));
  const secondaryClamped = Math.max(0, Math.min(100 - primary, secondary));
  const remainder = Math.max(0, 100 - primary - secondaryClamped);
  return (
    <div className="relative flex h-40 w-40 items-center justify-center">
      <div
        className="h-40 w-40 rounded-full"
        style={{
          background: `conic-gradient(var(--color-green) 0 ${primary}%, var(--color-blue) ${primary}% ${primary + secondaryClamped}%, rgba(120,160,134,0.15) ${primary + secondaryClamped}% ${primary + secondaryClamped + remainder}%)`,
        }}
      />
      <div className="absolute flex h-24 w-24 flex-col items-center justify-center rounded-full bg-[var(--color-bg-surface-1)] shadow-[var(--shadow-soft)]">
        <div className="text-[28px] font-semibold leading-none tracking-[-0.04em]">{Math.round(primary)}%</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      </div>
    </div>
  );
}

function CategoryBars({ stats }: { stats: CategoryStat[] }) {
  return (
    <div className="space-y-3">
      {stats.slice(0, 6).map((item) => (
        <div key={item.category} className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-[var(--color-text-primary)]">{item.category}</span>
            <span className="text-[var(--color-text-secondary)]">{formatMinutes(item.minutes)}</span>
          </div>
          <div className="h-2.5 rounded-full bg-[var(--color-bg-surface-3)]">
            <div
              className="h-2.5 rounded-full"
              style={{
                width: `${Math.max(6, Math.min(100, item.ratio))}%`,
                background: CATEGORY_COLORS[item.category],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function HourHeatmap({ series }: { series: number[] }) {
  const max = Math.max(...series, 1);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-12 gap-2">
        {series.map((minutes, hour) => {
          const ratio = minutes / max;
          const alpha = 0.12 + ratio * 0.88;
          return (
            <div key={hour} className="space-y-1">
              <div
                className="h-12 rounded-[16px] border border-[var(--color-border-light)]"
                style={{ background: `rgba(93, 169, 138, ${alpha})` }}
                title={`${formatHour(hour)} · ${formatMinutes(minutes)}`}
              />
              <div className="text-center text-[10px] text-[var(--color-text-muted)]">{String(hour).padStart(2, '0')}</div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>凌晨</span>
        <span>上午</span>
        <span>下午</span>
        <span>夜间</span>
      </div>
    </div>
  );
}

function ComparisonBars({
  current,
  previous,
  currentLabel,
  previousLabel,
}: {
  current: number;
  previous: number;
  currentLabel: string;
  previousLabel: string;
}) {
  const max = Math.max(current, previous, 1);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span>{currentLabel}</span>
          <span>{Math.round(current)}</span>
        </div>
        <div className="h-2.5 rounded-full bg-[var(--color-bg-surface-3)]">
          <div className="h-2.5 rounded-full bg-[var(--color-green)]" style={{ width: `${(current / max) * 100}%` }} />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span>{previousLabel}</span>
          <span>{Math.round(previous)}</span>
        </div>
        <div className="h-2.5 rounded-full bg-[var(--color-bg-surface-3)]">
          <div className="h-2.5 rounded-full bg-[var(--color-blue)]" style={{ width: `${(previous / max) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function Analytics() {
  const initialRange = getPresetRange('today');
  const [preset, setPreset] = useState<RangePreset>('today');
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [previousActivities, setPreviousActivities] = useState<Activity[]>([]);
  const [context, setContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [previousContext, setPreviousContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const { toast } = useToast();
  const settings = useAppStore((state) => state.settings);
  const hasLoadedOnceRef = useRef(false);

  const selectedRange = useMemo(
    () => (startDate <= endDate ? { start: startDate, end: endDate } : { start: endDate, end: startDate }),
    [endDate, startDate],
  );
  const previousRange = useMemo(() => getPreviousRange(selectedRange.start, selectedRange.end), [selectedRange.end, selectedRange.start]);
  const rangeLabel = selectedRange.start === selectedRange.end ? selectedRange.start : `${selectedRange.start} 至 ${selectedRange.end}`;

  const loadContexts = useCallback(async (useFreshContext = false) => {
    try {
      const nextContext = await dataService.getContextSources(
        selectedRange.start,
        selectedRange.end,
        false,
        settings.calendarInsightsEnabled,
        settings.remindersEnabled,
        { fresh: useFreshContext },
      );
      setContext(nextContext);
      void dataService.getContextSources(
        previousRange.start,
        previousRange.end,
        false,
        settings.calendarInsightsEnabled,
        settings.remindersEnabled,
        { fresh: useFreshContext },
      )
        .then((prevContext) => {
          setPreviousContext(prevContext);
        })
        .catch((error) => {
          console.error(error);
        });
    } catch (error) {
      console.error(error);
      if (!(error instanceof Error && error.message.includes('系统应用读取超时'))) {
        toast('读取分析上下文失败', 'error');
      }
    }
  }, [
    previousRange.end,
    previousRange.start,
    selectedRange.end,
    selectedRange.start,
    settings.calendarInsightsEnabled,
    settings.remindersEnabled,
    toast,
  ]);

  const load = useCallback(async (fresh = false) => {
    if (!fresh && !hasLoadedOnceRef.current) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const nextActivities = await dataService.getActivitiesRange(selectedRange.start, selectedRange.end, { fresh });
      setActivities((previous) => mergeActivitiesPreservingStable(previous, nextActivities.filter((item) => item.duration > 0)));
      setLoadError('');
      if (fresh) toast('分析数据已刷新');
      void loadContexts(fresh);
      void dataService.getActivitiesRange(previousRange.start, previousRange.end, { fresh })
        .then((prevActivities) => {
          setPreviousActivities((previous) => mergeActivitiesPreservingStable(previous, prevActivities.filter((item) => item.duration > 0)));
        })
        .catch((error) => {
          console.error(error);
        });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '未知错误';
      setLoadError(message);
      toast('读取分析数据失败', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnceRef.current = true;
    }
  }, [
    previousRange.end,
    previousRange.start,
    selectedRange.end,
    selectedRange.start,
    loadContexts,
    toast,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const range = preset === 'custom' ? { start: startDate, end: endDate } : getPresetRange(preset);
    setStartDate(range.start);
    setEndDate(range.end);
  }, [preset]);

  useEffect(() => {
    const ranges = new Map<string, [string, string]>();
    for (const [start, end] of [
      [selectedRange.start, selectedRange.end],
      [previousRange.start, previousRange.end],
      [dateKey(new Date()), dateKey(new Date())],
    ]) {
      ranges.set(`${start}:${end}`, [start, end]);
    }
    for (const [start, end] of ranges.values()) {
      dataService.prefetchActivitiesRange(start, end);
      dataService.prefetchContextSources(start, end, false, settings.calendarInsightsEnabled, settings.remindersEnabled);
    }
  }, [
    previousRange.end,
    previousRange.start,
    selectedRange.end,
    selectedRange.start,
    settings.calendarInsightsEnabled,
    settings.remindersEnabled,
  ]);

  const workblocks = useMemo(
    () => alignWorkblocksWithContext(aggregateWorkblocks(activities, settings.mergeGapMinutes, settings.categoryRulesDraft), context),
    [activities, context, settings.categoryRulesDraft, settings.mergeGapMinutes],
  );
  const previousWorkblocks = useMemo(
    () => alignWorkblocksWithContext(aggregateWorkblocks(previousActivities, settings.mergeGapMinutes, settings.categoryRulesDraft), previousContext),
    [previousActivities, previousContext, settings.categoryRulesDraft, settings.mergeGapMinutes],
  );
  const digest = useMemo(() => buildDailyDigest(workblocks, context), [context, workblocks]);
  const previousDigest = useMemo(() => buildDailyDigest(previousWorkblocks, previousContext), [previousContext, previousWorkblocks]);
  const categoryStats = useMemo(() => getCategoryStats(activities), [activities]);
  const topApps = useMemo(() => getTopApps(activities), [activities]);
  const hourlySeries = useMemo(() => buildHourlySeries(activities), [activities]);
  const missedCalendar = useMemo(() => findMissedCalendarEvents(workblocks, context, 3), [context, workblocks]);
  const visibleWarnings = useMemo(() => context.warnings.slice(0, 2), [context.warnings]);
  const keyWorkblocks = useMemo(
    () => [...workblocks].sort((a, b) => b.highlightScore - a.highlightScore || b.duration - a.duration).slice(0, 4),
    [workblocks],
  );
  const averageBlockMinutes = workblocks.length > 0 ? digest.totalMinutes / workblocks.length : 0;
  const plannedMinutes = digest.matchedReminderMinutes;
  const mainlineCategory = useMemo(() => getMainlineCategory(categoryStats), [categoryStats]);
  const headlineBlock = keyWorkblocks[0] || digest.longestBlock || null;
  const lowValueDominant = Boolean(categoryStats[0] && isLowValueCategory(categoryStats[0].category) && categoryStats[0].ratio >= 45);
  const trustworthyAlignment = !lowValueDominant && digest.focusedMinutes >= 30;
  const headlineSummary = useMemo(() => {
    if (headlineBlock) {
      return `今天最值得看的主线是「${headlineBlock.title}」，持续 ${formatMinutes(headlineBlock.duration)}。`;
    }
    if (mainlineCategory) {
      return `今天主要时间流向「${mainlineCategory.category}」，累计 ${formatMinutes(mainlineCategory.minutes)}。`;
    }
    return '今天还没有形成足够清晰的主线。';
  }, [headlineBlock, mainlineCategory]);
  const summaryTone = useMemo(() => {
    if (lowValueDominant) return '今天记录里低价值占用偏多，计划一致性数字只可作参考，建议优先回看主线块本身。';
    if (digest.focusRatio >= 55 && digest.plannedCoverage >= 40) return '今天主线比较清楚，系统识别到的推进也相对稳定。';
    if (digest.offtrackMinutes >= 90 || digest.fragmentationScore >= 10) return '今天的切换和偏移仍然比较多，建议优先回看关键工作块。';
    return '今天已经有可读轨迹，但还需要更强的任务归并和计划映射。';
  }, [digest.focusRatio, digest.fragmentationScore, digest.offtrackMinutes, digest.plannedCoverage, lowValueDominant]);
  const mainlineStats = useMemo<MainlineStat[]>(() => [
    {
      label: '今天主线',
      value: mainlineCategory?.category || '暂无',
      helper: mainlineCategory ? formatMinutes(mainlineCategory.minutes) : '还没有稳定主线',
    },
    {
      label: '当前最值回看',
      value: headlineBlock ? truncateLabel(headlineBlock.title, 12) : '暂无',
      helper: headlineBlock ? formatMinutes(headlineBlock.duration) : '没有明显重点块',
    },
    {
      label: '提醒事项覆盖',
      value: trustworthyAlignment ? `${formatPercent(digest.plannedCoverage)}` : '需复核',
      helper: trustworthyAlignment
        ? (plannedMinutes > 0 ? `${formatMinutes(plannedMinutes)} 已较稳定命中提醒事项` : '还没有稳定命中的提醒事项')
        : '当前存在低价值主导或专注不足，这个覆盖数字不宜直接解读成目标一致性',
    },
  ], [digest.plannedCoverage, headlineBlock, mainlineCategory, plannedMinutes, trustworthyAlignment]);
  if (loading) {
    return (
      <div className="min-h-screen px-8 py-8">
        <div className="mx-auto max-w-[1460px] animate-pulse space-y-6">
          <div className="h-48 rounded-[36px] bg-[var(--color-bg-surface-1)]" />
          <div className="grid gap-5 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 rounded-[28px] bg-[var(--color-bg-surface-1)]" />)}
          </div>
          <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="h-[320px] rounded-[30px] bg-[var(--color-bg-surface-1)]" />
            <div className="h-[320px] rounded-[30px] bg-[var(--color-bg-surface-1)]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-8 py-8">
      <div className="mx-auto flex max-w-[1460px] flex-col gap-6">
        <section className="rounded-[38px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-7 py-6 shadow-[var(--shadow-card)] backdrop-blur-xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center rounded-full bg-[var(--color-bg-surface-3)] px-4 py-2 text-sm font-medium text-[var(--color-accent)]">
                {rangeLabel}
              </div>
              <h1 className="mt-5 text-[56px] font-semibold leading-[0.95] tracking-[-0.05em] text-[var(--color-text-primary)]">
                分析总览
              </h1>
              <p className="mt-4 max-w-2xl text-[17px] leading-8 text-[var(--color-text-secondary)]">
                这个页面只保留高信号内容：投入时长、提醒事项覆盖、专注结构、时间节奏和关键工作块。目标是不用往下滚很久，也能快速看清今天或这段时间到底发生了什么。
              </p>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {mainlineStats.map((item) => (
                  <div key={item.label} className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                    <div className="text-xs text-[var(--color-text-muted)]">{item.label}</div>
                    <div className="mt-2 text-lg font-semibold text-[var(--color-text-primary)]">{item.value}</div>
                    <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{item.helper}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:min-w-[460px]">
              <div className="grid grid-cols-3 gap-2 rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-2">
                {[
                  { key: 'today', label: '今日' },
                  { key: 'thisWeek', label: '本周' },
                  { key: 'last30', label: '近 30 天' },
                ].map((item) => {
                  const active = preset === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setPreset(item.key as RangePreset)}
                      className={`rounded-[18px] px-4 py-3 text-sm font-semibold ${active ? 'bg-[var(--color-bg-surface-1)] text-[var(--color-text-primary)] shadow-[var(--shadow-soft)]' : 'text-[var(--color-text-secondary)]'}`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => {
                    setPreset('custom');
                    setStartDate(event.target.value);
                  }}
                  className="rounded-[18px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm text-[var(--color-text-primary)] outline-none"
                />
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => {
                    setPreset('custom');
                    setEndDate(event.target.value);
                  }}
                  className="rounded-[18px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm text-[var(--color-text-primary)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => void load(true)}
                  disabled={refreshing}
                  className="inline-flex items-center justify-center gap-2 rounded-[20px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-5 py-3 text-sm font-semibold text-[var(--color-text-primary)]"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                  轻刷新
                </button>
              </div>
            </div>
          </div>

          {loadError ? (
            <div className="mt-5 rounded-[22px] border border-[rgba(221,108,75,0.35)] bg-[rgba(243,141,114,0.12)] px-4 py-3 text-sm text-[var(--color-coral-hover)]">
              读取分析失败：{loadError}
            </div>
          ) : null}
          {visibleWarnings.length > 0 ? (
            <div className="mt-5 rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
              {visibleWarnings.join(' · ')}
            </div>
          ) : null}

          <div className="mt-5 rounded-[26px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(235,248,240,0.95),rgba(255,255,255,0.96))] px-5 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-green-hover)]">一眼结论</div>
            <div className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">{headlineSummary}</div>
            <div className="mt-2 text-sm leading-7 text-[var(--color-text-secondary)]">{summaryTone}</div>
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-4">
          <MiniStat
            label="记录时长"
            value={formatMinutes(digest.totalMinutes)}
            helper={compareDelta(digest.totalMinutes, previousDigest.totalMinutes, (value) => formatMinutes(value))}
          />
          <MiniStat
            label="高价值时长"
            value={formatMinutes(digest.focusedMinutes)}
            helper={`${formatPercent(digest.focusRatio)} 属于开发/工作/学习`}
          />
          <MiniStat
            label="提醒事项覆盖"
            value={formatPercent(digest.plannedCoverage)}
            helper={compareDelta(digest.plannedCoverage, previousDigest.plannedCoverage, (value) => `${Math.round(value)}%`)}
          />
          <MiniStat
            label="平均工作块"
            value={formatMinutes(averageBlockMinutes)}
            helper={`当前共 ${workblocks.length} 个工作块，碎片度 ${digest.fragmentationScore}`}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
          <Card icon={<Sparkles className="h-5 w-5" />} title="专注与计划结构" meta="首屏直接看结构，不看长段文字">
            <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
              <div className="flex items-center justify-center">
                <DonutChart value={digest.focusRatio} secondary={Math.max(0, digest.plannedCoverage - digest.focusRatio)} label="高价值占比" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
                  <div className="text-xs text-[var(--color-text-muted)]">提醒事项推进</div>
                  <div className="mt-2 text-[26px] font-semibold leading-none">{formatMinutes(plannedMinutes)}</div>
                  <div className="mt-2 text-sm text-[var(--color-text-secondary)]">{digest.matchedReminders.length} 个提醒事项有实际推进</div>
                </div>
                <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
                  <div className="text-xs text-[var(--color-text-muted)]">偏移时间</div>
                  <div className="mt-2 text-[26px] font-semibold leading-none">{formatMinutes(digest.offtrackMinutes)}</div>
                  <div className="mt-2 text-sm text-[var(--color-text-secondary)]">没有稳定归到计划项上的时间</div>
                </div>
                <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
                  <div className="text-xs text-[var(--color-text-muted)]">最长连续块</div>
                  <div className="mt-2 text-base font-semibold">{digest.longestBlock?.title || '暂无'}</div>
                  <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                    {digest.longestBlock ? formatMinutes(digest.longestBlock.duration) : '还没有形成明显长块'}
                  </div>
                </div>
                <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
                  <div className="text-xs text-[var(--color-text-muted)]">提醒落空</div>
                  <div className="mt-2 text-[26px] font-semibold leading-none">{digest.unmatchedReminders.length}</div>
                  <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                    {missedCalendar.length > 0 ? `${missedCalendar.length} 个日历事件疑似落空` : '没有明显落空的日历事件'}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card icon={<Layers3 className="h-5 w-5" />} title="类别分布" meta="看到时间主要流向哪几类事情">
            <CategoryBars stats={categoryStats} />
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <Card icon={<Clock3 className="h-5 w-5" />} title="24 小时时间热力" meta="把一天拆成小时，快速看节奏">
            <HourHeatmap series={hourlySeries} />
          </Card>

          <Card icon={<BarChart3 className="h-5 w-5" />} title="与上一周期对比" meta="不用翻历史，也能看到趋势">
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">高价值时长</div>
                <ComparisonBars
                  current={digest.focusedMinutes}
                  previous={previousDigest.focusedMinutes}
                  currentLabel="当前"
                  previousLabel="上一周期"
                />
              </div>
              <div>
                <div className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">提醒事项覆盖率</div>
                <ComparisonBars
                  current={digest.plannedCoverage}
                  previous={previousDigest.plannedCoverage}
                  currentLabel="当前"
                  previousLabel="上一周期"
                />
              </div>
            </div>
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
          <Card icon={<ActivitySquare className="h-5 w-5" />} title="关键工作块" meta="只保留最值得回看的块">
            <div className="space-y-3">
              {keyWorkblocks.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-5 text-sm text-[var(--color-text-muted)]">
                  当前范围内还没有形成明显工作块。
                </div>
              ) : (
                keyWorkblocks.map((block) => (
                  <div key={block.id} className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-[15px] font-semibold text-[var(--color-text-primary)]">{block.title}</div>
                        <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                          {block.category} · {formatMinutes(block.duration)} · {block.appNames.slice(0, 3).join(' / ')}
                        </div>
                      </div>
                      <div className="rounded-full bg-[var(--color-bg-surface-1)] px-3 py-1 text-xs text-[var(--color-text-secondary)]">
                        {block.highlightReason || '重点块'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card icon={<Target className="h-5 w-5" />} title="应用与计划命中" meta="左边看常用应用，右边看提醒推进">
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3">
                {topApps.map((app) => (
                  <div key={app.name} className="rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <span className="truncate text-sm font-medium">{app.name}</span>
                      <span className="text-sm text-[var(--color-text-secondary)]">{formatMinutes(app.minutes)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                {digest.matchedReminders.slice(0, 4).map((item) => (
                  <div key={item.item.title} className="rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                    <div className="text-sm font-medium">{item.item.title}</div>
                    <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                      {formatMinutes(item.minutes)} · {item.blocks.length} 个工作块
                    </div>
                  </div>
                ))}
                {digest.matchedReminders.length === 0 ? (
                  <div className="rounded-[22px] border border-dashed border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-5 text-sm text-[var(--color-text-muted)]">
                    当前范围还没有命中提醒事项。
                  </div>
                ) : null}
              </div>
            </div>
          </Card>
        </div>

        <Card icon={<CalendarRange className="h-5 w-5" />} title="待修正信号" meta="只显示真正需要你回头看的地方">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
              <div className="text-xs text-[var(--color-text-muted)]">低价值占用</div>
              <div className="mt-2 text-[26px] font-semibold leading-none">{formatMinutes(digest.lowValueBlocks.reduce((sum, block) => sum + block.duration, 0))}</div>
              <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                {digest.lowValueBlocks[0] ? `最大块：${digest.lowValueBlocks[0].title}` : '当前没有明显低价值大块'}
              </div>
            </div>
            <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
              <div className="text-xs text-[var(--color-text-muted)]">无计划高价值块</div>
              <div className="mt-2 text-[26px] font-semibold leading-none">{digest.unplannedBlocks.length}</div>
              <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                {digest.unplannedBlocks[0] ? `${digest.unplannedBlocks[0].title} 最值得先修正` : '当前没有明显无计划重点块'}
              </div>
            </div>
            <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
              <div className="text-xs text-[var(--color-text-muted)]">系统上下文警告</div>
              <div className="mt-2 text-[26px] font-semibold leading-none">{context.warnings.length}</div>
              <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                {context.warnings[0] || '当前没有系统警告'}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
