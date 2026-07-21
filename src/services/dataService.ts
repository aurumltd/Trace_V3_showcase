import * as activityIpc from './ipc/activityIpc';
import * as settingsIpc from './ipc/settingsIpc';
import { isTauri } from '@tauri-apps/api/core';
import type { TrackingOverview } from './ipc/settingsIpc';
import type { PlanBlock } from '../utils/planning';

export type ActivityCategory =
  | '开发'
  | '工作'
  | '学习'
  | '会议'
  | '沟通'
  | '浏览网页'
  | '整理文件'
  | '提醒事项'
  | '休息'
  | '娱乐'
  | '其他';

export interface Activity {
  id: string;
  name: string;
  windowTitle: string;
  rawWindowTitle?: string;
  category: ActivityCategory;
  activityType?: string;
  description?: string;
  focusScore?: number;
  contextKey?: string;
  startTime: string;
  endTime: string;
  duration: number;
  isManual: boolean;
  linkedReminderTitle?: string;
  linkedReminderSource?: string;
  linkedCalendarTitle?: string;
  linkedCalendarSource?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark';
  autoStartTracking: boolean;
  calendarSyncEnabled: boolean;
  calendarInsightsEnabled: boolean;
  calendarName: string;
  minActivityMinutes: number;
  mergeGapMinutes: number;
  activityRefreshMinutes: 1 | 5 | 15 | 30 | 60;
  calendarSyncIntervalMinutes: 5 | 15 | 30 | 60;
  ignoredApplications: string[];
  remindersEnabled: boolean;
  reminderLists: string[];
  aiSummariesEnabled: boolean;
  aiSummaryModel: 'qwen3:1.7b' | 'qwen3:4b';
  aiSummaryRefreshHours: 2 | 4 | 6 | 12;
  categoryRulesDraft: string;
  categoryRulesVersion: number;
  goalMetricMode: 'reminders';
}

export interface ContextItem {
  title: string;
  source: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

export interface ActivityCorrectionInput {
  description?: string;
  category?: ActivityCategory;
  activityType?: string;
  contextKey?: string;
  linkedReminderTitle?: string;
  linkedReminderSource?: string;
  linkedCalendarTitle?: string;
  linkedCalendarSource?: string;
}

export interface WeekContext {
  goals: ContextItem[];
  calendar_events: ContextItem[];
  reminders: ContextItem[];
  warnings: string[];
}

export interface LearnedRule {
  appName: string;
  activityType: string;
  contextKey: string;
  title: string;
  correctedCategory: string;
  correctedActivityType: string;
  correctedContextKey: string;
  correctedDescription: string;
  updatedAtMs: number;
}

export interface TrackingRuntimeStatus {
  is_tracking: boolean;
  recovery_active: boolean;
  recovery_until_ms?: number | null;
  last_recovery_at_ms?: number | null;
  last_recovery_gap_ms?: number | null;
  last_recovery_reason?: string | null;
  calendar_permission_backoff_active: boolean;
  calendar_permission_backoff_until_ms?: number | null;
}

function sameActivitySnapshot(left: Activity, right: Activity): boolean {
  return left.id === right.id
    && left.startTime === right.startTime
    && left.endTime === right.endTime
    && left.duration === right.duration
    && left.name === right.name
    && left.windowTitle === right.windowTitle
    && left.rawWindowTitle === right.rawWindowTitle
    && left.category === right.category
    && left.activityType === right.activityType
    && left.description === right.description
    && left.focusScore === right.focusScore
    && left.contextKey === right.contextKey
    && left.linkedReminderTitle === right.linkedReminderTitle
    && left.linkedReminderSource === right.linkedReminderSource
    && left.linkedCalendarTitle === right.linkedCalendarTitle
    && left.linkedCalendarSource === right.linkedCalendarSource;
}

export function mergeActivitiesPreservingStable(previous: Activity[], next: Activity[]): Activity[] {
  if (previous.length === 0) return next;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item) => {
    const existing = previousById.get(item.id);
    if (!existing) {
      changed = true;
      return item;
    }
    if (sameActivitySnapshot(existing, item)) {
      return existing;
    }
    changed = true;
    return item;
  });
  return changed ? merged : previous;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  autoStartTracking: false,
  calendarSyncEnabled: true,
  calendarInsightsEnabled: true,
  calendarName: 'Trace AI 时间追踪',
  minActivityMinutes: 5,
  mergeGapMinutes: 30,
  activityRefreshMinutes: 5,
  calendarSyncIntervalMinutes: 15,
  ignoredApplications: [],
  remindersEnabled: true,
  reminderLists: [],
  aiSummariesEnabled: true,
  aiSummaryModel: 'qwen3:4b',
  aiSummaryRefreshHours: 6,
  categoryRulesDraft:
    '项目推进：项目、方案、计划、交付、复盘\n文档写作：文档、报告、说明、案例、总结\n沟通协作：会议、回复、确认、讨论、同步\n开发构建：代码、调试、构建、测试、发布\n研究学习：搜索、资料、论文、阅读、分析\n休息娱乐：休息、音乐、视频、电影、剧集',
  categoryRulesVersion: 1,
  goalMetricMode: 'reminders',
};

const STORAGE_KEYS = {
  settings: 'trace-settings',
} as const;

type RequestOptions = {
  fresh?: boolean;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const RANGE_CACHE_TTL_MS = 3 * 60_000;
const REMINDER_LISTS_CACHE_TTL_MS = 10 * 60_000;

const activityRangeCache = new Map<string, CacheEntry<Activity[]>>();
const activityRangeInflight = new Map<string, Promise<Activity[]>>();
const activityRangeFreshInflight = new Map<string, Promise<Activity[]>>();
const contextCache = new Map<string, CacheEntry<WeekContext>>();
const contextInflight = new Map<string, Promise<WeekContext>>();
const contextFreshInflight = new Map<string, Promise<WeekContext>>();
const reminderListsCache = new Map<string, CacheEntry<string[]>>();
const reminderListsInflight = new Map<string, Promise<string[]>>();

function isDesktop(): boolean {
  return isTauri() || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function peekCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  return entry?.value ?? null;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timerId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback());
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        resolve(fallback());
      });
  });
}

function clearInsightCaches(): void {
  activityRangeCache.clear();
  activityRangeInflight.clear();
  activityRangeFreshInflight.clear();
  contextCache.clear();
  contextInflight.clear();
  contextFreshInflight.clear();
}

function buildActivityRangeKey(startDate: string, endDate: string): string {
  return `${startDate}:${endDate}`;
}

function buildContextKey(
  startDate: string,
  endDate: string,
  includeGoals: boolean,
  includeCalendar: boolean,
  includeReminders: boolean,
): string {
  return `${startDate}:${endDate}:${includeGoals ? 1 : 0}:${includeCalendar ? 1 : 0}:${includeReminders ? 1 : 0}`;
}

const dataService = {
  isDesktop,

  getDefaultSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS };
  },

  async getSettings(): Promise<AppSettings> {
    if (isDesktop()) {
      return settingsIpc.getSettings(DEFAULT_SETTINGS);
    }

    return { ...DEFAULT_SETTINGS, ...loadJson<Partial<AppSettings>>(STORAGE_KEYS.settings, {}) };
  },

  async updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    if (isDesktop()) {
      const next = await settingsIpc.updateSettings(settings);
      if ('remindersEnabled' in settings || 'reminderLists' in settings || 'categoryRulesVersion' in settings || 'categoryRulesDraft' in settings) {
        clearInsightCaches();
      }
      return next;
    }

    const next = { ...(await this.getSettings()), ...settings };
    saveJson(STORAGE_KEYS.settings, next);
    return next;
  },

  async getActivities(date: string, options?: RequestOptions): Promise<Activity[]> {
    return this.getActivitiesRange(date, date, options);
  },

  async getActivitiesRange(startDate: string, endDate: string, options?: RequestOptions): Promise<Activity[]> {
    if (isDesktop()) {
      const key = buildActivityRangeKey(startDate, endDate);
      if (!options?.fresh) {
        const cached = readCache(activityRangeCache, key);
        if (cached) return cached;
      }
      const inflight = options?.fresh ? activityRangeFreshInflight : activityRangeInflight;
      const pending = inflight.get(key);
      if (pending) return pending;

      const request = activityIpc.getActivitiesRange(startDate, endDate)
        .then((result) => writeCache(activityRangeCache, key, result, RANGE_CACHE_TTL_MS))
        .finally(() => {
          if (inflight.get(key) === request) {
            inflight.delete(key);
          }
        });

      inflight.set(key, request);
      return request;
    }

    console.info(`[Trace] Browser preview has no tracking data from ${startDate} to ${endDate}.`);
    return [];
  },

  prefetchActivitiesRange(startDate: string, endDate: string): void {
    if (!isDesktop()) return;
    void this.getActivitiesRange(startDate, endDate).catch((error) => {
      console.error(error);
    });
  },

  async clearAllData(): Promise<void> {
    if (isDesktop()) {
      await activityIpc.clearAllActivities();
      clearInsightCaches();
      return;
    }

    return;
  },

  async saveActivityCorrections(activityIds: string[], correction: ActivityCorrectionInput): Promise<Activity[]> {
    if (!isDesktop()) {
      return [];
    }
    const result = await activityIpc.saveActivityCorrections(activityIds, correction);
    clearInsightCaches();
    return result;
  },

  async getLearnedRules(): Promise<LearnedRule[]> {
    if (!isDesktop()) return [];
    return withTimeout(activityIpc.getLearnedRules(), 1500, () => []);
  },

  async clearLearnedRules(): Promise<void> {
    if (!isDesktop()) return;
    await activityIpc.clearLearnedRules();
    clearInsightCaches();
  },

  async generateAiSummary(prompt: string, model: AppSettings['aiSummaryModel']): Promise<string> {
    if (!isDesktop()) return '';
    return activityIpc.generateAiSummary(prompt, model);
  },

  async getReminderLists(options?: RequestOptions): Promise<string[]> {
    if (!isDesktop()) return [];
    const key = 'all';
    if (!options?.fresh) {
      const cached = readCache(reminderListsCache, key);
      if (cached) return cached;
      const pending = reminderListsInflight.get(key);
      if (pending) return pending;
    }

    const request = withTimeout(activityIpc.getReminderLists(), 2000, () => peekCache(reminderListsCache, key) ?? [])
      .then((result) => writeCache(reminderListsCache, key, result, REMINDER_LISTS_CACHE_TTL_MS))
      .finally(() => {
        reminderListsInflight.delete(key);
      });
    reminderListsInflight.set(key, request);
    return request;
  },

  async syncCalendarToday(): Promise<number> {
    if (!isDesktop()) return 0;
    return activityIpc.syncCalendarToday();
  },

  async queueCalendarSync(): Promise<boolean> {
    if (!isDesktop()) return false;
    return activityIpc.queueCalendarSync();
  },

  async writePlanBlocksToCalendar(date: string, blocks: PlanBlock[]): Promise<number> {
    if (!isDesktop()) return 0;
    return activityIpc.writePlanBlocksToCalendar(date, blocks);
  },

  async getTrackingOverview(): Promise<TrackingOverview> {
    if (!isDesktop()) {
      return {
        isTracking: false,
        activeApp: '',
        activeTitle: '',
        activeIgnored: false,
        currentBlockTitle: '',
        currentBlockMinutes: 0,
        minCalendarMinutes: 1,
        calendarSyncEnabled: false,
        calendarPending: false,
        calendarSyncRunning: false,
        lastCalendarWriteCount: 0,
        todayActivityCount: 0,
        todayCapturedMinutes: 0,
      };
    }
    return settingsIpc.getTrackingOverview();
  },

  async getTrackingRuntimeStatus(): Promise<TrackingRuntimeStatus | null> {
    if (!isDesktop()) return null;
    return withTimeout(activityIpc.getTrackingRuntimeStatus(), 1500, () => null);
  },

  async getWeekContext(): Promise<WeekContext> {
    if (!isDesktop()) {
      return { goals: [], calendar_events: [], reminders: [], warnings: ['浏览器预览无法读取本机目标、日历和提醒事项。'] };
    }
    return activityIpc.getWeekContext();
  },

  async getContextRange(startDate: string, endDate: string): Promise<WeekContext> {
    if (!isDesktop()) {
      return { goals: [], calendar_events: [], reminders: [], warnings: ['浏览器预览无法读取本机目标、日历和提醒事项。'] };
    }
    return activityIpc.getContextRange(startDate, endDate);
  },

  async getContextSources(
    startDate: string,
    endDate: string,
    includeGoals: boolean,
    includeCalendar: boolean,
    includeReminders: boolean,
    options?: RequestOptions,
  ): Promise<WeekContext> {
    if (!isDesktop()) {
      return { goals: [], calendar_events: [], reminders: [], warnings: ['浏览器预览无法读取本机目标、日历和提醒事项。'] };
    }
    const key = buildContextKey(startDate, endDate, includeGoals, includeCalendar, includeReminders);
    if (!options?.fresh) {
      const cached = readCache(contextCache, key);
      if (cached) return cached;
    }
    const inflight = options?.fresh ? contextFreshInflight : contextInflight;
    const pending = inflight.get(key);
    if (pending) return pending;

    const request = activityIpc.getContextSources(startDate, endDate, includeGoals, includeCalendar, includeReminders)
      .then((result) => writeCache(contextCache, key, result, RANGE_CACHE_TTL_MS))
      .catch((error) => {
        const fallback = peekCache(contextCache, key);
        if (fallback) {
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          '系统日历/提醒事项暂时读取较慢，当前先展示上一次成功结果。',
        ],
      } satisfies WeekContext;
    }
        if (error instanceof Error && error.message.includes('系统应用读取超时')) {
          return {
            goals: [],
            calendar_events: [],
            reminders: [],
            warnings: ['系统日历本次读取较慢，已先跳过，不影响当前页面浏览。'],
          } satisfies WeekContext;
        }
        throw error;
      })
      .finally(() => {
        if (inflight.get(key) === request) {
          inflight.delete(key);
        }
      });
    inflight.set(key, request);
    return request;
  },

  prefetchContextSources(
    startDate: string,
    endDate: string,
    includeGoals: boolean,
    includeCalendar: boolean,
    includeReminders: boolean,
  ): void {
    if (!isDesktop()) return;
    void this.getContextSources(startDate, endDate, includeGoals, includeCalendar, includeReminders).catch((error) => {
      console.error(error);
    });
  },
};

export default dataService;
