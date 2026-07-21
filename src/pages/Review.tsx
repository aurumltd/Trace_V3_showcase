import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrainCircuit, CalendarRange, Clock3, ListChecks, RefreshCw, Target, TrendingUp } from 'lucide-react';
import dataService, { mergeActivitiesPreservingStable, type Activity, type WeekContext } from '../services/dataService';
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

type RangePreset = 'today' | 'thisWeek' | 'lastWeek' | 'last30' | 'custom';

interface ReviewCacheEntry {
  summary: string;
  generatedAt: number;
}

interface AiSummarySections {
  did: string[];
  drift: string[];
  next: string[];
}

const REVIEW_CACHE_KEY = 'trace-v2-review-ai-cache';

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
  if (preset === 'thisWeek') {
    return { start: dateKey(weekStart), end: dateKey(shiftDate(weekStart, 6)) };
  }
  const lastWeekStart = shiftDate(weekStart, -7);
  return { start: dateKey(lastWeekStart), end: dateKey(shiftDate(lastWeekStart, 6)) };
}

function readReviewCache(): Record<string, ReviewCacheEntry> {
  try {
    const raw = window.localStorage.getItem(REVIEW_CACHE_KEY);
    return raw ? JSON.parse(raw) as Record<string, ReviewCacheEntry> : {};
  } catch {
    return {};
  }
}

function writeReviewCache(cache: Record<string, ReviewCacheEntry>): void {
  window.localStorage.setItem(REVIEW_CACHE_KEY, JSON.stringify(cache));
}

function buildPrompt(
  rangeLabel: string,
  digest: ReturnType<typeof buildDailyDigest>,
  context: WeekContext,
): string {
  const matched = digest.matchedReminders.slice(0, 4).map((item) => `${item.item.title}：${formatMinutes(item.minutes)}`).join('；');
  const unmatched = digest.unmatchedReminders.slice(0, 4).map((item) => item.title).join('；');
  const topBlocks = digest.unplannedBlocks.slice(0, 3).map((item) => `${item.title}：${formatMinutes(item.duration)}`).join('；');
  return [
    '请只用中文输出，并严格分成三个部分：',
    '做了什么：',
    '偏了什么：',
    '下一步：',
    '每个部分 2 到 4 条短句，不要写前言，不要写总结。',
    `范围：${rangeLabel}`,
    `总记录时长：${formatMinutes(digest.totalMinutes)}`,
    `高价值时长：${formatMinutes(digest.focusedMinutes)}`,
    `高价值占比：${formatPercent(digest.focusRatio)}`,
    `最长连续块：${digest.longestBlock ? `${digest.longestBlock.title} / ${formatMinutes(digest.longestBlock.duration)}` : '暂无'}`,
    `碎片化分数：${digest.fragmentationScore}`,
    `已推进提醒事项：${matched || '暂无'}`,
    `未推进提醒事项：${unmatched || '暂无'}`,
    `无计划但耗时较多：${topBlocks || '暂无'}`,
    `系统警告：${context.warnings.join('；') || '无'}`,
  ].join('\n');
}

function getPreviousRange(start: string, end: string): { start: string; end: string } {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const spanDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const prevEnd = shiftDate(startDate, -1);
  const prevStart = shiftDate(prevEnd, -(spanDays - 1));
  return { start: dateKey(prevStart), end: dateKey(prevEnd) };
}

function compareDelta(current: number, previous: number, suffix = ''): string {
  const delta = current - previous;
  if (Math.abs(delta) < 0.01) return `与上一周期基本持平${suffix}`;
  if (delta > 0) return `较上一周期增加 ${suffix ? `${Math.round(delta)}${suffix}` : `${Math.round(delta)}`}`;
  return `较上一周期减少 ${suffix ? `${Math.round(Math.abs(delta))}${suffix}` : `${Math.round(Math.abs(delta))}`}`;
}

function parseAiSummarySections(summary: string): AiSummarySections | null {
  const text = summary.trim();
  if (!text) return null;
  const sections: AiSummarySections = { did: [], drift: [], next: [] };
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  let current: keyof AiSummarySections | null = null;

  for (const line of lines) {
    if (line.startsWith('做了什么')) {
      current = 'did';
      continue;
    }
    if (line.startsWith('偏了什么')) {
      current = 'drift';
      continue;
    }
    if (line.startsWith('下一步')) {
      current = 'next';
      continue;
    }
    if (!current) continue;
    sections[current].push(line.replace(/^[-•\d.\s]+/, '').trim());
  }

  if (sections.did.length === 0 && sections.drift.length === 0 && sections.next.length === 0) {
    return null;
  }
  return sections;
}

type CategoryStat = {
  category: string;
  minutes: number;
  ratio: number;
};

const REVIEW_CATEGORY_COLORS: Record<string, string> = {
  开发: 'var(--color-green)',
  工作: 'var(--color-blue)',
  学习: '#8ab4a0',
  会议: '#d8b36c',
  沟通: '#e08a6a',
  浏览网页: '#a5b8ad',
  整理文件: '#c2d2c9',
  提醒事项: '#78be9c',
  休息: '#d8c6a3',
  娱乐: '#e4b3c7',
  其他: '#c7d2cc',
};

function buildCategoryStats(activities: Activity[]): CategoryStat[] {
  const total = activities.reduce((sum, activity) => sum + activity.duration, 0);
  const map = new Map<string, number>();
  for (const activity of activities) {
    map.set(activity.category, (map.get(activity.category) || 0) + activity.duration);
  }
  return [...map.entries()]
    .map(([category, minutes]) => ({
      category,
      minutes,
      ratio: total > 0 ? (minutes / total) * 100 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

function buildHourlySeries(activities: Activity[]): number[] {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const activity of activities) {
    let cursor = new Date(activity.startTime).getTime();
    const end = new Date(activity.endTime).getTime();
    while (cursor < end) {
      const current = new Date(cursor);
      const hour = current.getHours();
      const nextBoundary = new Date(current);
      nextBoundary.setMinutes(60, 0, 0);
      const sliceEnd = Math.min(end, nextBoundary.getTime());
      buckets[hour] += Math.max(0, (sliceEnd - cursor) / 60_000);
      cursor = sliceEnd;
    }
  }
  return buckets;
}

function buildDailySeries(activities: Activity[], start: string, end: string): Array<{ label: string; minutes: number }> {
  const map = new Map<string, number>();
  for (const activity of activities) {
    const key = activity.startTime.slice(0, 10);
    map.set(key, (map.get(key) || 0) + activity.duration);
  }

  const output: Array<{ label: string; minutes: number }> = [];
  let cursor = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  while (cursor <= endDate) {
    const key = dateKey(cursor);
    output.push({ label: key.slice(5), minutes: Math.round((map.get(key) || 0) * 10) / 10 });
    cursor = shiftDate(cursor, 1);
  }
  return output;
}

export default function Review() {
  const initialRange = getPresetRange('thisWeek');
  const [preset, setPreset] = useState<RangePreset>('thisWeek');
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [previousActivities, setPreviousActivities] = useState<Activity[]>([]);
  const [context, setContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [previousContext, setPreviousContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState('');
  const [aiError, setAiError] = useState('');
  const aiIdleTimerRef = useRef<number | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const { toast } = useToast();
  const settings = useAppStore((state) => state.settings);

  const selectedRange = useMemo(
    () => (startDate <= endDate ? { start: startDate, end: endDate } : { start: endDate, end: startDate }),
    [endDate, startDate],
  );
  const rangeLabel = selectedRange.start === selectedRange.end ? selectedRange.start : `${selectedRange.start} 至 ${selectedRange.end}`;
  const aiCacheKey = `${selectedRange.start}:${selectedRange.end}:${settings.aiSummaryModel}`;
  const previousRange = useMemo(() => getPreviousRange(selectedRange.start, selectedRange.end), [selectedRange.end, selectedRange.start]);

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
      if (!(error instanceof Error && error.message.includes('超时'))) {
        toast('读取复盘上下文失败', 'error');
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

  const load = useCallback(async ({ silent = false, background = false }: { silent?: boolean; background?: boolean } = {}) => {
    if (!silent && !hasLoadedOnceRef.current) {
      setLoading(true);
    } else if (!background) {
      setRefreshing(true);
    }
    try {
      if (!background) setLoadError('');
      const nextActivities = await dataService.getActivitiesRange(selectedRange.start, selectedRange.end, { fresh: silent });
      setActivities((previous) => mergeActivitiesPreservingStable(previous, nextActivities.filter((item) => item.duration > 0)));
      setLoadError('');
      void loadContexts(silent);
      void dataService.getActivitiesRange(previousRange.start, previousRange.end, { fresh: silent })
        .then((prevActivities) => {
          setPreviousActivities((previous) => mergeActivitiesPreservingStable(previous, prevActivities.filter((item) => item.duration > 0)));
        })
        .catch((error) => {
          console.error(error);
        });
    } catch (error) {
      console.error(error);
      if (!background) {
        setLoadError(error instanceof Error ? error.message : '未知错误');
        toast('读取复盘数据失败', 'error');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnceRef.current = true;
    }
  }, [loadContexts, previousRange.end, previousRange.start, selectedRange.end, selectedRange.start, toast]);

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
  const digest = useMemo(() => buildDailyDigest(workblocks, context), [context, workblocks]);
  const missedCalendarEvents = useMemo(() => findMissedCalendarEvents(workblocks, context, 6), [context, workblocks]);
  const previousWorkblocks = useMemo(
    () => alignWorkblocksWithContext(aggregateWorkblocks(previousActivities, settings.mergeGapMinutes, settings.categoryRulesDraft), previousContext),
    [previousActivities, previousContext, settings.categoryRulesDraft, settings.mergeGapMinutes],
  );
  const visibleWarnings = useMemo(() => context.warnings.slice(0, 2), [context.warnings]);
  const previousDigest = useMemo(() => buildDailyDigest(previousWorkblocks, previousContext), [previousContext, previousWorkblocks]);
  const categoryStats = useMemo(() => buildCategoryStats(activities), [activities]);
  const hourlySeries = useMemo(() => buildHourlySeries(activities), [activities]);
  const dailySeries = useMemo(() => buildDailySeries(activities, selectedRange.start, selectedRange.end), [activities, selectedRange.end, selectedRange.start]);
  const structuredSummary = useMemo(() => {
    const did = [
      `记录了 ${formatMinutes(digest.totalMinutes)}，其中 ${formatMinutes(digest.focusedMinutes)} 属于高价值推进。`,
      digest.longestBlock
        ? `最长连续块是「${digest.longestBlock.title}」，持续 ${formatMinutes(digest.longestBlock.duration)}。`
        : '当前范围内没有特别明显的连续投入块。',
    ];
    const drift = [
      `计划覆盖率约 ${formatPercent(digest.plannedCoverage)}，约 ${formatMinutes(digest.offtrackMinutes)} 没有稳定落在计划项上。`,
      digest.unmatchedReminders.length > 0
        ? `还有 ${digest.unmatchedReminders.length} 个提醒事项没有看到推进痕迹。`
        : '当前读取到的提醒事项都已有推进痕迹。',
      missedCalendarEvents.length > 0
        ? `有 ${missedCalendarEvents.length} 个日历事件看起来落空了。`
        : '当前范围没有明显落空的日历事件。',
    ];
    const next = [
      digest.unplannedBlocks[0]
        ? `先修正「${digest.unplannedBlocks[0].title}」这类高价值但未稳定归因的块。`
        : '优先保持当前已形成的计划推进节奏。',
      digest.lowValueBlocks[0]
        ? `下一步重点压缩「${digest.lowValueBlocks[0].title}」这类低价值占用。`
        : '低价值占用不明显，重点继续保护连续高价值时段。',
    ];
    return { did, drift, next };
  }, [digest, missedCalendarEvents.length]);
  const driftReasons = useMemo(() => {
    const reasons: string[] = [];
    if (digest.offtrackMinutes >= 60) {
      reasons.push(`有 ${formatMinutes(digest.offtrackMinutes)} 没有稳定落在计划项上，偏移量已经比较明显。`);
    }
    if (digest.fragmentationScore >= 10) {
      reasons.push(`碎片化分数达到 ${digest.fragmentationScore}，说明频繁切换正在侵蚀连续推进。`);
    }
    if (digest.unmatchedReminders.length >= 2) {
      reasons.push(`仍有 ${digest.unmatchedReminders.length} 个提醒事项没有看到推进痕迹，计划落地不够充分。`);
    }
    if (missedCalendarEvents.length > 0) {
      reasons.push(`有 ${missedCalendarEvents.length} 个日历事件落空，说明计划安排和实际执行之间存在断层。`);
    }
    if (digest.lowValueBlocks[0]?.duration && digest.lowValueBlocks[0].duration >= 20) {
      reasons.push(`低价值占用里最长的一段达到 ${formatMinutes(digest.lowValueBlocks[0].duration)}，已经值得重点限制。`);
    }
    return reasons.slice(0, 4);
  }, [digest.fragmentationScore, digest.lowValueBlocks, digest.offtrackMinutes, digest.unmatchedReminders.length, missedCalendarEvents.length]);
  const aiStructuredSummary = useMemo(() => parseAiSummarySections(aiSummary), [aiSummary]);

  const loadAiSummary = useCallback(async (manual = false) => {
    if (!settings.aiSummariesEnabled || digest.totalMinutes <= 0) return;
    const refreshMs = settings.aiSummaryRefreshHours * 60 * 60 * 1000;
    const cache = readReviewCache();
    const cached = cache[aiCacheKey];
    if (!manual && cached && Date.now() - cached.generatedAt < refreshMs) {
      setAiSummary(cached.summary);
      setAiError('');
      return;
    }

    setAiLoading(true);
    setAiError('');
    try {
      const prompt = buildPrompt(rangeLabel, digest, context);
      const summary = await dataService.generateAiSummary(prompt, settings.aiSummaryModel);
      setAiSummary(summary);
      cache[aiCacheKey] = { summary, generatedAt: Date.now() };
      writeReviewCache(cache);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setAiError(message);
      if (manual) {
        toast(`AI 总结生成失败：${message}`, 'error');
      }
    } finally {
      setAiLoading(false);
    }
  }, [aiCacheKey, context, digest, rangeLabel, settings.aiSummariesEnabled, settings.aiSummaryModel, settings.aiSummaryRefreshHours, toast]);

  useEffect(() => {
    setAiSummary('');
    setAiError('');
    if (aiIdleTimerRef.current !== null) {
      window.clearTimeout(aiIdleTimerRef.current);
      aiIdleTimerRef.current = null;
    }
    const refreshMs = settings.aiSummaryRefreshHours * 60 * 60 * 1000;
    const cache = readReviewCache();
    const cached = cache[aiCacheKey];
    if (cached && Date.now() - cached.generatedAt < refreshMs) {
      setAiSummary(cached.summary);
      return;
    }
    if (!settings.aiSummariesEnabled || loading || digest.totalMinutes <= 30) {
      return;
    }
    aiIdleTimerRef.current = window.setTimeout(() => {
      void loadAiSummary(false);
    }, 6000);
    return () => {
      if (aiIdleTimerRef.current !== null) {
        window.clearTimeout(aiIdleTimerRef.current);
        aiIdleTimerRef.current = null;
      }
    };
  }, [aiCacheKey, digest.totalMinutes, loadAiSummary, loading, settings.aiSummariesEnabled]);

  function applyPreset(nextPreset: RangePreset) {
    const next = getPresetRange(nextPreset);
    setPreset(nextPreset);
    setStartDate(next.start);
    setEndDate(next.end);
  }

  return (
    <div className="min-h-screen p-8 lg:p-10">
      <header className="mb-8 rounded-[32px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-7 py-7 shadow-[var(--shadow-card)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-4 inline-flex rounded-full bg-[var(--color-bg-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]">
              {rangeLabel}
            </div>
            <h1 className="mb-3 text-[34px] leading-[1.05] font-semibold tracking-[-0.04em]">周期复盘</h1>
            <p className="max-w-2xl text-sm leading-7 text-[var(--color-text-muted)]">
              这里不看实时运行状态，只看这段时间相对上一周期的变化、结构分布和偏差热点。目标是一眼判断节奏有没有变好，而不是重放今天。
            </p>
          </div>
          <button
            onClick={() => void load({ silent: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-soft)] disabled:opacity-60"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            轻刷新
          </button>
        </div>
      </header>

      <section className="mb-6 rounded-[30px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] p-1">
            {(['today', 'thisWeek', 'lastWeek', 'last30'] as const).map((option) => (
              <button
                key={option}
                onClick={() => applyPreset(option)}
                className={`rounded-[14px] px-3 py-2 text-xs font-semibold transition ${
                  preset === option
                    ? 'bg-white text-[var(--color-green-hover)] shadow-[var(--shadow-soft)]'
                    : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {{
                  today: '今日',
                  thisWeek: '本周',
                  lastWeek: '上周',
                  last30: '近 30 天',
                  custom: '自定义',
                }[option]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2">
            <input type="date" value={startDate} onChange={(event) => { setPreset('custom'); setStartDate(event.target.value); }} className="bg-transparent text-xs outline-none" />
            <span className="text-xs text-[var(--color-text-muted)]">至</span>
            <input type="date" value={endDate} onChange={(event) => { setPreset('custom'); setEndDate(event.target.value); }} className="bg-transparent text-xs outline-none" />
          </div>
          <div className="rounded-full bg-[var(--color-bg-surface-2)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            AI 模型：{settings.aiSummaryModel} · 刷新间隔：{settings.aiSummaryRefreshHours} 小时
          </div>
        </div>
      </section>

      {loading ? (
        <Panel title="复盘" icon={TrendingUp}>
          <div className="text-sm text-[var(--color-text-muted)]">正在整理复盘数据...</div>
        </Panel>
      ) : loadError ? (
        <ErrorPanel
          title="复盘数据暂时没有加载成功"
          description={loadError}
          onRetry={() => void load({ silent: true })}
        />
      ) : digest.totalMinutes <= 0 ? (
        <Panel title="复盘" icon={TrendingUp}>
          <div className="text-sm text-[var(--color-text-muted)]">当前范围没有足够的追溯记录。</div>
        </Panel>
      ) : (
        <div className="space-y-4">
          {visibleWarnings.length > 0 ? (
            <SoftNote tone="neutral">{visibleWarnings.join(' · ')}</SoftNote>
          ) : null}

          <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Panel title="周期对比" icon={TrendingUp}>
              <div className="mb-4 grid gap-3 md:grid-cols-4">
                <Metric icon={Clock3} label="总记录时长" value={formatMinutes(digest.totalMinutes)} detail={compareDelta(digest.totalMinutes, previousDigest.totalMinutes, ' 分钟')} />
                <Metric icon={Target} label="高价值占比" value={formatPercent(digest.focusRatio)} detail={compareDelta(digest.focusRatio, previousDigest.focusRatio, '%')} />
                <Metric icon={ListChecks} label="计划覆盖" value={formatPercent(digest.plannedCoverage)} detail={`${digest.matchedReminders.length} 项已推进`} />
                <Metric icon={CalendarRange} label="碎片化" value={`${digest.fragmentationScore}`} detail={compareDelta(digest.fragmentationScore, previousDigest.fragmentationScore)} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <CompactCompareChart
                  label="总时长"
                  current={digest.totalMinutes}
                  previous={previousDigest.totalMinutes}
                  currentLabel="当前"
                  previousLabel="上一周期"
                  formatter={formatMinutes}
                />
                <CompactCompareChart
                  label="计划覆盖"
                  current={digest.plannedCoverage}
                  previous={previousDigest.plannedCoverage}
                  currentLabel="当前"
                  previousLabel="上一周期"
                  formatter={(value) => formatPercent(value)}
                />
                <CompactCompareChart
                  label="高价值占比"
                  current={digest.focusRatio}
                  previous={previousDigest.focusRatio}
                  currentLabel="当前"
                  previousLabel="上一周期"
                  formatter={(value) => formatPercent(value)}
                />
                <CompactCompareChart
                  label="偏移时长"
                  current={digest.offtrackMinutes}
                  previous={previousDigest.offtrackMinutes}
                  currentLabel="当前"
                  previousLabel="上一周期"
                  formatter={formatMinutes}
                />
              </div>
            </Panel>

            <Panel title="解释与结论" icon={Target}>
              <div className="grid gap-3">
                <SoftNote tone="green">{structuredSummary.did[0]}</SoftNote>
                <SoftNote tone="blue">{structuredSummary.drift[0]}</SoftNote>
                <SoftNote tone="neutral">{structuredSummary.next[0]}</SoftNote>
                {driftReasons.slice(0, 2).map((reason) => (
                  <div key={reason} className="rounded-[20px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                    {reason}
                  </div>
                ))}
              </div>
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
            <Panel title="结构分布" icon={ListChecks}>
              <StackedCategoryBars stats={categoryStats} />
            </Panel>

            <Panel title="时间节奏" icon={CalendarRange}>
              <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                <MiniBarTrend series={dailySeries} />
                <HourHeatStrip series={hourlySeries} />
              </div>
            </Panel>
          </section>

          <Panel title="纠偏队列" icon={Target}>
            <div className="grid gap-4 xl:grid-cols-2">
              <QueueColumn
                title="优先修正的无计划工作块"
                empty="当前范围内没有明显的高耗时无计划块。"
                items={digest.unplannedBlocks.slice(0, 4).map((block) => ({
                  key: block.id,
                  title: block.title,
                  detail: `${formatMinutes(block.duration)} · ${block.category}${block.reviewReason ? ` · ${block.reviewReason}` : ''}`,
                  href: `/timeline?start=${selectedRange.start}&end=${selectedRange.end}&q=${encodeURIComponent(block.title)}&autocorrect=1`,
                  cta: '去修正',
                }))}
              />
              <QueueColumn
                title="尚未推进的提醒事项"
                empty="当前范围读取到的提醒事项都已有推进痕迹。"
                items={digest.unmatchedReminders.slice(0, 4).map((item) => ({
                  key: item.title,
                  title: item.title,
                  detail: item.source,
                }))}
              />
            </div>
          </Panel>

          <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <Panel title="偏差热点" icon={CalendarRange}>
              <div className="grid gap-3">
                <InlineBadge label="未推进提醒事项" value={`${digest.unmatchedReminders.length}`} />
                <InlineBadge label="落空日历事件" value={`${missedCalendarEvents.length}`} />
                <InlineBadge label="低价值长段" value={`${digest.lowValueBlocks.length}`} />
              </div>
              <div className="mt-4 space-y-3">
                {missedCalendarEvents.length === 0 ? (
                  <EmptyBlock>当前范围没有明显落空的计划事件。</EmptyBlock>
                ) : (
                  missedCalendarEvents.slice(0, 3).map((item) => (
                    <div key={`${item.title}-${item.startTimeMs || 0}`} className="rounded-[18px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm">
                      <div className="font-semibold">{item.title}</div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{item.source}</div>
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel title="本地 AI 总结" icon={BrainCircuit}>
              <div className="mb-4 flex items-center justify-between gap-4">
                <div className="text-xs leading-6 text-[var(--color-text-muted)]">
                  使用 {settings.aiSummaryModel}，按 {settings.aiSummaryRefreshHours} 小时缓存，优先后台低频生成。
                </div>
                <button
                  onClick={() => void loadAiSummary(true)}
                  disabled={aiLoading || !settings.aiSummariesEnabled}
                  className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] disabled:opacity-60"
                >
                  <RefreshCw size={14} className={aiLoading ? 'animate-spin' : ''} />
                  {aiLoading ? '生成中' : '更新 AI 总结'}
                </button>
              </div>

              {!settings.aiSummariesEnabled ? (
                <div className="text-sm text-[var(--color-text-muted)]">你已在设置中关闭本地 AI 总结。</div>
              ) : aiStructuredSummary ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <StructuredColumn title="做了什么" tone="green" items={aiStructuredSummary.did} />
                  <StructuredColumn title="偏了什么" tone="blue" items={aiStructuredSummary.drift} />
                  <StructuredColumn title="下一步" tone="neutral" items={aiStructuredSummary.next} />
                </div>
              ) : aiSummary ? (
                <div className="rounded-[22px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(241,249,244,0.96))] px-5 py-4 text-sm leading-7 shadow-[var(--shadow-soft)]">
                  {aiSummary}
                </div>
              ) : aiError ? (
                <div className="rounded-[22px] border border-[var(--color-coral)] bg-[var(--color-coral-soft)] px-4 py-3 text-sm text-[var(--color-coral-hover)]">
                  AI 总结暂时不可用：{aiError}
                </div>
              ) : (
                <div className="text-sm text-[var(--color-text-muted)]">
                  {aiLoading ? '正在后台生成本地 AI 总结...' : '进入页面后不会立刻触发重模型推理，系统会更晚地在后台补齐。'}
                </div>
              )}
            </Panel>
          </section>
        </div>
      )}
    </div>
  );
}

function ErrorPanel({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <Panel title="复盘" icon={TrendingUp}>
      <div className="rounded-[24px] border border-[var(--color-coral)] bg-[var(--color-coral-soft)] px-4 py-4">
        <div className="text-sm font-semibold text-[var(--color-coral-hover)]">{title}</div>
        <div className="mt-2 text-sm leading-7 text-[var(--color-coral-hover)]">{description}</div>
        <button
          onClick={onRetry}
          className="mt-4 rounded-2xl border border-[var(--color-coral)] bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--color-coral-hover)]"
        >
          重新加载
        </button>
      </div>
    </Panel>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-[20px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3.5 py-3.5">
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-[var(--color-text-secondary)]">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-bg-surface-2)] text-[var(--color-green-hover)]">
          <Icon size={15} />
        </span>
        {label}
      </div>
      <div className="mt-2 text-[17px] leading-none font-semibold tracking-[-0.03em]">{value}</div>
      {detail ? <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">{detail}</div> : null}
    </div>
  );
}

function CompactCompareChart({
  label,
  current,
  previous,
  currentLabel,
  previousLabel,
  formatter,
}: {
  label: string;
  current: number;
  previous: number;
  currentLabel: string;
  previousLabel: string;
  formatter: (value: number) => string;
}) {
  const max = Math.max(current, previous, 1);
  return (
    <div className="rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
      <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">{label}</div>
      {[
        { key: currentLabel, value: current, color: 'var(--color-green)' },
        { key: previousLabel, value: previous, color: 'var(--color-blue)' },
      ].map((item) => (
        <div key={item.key} className="mb-3 last:mb-0">
          <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
            <span>{item.key}</span>
            <span>{formatter(item.value)}</span>
          </div>
          <div className="h-2.5 rounded-full bg-white/80">
            <div className="h-2.5 rounded-full" style={{ width: `${(item.value / max) * 100}%`, background: item.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StackedCategoryBars({ stats }: { stats: CategoryStat[] }) {
  return (
    <div className="space-y-3">
      {stats.slice(0, 6).map((item) => (
        <div key={item.category}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{item.category}</span>
            <span className="text-xs text-[var(--color-text-muted)]">{formatMinutes(item.minutes)}</span>
          </div>
          <div className="h-3 rounded-full bg-[var(--color-bg-surface-2)]">
            <div
              className="h-3 rounded-full"
              style={{
                width: `${Math.max(6, Math.min(100, item.ratio))}%`,
                background: REVIEW_CATEGORY_COLORS[item.category] || 'var(--color-green)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniBarTrend({ series }: { series: Array<{ label: string; minutes: number }> }) {
  const max = Math.max(...series.map((item) => item.minutes), 1);
  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">按天</div>
      <div className="flex items-end gap-2">
        {series.slice(-10).map((item) => (
          <div key={item.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex h-28 w-full items-end rounded-[16px] bg-[var(--color-bg-surface-2)] px-1.5 py-1.5">
              <div
                className="w-full rounded-[12px] bg-[var(--color-green)]"
                style={{ height: `${Math.max(10, (item.minutes / max) * 100)}%` }}
                title={`${item.label} · ${formatMinutes(item.minutes)}`}
              />
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HourHeatStrip({ series }: { series: number[] }) {
  const max = Math.max(...series, 1);
  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">按小时</div>
      <div className="grid grid-cols-12 gap-2">
        {series.map((minutes, index) => {
          const alpha = 0.12 + (minutes / max) * 0.88;
          return (
            <div key={index} className="space-y-1">
              <div className="h-12 rounded-[14px]" style={{ background: `rgba(93, 169, 138, ${alpha})` }} />
              <div className="text-center text-[10px] text-[var(--color-text-muted)]">{String(index).padStart(2, '0')}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QueueColumn({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; detail: string; href?: string; cta?: string }>;
}) {
  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">{title}</div>
      <div className="space-y-3">
        {items.length === 0 ? (
          <EmptyBlock>{empty}</EmptyBlock>
        ) : (
          items.map((item) => (
            <div key={item.key} className="rounded-[20px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold leading-6">{item.title}</div>
                  <div className="mt-1 text-xs text-[var(--color-text-muted)]">{item.detail}</div>
                </div>
                {item.href && item.cta ? (
                  <Link to={item.href} className="shrink-0 rounded-full bg-white/85 px-3 py-2 text-xs font-semibold text-[var(--color-green-hover)] shadow-[var(--shadow-soft)]">
                    {item.cta}
                  </Link>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function InlineBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-[16px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
      <span className="text-sm text-[var(--color-text-secondary)]">{label}</span>
      <span className="text-lg font-semibold text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Clock3;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-5 shadow-[var(--shadow-card)] backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-3 text-sm font-semibold">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-[var(--color-bg-surface-2)] text-[var(--color-green-hover)]">
          <Icon size={17} />
        </span>
        {title}
      </div>
      {children}
    </section>
  );
}

function SoftNote({ children, tone }: { children: ReactNode; tone: 'green' | 'blue' | 'neutral' }) {
  const toneClass = {
    green: 'bg-[rgba(231,247,237,0.9)] text-[var(--color-green-hover)]',
    blue: 'bg-[var(--color-blue-soft)] text-[var(--color-blue-hover)]',
    neutral: 'bg-[var(--color-bg-surface-2)] text-[var(--color-text-secondary)]',
  }[tone];

  return (
    <div className={`rounded-[24px] px-4 py-4 text-sm leading-7 ${toneClass}`}>
      {children}
    </div>
  );
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[24px] border border-dashed border-[var(--color-border-light)] px-4 py-4 text-sm text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function StructuredColumn({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'green' | 'blue' | 'neutral';
  items: string[];
}) {
  const toneClass = {
    green: 'bg-[rgba(231,247,237,0.9)] text-[var(--color-green-hover)]',
    blue: 'bg-[var(--color-blue-soft)] text-[var(--color-blue-hover)]',
    neutral: 'bg-[var(--color-bg-surface-2)] text-[var(--color-text-secondary)]',
  }[tone];

  return (
    <div className={`rounded-[24px] px-4 py-4 ${toneClass}`}>
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em]">{title}</div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item} className="text-sm leading-7">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
