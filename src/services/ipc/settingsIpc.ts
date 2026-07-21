import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../dataService';

interface BackendSettings {
  theme?: 'light' | 'dark';
  auto_start_tracking?: boolean;
  calendar_sync_enabled?: boolean;
  calendar_insights_enabled?: boolean;
  calendar_name?: string;
  min_activity_minutes?: number;
  merge_gap_minutes?: number;
  activity_refresh_minutes?: number;
  calendar_sync_interval_minutes?: number;
  ignored_applications?: string[];
  reminders_enabled?: boolean;
  reminder_lists?: string[];
  ai_summaries_enabled?: boolean;
  ai_summary_model?: 'qwen3:1.7b' | 'qwen3:4b';
  ai_summary_refresh_hours?: number;
  category_rules_draft?: string;
  category_rules_version?: number;
  goal_metric_mode?: 'reminders';
}

interface BackendTrackingOverview {
  is_tracking: boolean;
  active_app: string;
  active_title: string;
  active_ignored: boolean;
  last_capture_at_ms?: number | null;
  current_block_title: string;
  current_block_minutes: number;
  min_calendar_minutes: number;
  calendar_sync_enabled: boolean;
  calendar_pending: boolean;
  calendar_sync_running: boolean;
  last_calendar_sync_at_ms?: number | null;
  last_calendar_sync_error?: string | null;
  last_calendar_write_count: number;
  today_activity_count: number;
  today_captured_minutes: number;
}

function normalizeSummaryModel(
  value: BackendSettings['ai_summary_model'],
  fallback: AppSettings['aiSummaryModel'],
): AppSettings['aiSummaryModel'] {
  if (value === 'qwen3:1.7b' || value === 'qwen3:4b') return value;
  return fallback;
}

function normalizeActivityRefreshMinutes(value: number | undefined, fallback: 1 | 5 | 15 | 30 | 60): 1 | 5 | 15 | 30 | 60 {
  if (value === 1 || value === 5 || value === 15 || value === 30 || value === 60) return value;
  return fallback;
}

function normalizeCalendarRefreshMinutes(value: number | undefined, fallback: 5 | 15 | 30 | 60): 5 | 15 | 30 | 60 {
  if (value === 5 || value === 15 || value === 30 || value === 60) return value;
  return fallback;
}

function normalizeSummaryRefreshHours(value: number | undefined, fallback: 2 | 4 | 6 | 12): 2 | 4 | 6 | 12 {
  if (value === 2 || value === 4 || value === 6 || value === 12) return value;
  return fallback;
}

function fromBackend(settings: BackendSettings, fallback: AppSettings): AppSettings {
  return {
    theme: settings.theme ?? fallback.theme,
    autoStartTracking: false,
    calendarSyncEnabled: settings.calendar_sync_enabled ?? fallback.calendarSyncEnabled,
    calendarInsightsEnabled: settings.calendar_insights_enabled ?? fallback.calendarInsightsEnabled,
    calendarName: settings.calendar_name ?? fallback.calendarName,
    minActivityMinutes: settings.min_activity_minutes ?? fallback.minActivityMinutes,
    mergeGapMinutes: settings.merge_gap_minutes ?? fallback.mergeGapMinutes,
    activityRefreshMinutes: normalizeActivityRefreshMinutes(settings.activity_refresh_minutes, fallback.activityRefreshMinutes),
    calendarSyncIntervalMinutes: normalizeCalendarRefreshMinutes(settings.calendar_sync_interval_minutes, fallback.calendarSyncIntervalMinutes),
    ignoredApplications: settings.ignored_applications ?? fallback.ignoredApplications,
    remindersEnabled: settings.reminders_enabled ?? fallback.remindersEnabled,
    reminderLists: settings.reminder_lists ?? fallback.reminderLists,
    aiSummariesEnabled: settings.ai_summaries_enabled ?? fallback.aiSummariesEnabled,
    aiSummaryModel: normalizeSummaryModel(settings.ai_summary_model, fallback.aiSummaryModel),
    aiSummaryRefreshHours: normalizeSummaryRefreshHours(settings.ai_summary_refresh_hours, fallback.aiSummaryRefreshHours),
    categoryRulesDraft: settings.category_rules_draft ?? fallback.categoryRulesDraft,
    categoryRulesVersion: settings.category_rules_version ?? fallback.categoryRulesVersion,
    goalMetricMode: settings.goal_metric_mode ?? fallback.goalMetricMode,
  };
}

function toBackend(settings: Partial<AppSettings>): BackendSettings {
  return {
    theme: settings.theme,
    auto_start_tracking: false,
    calendar_sync_enabled: settings.calendarSyncEnabled,
    calendar_insights_enabled: settings.calendarInsightsEnabled,
    calendar_name: settings.calendarName,
    min_activity_minutes: settings.minActivityMinutes,
    merge_gap_minutes: settings.mergeGapMinutes,
    activity_refresh_minutes: settings.activityRefreshMinutes,
    calendar_sync_interval_minutes: settings.calendarSyncIntervalMinutes,
    ignored_applications: settings.ignoredApplications,
    reminders_enabled: settings.remindersEnabled,
    reminder_lists: settings.reminderLists,
    ai_summaries_enabled: settings.aiSummariesEnabled,
    ai_summary_model: settings.aiSummaryModel,
    ai_summary_refresh_hours: settings.aiSummaryRefreshHours,
    category_rules_draft: settings.categoryRulesDraft,
    category_rules_version: settings.categoryRulesVersion,
    goal_metric_mode: settings.goalMetricMode,
  };
}

export async function getSettings(fallback: AppSettings): Promise<AppSettings> {
  const result = await invoke<BackendSettings>('get_settings');
  return fromBackend(result, fallback);
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const result = await invoke<BackendSettings>('save_settings', { settings: toBackend(settings) });
  return fromBackend(result, {
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
  });
}

export async function toggleTracking(enable: boolean): Promise<boolean> {
  return invoke<boolean>('toggle_tracking', { enable });
}

export async function checkTrackingStatus(): Promise<boolean> {
  return invoke<boolean>('check_tracking_status');
}

export interface TrackingOverview {
  isTracking: boolean;
  activeApp: string;
  activeTitle: string;
  activeIgnored: boolean;
  lastCaptureAtMs?: number;
  currentBlockTitle: string;
  currentBlockMinutes: number;
  minCalendarMinutes: number;
  calendarSyncEnabled: boolean;
  calendarPending: boolean;
  calendarSyncRunning: boolean;
  lastCalendarSyncAtMs?: number;
  lastCalendarSyncError?: string;
  lastCalendarWriteCount: number;
  todayActivityCount: number;
  todayCapturedMinutes: number;
}

export async function getTrackingOverview(): Promise<TrackingOverview> {
  const result = await invoke<BackendTrackingOverview>('get_tracking_overview');
  return {
    isTracking: result.is_tracking,
    activeApp: result.active_app,
    activeTitle: result.active_title,
    activeIgnored: result.active_ignored,
    lastCaptureAtMs: result.last_capture_at_ms ?? undefined,
    currentBlockTitle: result.current_block_title,
    currentBlockMinutes: result.current_block_minutes,
    minCalendarMinutes: result.min_calendar_minutes,
    calendarSyncEnabled: result.calendar_sync_enabled,
    calendarPending: result.calendar_pending,
    calendarSyncRunning: result.calendar_sync_running,
    lastCalendarSyncAtMs: result.last_calendar_sync_at_ms ?? undefined,
    lastCalendarSyncError: result.last_calendar_sync_error ?? undefined,
    lastCalendarWriteCount: result.last_calendar_write_count,
    todayActivityCount: result.today_activity_count,
    todayCapturedMinutes: result.today_captured_minutes,
  };
}
