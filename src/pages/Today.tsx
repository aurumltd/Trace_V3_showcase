import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CalendarCheck2, CircleAlert, Clock3, ListChecks, PencilLine, Plus, Radio, RefreshCw, Save, Sparkles, Target, Trash2 } from 'lucide-react';
import dataService, { mergeActivitiesPreservingStable, type WeekContext } from '../services/dataService';
import type { TrackingOverview } from '../services/ipc/settingsIpc';
import { useToast } from '../components/ui/Toast';
import {
  alignWorkblocksWithContext,
  aggregateWorkblocks,
  buildDailyDigest,
  findMissedCalendarEvents,
  formatMinutes,
  formatPercent,
  hasExplicitCalendarLink,
  hasExplicitReminderLink,
} from '../utils/workblocks';
import { buildFallbackPlan, buildPlanCacheKey, buildPlanningPrompt, evaluatePlanExecution, parseAiPlan, type DailyPlanSuggestion, type PlanBlock } from '../utils/planning';
import { useAppStore } from '../store/useAppStore';

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isCalendarPermissionError(value?: string): boolean {
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
}

function isCalendarTransientError(value?: string): boolean {
  return Boolean(
    value
      && (
        value.includes('Calendar 响应超时')
        || value.includes('Calendar 没有响应')
        || value.includes('应用程序没有运行')
        || value.includes('(-600)')
      ),
  );
}

function toLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function normalizePlanBlocks(blocks: PlanBlock[]): PlanBlock[] {
  return [...blocks]
    .map((block) => {
      const startMs = new Date(block.startTime).getTime();
      const endMs = new Date(block.endTime).getTime();
      const safeEndMs = endMs > startMs ? endMs : startMs + Math.max(15, block.durationMinutes) * 60_000;
      return {
        ...block,
        startTime: toLocalDateTime(new Date(startMs)),
        endTime: toLocalDateTime(new Date(safeEndMs)),
        durationMinutes: Math.max(15, Math.round((safeEndMs - startMs) / 60_000)),
      };
    })
    .sort((left, right) => left.startTime.localeCompare(right.startTime));
}

function nextPlanSlot(today: string, blocks: PlanBlock[]): { startTime: string; endTime: string } {
  const now = new Date();
  now.setSeconds(0, 0);
  const [year, month, day] = today.split('-').map(Number);
  const base = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), 0, 0);
  if (base.getMinutes() > 0 && base.getMinutes() <= 30) {
    base.setMinutes(30, 0, 0);
  } else if (base.getMinutes() > 30) {
    base.setHours(base.getHours() + 1, 0, 0, 0);
  }
  const sorted = [...blocks].sort((a, b) => a.endTime.localeCompare(b.endTime));
  const last = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
  const start = last ? new Date(new Date(last.endTime).getTime() + 10 * 60_000) : base;
  const end = new Date(start.getTime() + 45 * 60_000);
  return {
    startTime: toLocalDateTime(start),
    endTime: toLocalDateTime(end),
  };
}

function subtractDays(dateKeyValue: string, days: number): string {
  const [year, month, day] = dateKeyValue.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - days);
  return dateKey(date);
}

const PLAN_CACHE_STORAGE_KEY = 'trace-daily-plan-cache';

function readPlanCache(): Record<string, DailyPlanSuggestion> {
  try {
    const raw = localStorage.getItem(PLAN_CACHE_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, DailyPlanSuggestion> : {};
  } catch {
    return {};
  }
}

function writePlanCache(value: Record<string, DailyPlanSuggestion>): void {
  localStorage.setItem(PLAN_CACHE_STORAGE_KEY, JSON.stringify(value));
}

function formatClockFromIso(value: string): string {
  return value.slice(11, 16);
}

function sameDayLocal(date: Date, today: string): boolean {
  return dateKey(date) === today;
}

export default function Today() {
  const today = dateKey(new Date());
  const settings = useAppStore((state) => state.settings);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activities, setActivities] = useState<Awaited<ReturnType<typeof dataService.getActivitiesRange>>>([]);
  const [context, setContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [contextError, setContextError] = useState('');
  const [overview, setOverview] = useState<TrackingOverview | null>(null);
  const [dailyPlan, setDailyPlan] = useState<DailyPlanSuggestion | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [editingPlanBlockKey, setEditingPlanBlockKey] = useState<string>('');
  const [planWriting, setPlanWriting] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const { toast } = useToast();

  const loadContext = useCallback(async (useFreshContext = false) => {
    try {
      const nextContext = await dataService.getContextSources(
        today,
        today,
        false,
        settings.calendarInsightsEnabled,
        settings.remindersEnabled,
        { fresh: useFreshContext },
      );
      setContext(nextContext);
      setContextError('');
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message.includes('系统应用读取超时')) {
        setContextError('');
        return;
      }
      setContextError(error instanceof Error ? error.message : '上下文读取失败');
    }
  }, [settings.calendarInsightsEnabled, settings.remindersEnabled, today]);

  const load = useCallback(async ({ silent = false, background = false }: { silent?: boolean; background?: boolean } = {}) => {
    if (!silent && !hasLoadedOnceRef.current) setLoading(true);
    setRefreshing(silent && !background);
    try {
      if (!background) setLoadError('');
      const nextActivities = await dataService.getActivitiesRange(today, today, { fresh: silent });
      setActivities((previous) => mergeActivitiesPreservingStable(previous, nextActivities));
      setLoadError('');
      void loadContext(silent);
      if (silent && !background) {
        void dataService.getTrackingOverview().then(setOverview).catch((error) => {
          console.error(error);
        });
        toast('页面数据已刷新', 'success');
      }
    } catch (error) {
      console.error(error);
      if (!background) {
        setLoadError(error instanceof Error ? error.message : '未知错误');
        toast('读取今日追溯失败', 'error');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnceRef.current = true;
    }
  }, [loadContext, toast, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      void load({ silent: true, background: true });
    }, settings.activityRefreshMinutes * 60_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [load, settings.activityRefreshMinutes]);

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

  const workblocks = useMemo(
    () => alignWorkblocksWithContext(aggregateWorkblocks(activities, settings.mergeGapMinutes, settings.categoryRulesDraft), context),
    [activities, context, settings.categoryRulesDraft, settings.mergeGapMinutes],
  );
  const digest = useMemo(() => buildDailyDigest(workblocks, context), [context, workblocks]);
  const topBlocks = useMemo(() => [...workblocks].sort((a, b) => b.duration - a.duration).slice(0, 6), [workblocks]);
  const missedCalendarEvents = useMemo(() => findMissedCalendarEvents(workblocks, context, 4), [context, workblocks]);
  const focusBlocks = useMemo(() => [...workblocks].sort((a, b) => b.focusScore - a.focusScore || b.duration - a.duration).slice(0, 3), [workblocks]);
  const planExecution = useMemo(() => evaluatePlanExecution(dailyPlan, workblocks, Date.now()), [dailyPlan, workblocks]);
  const dashboardStatus = useMemo(() => {
    if (digest.focusRatio >= 65 && digest.plannedCoverage >= 55) return '今天整体节奏比较稳';
    if (digest.offtrackMinutes >= 90 || digest.lowValueBlocks.length >= 2) return '今天有明显偏航，建议尽快纠偏';
    return '今天已经有主线，但还需要收束';
  }, [digest.focusRatio, digest.lowValueBlocks.length, digest.offtrackMinutes, digest.plannedCoverage]);
  const visibleWarnings = useMemo(() => context.warnings.slice(0, 3), [context.warnings]);
  const warningTone = useMemo(() => {
    if (visibleWarnings.some((item) => item.includes('读取系统日历失败') || item.includes('读取提醒事项失败'))) {
      return 'error';
    }
    if (visibleWarnings.length > 0) {
      return 'soft';
    }
    return 'none';
  }, [visibleWarnings]);

  const planOverview = useMemo(() => {
    if (!dailyPlan) return null;
    const now = new Date();
    const nowMs = now.getTime();
    const todayCalendarEvents = context.calendar_events.filter((item) => (item.startTimeMs ?? 0) > 0 && sameDayLocal(new Date(item.startTimeMs ?? 0), today));
    const nextBlock = dailyPlan.blocks.find((item) => new Date(item.endTime).getTime() >= nowMs);
    const pendingBlocks = dailyPlan.blocks.filter((item) => new Date(item.endTime).getTime() >= nowMs);
    const plannedMinutesRemaining = pendingBlocks.reduce((sum, item) => sum + item.durationMinutes, 0);
    const calendarOccupiedMinutes = todayCalendarEvents.reduce((sum, item) => {
      const start = item.startTimeMs ?? 0;
      const end = item.endTimeMs ?? start;
      if (end <= start) return sum;
      return sum + Math.round((end - start) / 60_000);
    }, 0);
    return {
      nextBlock,
      pendingCount: pendingBlocks.length,
      plannedMinutesRemaining,
      deferredCount: dailyPlan.deferredReminders.length,
      calendarOccupiedMinutes,
    };
  }, [context.calendar_events, dailyPlan, today]);

  const loadDailyPlan = useCallback(async (options?: { manual?: boolean; preserveProgress?: boolean }) => {
    const manual = options?.manual ?? false;
    const preserveProgress = options?.preserveProgress ?? false;
    if (!settings.remindersEnabled || context.reminders.length === 0) {
      setDailyPlan(null);
      setPlanError('');
      return;
    }

    const execution = preserveProgress ? evaluatePlanExecution(dailyPlan, workblocks, Date.now()) : null;
    const lockedBlocks = preserveProgress && dailyPlan && execution
      ? dailyPlan.blocks.filter((block, index) => {
          const blockExecution = execution.blocks[index];
          const endMs = new Date(block.endTime).getTime();
          return endMs <= Date.now() || Boolean(blockExecution && ['已完成', '推进中', '已开始'].includes(blockExecution.status));
        })
      : [];
    const lockedReminderTitles = new Set(lockedBlocks.map((item) => item.sourceReminder));
    const targetReminders = preserveProgress
      ? context.reminders.filter((item) => !lockedReminderTitles.has(item.title))
      : context.reminders;
    const cacheKey = buildPlanCacheKey(today, settings, targetReminders);
    const refreshMs = settings.aiSummaryRefreshHours * 60 * 60 * 1000;
    const cache = readPlanCache();
    const cached = cache[cacheKey];
    if (!manual && cached && Date.now() - cached.generatedAt < refreshMs) {
      const merged = preserveProgress
        ? {
            ...cached,
            blocks: normalizePlanBlocks([...lockedBlocks, ...cached.blocks]),
            deferredReminders: Array.from(new Set([...(dailyPlan?.deferredReminders ?? []), ...cached.deferredReminders])),
          }
        : cached;
      setDailyPlan(merged);
      setPlanError('');
      return;
    }

    setPlanLoading(true);
    setPlanError('');
    try {
      const historyStart = subtractDays(today, 21);
      const historyEnd = subtractDays(today, 1);
      const recentActivities = await dataService.getActivitiesRange(historyStart, historyEnd);
      const fallback = buildFallbackPlan(today, targetReminders, context.calendar_events, recentActivities, workblocks, Date.now());
      let nextPlan = fallback;

      if (settings.aiSummariesEnabled) {
        try {
          const prompt = buildPlanningPrompt(today, Date.now(), targetReminders, context.calendar_events, recentActivities, workblocks, fallback);
          const raw = await dataService.generateAiSummary(prompt, settings.aiSummaryModel);
          const aiPlan = parseAiPlan(raw, today, Date.now(), targetReminders, context.calendar_events);
          if (aiPlan) {
            nextPlan = aiPlan;
          }
        } catch (error) {
          console.error(error);
          if (manual) {
            toast('本地 AI 计划生成失败，已回退到轻量估时方案', 'error');
          }
        }
      }

      const mergedPlan = preserveProgress
        ? {
            ...nextPlan,
            headline: lockedBlocks.length > 0 ? `已保留 ${lockedBlocks.length} 个正在进行或已过去的计划块，并重排了剩余时间。` : nextPlan.headline,
            blocks: normalizePlanBlocks([...lockedBlocks, ...nextPlan.blocks]),
            deferredReminders: Array.from(new Set([...(dailyPlan?.deferredReminders ?? []), ...nextPlan.deferredReminders])),
            basis: [
              ...(lockedBlocks.length > 0 ? [`保留了 ${lockedBlocks.length} 个已开始 / 已过时间段的计划块`] : []),
              ...nextPlan.basis,
            ].slice(0, 5),
          }
        : nextPlan;

      setDailyPlan(mergedPlan);
      cache[cacheKey] = mergedPlan;
      writePlanCache(cache);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '轻计划生成失败';
      setPlanError(message);
      if (manual) {
        toast(`轻计划生成失败：${message}`, 'error');
      }
    } finally {
      setPlanLoading(false);
    }
  }, [context.calendar_events, context.reminders, dailyPlan, settings, toast, today, workblocks]);

  const persistPlan = useCallback((nextPlan: DailyPlanSuggestion) => {
    const cacheKey = buildPlanCacheKey(today, settings, context.reminders);
    const cache = readPlanCache();
    const normalized = { ...nextPlan, blocks: normalizePlanBlocks(nextPlan.blocks) };
    cache[cacheKey] = normalized;
    writePlanCache(cache);
    setDailyPlan(normalized);
  }, [context.reminders, settings, today]);

  const updatePlanBlock = useCallback((index: number, patch: Partial<PlanBlock>) => {
    if (!dailyPlan) return;
    const nextBlocks = dailyPlan.blocks.map((block, blockIndex) => (
      blockIndex === index ? { ...block, ...patch } : block
    ));
    persistPlan({ ...dailyPlan, blocks: nextBlocks, generatedAt: Date.now() });
  }, [dailyPlan, persistPlan]);

  const saveEditedPlan = useCallback(() => {
    if (!dailyPlan) return;
    persistPlan({ ...dailyPlan, generatedAt: Date.now() });
    setEditingPlanBlockKey('');
    toast('今日轻计划已保存到本地', 'success');
  }, [dailyPlan, persistPlan, toast]);

  const writePlanToCalendar = useCallback(async () => {
    if (!dailyPlan || dailyPlan.blocks.length === 0) return;
    setPlanWriting(true);
    try {
      const count = await dataService.writePlanBlocksToCalendar(today, dailyPlan.blocks);
      toast(count > 0 ? `已写入 ${count} 个今日计划事件` : '当前没有可写入的计划块', count > 0 ? 'success' : 'warning');
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '写入计划日历失败';
      toast(`写入计划日历失败：${message}`, 'error');
    } finally {
      setPlanWriting(false);
    }
  }, [dailyPlan, toast, today]);

  const removePlanBlock = useCallback((index: number) => {
    if (!dailyPlan) return;
    const removed = dailyPlan.blocks[index];
    const nextBlocks = dailyPlan.blocks.filter((_, blockIndex) => blockIndex !== index);
    const nextDeferred = removed ? [...dailyPlan.deferredReminders, removed.sourceReminder] : dailyPlan.deferredReminders;
    persistPlan({
      ...dailyPlan,
      blocks: nextBlocks,
      deferredReminders: Array.from(new Set(nextDeferred)),
      generatedAt: Date.now(),
    });
  }, [dailyPlan, persistPlan]);

  const addDeferredReminderToPlan = useCallback((title: string) => {
    if (!dailyPlan) return;
    const slot = nextPlanSlot(today, dailyPlan.blocks);
    persistPlan({
      ...dailyPlan,
      blocks: [
        ...dailyPlan.blocks,
        {
          title,
          startTime: slot.startTime,
          endTime: slot.endTime,
          durationMinutes: 45,
          sourceReminder: title,
          confidence: '低',
          rationale: '这是手动加入的提醒事项，默认先给 45 分钟，你可以再编辑时间和说明。',
        },
      ],
      deferredReminders: dailyPlan.deferredReminders.filter((item) => item !== title),
      generatedAt: Date.now(),
    });
  }, [dailyPlan, persistPlan, today]);

  useEffect(() => {
    if (loading || context.reminders.length === 0) return;
    void loadDailyPlan({ manual: false });
  }, [context.reminders.length, loadDailyPlan, loading]);

  return (
    <div className="min-h-screen p-8 lg:p-10">
      <header className="mb-8 rounded-[32px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-7 py-7 shadow-[var(--shadow-card)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex rounded-full bg-[var(--color-bg-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)] mb-4">
              {today}
            </div>
            <h1 className="text-[30px] leading-[1.05] font-semibold tracking-[-0.04em] mb-3">今日执行</h1>
            <p className="max-w-2xl text-sm leading-7 text-[var(--color-text-muted)]">
              这里看今天正在发生什么、当前主线是否偏移，以及接下来最值得推进的动作。复盘页只负责周期比较，不再重复今日执行细节。
            </p>
          </div>
          <button
            onClick={() => void load({ silent: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-soft)] disabled:opacity-60"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中...' : '轻刷新'}
          </button>
        </div>
        <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[28px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.92),rgba(255,255,255,0.96))] px-5 py-5 shadow-[var(--shadow-soft)]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-green-hover)]">Today Pulse</div>
                <div className="mt-2 text-[22px] font-semibold tracking-[-0.04em]">{dashboardStatus}</div>
                <div className="mt-2 max-w-2xl text-sm leading-7 text-[var(--color-text-secondary)]">
                  {digest.summary}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <InsightPill label="高价值" value={formatPercent(digest.focusRatio)} tone="green" />
                <InsightPill label="计划覆盖" value={formatPercent(digest.plannedCoverage)} tone="blue" />
                <InsightPill label="偏移" value={formatMinutes(digest.offtrackMinutes)} tone={digest.offtrackMinutes >= 90 ? 'coral' : 'neutral'} />
              </div>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <LiveStat
                icon={Radio}
                label="后台追溯"
                value={!overview?.isTracking ? '已暂停' : overview.activeIgnored ? '当前应用暂未记录' : '正在工作'}
                detail={
                  overview?.activeIgnored
                    ? '当前前台应用暂时没有进入追溯规则，切到其他应用后会继续捕获。'
                    : overview?.activeApp
                      ? `${overview.activeApp}${overview.activeTitle ? ` · ${overview.activeTitle}` : ''}`
                      : '等待第一条前台活动'
                }
              />
              <LiveStat
                icon={Clock3}
                label="最近捕获"
                value={formatRelativeTime(overview?.lastCaptureAtMs)}
                detail={overview?.currentBlockTitle || '还没有形成可展示的工作块'}
              />
              <LiveStat
                icon={CalendarCheck2}
                label="日历写入"
                value={formatCalendarState(overview)}
                detail={
                  overview?.calendarSyncEnabled
                    ? (
                        isCalendarPermissionError(overview.lastCalendarSyncError)
                          ? '需要在系统设置里允许 Trace 访问 Calendar 与自动化。'
                          : isCalendarTransientError(overview.lastCalendarSyncError)
                            ? 'Calendar 暂时没准备好，Trace 会在后台自动重试。'
                          : `最短写入 ${overview.minCalendarMinutes} 分钟`
                      )
                    : '当前未开启自动写入'
                }
                tone={overview?.lastCalendarSyncError ? 'warning' : 'default'}
              />
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <CompactProgressCard
                label="执行重心"
                value={formatPercent(digest.focusRatio)}
                detail={`${formatMinutes(digest.focusedMinutes)} 高价值推进`}
                percent={digest.focusRatio}
                tone="green"
              />
              <CompactProgressCard
                label="计划落地"
                value={formatPercent(digest.plannedCoverage)}
                detail={`${digest.matchedReminders.length} 项已推进`}
                percent={digest.plannedCoverage}
                tone="blue"
              />
              <CompactProgressCard
                label="主线偏移"
                value={formatMinutes(digest.offtrackMinutes)}
                detail={digest.offtrackMinutes >= 90 ? '已经值得尽快修正' : '目前还在可控范围'}
                percent={Math.min(100, (digest.offtrackMinutes / Math.max(digest.totalMinutes || 1, 120)) * 100)}
                tone={digest.offtrackMinutes >= 90 ? 'coral' : 'neutral'}
              />
            </div>
          </div>

          <div className="rounded-[28px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-5 py-5 shadow-[var(--shadow-soft)]">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">接下来优先处理</div>
              <div className="text-xs text-[var(--color-text-muted)]">只保留最值得动手的 3 件事</div>
            </div>
            <div className="mt-4 space-y-3">
              <ActionLine
                title={planOverview?.nextBlock ? `先进入「${planOverview.nextBlock.title}」` : '先收束当前主线'}
                detail={planOverview?.nextBlock
                  ? `${formatClockFromIso(planOverview.nextBlock.startTime)} 开始，当前剩余 ${formatMinutes(planOverview.plannedMinutesRemaining)} 计划时长。`
                  : digest.longestBlock?.title || '如果还没有计划块，优先从当前最长连续块抽出下一步动作。'}
              />
              <ActionLine
                title={digest.unmatchedReminders[0] ? `补推进提醒事项「${digest.unmatchedReminders[0].title}」` : '保持提醒事项已推进状态'}
                detail={digest.unmatchedReminders[0]
                  ? digest.unmatchedReminders[0].source
                  : '当前读取到的提醒事项都已看到推进痕迹。'}
              />
              <ActionLine
                title={digest.unplannedBlocks[0] ? `修正「${digest.unplannedBlocks[0].title}」的归因` : '暂时没有明显偏航块'}
                detail={digest.unplannedBlocks[0]
                  ? `${formatMinutes(digest.unplannedBlocks[0].duration)} 尚未稳定落在计划项上。`
                  : '如果后续出现主线外长段，再去时间线补标注。'}
                href={digest.unplannedBlocks[0] ? `/timeline?start=${today}&end=${today}&q=${encodeURIComponent(digest.unplannedBlocks[0].title)}&autocorrect=1` : undefined}
                cta={digest.unplannedBlocks[0] ? '去修正' : undefined}
              />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <CompactMetric label="最长连续块" value={digest.longestBlock ? formatMinutes(digest.longestBlock.duration) : '暂无'} detail={digest.longestBlock?.title || '还没有明显主块'} />
              <CompactMetric label="碎片化" value={`${digest.fragmentationScore}`} detail={digest.fragmentationScore >= 7 ? '切换较频繁' : '切换相对可控'} />
              <CompactMetric label="低价值占用" value={digest.lowValueBlocks.length === 0 ? '很低' : `${digest.lowValueBlocks.length} 块`} detail={digest.lowValueBlocks[0]?.title || '当前没有明显低价值长段'} />
            </div>
          </div>
        </div>
      </header>

      {loading ? (
        <EmptyState title="正在读取今日记录..." description="Trace 正在整理今天的活动块和计划对照。" />
      ) : loadError ? (
        <ErrorState
          title="今天的回放暂时没有加载成功"
          description={loadError}
          onRetry={() => void load({ silent: true })}
        />
      ) : workblocks.length === 0 ? (
        <EmptyState
          title="今天还没有有效记录"
          description={overview?.activeIgnored ? '当前前台应用在忽略列表中。切到其他应用后，Trace 才会开始产生记录。' : '先正常使用电脑一段时间，再回来查看 Today。'}
        />
      ) : (
        <div className="space-y-6">
          {refreshing ? (
            <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
              正在刷新活动记录。页面会先更新工作块，再补齐日历和提醒事项上下文。
            </div>
          ) : null}
          {contextError ? (
            <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm text-[var(--color-text-muted)]">
              系统日历或提醒事项读取较慢，当前先展示活动记录。
            </div>
          ) : null}
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Clock3} label="总记录时长" value={formatMinutes(digest.totalMinutes)} detail={`${workblocks.length} 个工作块`} />
            <MetricCard icon={Target} label="高价值推进" value={formatMinutes(digest.focusedMinutes)} detail={`${formatPercent(digest.focusRatio)} 占比`} />
            <MetricCard icon={ListChecks} label="已推进事项" value={`${digest.matchedReminders.length} 项`} detail={`${formatPercent(digest.plannedCoverage)} 覆盖率`} />
            <MetricCard icon={Activity} label="待修正偏移" value={formatMinutes(digest.offtrackMinutes)} detail={digest.unplannedBlocks[0]?.title || '当前没有明显主线外长段'} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
            <Card title="当前主线" icon={CalendarCheck2}>
              <p className="text-sm leading-7 text-[var(--color-text-secondary)]">{digest.summary}</p>
              <div className="mt-4 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4 text-sm leading-7">
                {digest.driftLabel}
              </div>
              <div className="mt-4 space-y-3">
                {digest.suggestions.map((suggestion) => (
                  <div key={suggestion} className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm leading-6">
                    {suggestion}
                  </div>
                ))}
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {focusBlocks.map((block) => (
                  <div key={block.id} className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                      专注块
                    </div>
                    <div className="mt-2 text-sm font-semibold leading-6">{block.title}</div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {formatMinutes(block.duration)} · {block.focusScore}% · {block.category}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="执行对照" icon={Target}>
              <div className="space-y-4">
                <SectionLabel title="已推进提醒事项" count={digest.matchedReminders.length} />
                <div className="space-y-2">
                  {digest.matchedReminders.length === 0 ? (
                    <MutedLine>今天还没有明显匹配到提醒事项。</MutedLine>
                  ) : (
                    digest.matchedReminders.slice(0, 4).map((item) => (
                      <ListLine
                        key={item.item.title}
                        title={item.item.title}
                        detail={`${formatMinutes(item.minutes)} · ${item.blocks.length} 个工作块`}
                      />
                    ))
                  )}
                </div>

                <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-xs leading-6 text-[var(--color-text-secondary)]">
                  计划覆盖率：{formatPercent(digest.plannedCoverage)} · 偏移时长：{formatMinutes(digest.offtrackMinutes)}
                </div>

                <SectionLabel title="尚未推进提醒事项" count={digest.unmatchedReminders.length} />
                <div className="space-y-2">
                  {digest.unmatchedReminders.length === 0 ? (
                    <MutedLine>今天读取到的提醒事项都已有对应推进。</MutedLine>
                  ) : (
                    digest.unmatchedReminders.slice(0, 4).map((item) => (
                      <ListLine key={item.title} title={item.title} detail={item.source} />
                    ))
                  )}
                </div>

                <SectionLabel title="未按计划发生的日历事件" count={missedCalendarEvents.length} />
                <div className="space-y-2">
                  {missedCalendarEvents.length === 0 ? (
                    <MutedLine>今天没有明显落空的计划事件。</MutedLine>
                  ) : (
                    missedCalendarEvents.map((item) => (
                      <ListLine key={`${item.title}-${item.startTimeMs || 0}`} title={item.title} detail={item.source} />
                    ))
                  )}
                </div>
                {visibleWarnings.length > 0 ? (
                  <div
                    className={`rounded-2xl px-4 py-3 text-xs leading-6 ${
                      warningTone === 'error'
                        ? 'border border-[var(--color-coral)] bg-[var(--color-coral-soft)] text-[var(--color-coral-hover)]'
                        : 'border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] text-[var(--color-text-muted)]'
                    }`}
                  >
                    {visibleWarnings.join('；')}
                  </div>
                ) : null}
              </div>
            </Card>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
            <Card title="下一步计划" icon={Sparkles}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm leading-7 text-[var(--color-text-secondary)]">
                    根据提醒事项、今天剩余空档和最近历史时长，给你一个不排满、可执行的今日建议计划。
                  </div>
                  <div className="mt-2 text-xs leading-6 text-[var(--color-text-muted)]">
                    仅做建议，不会自动写入日历。提醒事项越简单，AI 越会参考你的历史模式而不是字面意思。
                  </div>
                </div>
                <button
                  onClick={() => void loadDailyPlan({ manual: true })}
                  disabled={planLoading || context.reminders.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--color-green-hover)] disabled:opacity-60"
                >
                  <Sparkles size={14} className={planLoading ? 'animate-pulse' : ''} />
                  {planLoading ? '生成中...' : dailyPlan ? '重新排一下' : '生成今日计划'}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void loadDailyPlan({ manual: true, preserveProgress: true })}
                  disabled={planLoading || !dailyPlan || dailyPlan.blocks.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-light)] bg-[rgba(237,246,255,0.9)] px-4 py-2 text-xs font-semibold text-[var(--color-blue-hover)] disabled:opacity-60"
                >
                  <RefreshCw size={14} className={planLoading ? 'animate-spin' : ''} />
                  从现在重排剩余部分
                </button>
                <button
                  onClick={saveEditedPlan}
                  disabled={!dailyPlan || dailyPlan.blocks.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-light)] bg-white/70 px-4 py-2 text-xs font-semibold text-[var(--color-text-secondary)] disabled:opacity-60"
                >
                  <Save size={14} />
                  保存本地改动
                </button>
                <button
                  onClick={() => void writePlanToCalendar()}
                  disabled={planWriting || !dailyPlan || dailyPlan.blocks.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-light)] bg-[var(--color-blue-soft)] px-4 py-2 text-xs font-semibold text-[var(--color-blue-hover)] disabled:opacity-60"
                >
                  <CalendarCheck2 size={14} />
                  {planWriting ? '写入中...' : '写入今日计划日历'}
                </button>
              </div>

              {context.reminders.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4 text-sm leading-7 text-[var(--color-text-muted)]">
                  当前没有读取到未完成提醒事项，所以还没法帮你排今天的计划。
                </div>
              ) : planError ? (
                <div className="mt-4 rounded-2xl border border-[var(--color-coral)] bg-[var(--color-coral-soft)] px-4 py-4 text-sm leading-7 text-[var(--color-coral-hover)]">
                  {planError}
                </div>
              ) : dailyPlan ? (
                <div className="mt-4 space-y-3">
                  {planExecution ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      <CompactMetric
                        label="执行覆盖"
                        value={formatPercent(planExecution.completionRate)}
                        detail={`${formatMinutes(planExecution.totalActualMinutes)} / ${formatMinutes(planExecution.totalPlannedMinutes)}`}
                      />
                      <CompactMetric
                        label="已启动"
                        value={`${planExecution.startedCount}/${planExecution.blocks.length}`}
                        detail={planExecution.completedCount > 0 ? `${planExecution.completedCount} 个已基本完成` : '还没有完整完成块'}
                      />
                      <CompactMetric
                        label="偏移块"
                        value={`${planExecution.driftCount}`}
                        detail={planExecution.driftCount > 0 ? '建议先修正或重排这些块' : '当前没有明显过期块'}
                      />
                    </div>
                  ) : null}
                  {planOverview ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      <CompactMetric
                        label="下一块"
                        value={planOverview.nextBlock ? formatClockFromIso(planOverview.nextBlock.startTime) : '已排完'}
                        detail={planOverview.nextBlock?.title || '当前没有待执行计划块'}
                      />
                      <CompactMetric
                        label="剩余计划"
                        value={formatMinutes(planOverview.plannedMinutesRemaining)}
                        detail={`${planOverview.pendingCount} 个块待执行`}
                      />
                      <CompactMetric
                        label="今日占位"
                        value={formatMinutes(planOverview.calendarOccupiedMinutes)}
                        detail={planOverview.deferredCount > 0 ? `${planOverview.deferredCount} 个事项建议后移` : '当前没有建议后移事项'}
                      />
                    </div>
                  ) : null}
                  <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4 text-sm leading-7 text-[var(--color-text-secondary)]">
                    {dailyPlan.headline}
                  </div>
                  {dailyPlan.blocks.length === 0 ? (
                    <MutedLine>今天剩余空档不多，或者提醒事项信息还不足，建议只保留 1 到 2 个重点事项。</MutedLine>
                  ) : (
                    dailyPlan.blocks.map((block, index) => {
                      const blockKey = `${block.startTime}-${block.title}-${index}`;
                      const editing = editingPlanBlockKey === blockKey;
                      const execution = planExecution?.blocks[index];
                      return (
                      <div key={blockKey} className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            {editing ? (
                              <div className="grid gap-2 md:grid-cols-[1.2fr_0.9fr_0.9fr]">
                                <input
                                  value={block.title}
                                  onChange={(event) => updatePlanBlock(index, { title: event.target.value })}
                                  className="rounded-xl border border-[var(--color-border-light)] bg-white px-3 py-2 text-sm"
                                />
                                <input
                                  type="time"
                                  value={block.startTime.slice(11, 16)}
                                  onChange={(event) => {
                                    const next = `${today}T${event.target.value}:00`;
                                    const end = new Date(new Date(next).getTime() + block.durationMinutes * 60_000);
                                    updatePlanBlock(index, { startTime: next, endTime: toLocalDateTime(end) });
                                  }}
                                  className="rounded-xl border border-[var(--color-border-light)] bg-white px-3 py-2 text-sm"
                                />
                                <input
                                  type="time"
                                  value={block.endTime.slice(11, 16)}
                                  onChange={(event) => {
                                    const next = `${today}T${event.target.value}:00`;
                                    const durationMinutes = Math.max(15, Math.round((new Date(next).getTime() - new Date(block.startTime).getTime()) / 60_000));
                                    updatePlanBlock(index, { endTime: next, durationMinutes });
                                  }}
                                  className="rounded-xl border border-[var(--color-border-light)] bg-white px-3 py-2 text-sm"
                                />
                              </div>
                            ) : (
                              <>
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="font-semibold leading-6">{block.title}</div>
                                  {execution ? (
                                    <StatusBadge status={execution.status} />
                                  ) : null}
                                </div>
                                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                                  {timeRange(block.startTime, block.endTime)} · {block.durationMinutes} 分钟 · 置信度 {block.confidence}
                                  {block.energy ? ` · ${block.energy}` : ''}
                                </div>
                                {block.priorityReason ? (
                                  <div className="mt-2 text-xs leading-6 text-[var(--color-blue-hover)]">
                                    排序依据：{block.priorityReason}
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2">
                            <div className="rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]">
                              {block.sourceReminder}
                            </div>
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                onClick={() => setEditingPlanBlockKey(editing ? '' : blockKey)}
                                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-surface-1)] px-3 py-1 text-xs font-semibold text-[var(--color-text-secondary)]"
                              >
                                <PencilLine size={12} />
                                {editing ? '收起编辑' : '编辑'}
                              </button>
                              <button
                                onClick={() => removePlanBlock(index)}
                                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-coral-soft)] px-3 py-1 text-xs font-semibold text-[var(--color-coral-hover)]"
                              >
                                <Trash2 size={12} />
                                移出
                              </button>
                            </div>
                          </div>
                        </div>
                        {editing ? (
                          <textarea
                            value={block.rationale}
                            onChange={(event) => updatePlanBlock(index, { rationale: event.target.value })}
                            className="mt-3 min-h-[96px] w-full rounded-2xl border border-[var(--color-border-light)] bg-white px-3 py-3 text-sm leading-6"
                          />
                        ) : (
                          <div className="mt-3 space-y-3">
                            <div className="text-sm leading-6 text-[var(--color-text-secondary)]">{block.rationale}</div>
                            {block.nextAction || block.prepHint ? (
                              <div className="grid gap-2 md:grid-cols-2">
                                {block.nextAction ? (
                                  <MicroHint title="下一步" detail={block.nextAction} />
                                ) : null}
                                {block.prepHint ? (
                                  <MicroHint title="准备项" detail={block.prepHint} />
                                ) : null}
                              </div>
                            ) : null}
                            {execution ? (
                              <div className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-4 py-3">
                                <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
                                  <span>执行进度</span>
                                  <span>{Math.round(Math.min(100, execution.progressRatio * 100))}%</span>
                                </div>
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[rgba(34,197,94,0.12)]">
                                  <div
                                    className="h-full rounded-full bg-[linear-gradient(90deg,#6fcf97,#3d9b6d)]"
                                    style={{ width: `${Math.max(8, Math.min(100, execution.progressRatio * 100))}%` }}
                                  />
                                </div>
                                <div className="mt-2 text-xs leading-6 text-[var(--color-text-secondary)]">{execution.statusReason}</div>
                                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                                  实际命中 {formatMinutes(execution.actualMinutes)}
                                  {execution.matchedTitle ? ` · 主要对应“${execution.matchedTitle}”` : ''}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                      );
                    })
                  )}
                  {dailyPlan.deferredReminders.length > 0 ? (
                    <div className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-4 py-4 text-sm leading-7 text-[var(--color-text-secondary)]">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">建议留到后面</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {dailyPlan.deferredReminders.map((item) => (
                          <button
                            key={item}
                            onClick={() => addDeferredReminderToPlan(item)}
                            className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)]"
                          >
                            <Plus size={12} />
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4 text-sm leading-7 text-[var(--color-text-muted)]">
                  你可以先让 Trace 读取今天的提醒事项，再按今天剩余时间生成一版轻计划。
                </div>
              )}
            </Card>

            <Card title="计划依据" icon={ListChecks}>
              <div className="space-y-3">
                {planExecution ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <RiskLine
                      title="计划执行状态"
                      value={`${planExecution.completedCount} 完成 / ${planExecution.startedCount} 启动`}
                      tone={planExecution.driftCount > 0 ? 'neutral' : 'green'}
                      detail={planExecution.driftCount > 0 ? `${planExecution.driftCount} 个块已经过期且无明显执行` : '当前执行和计划基本对得上。'}
                    />
                    <RiskLine
                      title="计划来源"
                      value={dailyPlan?.method === 'ai' ? '本地 AI' : '轻量估时'}
                      tone={dailyPlan?.method === 'ai' ? 'green' : 'neutral'}
                      detail={dailyPlan?.method === 'ai' ? `使用 ${settings.aiSummaryModel} 做了轻量排程` : '信息不足时，会回退到保守规则估时。'}
                    />
                  </div>
                ) : null}
                {dailyPlan?.basis?.length ? (
                  dailyPlan.basis.map((item) => (
                    <div key={item} className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                      {item}
                    </div>
                  ))
                ) : (
                  <MutedLine>生成轻计划后，这里会说明它参考了哪些提醒事项、历史记录和空档。</MutedLine>
                )}
                <RiskLine
                  title="今日提醒事项"
                  value={`${context.reminders.length} 项`}
                  tone={context.reminders.length > 0 ? 'green' : 'neutral'}
                  detail={context.reminders[0]?.title || '当前未读取到提醒事项。'}
                />
                <RiskLine
                  title="今日已有日程"
                  value={`${context.calendar_events.length} 个`}
                  tone={context.calendar_events.length > 0 ? 'neutral' : 'green'}
                  detail={context.calendar_events[0]?.title || '今天没有明显的日历占位。'}
                />
                <RiskLine
                  title="计划生成方式"
                  value={dailyPlan?.method === 'ai' ? '本地 AI' : dailyPlan ? '轻量估时' : '未生成'}
                  tone={dailyPlan?.method === 'ai' ? 'green' : 'neutral'}
                  detail={dailyPlan?.method === 'ai' ? `使用 ${settings.aiSummaryModel} 生成` : '信息不足时，会回退到保守规则估时。'}
                />
              </div>
            </Card>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
            <Card title="今日关键工作块" icon={Activity}>
              <div className="space-y-3">
                {topBlocks.map((block) => (
                  <div
                    key={block.id}
                    className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-semibold leading-6">{block.title}</div>
                        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                          {timeRange(block.startTime, block.endTime)} · {block.category} · {block.activityType}
                        </div>
                      </div>
                      <div className="text-sm font-semibold whitespace-nowrap text-[var(--color-green-hover)]">{formatMinutes(block.duration)}</div>
                    </div>
                    {block.matchedReminder ? (
                      <div className="mt-3 text-xs text-[var(--color-blue-hover)]">
                        {hasExplicitReminderLink(block) ? '已确认提醒事项' : '对应提醒事项'}：{block.matchedReminder.title}
                      </div>
                    ) : null}
                    {block.matchedCalendarEvent ? (
                      <div className="mt-1 text-xs text-[var(--color-purple)]">
                        {hasExplicitCalendarLink(block) ? '已确认日历事件' : '对应日历事件'}：{block.matchedCalendarEvent.title}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <Link
                to="/timeline"
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-green-hover)]"
              >
                查看完整时间线
              </Link>
            </Card>

            <Card title="优先修正的偏移" icon={ListChecks}>
              <div className="space-y-3">
                {digest.unplannedBlocks.length === 0 ? (
                  <MutedLine>今天主要时间基本都能对应到计划项。</MutedLine>
                ) : (
                  digest.unplannedBlocks.map((block) => (
                    <div key={block.id} className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium leading-6">{block.title}</div>
                          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                            {formatMinutes(block.duration)} · {block.category}
                          </div>
                        </div>
                        <Link
                          to={`/timeline?start=${today}&end=${today}&q=${encodeURIComponent(block.title)}&autocorrect=1`}
                          className="shrink-0 rounded-full bg-[var(--color-bg-surface-1)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]"
                        >
                          去修正
                        </Link>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <Card title="风险提醒" icon={CircleAlert}>
              <div className="space-y-3">
                <RiskLine
                  title="偏移时长"
                  value={formatMinutes(digest.offtrackMinutes)}
                  tone={digest.offtrackMinutes >= 90 ? 'coral' : 'neutral'}
                  detail={digest.offtrackMinutes >= 90 ? '今天有一段比较明显的主线外消耗。' : '当前偏移还在可控范围。'}
                />
                <RiskLine
                  title="落空日历事件"
                  value={`${missedCalendarEvents.length} 个`}
                  tone={missedCalendarEvents.length > 0 ? 'coral' : 'green'}
                  detail={missedCalendarEvents[0]?.title || '今天没有明显落空的计划事件。'}
                />
                <RiskLine
                  title="未推进提醒事项"
                  value={`${digest.unmatchedReminders.length} 项`}
                  tone={digest.unmatchedReminders.length >= 3 ? 'coral' : 'neutral'}
                  detail={digest.unmatchedReminders[0]?.title || '当前读取到的提醒事项基本都有推进。'}
                />
              </div>
            </Card>

            <Card title="低价值占用" icon={Activity}>
              <div className="space-y-3">
                {digest.lowValueBlocks.length === 0 ? (
                  <MutedLine>今天没有明显的低价值长时段占用。</MutedLine>
                ) : (
                  digest.lowValueBlocks.map((block) => (
                    <div key={block.id} className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium leading-6">{block.title}</div>
                          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                            {formatMinutes(block.duration)} · {block.category} · 专注 {block.focusScore}%
                          </div>
                        </div>
                        <Link
                          to={`/timeline?start=${today}&end=${today}&q=${encodeURIComponent(block.title)}`}
                          className="shrink-0 rounded-full bg-[var(--color-bg-surface-1)] px-3 py-1 text-xs font-semibold text-[var(--color-coral-hover)]"
                        >
                          去查看
                        </Link>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </section>
        </div>
      )}
    </div>
  );
}

function LiveStat({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        <Icon size={14} />
        {label}
      </div>
      <div className={`mt-3 text-[15px] font-semibold ${tone === 'warning' ? 'text-[var(--color-coral-hover)]' : 'text-[var(--color-text-primary)]'}`}>
        {value}
      </div>
      <div className="mt-1 text-xs leading-6 text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function InsightPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'green' | 'blue' | 'coral' | 'neutral';
}) {
  const toneClass = {
    green: 'bg-[rgba(231,247,237,0.95)] text-[var(--color-green-hover)]',
    blue: 'bg-[var(--color-blue-soft)] text-[var(--color-blue-hover)]',
    coral: 'bg-[var(--color-coral-soft)] text-[var(--color-coral-hover)]',
    neutral: 'bg-white/75 text-[var(--color-text-secondary)]',
  }[tone];

  return (
    <div className={`rounded-full px-3 py-2 text-xs font-semibold ${toneClass}`}>
      {label} · {value}
    </div>
  );
}

function CompactMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-[18px] border border-[var(--color-border-light)] bg-white/70 px-3 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1.5 text-[18px] font-semibold tracking-[-0.03em]">{value}</div>
      <div className="mt-1 text-xs leading-6 text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function CompactProgressCard({
  label,
  value,
  detail,
  percent,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  percent: number;
  tone: 'green' | 'blue' | 'coral' | 'neutral';
}) {
  const barClass = {
    green: 'bg-[linear-gradient(90deg,#6fcf97,#3d9b6d)]',
    blue: 'bg-[linear-gradient(90deg,#9bc9ff,#5f9ef5)]',
    coral: 'bg-[linear-gradient(90deg,#f1b097,#e58068)]',
    neutral: 'bg-[linear-gradient(90deg,#ced7d1,#9aa8a0)]',
  }[tone];

  return (
    <div className="rounded-[18px] border border-[var(--color-border-light)] bg-white/72 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{label}</div>
        <div className="text-sm font-semibold">{value}</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/80">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${Math.max(8, Math.min(100, percent))}%` }} />
      </div>
      <div className="mt-2 text-xs leading-6 text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function ActionLine({
  title,
  detail,
  href,
  cta,
}: {
  title: string;
  detail: string;
  href?: string;
  cta?: string;
}) {
  return (
    <div className="rounded-[20px] border border-[var(--color-border-light)] bg-white/70 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-6">{title}</div>
          <div className="mt-1 text-xs leading-6 text-[var(--color-text-muted)]">{detail}</div>
        </div>
        {href && cta ? (
          <Link to={href} className="shrink-0 rounded-full bg-[var(--color-bg-surface-1)] px-3 py-1.5 text-xs font-semibold text-[var(--color-green-hover)]">
            {cta}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: '已完成' | '推进中' | '已开始' | '待开始' | '明显偏移' }) {
  const toneClass = {
    已完成: 'bg-[rgba(231,247,237,0.95)] text-[var(--color-green-hover)]',
    推进中: 'bg-[var(--color-blue-soft)] text-[var(--color-blue-hover)]',
    已开始: 'bg-[rgba(255,244,214,0.95)] text-[rgba(153,104,0,0.95)]',
    待开始: 'bg-white/80 text-[var(--color-text-secondary)]',
    明显偏移: 'bg-[var(--color-coral-soft)] text-[var(--color-coral-hover)]',
  }[status];

  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${toneClass}`}>
      {status}
    </span>
  );
}

function MicroHint({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{title}</div>
      <div className="mt-1 text-xs leading-6 text-[var(--color-text-secondary)]">{detail}</div>
    </div>
  );
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '还没有记录';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 10) return '刚刚';
  if (deltaSeconds < 60) return `${deltaSeconds} 秒前`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  return `${Math.round(deltaMinutes / 60)} 小时前`;
}

function formatCalendarState(overview: TrackingOverview | null): string {
  if (!overview?.calendarSyncEnabled) return '未启用';
  if (isCalendarPermissionError(overview.lastCalendarSyncError)) return '需要授权';
  if (isCalendarTransientError(overview.lastCalendarSyncError)) return '稍后重试';
  if (overview.lastCalendarSyncError) return '同步失败';
  if (overview.calendarSyncRunning) return '正在写入';
  if (overview.calendarPending) {
    const pendingMinutes = Math.max(0, overview.minCalendarMinutes - overview.currentBlockMinutes);
    return pendingMinutes > 0.05 ? `还差 ${pendingMinutes.toFixed(1)} 分钟` : '待同步';
  }
  if (overview.lastCalendarWriteCount > 0) return `已写入 ${overview.lastCalendarWriteCount} 条`;
  return '等待首条事件';
}

function ErrorState({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-[30px] border border-[var(--color-coral)] bg-[var(--color-coral-soft)] p-6 shadow-[var(--shadow-soft)]">
      <div className="text-lg font-semibold text-[var(--color-coral-hover)]">{title}</div>
      <div className="mt-2 text-sm leading-7 text-[var(--color-coral-hover)]">{description}</div>
      <button
        onClick={onRetry}
        className="mt-4 rounded-2xl border border-[var(--color-coral)] bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--color-coral-hover)]"
      >
        重新加载
      </button>
    </div>
  );
}

function timeRange(startTime: string, endTime: string): string {
  const start = startTime.slice(11, 16);
  const end = endTime.slice(11, 16);
  return `${start} - ${end}`;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-4 py-4 shadow-[var(--shadow-soft)] backdrop-blur-xl">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-text-secondary)]">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-bg-surface-2)] text-[var(--color-green-hover)]">
          <Icon size={15} />
        </span>
        {label}
      </div>
      <div className="mt-2.5 text-[18px] leading-none font-semibold tracking-[-0.03em]">{value}</div>
      <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Clock3;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[30px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-6 shadow-[var(--shadow-card)] backdrop-blur-xl">
      <div className="mb-5 flex items-center gap-3 text-sm font-semibold">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-bg-surface-2)] text-[var(--color-green-hover)]">
          <Icon size={17} />
        </span>
        {title}
      </div>
      {children}
    </section>
  );
}

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between text-xs font-semibold text-[var(--color-text-muted)]">
      <span>{title}</span>
      <span>{count}</span>
    </div>
  );
}

function ListLine({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
      <div className="text-sm font-medium leading-6">{title}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function MutedLine({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-[var(--color-border-light)] bg-[rgba(255,255,255,0.3)] px-4 py-3 text-sm text-[var(--color-text-muted)]">{children}</div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[32px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-8 shadow-[var(--shadow-card)]">
      <div className="text-lg font-bold">{title}</div>
      <div className="mt-2 text-sm text-[var(--color-text-muted)]">{description}</div>
    </div>
  );
}

function RiskLine({
  title,
  value,
  detail,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  tone: 'green' | 'coral' | 'neutral';
}) {
  const toneClass = {
    green: 'text-[var(--color-green-hover)] bg-[rgba(231,247,237,0.95)]',
    coral: 'text-[var(--color-coral-hover)] bg-[var(--color-coral-soft)]',
    neutral: 'text-[var(--color-text-secondary)] bg-[var(--color-bg-surface-2)]',
  }[tone];

  return (
    <div className={`rounded-2xl border border-[var(--color-border-light)] px-4 py-3 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-sm font-semibold">{value}</div>
      </div>
      <div className="mt-1 text-xs leading-6">{detail}</div>
    </div>
  );
}
