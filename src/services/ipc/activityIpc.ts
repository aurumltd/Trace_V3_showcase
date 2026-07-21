import { invoke } from '@tauri-apps/api/core';
import type { Activity, ActivityCorrectionInput, ActivityCategory, WeekContext } from '../dataService';
import type { PlanBlock } from '../../utils/planning';

interface BackendActivity {
  id: string;
  name: string;
  window_title: string;
  raw_window_title?: string | null;
  category: string | null;
  activity_type?: string | null;
  description?: string | null;
  focus_score?: number | null;
  context_key?: string | null;
  linked_reminder_title?: string | null;
  linked_reminder_source?: string | null;
  linked_calendar_title?: string | null;
  linked_calendar_source?: string | null;
  start_time_ms: number;
  duration_minutes: number;
}

function toActivity(activity: BackendActivity): Activity {
  const start = new Date(activity.start_time_ms);
  const end = new Date(activity.start_time_ms + activity.duration_minutes * 60_000);

  return {
    id: activity.id,
    name: activity.name,
    windowTitle: activity.window_title,
    rawWindowTitle: activity.raw_window_title || undefined,
    category: (activity.category || '其他') as ActivityCategory,
    activityType: activity.activity_type || undefined,
    description: activity.description || undefined,
    focusScore: activity.focus_score ?? undefined,
    contextKey: activity.context_key || undefined,
    linkedReminderTitle: activity.linked_reminder_title || undefined,
    linkedReminderSource: activity.linked_reminder_source || undefined,
    linkedCalendarTitle: activity.linked_calendar_title || undefined,
    linkedCalendarSource: activity.linked_calendar_source || undefined,
    startTime: toLocalDateTime(start),
    endTime: toLocalDateTime(end),
    duration: Math.round(activity.duration_minutes * 10) / 10,
    isManual: false,
  };
}

function toLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export async function getActivities(date: string): Promise<Activity[]> {
  const result = await invoke<BackendActivity[]>('get_activities_by_date', { dateStr: date });
  return result.map(toActivity);
}

export async function getActivitiesRange(startDate: string, endDate: string): Promise<Activity[]> {
  const result = await invoke<BackendActivity[]>('get_activities_by_range', { startDate, endDate });
  return result.map(toActivity);
}

export async function clearAllActivities(): Promise<void> {
  await invoke('clear_all_activities');
}

interface BackendCorrectionInput {
  description?: string;
  category?: string;
  activity_type?: string;
  context_key?: string;
  linked_reminder_title?: string;
  linked_reminder_source?: string;
  linked_calendar_title?: string;
  linked_calendar_source?: string;
}

interface BackendLearnedRule {
  app_name: string;
  activity_type: string;
  context_key: string;
  title: string;
  corrected_category: string;
  corrected_activity_type: string;
  corrected_context_key: string;
  corrected_description: string;
  updated_at_ms: number;
}

interface BackendTrackingRuntimeStatus {
  is_tracking: boolean;
  recovery_active: boolean;
  recovery_until_ms?: number | null;
  last_recovery_at_ms?: number | null;
  last_recovery_gap_ms?: number | null;
  last_recovery_reason?: string | null;
  calendar_permission_backoff_active: boolean;
  calendar_permission_backoff_until_ms?: number | null;
}

function toLearnedRule(rule: BackendLearnedRule) {
  return {
    appName: rule.app_name,
    activityType: rule.activity_type,
    contextKey: rule.context_key,
    title: rule.title,
    correctedCategory: rule.corrected_category,
    correctedActivityType: rule.corrected_activity_type,
    correctedContextKey: rule.corrected_context_key,
    correctedDescription: rule.corrected_description,
    updatedAtMs: rule.updated_at_ms,
  };
}

export async function saveActivityCorrections(activityIds: string[], correction: ActivityCorrectionInput): Promise<Activity[]> {
  const result = await invoke<BackendActivity[]>('save_activity_corrections', {
    activityIds,
    correction: {
      description: correction.description,
      category: correction.category,
      activity_type: correction.activityType,
      context_key: correction.contextKey,
      linked_reminder_title: correction.linkedReminderTitle,
      linked_reminder_source: correction.linkedReminderSource,
      linked_calendar_title: correction.linkedCalendarTitle,
      linked_calendar_source: correction.linkedCalendarSource,
    } satisfies BackendCorrectionInput,
  });
  return result.map(toActivity);
}

export async function getLearnedRules() {
  const result = await invoke<BackendLearnedRule[]>('get_learned_rules');
  return result.map(toLearnedRule);
}

export async function clearLearnedRules(): Promise<void> {
  await invoke('clear_learned_rules');
}

export async function generateAiSummary(prompt: string, model: 'qwen3:1.7b' | 'qwen3:4b'): Promise<string> {
  return invoke<string>('generate_ai_summary', { prompt, model });
}

export async function getReminderLists(): Promise<string[]> {
  return invoke<string[]>('get_reminder_lists');
}

export async function syncCalendarToday(): Promise<number> {
  return invoke<number>('sync_calendar_today');
}

export async function queueCalendarSync(): Promise<boolean> {
  return invoke<boolean>('queue_calendar_sync');
}

export async function getTrackingRuntimeStatus() {
  return invoke<BackendTrackingRuntimeStatus>('get_tracking_runtime_status');
}

export async function writePlanBlocksToCalendar(date: string, blocks: PlanBlock[]): Promise<number> {
  return invoke<number>('write_plan_blocks_to_calendar', {
    date,
    blocks: blocks.map((item) => ({
      title: item.title,
      start_time_ms: new Date(item.startTime).getTime(),
      end_time_ms: new Date(item.endTime).getTime(),
      source_reminder: item.sourceReminder,
      rationale: item.rationale,
    })),
  });
}

export async function getWeekContext(): Promise<WeekContext> {
  return invoke<WeekContext>('get_week_context');
}

export async function getContextRange(startDate: string, endDate: string): Promise<WeekContext> {
  return invoke<WeekContext>('get_context_for_range', { startDate, endDate });
}

export async function getContextSources(
  startDate: string,
  endDate: string,
  includeGoals: boolean,
  includeCalendar: boolean,
  includeReminders: boolean,
): Promise<WeekContext> {
  return invoke<WeekContext>('get_context_sources', {
    startDate,
    endDate,
    includeGoals,
    includeCalendar,
    includeReminders,
  });
}
