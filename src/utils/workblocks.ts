import type { Activity, ContextItem, WeekContext } from '../services/dataService.js';

export interface Workblock {
  id: string;
  activityIds: string[];
  startTime: string;
  endTime: string;
  duration: number;
  title: string;
  category: Activity['category'];
  activityType: string;
  contextKey: string;
  focusScore: number;
  appNames: string[];
  evidence: string[];
  activities: Activity[];
  matchedReminder?: ContextItem;
  matchedCalendarEvent?: ContextItem;
  linkedReminderTitle?: string;
  linkedReminderSource?: string;
  linkedCalendarTitle?: string;
  linkedCalendarSource?: string;
  reviewPriority: number;
  reviewReason: string;
  isLowValue: boolean;
  highlightScore: number;
  highlightReason: string;
}

export interface DailyDigest {
  totalMinutes: number;
  focusedMinutes: number;
  focusRatio: number;
  matchedReminderMinutes: number;
  plannedCoverage: number;
  offtrackMinutes: number;
  longestBlock: Workblock | null;
  fragmentationScore: number;
  matchedReminders: Array<{ item: ContextItem; minutes: number; blocks: Workblock[] }>;
  unmatchedReminders: ContextItem[];
  unplannedBlocks: Workblock[];
  lowValueBlocks: Workblock[];
  driftLabel: string;
  suggestions: string[];
  summary: string;
}

const FOCUS_CATEGORIES = new Set(['开发', '工作', '学习']);
const LOW_VALUE_CATEGORIES = new Set(['娱乐', '休息', '浏览网页']);
const CATEGORY_VALUES = new Set<Activity['category']>(['开发', '工作', '学习', '会议', '沟通', '浏览网页', '整理文件', '提醒事项', '休息', '娱乐', '其他']);
const PRODUCTIVE_APP_HINTS = ['editor', 'ide', 'terminal', 'browser', 'document', 'notes', 'research', 'design'];
const UTILITY_APP_HINTS = [
  'calendar',
  '日历',
  'reminders',
  '提醒事项',
  'clock',
  '时钟',
  'clash',
  'clashx',
  'clashfx',
  'system settings',
  '系统设置',
  'finder',
  '访达',
];
const GENERIC_TASK_TOKENS = new Set([
  '进行', '处理', '查看', '使用', '工作', '开发', '学习', '研究', '浏览', '网页', '内容', '任务', 'app',
  'editor', 'terminal', 'browser', 'document', 'calendar', 'window', 'page', 'pages', 'info',
]);
export const MANUAL_UNLINKED_REMINDER_SOURCE = 'trace://manual-unlinked-reminder';
export const MANUAL_UNLINKED_CALENDAR_SOURCE = 'trace://manual-unlinked-calendar';

type CategoryRule = {
  category: Activity['category'];
  keywords: string[];
};

export function formatMinutes(minutes: number): string {
  if (minutes > 0 && minutes < 1) return `${Math.round(minutes * 10) / 10} 分钟`;
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours === 0) return `${mins} 分钟`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分钟`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
}

function titleFromActivity(activity: Activity): string {
  if (activity.description?.trim()) return activity.description.trim();
  if (activity.windowTitle && activity.windowTitle !== activity.name) return activity.windowTitle.trim();
  return activity.name;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .filter((token) => token.length >= 2)
    .filter((token) => !['using', 'with', 'from', 'into', 'this', 'that', '进行', '处理', '查看', '使用'].includes(token));
}

function overlapScore(source: string, target: string): number {
  const sourceTokens = tokenize(source);
  const targetTokens = tokenize(target);
  if (sourceTokens.length === 0 || targetTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  let matches = 0;
  for (const token of sourceTokens) {
    if (targetSet.has(token)) matches += 1;
  }
  const direct = normalizeText(source);
  const directTarget = normalizeText(target);
  if (direct && directTarget && (direct.includes(directTarget) || directTarget.includes(direct))) {
    matches += 2;
  }
  return matches;
}

function inferActivityMergeCluster(activity: Activity): string {
  const combined = [
    activity.name,
    activity.windowTitle,
    activity.rawWindowTitle || '',
    activity.description || '',
    activity.contextKey || '',
    activity.activityType || '',
  ].join(' ').toLowerCase();

  if (['产品', '方案', '需求', '设计', '路线图', '指标'].some((keyword) => combined.includes(keyword))) {
    return 'product-work';
  }
  if (['项目推进', '项目', '文档', 'document', 'meeting', '沟通', '知识库', '资料', '计划'].some((keyword) => combined.includes(keyword))) {
    return 'project-work';
  }
  if (
    ['代码', '开发', '调试', '构建', '发布', 'terminal', 'editor', 'ide'].some((keyword) => combined.includes(keyword))
    && ['ai 编程', '编写代码', '命令行开发', '代码协作', '调试修复', '搜索资料', '文档整理', '开发', '研究', '产品', 'app'].some((keyword) => combined.includes(keyword))
  ) {
    return 'build-flow';
  }

  return '';
}

function inferBlockMergeCluster(block: Workblock): string {
  const combined = [block.title, block.contextKey, block.activityType, block.category, ...block.appNames, ...block.evidence].join(' ').toLowerCase();
  if (['产品', '方案', '需求', '设计', '路线图', '指标'].some((keyword) => combined.includes(keyword))) {
    return 'product-work';
  }
  if (['项目推进', '项目', '文档', 'document', 'meeting', '沟通', '知识库', '资料', '计划'].some((keyword) => combined.includes(keyword))) {
    return 'project-work';
  }
  if (
    ['代码', '开发', '调试', '构建', '发布', 'terminal', 'editor', 'ide'].some((keyword) => combined.includes(keyword))
    && ['ai 编程', '编写代码', '命令行开发', '代码协作', '调试修复', '搜索资料', '文档整理', '开发', '研究', '产品', 'app'].some((keyword) => combined.includes(keyword))
  ) {
    return 'build-flow';
  }

  return '';
}

function isBackgroundCompanionActivity(activity: Activity): boolean {
  const combined = [activity.name, activity.windowTitle, activity.rawWindowTitle || ''].join(' ').toLowerCase();
  return ['网易云音乐', 'netease music', 'music', 'spotify', 'apple music', 'qq 音乐', 'qqmusic'].some((keyword) =>
    combined.includes(keyword.toLowerCase()),
  );
}

function isUtilityCompanionActivity(activity: Activity): boolean {
  const combined = [activity.name, activity.windowTitle, activity.rawWindowTitle || '', activity.description || ''].join(' ').toLowerCase();
  return UTILITY_APP_HINTS.some((keyword) => combined.includes(keyword.toLowerCase()));
}

function contextCandidates(activity: Activity): string[] {
  return [
    activity.description || '',
    activity.contextKey || '',
    activity.activityType || '',
    activity.windowTitle || '',
    activity.rawWindowTitle || '',
    activity.name || '',
  ].filter(Boolean);
}

function focusLikeCategory(category: Activity['category']): boolean {
  return FOCUS_CATEGORIES.has(category) || category === '浏览网页';
}

function isMeaningfulPlannedBlock(block: Workblock): boolean {
  if (!block.matchedReminder) return false;
  if (FOCUS_CATEGORIES.has(block.category)) return true;
  if (block.category === '浏览网页' && block.focusScore >= 60) return true;
  return !block.isLowValue && block.focusScore >= 68;
}

function isProductiveApp(name: string): boolean {
  const lower = name.toLowerCase();
  return PRODUCTIVE_APP_HINTS.some((keyword) => lower.includes(keyword));
}

function extractSemanticTokens(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    for (const token of tokenize(value)) {
      if (GENERIC_TASK_TOKENS.has(token)) continue;
      if (!output.includes(token)) output.push(token);
    }
  }
  return output.slice(0, 8);
}

function semanticOverlap(leftValues: string[], rightValues: string[]): number {
  const left = extractSemanticTokens(leftValues);
  const rightSet = new Set(extractSemanticTokens(rightValues));
  let score = 0;
  for (const token of left) {
    if (rightSet.has(token)) score += 1;
  }
  return score;
}

function inferActivitySemanticKey(activity: Activity): string {
  const tokens = extractSemanticTokens(contextCandidates(activity));
  if (tokens.length === 0) return '';
  return tokens.slice(0, 3).join(' ');
}

function inferBlockSemanticKey(block: Workblock): string {
  const tokens = extractSemanticTokens([block.title, block.contextKey, block.activityType, ...block.evidence]);
  if (tokens.length === 0) return '';
  return tokens.slice(0, 3).join(' ');
}

function shouldMergeCrossWindowTaskFlow(last: Workblock, activity: Activity, gapMinutes: number, mergeGapMinutes: number): boolean {
  if (gapMinutes > Math.max(mergeGapMinutes, 8)) return false;
  if (!focusLikeCategory(last.category) || !focusLikeCategory(activity.category)) return false;

  const blockSemanticKey = inferBlockSemanticKey(last);
  const activitySemanticKey = inferActivitySemanticKey(activity);
  const overlap = semanticOverlap([last.title, last.contextKey, last.activityType, ...last.evidence], contextCandidates(activity));
  const semanticKeyMatch = Boolean(blockSemanticKey && activitySemanticKey && blockSemanticKey === activitySemanticKey);
  const productiveFlow = last.appNames.some(isProductiveApp) && isProductiveApp(activity.name);

  if (semanticKeyMatch && productiveFlow) return true;
  if (overlap >= 2 && productiveFlow) return true;
  if (overlap >= 3) return true;
  return false;
}

function shouldMergeSameUserTaskBridge(last: Workblock, activity: Activity, gapMinutes: number, mergeGapMinutes: number): boolean {
  if (gapMinutes > Math.max(mergeGapMinutes, 6)) return false;
  if (!focusLikeCategory(last.category) || !focusLikeCategory(activity.category)) return false;

  const lastCluster = inferBlockMergeCluster(last);
  const activityCluster = inferActivityMergeCluster(activity);
  const clusterMatch = Boolean(lastCluster && activityCluster && lastCluster === activityCluster);
  const productiveFlow = last.appNames.some(isProductiveApp) && isProductiveApp(activity.name);
  if (!productiveFlow && !clusterMatch) return false;

  const categoryStable =
    last.category === activity.category ||
    (FOCUS_CATEGORIES.has(last.category) && FOCUS_CATEGORIES.has(activity.category));
  if (!categoryStable && !clusterMatch) return false;

  const overlap = semanticOverlap(
    [last.title, last.contextKey, last.activityType, ...last.evidence],
    contextCandidates(activity),
  );
  const sameSemanticKey = Boolean(
    inferBlockSemanticKey(last) &&
    inferActivitySemanticKey(activity) &&
    inferBlockSemanticKey(last) === inferActivitySemanticKey(activity),
  );
  const shortHop = gapMinutes <= Math.min(Math.max(mergeGapMinutes, 4), 6);
  const appHandoff = !last.appNames.includes(activity.name) && last.appNames.length <= 4;

  return Boolean(
    clusterMatch ||
    sameSemanticKey ||
    overlap >= 1 && shortHop && appHandoff,
  );
}

function parseCategoryRulesDraft(raw: string): CategoryRule[] {
  if (!raw) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, rest] = line.split('：');
      const category = label?.trim() as Activity['category'] | undefined;
      if (!category || !CATEGORY_VALUES.has(category) || !rest) return null;
      const keywords = rest
        .split(/[、,，]/)
        .map((keyword) => normalizeText(keyword))
        .filter((keyword) => keyword.length >= 2);
      if (keywords.length === 0) return null;
      return { category, keywords };
    })
    .filter((rule): rule is CategoryRule => Boolean(rule));
}

function inferCategoryFromRules(block: Workblock, rules: CategoryRule[]): Activity['category'] | null {
  if (rules.length === 0) return null;
  const candidateText = normalizeText([block.title, block.activityType, block.contextKey, ...block.appNames, ...block.evidence].join(' '));
  if (!candidateText) return null;

  let bestCategory: Activity['category'] | null = null;
  let bestScore = 0;
  for (const rule of rules) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (candidateText.includes(keyword)) score += Math.max(2, keyword.length);
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  if (bestScore < 2) return null;
  return bestCategory;
}

function applyCategoryRules(blocks: Workblock[], categoryRulesDraft?: string): Workblock[] {
  const rules = parseCategoryRulesDraft(categoryRulesDraft || '');
  if (rules.length === 0) return blocks;

  return blocks.map((block) => {
    const inferredCategory = inferCategoryFromRules(block, rules);
    if (!inferredCategory || inferredCategory === block.category) return block;

    const shouldOverride =
      block.category === '其他' ||
      block.category === '浏览网页' ||
      block.category === '整理文件' ||
      (FOCUS_CATEGORIES.has(inferredCategory) && !FOCUS_CATEGORIES.has(block.category));

    if (!shouldOverride) return block;

    return {
      ...block,
      category: inferredCategory,
      activityType: block.activityType === block.category ? inferredCategory : block.activityType,
    };
  });
}

export function aggregateWorkblocks(activities: Activity[], mergeGapMinutes = 3, categoryRulesDraft?: string): Workblock[] {
  const sorted = [...activities]
    .filter((activity) => activity.duration >= 0.05 && activity.name.trim())
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const blocks: Workblock[] = [];

  for (const activity of sorted) {
    const last = blocks[blocks.length - 1];
    const currentTitle = titleFromActivity(activity);
    const currentContext = activity.contextKey || activity.activityType || currentTitle;
    if (!last) {
      blocks.push({
        id: activity.id,
        activityIds: [activity.id],
        startTime: activity.startTime,
        endTime: activity.endTime,
        duration: activity.duration,
        title: currentTitle,
        category: activity.category,
        activityType: activity.activityType || activity.category,
        contextKey: currentContext,
        focusScore: activity.focusScore || 50,
        appNames: [activity.name],
        evidence: Array.from(new Set(contextCandidates(activity))).slice(0, 6),
        activities: [{ ...activity }],
        linkedReminderTitle: activity.linkedReminderTitle,
        linkedReminderSource: activity.linkedReminderSource,
        linkedCalendarTitle: activity.linkedCalendarTitle,
        linkedCalendarSource: activity.linkedCalendarSource,
        reviewPriority: 0,
        reviewReason: '',
        isLowValue: LOW_VALUE_CATEGORIES.has(activity.category),
        highlightScore: 0,
        highlightReason: '',
      });
      continue;
    }

    const gapMinutes = Math.max(0, (new Date(activity.startTime).getTime() - new Date(last.endTime).getTime()) / 60_000);
    const sameContext = Boolean(activity.contextKey && last.contextKey && activity.contextKey === last.contextKey);
    const sameTitle = normalizeText(currentTitle) === normalizeText(last.title);
    const sameApp = last.appNames.includes(activity.name);
    const sameCluster = Boolean(inferActivityMergeCluster(activity) && inferActivityMergeCluster(activity) === inferBlockMergeCluster(last));
    const relatedTitle = overlapScore(currentTitle, last.title) >= 2 || overlapScore(currentTitle, last.contextKey) >= 2;
    const crossWindowTaskFlow = shouldMergeCrossWindowTaskFlow(last, activity, gapMinutes, mergeGapMinutes);
    const sameTaskBridge = shouldMergeSameUserTaskBridge(last, activity, gapMinutes, mergeGapMinutes);
    const backgroundBridge = isBackgroundCompanionActivity(activity)
      && gapMinutes <= Math.min(mergeGapMinutes, 2)
      && (FOCUS_CATEGORIES.has(last.category) || Boolean(inferBlockMergeCluster(last)));
    const utilityBridge = isUtilityCompanionActivity(activity)
      && activity.duration <= 4
      && gapMinutes <= Math.max(mergeGapMinutes, 5)
      && (FOCUS_CATEGORIES.has(last.category) || Boolean(inferBlockMergeCluster(last)));
    const shouldMerge = gapMinutes <= Math.max(mergeGapMinutes, 5)
      && (sameContext || sameTitle || sameApp || sameCluster || relatedTitle || backgroundBridge || utilityBridge || crossWindowTaskFlow || sameTaskBridge);

    if (!shouldMerge) {
      blocks.push({
        id: activity.id,
        activityIds: [activity.id],
        startTime: activity.startTime,
        endTime: activity.endTime,
        duration: activity.duration,
        title: currentTitle,
        category: activity.category,
        activityType: activity.activityType || activity.category,
        contextKey: currentContext,
        focusScore: activity.focusScore || 50,
        appNames: [activity.name],
        evidence: Array.from(new Set(contextCandidates(activity))).slice(0, 6),
        activities: [{ ...activity }],
        linkedReminderTitle: activity.linkedReminderTitle,
        linkedReminderSource: activity.linkedReminderSource,
        linkedCalendarTitle: activity.linkedCalendarTitle,
        linkedCalendarSource: activity.linkedCalendarSource,
        reviewPriority: 0,
        reviewReason: '',
        isLowValue: LOW_VALUE_CATEGORIES.has(activity.category),
        highlightScore: 0,
        highlightReason: '',
      });
      continue;
    }

    last.endTime = activity.endTime > last.endTime ? activity.endTime : last.endTime;
    last.duration = Math.round((last.duration + activity.duration) * 10) / 10;
    last.activityIds.push(activity.id);
    last.activities.push({ ...activity });
    last.focusScore = Math.round(
      last.activities.reduce((sum, item) => sum + (item.focusScore || 50) * item.duration, 0) /
      Math.max(last.activities.reduce((sum, item) => sum + item.duration, 0), 0.1),
    );

    if (activity.duration >= Math.max(...last.activities.map((item) => item.duration))) {
      last.title = currentTitle;
      last.category = activity.category;
      last.activityType = activity.activityType || activity.category;
      last.contextKey = currentContext;
    }

    if (!last.appNames.includes(activity.name)) last.appNames.push(activity.name);
    last.evidence = Array.from(new Set([...last.evidence, ...contextCandidates(activity)])).slice(0, 8);
    last.linkedReminderTitle = last.linkedReminderTitle || activity.linkedReminderTitle;
    last.linkedReminderSource = last.linkedReminderSource || activity.linkedReminderSource;
    last.linkedCalendarTitle = last.linkedCalendarTitle || activity.linkedCalendarTitle;
    last.linkedCalendarSource = last.linkedCalendarSource || activity.linkedCalendarSource;
    last.isLowValue = last.isLowValue && LOW_VALUE_CATEGORIES.has(activity.category);
  }

  return applyCategoryRules(collapseBridgeBlocks(blocks.sort((a, b) => a.startTime.localeCompare(b.startTime)), mergeGapMinutes), categoryRulesDraft);
}

function canBridgeNeighborTasks(left: Workblock, right: Workblock, mergeGapMinutes: number): boolean {
  const gapMinutes = Math.max(0, (new Date(right.startTime).getTime() - new Date(left.endTime).getTime()) / 60_000);
  if (gapMinutes > Math.max(mergeGapMinutes, 8)) return false;
  if (normalizeText(left.title) === normalizeText(right.title)) return true;
  if (left.contextKey && right.contextKey && left.contextKey === right.contextKey) return true;
  if (inferBlockMergeCluster(left) && inferBlockMergeCluster(left) === inferBlockMergeCluster(right)) return true;
  if (semanticOverlap([left.title, left.contextKey, left.activityType, ...left.evidence], [right.title, right.contextKey, right.activityType, ...right.evidence]) >= 2) {
    return true;
  }
  return false;
}

function isUtilityBridgeBlock(block: Workblock): boolean {
  if (block.duration > 4) return false;
  const values = [block.title, block.activityType, block.contextKey, ...block.appNames, ...block.evidence].join(' ').toLowerCase();
  return UTILITY_APP_HINTS.some((keyword) => values.includes(keyword.toLowerCase()));
}

function mergeBlockInto(target: Workblock, source: Workblock): Workblock {
  const sourceMinutes = source.activities.reduce((sum, item) => sum + item.duration, 0);
  const targetMinutesBefore = target.activities.reduce((sum, item) => sum + item.duration, 0);
  const totalMinutes = Math.max(target.duration + source.duration, 0.1);
  target.startTime = target.startTime < source.startTime ? target.startTime : source.startTime;
  target.endTime = target.endTime > source.endTime ? target.endTime : source.endTime;
  target.duration = Math.round(totalMinutes * 10) / 10;
  target.activityIds = Array.from(new Set([...target.activityIds, ...source.activityIds]));
  target.activities = [...target.activities, ...source.activities].sort((a, b) => a.startTime.localeCompare(b.startTime));
  target.focusScore = Math.round(
    ((target.focusScore * Math.max(targetMinutesBefore, 0.1)) + (source.focusScore * Math.max(sourceMinutes, 0.1))) /
    Math.max(totalMinutes, 0.1),
  );
  target.appNames = Array.from(new Set([...target.appNames, ...source.appNames]));
  target.evidence = Array.from(new Set([...target.evidence, ...source.evidence])).slice(0, 8);
  target.linkedReminderTitle = target.linkedReminderTitle || source.linkedReminderTitle;
  target.linkedReminderSource = target.linkedReminderSource || source.linkedReminderSource;
  target.linkedCalendarTitle = target.linkedCalendarTitle || source.linkedCalendarTitle;
  target.linkedCalendarSource = target.linkedCalendarSource || source.linkedCalendarSource;
  target.isLowValue = target.isLowValue && source.isLowValue;
  return target;
}

function collapseBridgeBlocks(blocks: Workblock[], mergeGapMinutes: number): Workblock[] {
  if (blocks.length <= 2) return blocks;
  const next = [...blocks];
  for (let index = 1; index < next.length - 1; index += 1) {
    const current = next[index];
    const previous = next[index - 1];
    const following = next[index + 1];
    if (current.duration <= 0.75 && previous) {
      const gapToPrevious = Math.max(0, (new Date(current.startTime).getTime() - new Date(previous.endTime).getTime()) / 60_000);
      if (gapToPrevious <= Math.max(mergeGapMinutes, 8)) {
        mergeBlockInto(previous, current);
        next.splice(index, 1);
        index -= 1;
        continue;
      }
    }
    if (!isUtilityBridgeBlock(current)) continue;
    if (!previous || !following) continue;
    if (!canBridgeNeighborTasks(previous, following, mergeGapMinutes)) continue;
    mergeBlockInto(previous, current);
    mergeBlockInto(previous, following);
    next.splice(index, 2);
    index -= 1;
  }
  return next;
}

export function alignWorkblocksWithContext(workblocks: Workblock[], context: WeekContext): Workblock[] {
  const reminders = [...context.reminders];
  const calendarEvents = [...context.calendar_events];
  const reminderUsage = new Map<string, number>();

  return workblocks.map((block) => {
    const candidateText = [block.title, block.contextKey, block.activityType, ...block.evidence].join(' ');
    const blockStartMs = new Date(block.startTime).getTime();
    const blockEndMs = new Date(block.endTime).getTime();
    let bestReminder: ContextItem | undefined;
    let bestReminderScore = 0;
    for (const reminder of reminders) {
      if (hasExplicitReminderLink(block) && reminder.title === block.linkedReminderTitle) {
        bestReminder = reminder;
        bestReminderScore = 99;
        break;
      }
      if (isReminderLinkSuppressed(block.linkedReminderSource)) {
        continue;
      }
      const score = overlapScore(candidateText, reminder.title);
      const penalty = reminderUsage.get(reminder.title) || 0;
      const adjusted = score - penalty;
      if (adjusted > bestReminderScore) {
        bestReminder = reminder;
        bestReminderScore = adjusted;
      }
    }
    if (bestReminder && bestReminderScore >= 2) {
      reminderUsage.set(bestReminder.title, (reminderUsage.get(bestReminder.title) || 0) + 1);
    } else {
      bestReminder = undefined;
    }
    if (!bestReminder && hasExplicitReminderLink(block)) {
      bestReminder = {
        title: block.linkedReminderTitle!,
        source: block.linkedReminderSource || '提醒事项/手动关联',
      };
    }

    let bestCalendarEvent: ContextItem | undefined;
    let bestCalendarScore = 0;
    for (const event of calendarEvents) {
      if (hasExplicitCalendarLink(block) && event.title === block.linkedCalendarTitle) {
        bestCalendarEvent = event;
        bestCalendarScore = 99;
        break;
      }
      if (isCalendarLinkSuppressed(block.linkedCalendarSource)) {
        continue;
      }
      const titleScore = overlapScore(candidateText, event.title);
      const overlapStart = event.startTimeMs ? Math.max(blockStartMs, event.startTimeMs) : 0;
      const overlapEnd = event.endTimeMs ? Math.min(blockEndMs, event.endTimeMs) : 0;
      const overlapMinutes = overlapEnd > overlapStart ? (overlapEnd - overlapStart) / 60_000 : 0;
      const score = titleScore + (overlapMinutes >= 10 ? 3 : overlapMinutes >= 3 ? 1 : 0);
      if (score > bestCalendarScore) {
        bestCalendarEvent = event;
        bestCalendarScore = score;
      }
    }
    if (bestCalendarScore < 2) {
      bestCalendarEvent = undefined;
    }
    if (!bestCalendarEvent && hasExplicitCalendarLink(block)) {
      bestCalendarEvent = {
        title: block.linkedCalendarTitle!,
        source: block.linkedCalendarSource || 'Calendar/手动关联',
      };
    }

    let reviewPriority = 0;
    let reviewReason = '';
    if (!bestReminder && FOCUS_CATEGORIES.has(block.category)) {
      reviewPriority += Math.min(Math.round(block.duration / 10), 6);
      reviewPriority += block.focusScore >= 75 ? 2 : block.focusScore >= 60 ? 1 : 0;
      if (bestCalendarEvent) {
        reviewPriority += 1;
        reviewReason = '已匹配日历但仍未稳定归因到提醒事项';
      } else if (block.duration >= 45) {
        reviewPriority += 2;
        reviewReason = '连续高价值时段较长但没有计划归因';
      } else if (block.duration >= 20) {
        reviewReason = '有明显高价值投入但没有计划归因';
      } else {
        reviewReason = '值得快速检查是否需要归因';
      }
    }

    let highlightScore = 0;
    let highlightReason = '';
    if (bestReminder && block.duration >= 20) {
      highlightScore += 4;
      highlightReason = '推进了明确计划项';
    }
    if (block.duration >= 45) {
      highlightScore += 3;
      if (!highlightReason) highlightReason = '连续投入时段较长';
    }
    if (block.focusScore >= 80 && FOCUS_CATEGORIES.has(block.category)) {
      highlightScore += 2;
      if (!highlightReason) highlightReason = '高专注高价值工作块';
    }
    if (reviewPriority >= 6) {
      highlightScore += 2;
      if (!highlightReason) highlightReason = '值得优先纠偏';
    }
    if (bestCalendarEvent && !bestReminder) {
      highlightScore += 1;
      if (!highlightReason) highlightReason = '与日历事件明显重叠';
    }

    return {
      ...block,
      matchedReminder: bestReminder,
      matchedCalendarEvent: bestCalendarEvent,
      reviewPriority,
      reviewReason,
      isLowValue:
        LOW_VALUE_CATEGORIES.has(block.category) ||
        (block.focusScore < 45 && !FOCUS_CATEGORIES.has(block.category) && block.duration >= 10),
      highlightScore,
      highlightReason,
    };
  });
}

export function buildDailyDigest(workblocks: Workblock[], context: WeekContext): DailyDigest {
  const totalMinutes = workblocks.reduce((sum, block) => sum + block.duration, 0);
  const focusedMinutes = workblocks
    .filter((block) => FOCUS_CATEGORIES.has(block.category))
    .reduce((sum, block) => sum + block.duration, 0);
  const focusRatio = totalMinutes > 0 ? (focusedMinutes / totalMinutes) * 100 : 0;
  const longestBlock = [...workblocks].sort((a, b) => b.duration - a.duration)[0] || null;
  const fragmentationScore = totalMinutes > 0 ? Math.round((workblocks.length / Math.max(totalMinutes / 60, 1)) * 10) : 0;

  const matchedMap = new Map<string, { item: ContextItem; minutes: number; blocks: Workblock[] }>();
  for (const block of workblocks) {
    if (!block.matchedReminder) continue;
    const existing = matchedMap.get(block.matchedReminder.title) || {
      item: block.matchedReminder,
      minutes: 0,
      blocks: [],
    };
    existing.minutes += block.duration;
    existing.blocks.push(block);
    matchedMap.set(block.matchedReminder.title, existing);
  }

  const matchedReminders = [...matchedMap.values()].sort((a, b) => b.minutes - a.minutes);
  const matchedReminderMinutes = workblocks
    .filter((block) => isMeaningfulPlannedBlock(block))
    .reduce((sum, block) => sum + block.duration, 0);
  const plannedCoverage = totalMinutes > 0 ? (matchedReminderMinutes / totalMinutes) * 100 : 0;
  const unmatchedReminders = context.reminders.filter((item: ContextItem) => !matchedMap.has(item.title));
  const unplannedBlocks = workblocks
    .filter((block) => !block.matchedReminder && FOCUS_CATEGORIES.has(block.category))
    .sort((a, b) => b.reviewPriority - a.reviewPriority || b.duration - a.duration)
    .slice(0, 4);
  const lowValueBlocks = workblocks
    .filter((block) => block.isLowValue)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4);
  const offtrackMinutes = Math.max(0, totalMinutes - matchedReminderMinutes);
  const driftLabel =
    plannedCoverage >= 70 ? '大部分时间都围绕计划推进。'
    : plannedCoverage >= 40 ? '部分时间在推进计划，但仍有明显偏移。'
    : '今天大部分时间没有稳定落在计划项上。';

  const suggestions: string[] = [];
  if (focusRatio < 45) {
    suggestions.push('今天高价值推进时间偏少，优先保护一段连续深度工作时段。');
  }
  if (fragmentationScore >= 10) {
    suggestions.push('今天切换频繁，明天应减少上下文切换，把相近任务合并处理。');
  }
  if (unmatchedReminders.length >= 3) {
    suggestions.push('提醒事项里有较多未推进项，建议明早先确认 1 到 3 个真正要推进的目标。');
  }
  if (matchedReminderMinutes >= totalMinutes * 0.5) {
    suggestions.push('今天有一半以上时间与计划项对齐，适合保留当前安排方式。');
  }
  if (lowValueBlocks.length > 0 && lowValueBlocks[0].duration >= 20) {
    suggestions.push('有一段明显的低价值占用时段，明天可以先限制它出现的时间窗口。');
  }
  if (suggestions.length === 0) {
    suggestions.push('今天节奏总体稳定，下一步重点是继续减少低价值切换。');
  }

  const summaryParts = [
    totalMinutes > 0 ? `今天共记录 ${formatMinutes(totalMinutes)}` : '今天还没有有效记录',
    focusRatio > 0 ? `其中 ${formatPercent(focusRatio)} 属于高价值活动` : null,
    matchedReminders.length > 0 ? `${matchedReminders.length} 个提醒事项出现实际推进` : '暂未匹配到提醒事项推进',
    totalMinutes > 0 ? `计划覆盖率约 ${formatPercent(plannedCoverage)}` : null,
  ].filter(Boolean);

  return {
    totalMinutes,
    focusedMinutes,
    focusRatio,
    matchedReminderMinutes,
    plannedCoverage,
    offtrackMinutes,
    longestBlock,
    fragmentationScore,
    matchedReminders,
    unmatchedReminders,
    unplannedBlocks,
    lowValueBlocks,
    driftLabel,
    suggestions,
    summary: summaryParts.join('，'),
  };
}

export function findMissedCalendarEvents(workblocks: Workblock[], context: WeekContext, limit = 4): ContextItem[] {
  return context.calendar_events.filter((event: ContextItem) => {
    if (!event.startTimeMs || !event.endTimeMs) return false;
    const eventStartMs = event.startTimeMs;
    const eventEndMs = event.endTimeMs;
    return !workblocks.some((block) => {
      const blockStart = new Date(block.startTime).getTime();
      const blockEnd = new Date(block.endTime).getTime();
      return Math.min(blockEnd, eventEndMs) > Math.max(blockStart, eventStartMs);
    });
  }).slice(0, limit);
}
function isReminderLinkSuppressed(source?: string): boolean {
  return source === MANUAL_UNLINKED_REMINDER_SOURCE;
}

function isCalendarLinkSuppressed(source?: string): boolean {
  return source === MANUAL_UNLINKED_CALENDAR_SOURCE;
}

export function hasExplicitReminderLink(block: Pick<Workblock, 'linkedReminderTitle' | 'linkedReminderSource'>): boolean {
  return Boolean(block.linkedReminderTitle) && !isReminderLinkSuppressed(block.linkedReminderSource);
}

export function hasExplicitCalendarLink(block: Pick<Workblock, 'linkedCalendarTitle' | 'linkedCalendarSource'>): boolean {
  return Boolean(block.linkedCalendarTitle) && !isCalendarLinkSuppressed(block.linkedCalendarSource);
}
