import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3, Filter, PencilLine, RefreshCw, Save, Search, X } from 'lucide-react';
import dataService, { mergeActivitiesPreservingStable, type Activity, type ActivityCategory, type ActivityCorrectionInput, type WeekContext } from '../services/dataService';
import { useToast } from '../components/ui/Toast';
import {
  alignWorkblocksWithContext,
  aggregateWorkblocks,
  formatMinutes,
  hasExplicitCalendarLink,
  hasExplicitReminderLink,
  MANUAL_UNLINKED_CALENDAR_SOURCE,
  MANUAL_UNLINKED_REMINDER_SOURCE,
  type Workblock,
} from '../utils/workblocks';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';

type RangePreset = 'today' | 'last7' | 'last30' | 'custom';
type ReviewMode = 'all' | 'unplanned' | 'highlights';
type QuickCorrectionAction = {
  label: string;
  apply: (draft: ActivityCorrectionInput, block: Workblock) => ActivityCorrectionInput;
  tone?: 'default' | 'accent';
};
type LearnedRuleSuggestion = {
  id: string;
  score: number;
  reason: string;
  correction: ActivityCorrectionInput;
  label: string;
  meta: string;
  confidence: '高' | '中';
  lastAppliedLabel: string;
};

type TimelineRenderEntry =
  | { kind: 'day'; key: string; day: string }
  | { kind: 'block'; key: string; block: Workblock };

const PAGE_SIZE = 120;
const CATEGORY_OPTIONS: ActivityCategory[] = ['开发', '工作', '学习', '会议', '沟通', '浏览网页', '整理文件', '提醒事项', '休息', '娱乐', '其他'];
const REVIEW_CATEGORIES = new Set<ActivityCategory>(['开发', '工作', '学习']);

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
  const current = dateKey(today);
  if (preset === 'today') return { start: current, end: current };
  if (preset === 'last7') return { start: dateKey(shiftDate(today, -6)), end: current };
  if (preset === 'last30') return { start: dateKey(shiftDate(today, -29)), end: current };
  return { start: current, end: current };
}

function matchesQuery(block: Workblock, query: string): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return [
    block.title,
    block.category,
    block.activityType,
    block.contextKey,
    block.matchedReminder?.title || '',
    block.matchedCalendarEvent?.title || '',
    ...block.appNames,
    ...block.evidence,
    block.startTime.slice(0, 10),
    block.startTime.slice(11, 16),
  ].join(' ').toLowerCase().includes(keyword);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((item) => item.length >= 2);
}

function overlapScore(source: string, target: string): number {
  const left = tokens(source);
  const right = new Set(tokens(target));
  if (left.length === 0 || right.size === 0) return 0;
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  const normalizedSource = normalizeText(source);
  const normalizedTarget = normalizeText(target);
  if (normalizedSource && normalizedTarget && (normalizedSource.includes(normalizedTarget) || normalizedTarget.includes(normalizedSource))) {
    score += 2;
  }
  return score;
}

function buildLearnedRuleSuggestions(
  block: Workblock,
  learnedRules: Awaited<ReturnType<typeof dataService.getLearnedRules>>,
): LearnedRuleSuggestion[] {
  const blockText = [block.title, block.contextKey, block.activityType, ...block.evidence, ...block.appNames].join(' ');
  const normalizedBlockTitle = normalizeText(block.title);
  const normalizedBlockContext = normalizeText(block.contextKey || '');
  const suggestions: LearnedRuleSuggestion[] = [];
  const seen = new Set<string>();

  for (const rule of learnedRules) {
    let score = 0;
    const reasons: string[] = [];
    const sameApp = block.appNames.includes(rule.appName);
    const normalizedRuleTitle = normalizeText(rule.correctedDescription || rule.title || '');
    const normalizedRuleContext = normalizeText(rule.correctedContextKey || rule.contextKey || '');
    const exactTitleMatch = Boolean(normalizedBlockTitle && normalizedRuleTitle && normalizedBlockTitle === normalizedRuleTitle);
    const exactContextMatch = Boolean(normalizedBlockContext && normalizedRuleContext && normalizedBlockContext === normalizedRuleContext);
    const sameActivityType = Boolean(rule.correctedActivityType && rule.correctedActivityType === block.activityType);
    const recencyBoost = rule.updatedAtMs >= Date.now() - 14 * 86_400_000 ? 1 : 0;

    if (sameApp) {
      score += 3;
      reasons.push('同应用');
    }
    const titleScore = overlapScore(blockText, [rule.correctedDescription, rule.title, rule.contextKey].join(' '));
    if (titleScore > 0) {
      score += titleScore;
      reasons.push('文案相似');
    }
    if (exactTitleMatch) {
      score += 3;
      reasons.push('标题完全一致');
    }
    if (exactContextMatch) {
      score += 2;
      reasons.push('上下文一致');
    }
    if (sameActivityType) {
      score += 1;
      reasons.push('活动类型一致');
    }
    if (rule.correctedCategory === block.category) {
      score += 1;
      reasons.push('同分类');
    }
    score += recencyBoost;
    const hasStrongAnchor = exactTitleMatch || exactContextMatch || (sameApp && titleScore >= 2);
    if (!hasStrongAnchor) continue;
    if (score < 5) continue;
    const dedupeKey = `${rule.correctedDescription}|${rule.correctedCategory}|${rule.correctedActivityType}|${rule.correctedContextKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    suggestions.push({
        id: `${rule.appName}:${rule.contextKey}:${rule.updatedAtMs}`,
        score,
        reason: reasons.join(' · '),
        label: rule.correctedDescription || rule.title || rule.correctedContextKey || '复用已有规则',
        meta: `${rule.correctedCategory || '未分类'} · ${rule.correctedActivityType || '未设 activity type'}`,
        confidence: score >= 6 ? '高' : '中',
        lastAppliedLabel: formatRuleTime(rule.updatedAtMs),
        correction: {
          description: rule.correctedDescription || rule.title || block.title,
          category: (rule.correctedCategory as ActivityCategory) || block.category,
          activityType: rule.correctedActivityType || block.activityType,
          contextKey: rule.correctedContextKey || rule.contextKey || block.contextKey,
        },
      });
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function buildQuickCorrectionActions(block: Workblock): QuickCorrectionAction[] {
  const actions: QuickCorrectionAction[] = [];

  if (block.matchedReminder) {
    actions.push({
      label: '按提醒事项归因',
      tone: 'accent',
      apply: (draft) => ({
        ...draft,
        description: block.matchedReminder?.title || draft.description,
        activityType: '推进提醒事项',
        contextKey: block.matchedReminder?.title || draft.contextKey,
        category: draft.category || block.category,
        linkedReminderTitle: block.matchedReminder?.title,
        linkedReminderSource: block.matchedReminder?.source,
      }),
    });
  }

  if (block.matchedCalendarEvent) {
    actions.push({
      label: '按日历事件归因',
      apply: (draft) => ({
        ...draft,
        description: block.matchedCalendarEvent?.title || draft.description,
        activityType: '处理日程事项',
        contextKey: block.matchedCalendarEvent?.title || draft.contextKey,
        category: draft.category || block.category,
        linkedCalendarTitle: block.matchedCalendarEvent?.title,
        linkedCalendarSource: block.matchedCalendarEvent?.source,
      }),
    });
  }

  if (block.category === '开发') {
    actions.push({
      label: '标记为深度开发',
      apply: (draft, currentBlock) => ({
        ...draft,
        category: '开发',
        activityType: '深度开发',
        contextKey: currentBlock.contextKey || currentBlock.title,
      }),
    });
  }

  if (block.category === '学习' || block.category === '浏览网页') {
    actions.push({
      label: '标记为研究学习',
      apply: (draft, currentBlock) => ({
        ...draft,
        category: '学习',
        activityType: '研究学习',
        contextKey: currentBlock.contextKey || currentBlock.title,
      }),
    });
  }

  if (block.category === '会议' || block.matchedCalendarEvent) {
    actions.push({
      label: '标记为会议沟通',
      apply: (draft, currentBlock) => ({
        ...draft,
        category: '会议',
        activityType: '会议沟通',
        contextKey: currentBlock.matchedCalendarEvent?.title || currentBlock.contextKey || currentBlock.title,
      }),
    });
  }

  return actions;
}

function buildTimelineEntries(blocks: Workblock[]): TimelineRenderEntry[] {
  const entries: TimelineRenderEntry[] = [];
  let previousDay = '';
  for (const block of blocks) {
    const day = block.startTime.slice(0, 10);
    if (day !== previousDay) {
      entries.push({ kind: 'day', key: `day:${day}`, day });
      previousDay = day;
    }
    entries.push({ kind: 'block', key: block.id, block });
  }
  return entries;
}

function estimateBlockHeight(block: Workblock, isLongRange: boolean, reviewMode: ReviewMode): number {
  let height = 156;
  height += Math.min(block.appNames.length, 4) > 0 ? 34 : 0;
  if (reviewMode === 'unplanned' && block.reviewReason) height += 36;
  if (reviewMode === 'highlights' && block.highlightReason) height += 36;
  if (block.evidence.length > 0) {
    height += 26;
    height += (isLongRange ? Math.min(block.evidence.length, 2) : Math.min(block.evidence.length, 4)) * 34;
  }
  return height;
}

function buildPrefixSums(entries: TimelineRenderEntry[], isLongRange: boolean, reviewMode: ReviewMode): number[] {
  const prefix = [0];
  for (const entry of entries) {
    const nextHeight = entry.kind === 'day' ? 52 : estimateBlockHeight(entry.block, isLongRange, reviewMode);
    prefix.push(prefix[prefix.length - 1] + nextHeight + 12);
  }
  return prefix;
}

function findEntryIndex(prefix: number[], target: number): number {
  let left = 0;
  let right = prefix.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (prefix[mid] <= target) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }
  return Math.max(0, Math.min(left, prefix.length - 2));
}

export default function Timeline() {
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const settings = useAppStore((state) => state.settings);
  const [searchParams, setSearchParams] = useSearchParams();
  const autoCorrectRequested = searchParams.get('autocorrect') === '1';
  const initialPreset = (searchParams.get('preset') as RangePreset | null) || 'today';
  const initialRange = getPresetRange(initialPreset === 'custom' ? 'today' : initialPreset);
  const [preset, setPreset] = useState<RangePreset>(initialPreset);
  const [startDate, setStartDate] = useState(searchParams.get('start') || initialRange.start);
  const [endDate, setEndDate] = useState(searchParams.get('end') || initialRange.end);
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '全部');
  const [reviewMode, setReviewMode] = useState<ReviewMode>((searchParams.get('review') as ReviewMode | null) || 'all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [contextError, setContextError] = useState('');
  const [saving, setSaving] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [context, setContext] = useState<WeekContext>({ goals: [], calendar_events: [], reminders: [], warnings: [] });
  const [learnedRules, setLearnedRules] = useState<Awaited<ReturnType<typeof dataService.getLearnedRules>>>([]);
  const [selected, setSelected] = useState<Workblock | null>(null);
  const [draft, setDraft] = useState<ActivityCorrectionInput>({});
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [autoOpenedForKey, setAutoOpenedForKey] = useState('');
  const [pendingOpenBlockId, setPendingOpenBlockId] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const { toast } = useToast();
  const deferredQuery = useDeferredValue(query);
  const deferredCategoryFilter = useDeferredValue(categoryFilter);

  const loadContext = useCallback(async (start: string, end: string, useFreshContext = false) => {
    try {
      const nextContext = await dataService.getContextSources(
        start,
        end,
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
  }, [settings.calendarInsightsEnabled, settings.remindersEnabled]);

  const load = useCallback(async ({ fresh = false, background = false }: { fresh?: boolean; background?: boolean } = {}) => {
    if (!fresh && !hasLoadedOnceRef.current) {
      setLoading(true);
    } else if (!background) {
      setRefreshing(true);
    }
    const normalized = startDate <= endDate ? { start: startDate, end: endDate } : { start: endDate, end: startDate };
    try {
      if (!background) setLoadError('');
      const nextActivities = await dataService.getActivitiesRange(normalized.start, normalized.end, { fresh });
      setActivities((previous) => mergeActivitiesPreservingStable(previous, nextActivities));
      setLoadError('');
      void loadContext(normalized.start, normalized.end, fresh);
    } catch (error) {
      console.error(error);
      if (!background) {
        setLoadError(error instanceof Error ? error.message : '未知错误');
        toast('读取时间线失败', 'error');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnceRef.current = true;
    }
  }, [endDate, loadContext, startDate, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      void load({ background: true });
    }, settings.activityRefreshMinutes * 60_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [load, settings.activityRefreshMinutes]);

  useEffect(() => {
    void dataService.getLearnedRules()
      .then(setLearnedRules)
      .catch((error) => {
        console.error(error);
      });
  }, []);

  const workblocks = useMemo(
    () => alignWorkblocksWithContext(aggregateWorkblocks(activities, settings.mergeGapMinutes, settings.categoryRulesDraft), context),
    [activities, context, settings.categoryRulesDraft, settings.mergeGapMinutes],
  );
  const filtered = useMemo(() => {
    const nextBlocks = workblocks
      .filter((block) => reviewMode !== 'unplanned' || (!block.matchedReminder && REVIEW_CATEGORIES.has(block.category)))
      .filter((block) => reviewMode !== 'highlights' || block.highlightScore >= 3)
      .filter((block) => deferredCategoryFilter === '全部' || block.category === deferredCategoryFilter)
      .filter((block) => matchesQuery(block, deferredQuery));

    if (reviewMode === 'unplanned') {
      return nextBlocks.sort((a, b) =>
        b.reviewPriority - a.reviewPriority ||
        b.duration - a.duration ||
        b.startTime.localeCompare(a.startTime),
      );
    }

    if (reviewMode === 'highlights') {
      return nextBlocks.sort((a, b) =>
        b.highlightScore - a.highlightScore ||
        b.duration - a.duration ||
        b.startTime.localeCompare(a.startTime),
      );
    }

    return nextBlocks.sort((a, b) => b.startTime.localeCompare(a.startTime));
  }, [deferredCategoryFilter, deferredQuery, reviewMode, workblocks]);
  const visibleBlocks = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const normalizedStart = startDate <= endDate ? startDate : endDate;
  const normalizedEnd = startDate <= endDate ? endDate : startDate;
  useEffect(() => {
    const today = dateKey(new Date());
    const yesterday = dateKey(shiftDate(new Date(), -1));
    const ranges = new Map<string, [string, string]>();
    for (const [start, end] of [
      [today, today],
      [yesterday, yesterday],
      [normalizedStart, normalizedEnd],
    ]) {
      ranges.set(`${start}:${end}`, [start, end]);
    }
    for (const [start, end] of ranges.values()) {
      dataService.prefetchActivitiesRange(start, end);
      dataService.prefetchContextSources(start, end, false, settings.calendarInsightsEnabled, settings.remindersEnabled);
    }
  }, [normalizedEnd, normalizedStart, settings.calendarInsightsEnabled, settings.remindersEnabled]);
  const daySpan = useMemo(() => {
    const start = new Date(`${normalizedStart}T00:00:00`);
    const end = new Date(`${normalizedEnd}T00:00:00`);
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  }, [normalizedEnd, normalizedStart]);
  const pageSize = daySpan > 14 ? 60 : PAGE_SIZE;
  const isLongRange = daySpan > 14;
  const [viewportState, setViewportState] = useState({ top: 0, height: 900 });
  const totalMinutes = filtered.reduce((sum, block) => sum + block.duration, 0);
  const selectedIndex = selected ? filtered.findIndex((block) => block.id === selected.id) : -1;
  const previousBlock = selectedIndex > 0 ? filtered[selectedIndex - 1] : null;
  const nextBlock = selectedIndex >= 0 && selectedIndex < filtered.length - 1 ? filtered[selectedIndex + 1] : null;
  const reviewQueueMinutes = useMemo(
    () => filtered.reduce((sum, block) => sum + block.duration, 0),
    [filtered],
  );
  const highPriorityCount = useMemo(
    () => filtered.filter((block) => block.reviewPriority >= 6).length,
    [filtered],
  );

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [categoryFilter, pageSize, query, reviewMode, startDate, endDate]);

  useEffect(() => {
    if (!isLongRange) return;
    const scroller = document.querySelector('main');
    if (!(scroller instanceof HTMLElement)) return;

    let frame = 0;
    const updateViewport = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setViewportState({
          top: scroller.scrollTop,
          height: scroller.clientHeight,
        });
      });
    };

    updateViewport();
    scroller.addEventListener('scroll', updateViewport, { passive: true });
    window.addEventListener('resize', updateViewport);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [isLongRange]);

  useEffect(() => {
    const nextParams = new URLSearchParams();
    nextParams.set('preset', preset);
    nextParams.set('start', startDate);
    nextParams.set('end', endDate);
    if (query.trim()) nextParams.set('q', query.trim());
    if (categoryFilter !== '全部') nextParams.set('category', categoryFilter);
    if (reviewMode !== 'all') nextParams.set('review', reviewMode);
    if (autoCorrectRequested) nextParams.set('autocorrect', '1');
    setSearchParams(nextParams, { replace: true });
  }, [autoCorrectRequested, categoryFilter, endDate, preset, query, reviewMode, setSearchParams, startDate]);

  const renderSourceBlocks = isLongRange ? filtered : visibleBlocks;
  const renderEntries = useMemo(() => buildTimelineEntries(renderSourceBlocks), [renderSourceBlocks]);
  const entryPrefix = useMemo(
    () => buildPrefixSums(renderEntries, isLongRange, reviewMode),
    [isLongRange, renderEntries, reviewMode],
  );
  const virtualWindow = useMemo(() => {
    if (!isLongRange) {
      return {
        startIndex: 0,
        endIndex: renderEntries.length,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }
    const overscan = 1200;
    const startTarget = Math.max(0, viewportState.top - overscan);
    const endTarget = viewportState.top + viewportState.height + overscan;
    const startIndex = findEntryIndex(entryPrefix, startTarget);
    const endIndex = Math.min(renderEntries.length, findEntryIndex(entryPrefix, endTarget) + 1);
    return {
      startIndex,
      endIndex,
      topSpacer: entryPrefix[startIndex] ?? 0,
      bottomSpacer: Math.max(0, entryPrefix[entryPrefix.length - 1] - (entryPrefix[endIndex] ?? 0)),
    };
  }, [entryPrefix, isLongRange, renderEntries.length, viewportState.height, viewportState.top]);
  const visibleEntries = useMemo(
    () => renderEntries.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [renderEntries, virtualWindow.endIndex, virtualWindow.startIndex],
  );

  useEffect(() => {
    if (!autoCorrectRequested || loading || selected) return;
    const autoOpenKey = `${normalizedStart}:${normalizedEnd}:${deferredQuery}:${deferredCategoryFilter}`;
    if (autoOpenedForKey === autoOpenKey) return;
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const target = [...filtered].sort((a, b) => {
      const aExact = normalizedQuery && a.title.toLowerCase() === normalizedQuery ? 1 : 0;
      const bExact = normalizedQuery && b.title.toLowerCase() === normalizedQuery ? 1 : 0;
      return bExact - aExact || b.reviewPriority - a.reviewPriority || b.duration - a.duration;
    })[0];
    if (!target) return;
    openCorrection(target);
    setAutoOpenedForKey(autoOpenKey);

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('autocorrect');
    setSearchParams(nextParams, { replace: true });
  }, [
    autoCorrectRequested,
    autoOpenedForKey,
    deferredCategoryFilter,
    deferredQuery,
    filtered,
    loading,
    normalizedEnd,
    normalizedStart,
    searchParams,
    selected,
    setSearchParams,
  ]);

  useEffect(() => {
    if (!pendingOpenBlockId || loading) return;
    const target = filtered.find((block) => block.id === pendingOpenBlockId);
    if (target) {
      openCorrection(target);
    }
    setPendingOpenBlockId('');
  }, [filtered, loading, pendingOpenBlockId]);

  function applyPreset(nextPreset: RangePreset) {
    const range = getPresetRange(nextPreset);
    setPreset(nextPreset);
    setStartDate(range.start);
    setEndDate(range.end);
  }

  function openCorrection(block: Workblock) {
    setSelected(block);
    setDraft({
      description: block.title,
      category: block.category,
      activityType: block.activityType,
      contextKey: block.contextKey,
    });
  }

  async function saveCorrection(mode: 'close' | 'next' = 'close') {
    if (!selected) return;
    const nextTargetId = mode === 'next' ? nextBlock?.id || '' : '';
    const currentSelectedId = selected.id;
    setSaving(true);
    try {
      const updatedActivities = await dataService.saveActivityCorrections(selected.activityIds, draft);
      setActivities((current) => {
        if (updatedActivities.length === 0) return current;
        const updates = new Map(updatedActivities.map((item) => [item.id, item]));
        return current.map((activity) => updates.get(activity.id) || activity);
      });
      const nextRules = await dataService.getLearnedRules();
      setLearnedRules(nextRules);
      toast('工作块修正已保存', 'success');
      if (mode === 'next') {
        setSelected(null);
        setPendingOpenBlockId(nextTargetId);
      } else {
        const updatedSelected = updatedActivities.find((item) => selected.activityIds.includes(item.id));
        if (updatedSelected) {
          setPendingOpenBlockId(currentSelectedId);
        }
      }
    } catch (error) {
      console.error(error);
      toast('保存修正失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen p-8 lg:p-10">
      <header className="mb-8 rounded-[32px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-7 py-7 shadow-[var(--shadow-card)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="mb-4 inline-flex rounded-full bg-[var(--color-bg-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]">
              {normalizedStart === normalizedEnd ? normalizedStart : `${normalizedStart} 至 ${normalizedEnd}`}
            </div>
            <h1 className="mb-3 text-[30px] leading-[1.05] font-semibold tracking-[-0.04em]">时间线与修正队列</h1>
            <p className="max-w-2xl text-sm leading-7 text-[var(--color-text-muted)]">
              这里不是原始噪声列表，而是已经聚合好的工作块。你可以把它当作轻量 review 台，快速确认今天到底做了什么、哪些块值得先纠偏。
            </p>
          </div>
          <button
            onClick={() => void load({ fresh: true })}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-soft)] disabled:opacity-60"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中...' : '轻刷新'}
          </button>
        </div>
      </header>

      <section className="mb-6 rounded-[30px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、页面、提醒事项、时间"
              className="w-full rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] py-3 pl-11 pr-4 text-sm outline-none"
            />
          </label>
          <button
            onClick={() => setFiltersExpanded((current) => !current)}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-sm font-semibold text-[var(--color-text-secondary)]"
          >
            <Filter size={16} />
            高级筛选
            <ChevronDown size={15} className={`transition-transform ${filtersExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
        {filtersExpanded ? (
          <div className="grid grid-cols-1 gap-4 border-t border-[var(--color-border-light)] pt-4">
            <div className="grid grid-cols-3 gap-2">
              {([
                ['today', '今日'],
                ['last7', '近 7 天'],
                ['last30', '近 30 天'],
              ] as Array<[RangePreset, string]>).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => applyPreset(value)}
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    preset === value
                      ? 'bg-white text-[var(--color-green-hover)] shadow-[var(--shadow-soft)]'
                      : 'bg-[var(--color-bg-surface-2)] text-[var(--color-text-secondary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['all', '全部工作块'],
                ['unplanned', '待修正队列'],
                ['highlights', '重点块'],
              ] as Array<[ReviewMode, string]>).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setReviewMode(value)}
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    reviewMode === value
                      ? 'bg-[rgba(231,247,237,0.95)] text-[var(--color-green-hover)] shadow-[var(--shadow-soft)]'
                      : 'bg-[var(--color-bg-surface-2)] text-[var(--color-text-secondary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[180px_180px_180px]">
            <Field label="开始日期" icon={CalendarDays}>
              <input type="date" value={startDate} onChange={(event) => { setPreset('custom'); setStartDate(event.target.value); }} className="w-full rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2" />
            </Field>
            <Field label="结束日期" icon={Clock3}>
              <input type="date" value={endDate} onChange={(event) => { setPreset('custom'); setEndDate(event.target.value); }} className="w-full rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2" />
            </Field>
            <Field label="分类" icon={Filter}>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="w-full rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2 outline-none">
                {['全部', ...CATEGORY_OPTIONS].map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </Field>
            </div>
          </div>
        ) : null}
        <div className="mt-4 text-xs text-[var(--color-text-muted)]">
          当前范围：{normalizedStart === normalizedEnd ? normalizedStart : `${normalizedStart} 至 ${normalizedEnd}`} · {filtered.length} 个工作块 · {formatMinutes(totalMinutes)}
        </div>
        {refreshing ? (
          <div className="mt-3 rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-xs leading-6 text-[var(--color-text-secondary)]">
            正在刷新工作块。页面会先更新活动记录，上下文信息随后补齐。
          </div>
        ) : null}
        {contextError ? (
          <div className="mt-3 rounded-[22px] border border-[var(--color-border-light)] bg-[rgba(255,246,232,0.95)] px-4 py-3 text-xs leading-6 text-[var(--color-coral-hover)]">
            日历或提醒事项上下文读取较慢：{contextError}
          </div>
        ) : null}
        {reviewMode === 'unplanned' ? (
          <div className="mt-3 rounded-[22px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(233,246,255,0.92),rgba(255,255,255,0.92))] px-4 py-3 text-xs leading-6 text-[var(--color-blue-hover)]">
            待修正队列已筛出 {filtered.length} 个高价值但未稳定归因的工作块，总计 {formatMinutes(reviewQueueMinutes)}。
            其中 {highPriorityCount} 个属于高优先级，建议先处理。
          </div>
        ) : null}
        {reviewMode === 'highlights' ? (
          <div className="mt-3 rounded-[22px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.92),rgba(255,255,255,0.92))] px-4 py-3 text-xs leading-6 text-[var(--color-green-hover)]">
            重点块会优先展示明确推进计划、连续高投入、或值得优先纠偏的工作块。
          </div>
        ) : null}
        {deferredQuery.trim() ? (
          <div className="mt-3 rounded-[22px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-xs leading-6 text-[var(--color-text-secondary)]">
            当前搜索词 “{deferredQuery.trim()}” 匹配到 {filtered.length} 个工作块。
            {filtered.length === 1 ? ' 已尽量直接打开修正面板。' : ' 继续缩小范围可以更快进入单块修正。'}
          </div>
        ) : null}
      </section>

      {loading ? (
        <EmptyState title="正在整理时间线..." description="Trace 正在把原始活动记录聚合成可读工作块。" />
      ) : loadError ? (
        <ErrorState
          title="时间线暂时没有加载成功"
          description={loadError}
          onRetry={() => void load({ fresh: true })}
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="当前范围没有工作块" description="换一个日期范围，或者先继续使用电脑一段时间。" />
      ) : (
        <section ref={listViewportRef} className="space-y-3">
          {isLongRange ? (
            <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-xs leading-6 text-[var(--color-text-secondary)]">
              当前范围跨越 {daySpan} 天，时间线已自动切到轻量窗口化模式：只渲染当前视口附近的工作块，证据片段也会收缩展示，以减少卡顿。
            </div>
          ) : null}
          {isLongRange && virtualWindow.topSpacer > 0 ? <div style={{ height: virtualWindow.topSpacer }} /> : null}
          {visibleEntries.map((entry) => (
            entry.kind === 'day' ? (
              <div key={entry.key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-4">
                <div className="pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                  {entry.day.slice(5)}
                </div>
                <div className="sticky top-0 z-10 rounded-2xl border border-[var(--color-border-light)] bg-[rgba(255,255,255,0.9)] px-4 py-2 text-sm font-bold shadow-[var(--shadow-soft)] backdrop-blur-xl">
                  {entry.day}
                </div>
              </div>
            ) : (
              <article key={entry.key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-4">
                <div className="relative pb-3">
                  <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">{entry.block.startTime.slice(11, 16)}</div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{formatMinutes(entry.block.duration)}</div>
                  <div className="absolute left-[42px] top-7 bottom-[-18px] w-px bg-[var(--color-border-light)]" />
                  <div className="absolute left-[37px] top-7 h-[10px] w-[10px] rounded-full border-2 border-white bg-[var(--color-green-hover)] shadow-[var(--shadow-soft)]" />
                </div>
                <div className="rounded-[28px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-5 shadow-[var(--shadow-card)] backdrop-blur-xl">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold leading-6 text-[var(--color-text-primary)]">{entry.block.title}</div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                        {entry.block.startTime.slice(11, 16)} - {entry.block.endTime.slice(11, 16)} · {entry.block.category} · {entry.block.activityType}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="text-sm font-semibold">{formatMinutes(entry.block.duration)}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">专注 {entry.block.focusScore}%</div>
                        {reviewMode === 'unplanned' && entry.block.reviewPriority > 0 ? (
                          <div className="mt-1 text-xs font-semibold text-[var(--color-blue-hover)]">优先级 {entry.block.reviewPriority}</div>
                        ) : null}
                        {reviewMode === 'highlights' && entry.block.highlightScore > 0 ? (
                          <div className="mt-1 text-xs font-semibold text-[var(--color-green-hover)]">重点分 {entry.block.highlightScore}</div>
                        ) : null}
                      </div>
                      <button
                        onClick={() => openCorrection(entry.block)}
                        className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)]"
                      >
                        <PencilLine size={14} />
                        修正
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    {entry.block.appNames.map((app) => (
                      <span key={app} className="rounded-full bg-[var(--color-bg-surface-2)] px-3 py-1 text-[var(--color-text-secondary)]">
                        {app}
                      </span>
                    ))}
                    {entry.block.matchedReminder ? (
                      <span className="rounded-full bg-[rgba(231,247,237,0.95)] px-3 py-1 text-[var(--color-green-hover)]">
                        {hasExplicitReminderLink(entry.block) ? '已确认提醒事项' : '提醒事项'}：{entry.block.matchedReminder.title}
                      </span>
                    ) : null}
                    {entry.block.matchedCalendarEvent ? (
                      <span className="rounded-full bg-[var(--color-blue-soft)] px-3 py-1 text-[var(--color-blue-hover)]">
                        {hasExplicitCalendarLink(entry.block) ? '已确认日历' : '日历'}：{entry.block.matchedCalendarEvent.title}
                      </span>
                    ) : null}
                    {entry.block.isLowValue ? (
                      <span className="rounded-full bg-[rgba(255,236,230,0.9)] px-3 py-1 text-[var(--color-coral-hover)]">
                        低价值占用
                      </span>
                    ) : null}
                  </div>

                  {entry.block.evidence.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {reviewMode === 'unplanned' && entry.block.reviewReason ? (
                        <div className="rounded-2xl border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.92),rgba(255,255,255,0.92))] px-3 py-2 text-xs text-[var(--color-green-hover)]">
                          {entry.block.reviewReason}
                        </div>
                      ) : null}
                      {reviewMode === 'highlights' && entry.block.highlightReason ? (
                        <div className="rounded-2xl border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.92),rgba(255,255,255,0.92))] px-3 py-2 text-xs text-[var(--color-green-hover)]">
                          {entry.block.highlightReason}
                        </div>
                      ) : null}
                      <div className="text-xs font-semibold text-[var(--color-text-muted)]">证据片段</div>
                      <div className="grid gap-2 md:grid-cols-2">
                        {entry.block.evidence.slice(0, isLongRange ? 2 : 4).map((evidence) => (
                          <div key={evidence} className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
                            {evidence}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </article>
            )
          ))}
          {isLongRange && virtualWindow.bottomSpacer > 0 ? <div style={{ height: virtualWindow.bottomSpacer }} /> : null}

          {!isLongRange && visibleBlocks.length < filtered.length ? (
            <button
              onClick={() => setVisibleCount((current) => current + pageSize)}
              className="w-full rounded-[24px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-4 py-3 text-sm font-semibold shadow-[var(--shadow-soft)]"
            >
              继续加载更多
            </button>
          ) : null}
        </section>
      )}

      {selected ? (
        <CorrectionPanel
          block={selected}
          learnedRuleSuggestions={buildLearnedRuleSuggestions(selected, learnedRules)}
          draft={draft}
          saving={saving}
          canGoPrevious={Boolean(previousBlock)}
          canGoNext={Boolean(nextBlock)}
          queuePosition={selectedIndex >= 0 ? selectedIndex + 1 : 0}
          queueSize={filtered.length}
          reviewMode={reviewMode}
          onDraftChange={setDraft}
          onClose={() => setSelected(null)}
          onPrevious={() => previousBlock && openCorrection(previousBlock)}
          onNext={() => nextBlock && openCorrection(nextBlock)}
          onSkip={() => nextBlock ? openCorrection(nextBlock) : setSelected(null)}
          onSave={() => void saveCorrection('close')}
          onSaveAndNext={() => void saveCorrection('next')}
        />
      ) : null}
    </div>
  );
}

function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof Clock3;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
        <Icon size={14} />
        {label}
      </span>
      {children}
    </label>
  );
}

function CorrectionPanel({
  block,
  learnedRuleSuggestions,
  draft,
  saving,
  canGoPrevious,
  canGoNext,
  queuePosition,
  queueSize,
  reviewMode,
  onDraftChange,
  onClose,
  onPrevious,
  onNext,
  onSkip,
  onSave,
  onSaveAndNext,
}: {
  block: Workblock;
  learnedRuleSuggestions: LearnedRuleSuggestion[];
  draft: ActivityCorrectionInput;
  saving: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  queuePosition: number;
  queueSize: number;
  reviewMode: ReviewMode;
  onDraftChange: (value: ActivityCorrectionInput) => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSkip: () => void;
  onSave: () => void;
  onSaveAndNext: () => void;
}) {
  const quickActions = useMemo(() => buildQuickCorrectionActions(block), [block]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!saving && event.shiftKey && canGoNext) {
          onSaveAndNext();
        } else if (!saving) {
          onSave();
        }
        return;
      }
      if (event.key === 'ArrowLeft' && canGoPrevious) {
        event.preventDefault();
        onPrevious();
        return;
      }
      if (event.key === 'ArrowRight' && canGoNext) {
        event.preventDefault();
        onNext();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [canGoNext, canGoPrevious, onClose, onNext, onPrevious, onSave, onSaveAndNext, saving]);

  return (
    <div className="fixed inset-0 z-40 bg-[rgba(31,49,40,0.14)] backdrop-blur-[6px]">
      <div className="absolute right-0 top-0 h-full w-full max-w-xl border-l border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(244,250,246,0.98))] p-6 shadow-2xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="text-xl font-semibold tracking-[-0.03em]">修正工作块</div>
            <div className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              这次修正会同时影响当前工作块，并写入本地学习规则。
            </div>
            {reviewMode === 'unplanned' && queueSize > 0 ? (
              <div className="mt-3 inline-flex rounded-full bg-[rgba(231,247,237,0.95)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]">
                队列进度 {queuePosition}/{queueSize}
              </div>
            ) : null}
            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              `Esc` 关闭，`Cmd/Ctrl + Enter` 保存，`Shift + Cmd/Ctrl + Enter` 保存并进入下一个，方向键切换相邻工作块。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onPrevious}
              disabled={!canGoPrevious}
              className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 p-2 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={onNext}
              disabled={!canGoNext}
              className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 p-2 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
            <button onClick={onClose} className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 p-2">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {learnedRuleSuggestions.length > 0 ? (
            <div className="rounded-[26px] border border-[var(--color-border-light)] bg-white/75 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">复用历史修正</div>
              <div className="space-y-2">
                {learnedRuleSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    onClick={() => onDraftChange({ ...draft, ...suggestion.correction })}
                    className="w-full rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3 text-left transition hover:bg-white"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold leading-6 text-[var(--color-text-primary)]">{suggestion.label}</div>
                      <div className="rounded-full bg-white/80 px-2 py-1 text-[10px] font-semibold text-[var(--color-green-hover)]">
                        {suggestion.confidence} 置信
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {suggestion.meta} · 命中原因：{suggestion.reason}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      最近一次类似修正：{suggestion.lastAppliedLabel}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {quickActions.length > 0 ? (
            <div className="rounded-[26px] border border-[var(--color-border-light)] bg-[linear-gradient(180deg,rgba(231,247,237,0.95),rgba(255,255,255,0.95))] p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-green-hover)]">快捷归因</div>
              <div className="space-y-2">
                {block.matchedReminder ? (
                  <div className="text-sm leading-6">{hasExplicitReminderLink(block) ? '已确认提醒事项' : '已匹配提醒事项'}：{block.matchedReminder.title}</div>
                ) : null}
                {block.matchedCalendarEvent ? (
                  <div className="text-sm leading-6">{hasExplicitCalendarLink(block) ? '已确认日历事件' : '已匹配日历事件'}：{block.matchedCalendarEvent.title}</div>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {quickActions.map((action) => (
                  <button
                    key={action.label}
                    onClick={() => onDraftChange(action.apply(draft, block))}
                    className={`rounded-2xl px-3 py-2 text-xs font-semibold ${
                      action.tone === 'accent'
                        ? 'border border-[var(--color-border-light)] bg-white/85 text-[var(--color-green-hover)] shadow-[var(--shadow-soft)]'
                        : 'border border-[var(--color-border-light)] bg-white/70 text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              {(hasExplicitReminderLink(block) || hasExplicitCalendarLink(block)) ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {hasExplicitReminderLink(block) ? (
                    <button
                      onClick={() => onDraftChange({ ...draft, linkedReminderTitle: '', linkedReminderSource: MANUAL_UNLINKED_REMINDER_SOURCE })}
                      className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-3 py-2 text-xs font-semibold text-[var(--color-coral-hover)]"
                    >
                      清除提醒事项关联
                    </button>
                  ) : null}
                  {hasExplicitCalendarLink(block) ? (
                    <button
                      onClick={() => onDraftChange({ ...draft, linkedCalendarTitle: '', linkedCalendarSource: MANUAL_UNLINKED_CALENDAR_SOURCE })}
                      className="rounded-2xl border border-[var(--color-border-light)] bg-white/70 px-3 py-2 text-xs font-semibold text-[var(--color-coral-hover)]"
                    >
                      清除日历关联
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <TextInput label="标题 / 描述" value={draft.description || ''} onChange={(value) => onDraftChange({ ...draft, description: value })} />
          <SelectInput label="分类" value={draft.category || block.category} onChange={(value) => onDraftChange({ ...draft, category: value as ActivityCategory })}>
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </SelectInput>
          <TextInput label="活动类型" value={draft.activityType || ''} onChange={(value) => onDraftChange({ ...draft, activityType: value })} />
          <TextInput label="上下文键" value={draft.contextKey || ''} onChange={(value) => onDraftChange({ ...draft, contextKey: value })} />

          <div className="rounded-[24px] border border-[var(--color-border-light)] bg-white/75 p-4 text-xs text-[var(--color-text-secondary)]">
            <div className="font-semibold mb-2">当前工作块</div>
            <div>{block.title}</div>
            <div className="mt-1">{formatMinutes(block.duration)} · {block.activityIds.length} 条原始活动</div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onPrevious}
            disabled={!canGoPrevious || saving}
            className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3 text-sm font-semibold disabled:opacity-40"
          >
            上一个
          </button>
          <button
            onClick={onNext}
            disabled={!canGoNext || saving}
            className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3 text-sm font-semibold disabled:opacity-40"
          >
            下一个
          </button>
          <button
            onClick={onSkip}
            disabled={!canGoNext || saving}
            className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3 text-sm font-semibold disabled:opacity-40"
          >
            跳过
          </button>
          <button onClick={onClose} className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3 text-sm font-semibold">
            取消
          </button>
          <button
            onClick={onSaveAndNext}
            disabled={!canGoNext || saving}
            className="rounded-2xl border border-[var(--color-border-light)] bg-white/75 px-4 py-3 text-sm font-semibold disabled:opacity-40"
          >
            保存并下一个
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-light)] bg-[rgba(231,247,237,0.98)] px-4 py-3 text-sm font-semibold text-[var(--color-green-hover)] shadow-[var(--shadow-soft)] disabled:opacity-60"
          >
            <Save size={15} />
            {saving ? '保存中...' : '保存修正'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRuleTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
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

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs text-[var(--color-text-muted)]">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-2xl border border-[var(--color-border-light)] bg-white/80 px-4 py-3 outline-none" />
    </label>
  );
}

function SelectInput({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs text-[var(--color-text-muted)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-2xl border border-[var(--color-border-light)] bg-white/80 px-4 py-3 outline-none">
        {children}
      </select>
    </label>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-3xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-1)] p-8 shadow-[var(--shadow-card)]">
      <div className="text-lg font-bold">{title}</div>
      <div className="mt-2 text-sm text-[var(--color-text-muted)]">{description}</div>
    </div>
  );
}
