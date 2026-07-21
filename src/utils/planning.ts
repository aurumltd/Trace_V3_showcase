import type { Activity, AppSettings, ContextItem } from '../services/dataService';
import type { Workblock } from './workblocks';

export interface PlanBlock {
  title: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  sourceReminder: string;
  confidence: '高' | '中' | '低';
  rationale: string;
  nextAction?: string;
  prepHint?: string;
  energy?: '高专注' | '中专注' | '低压';
  priorityReason?: string;
}

export interface DailyPlanSuggestion {
  headline: string;
  blocks: PlanBlock[];
  deferredReminders: string[];
  basis: string[];
  generatedAt: number;
  method: 'ai' | 'fallback';
}

export interface PlanExecutionBlock {
  block: PlanBlock;
  actualMinutes: number;
  matchedWorkblocks: Workblock[];
  status: '已完成' | '推进中' | '已开始' | '待开始' | '明显偏移';
  statusReason: string;
  matchedTitle: string;
  progressRatio: number;
}

export interface PlanExecutionSummary {
  totalPlannedMinutes: number;
  totalActualMinutes: number;
  completionRate: number;
  startedCount: number;
  completedCount: number;
  driftCount: number;
  blocks: PlanExecutionBlock[];
}

type BusySlot = {
  startMs: number;
  endMs: number;
};

type ReminderEstimate = {
  title: string;
  source: string;
  estimatedMinutes: number;
  confidence: '高' | '中' | '低';
  evidence: string;
  priorityScore: number;
  priorityReason: string;
  startedTodayMinutes: number;
};

type RawAiPlanBlock = {
  title?: string;
  start?: string;
  end?: string;
  durationMinutes?: number;
  sourceReminder?: string;
  confidence?: string;
  rationale?: string;
  nextAction?: string;
  prepHint?: string;
  energy?: string;
  priorityReason?: string;
};

const CHINESE_MINUTE = 60 * 1000;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 2)
    .filter((token) => !['使用', '处理', '查看', '进行', '工作', '任务', 'the', 'with', 'from'].includes(token));
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = new Set(tokenize(right));
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += 1;
  }
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a && b && (a.includes(b) || b.includes(a))) score += 2;
  return score;
}

function intervalOverlapMinutes(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  if (end <= start) return 0;
  return Math.max(0, Math.round((end - start) / CHINESE_MINUTE));
}

function roundToNextHalfHour(valueMs: number): number {
  const date = new Date(valueMs);
  date.setSeconds(0, 0);
  const minutes = date.getMinutes();
  if (minutes === 0 || minutes === 30) return date.getTime();
  if (minutes < 30) {
    date.setMinutes(30, 0, 0);
  } else {
    date.setHours(date.getHours() + 1, 0, 0, 0);
  }
  return date.getTime();
}

function toLocalIsoMinute(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function parseTimeLiteral(baseDate: Date, value?: string): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, hourText, minuteText] = match;
  const date = new Date(baseDate);
  date.setHours(Number(hourText), Number(minuteText), 0, 0);
  return date.getTime();
}

function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return 45;
  if (minutes < 20) return 20;
  if (minutes > 180) return 180;
  return Math.round(minutes / 5) * 5;
}

function inferEnergy(title: string): '高专注' | '中专注' | '低压' {
  const text = title.toLowerCase();
  if (['写', '开发', '方案', '设计', '分析', '研究', '复盘', '优化', 'coding', 'build', 'debug'].some((token) => text.includes(token))) {
    return '高专注';
  }
  if (['沟通', '会议', '回复', '面试', 'review', 'call'].some((token) => text.includes(token))) {
    return '中专注';
  }
  return '低压';
}

function inferNextAction(title: string): string {
  const text = title.trim();
  if (!text) return '先打开相关材料，明确这一块要产出什么。';
  if (['写', '方案', '总结', '复盘'].some((token) => text.includes(token))) return `先列一个 3 点小提纲，再进入 ${text}。`;
  if (['开发', '修复', '优化', 'coding', 'debug'].some((token) => text.toLowerCase().includes(token))) return `先定位这次 ${text} 的入口文件或主问题，再连续推进 25 到 45 分钟。`;
  if (['回复', '沟通', '发', '确认'].some((token) => text.includes(token))) return `先把 ${text} 需要确认的 1 到 2 个关键点写清楚，再统一处理。`;
  if (['准备', '面试', '会议'].some((token) => text.includes(token))) return `先确认 ${text} 的目标和材料，再补最关键的信息。`;
  return `先把 ${text} 拆成一个最小可启动动作，再开始。`;
}

function inferPrepHint(title: string): string {
  const text = title.trim();
  if (!text) return '提前准备相关页面、资料或联系人。';
  if (['开发', '修复', '优化', 'coding', 'debug'].some((token) => text.toLowerCase().includes(token))) return '提前打开代码仓库、日志或待改文件，减少进入成本。';
  if (['写', '方案', '总结', '复盘'].some((token) => text.includes(token))) return '先收好资料来源和上下文，再开始输出。';
  if (['沟通', '回复', '面试', '会议'].some((token) => text.includes(token))) return '先准备要点、链接或对方上下文，避免临时切换。';
  return `开始前把与“${text}”相关的材料先开好。`;
}

function normalizeEnergy(value?: string): '高专注' | '中专注' | '低压' {
  if (value === '高专注' || value === '中专注' || value === '低压') return value;
  if (!value) return '中专注';
  if (value.includes('高') || value.toLowerCase().includes('deep')) return '高专注';
  if (value.includes('低') || value.toLowerCase().includes('light')) return '低压';
  return '中专注';
}

function urgencyScore(title: string): { score: number; reason: string } {
  const text = title.toLowerCase();
  if (['今天', '今晚', '立刻', '马上', '尽快', '截止', 'ddl', 'deadline', 'asap'].some((token) => text.includes(token))) {
    return { score: 4, reason: '提醒事项里带有明显的当日 / 截止信号。' };
  }
  if (['明天', '本周', '这周', '周内'].some((token) => text.includes(token))) {
    return { score: 2, reason: '提醒事项带有近期时间约束。' };
  }
  return { score: 0, reason: '' };
}

function reminderMomentum(reminder: ContextItem, todayWorkblocks: Workblock[]): {
  score: number;
  reason: string;
  startedTodayMinutes: number;
} {
  let startedTodayMinutes = 0;
  let strongestLabel = '';
  let strongestScore = 0;

  for (const block of todayWorkblocks) {
    let score = 0;
    if (block.linkedReminderTitle && block.linkedReminderTitle === reminder.title) {
      score = 99;
    } else if (block.matchedReminder?.title === reminder.title) {
      score = 99;
    } else {
      score = overlapScore(reminder.title, [block.title, block.contextKey, block.activityType, ...block.evidence].join(' '));
    }

    if (score >= 2) {
      startedTodayMinutes += block.duration;
      if (score > strongestScore) {
        strongestScore = score;
        strongestLabel = block.title;
      }
    }
  }

  if (startedTodayMinutes >= 20) {
    return {
      score: 6,
      reason: strongestLabel
        ? `今天已经在“${strongestLabel}”上投入 ${Math.round(startedTodayMinutes)} 分钟，优先延续主线。`
        : `今天已经在这类事项上投入 ${Math.round(startedTodayMinutes)} 分钟，优先延续主线。`,
      startedTodayMinutes: Math.round(startedTodayMinutes),
    };
  }

  if (startedTodayMinutes > 0) {
    return {
      score: 3,
      reason: `今天已经有 ${Math.round(startedTodayMinutes)} 分钟相关推进，适合顺势继续。`,
      startedTodayMinutes: Math.round(startedTodayMinutes),
    };
  }

  return { score: 0, reason: '', startedTodayMinutes: 0 };
}

function estimateReminderMinutes(title: string): number {
  const text = title.toLowerCase();
  if (['回复', '发', '发送', '买', '付款', '报销', '预约', '确认', '整理一下', '看一下'].some((token) => text.includes(token))) return 25;
  if (['开会', '会议', '沟通', '电话', '面试'].some((token) => text.includes(token))) return 45;
  if (['写', '做', '开发', '设计', '方案', '研究', '分析', '复盘', '准备', '优化'].some((token) => text.includes(token))) return 60;
  if (title.length >= 18) return 60;
  return 40;
}

function buildBusySlots(calendarEvents: ContextItem[], today: string): BusySlot[] {
  const slots = calendarEvents
    .map((item) => ({ startMs: item.startTimeMs ?? 0, endMs: item.endTimeMs ?? 0 }))
    .filter((item) => item.startMs > 0 && item.endMs > item.startMs)
    .filter((item) => toLocalIsoMinute(item.startMs).startsWith(today));
  return slots.sort((a, b) => a.startMs - b.startMs);
}

function findRecentEvidence(reminder: ContextItem, activities: Activity[]): { minutes: number[]; evidence: string[] } {
  const title = reminder.title;
  const minutes: number[] = [];
  const evidence: string[] = [];

  for (const activity of activities) {
    const joined = [activity.description || '', activity.contextKey || '', activity.activityType || '', activity.windowTitle || '', activity.linkedReminderTitle || ''].join(' ');
    let score = 0;
    if (activity.linkedReminderTitle && activity.linkedReminderTitle === title) {
      score = 99;
    } else {
      score = overlapScore(title, joined);
    }
    if (score >= 2) {
      minutes.push(activity.duration);
      if (evidence.length < 3) {
        evidence.push(activity.description || activity.contextKey || activity.windowTitle || activity.name);
      }
    }
  }

  return { minutes, evidence };
}

function summarizeHistoricalEstimate(reminder: ContextItem, activities: Activity[], todayWorkblocks: Workblock[]): ReminderEstimate {
  const { minutes } = findRecentEvidence(reminder, activities);
  const urgency = urgencyScore(reminder.title);
  const momentum = reminderMomentum(reminder, todayWorkblocks);

  if (minutes.length === 0) {
    const estimatedMinutes = estimateReminderMinutes(reminder.title);
    return {
      title: reminder.title,
      source: reminder.source,
      estimatedMinutes,
      confidence: estimatedMinutes >= 55 ? '中' : '低',
      evidence: '没有直接历史命中，按提醒事项语义做轻量估时。',
      priorityScore: momentum.score + urgency.score,
      priorityReason: momentum.reason || urgency.reason || '当前主要按提醒事项字面语义进入候选。',
      startedTodayMinutes: momentum.startedTodayMinutes,
    };
  }

  const sorted = [...minutes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
  return {
    title: reminder.title,
    source: reminder.source,
    estimatedMinutes: clampDuration(median),
    confidence: minutes.length >= 2 ? '高' : '中',
    evidence: `最近 ${minutes.length} 次相似记录，常见耗时约 ${clampDuration(median)} 分钟。`,
    priorityScore: momentum.score + urgency.score + (minutes.length >= 2 ? 1 : 0),
    priorityReason: momentum.reason || urgency.reason || `最近有 ${minutes.length} 次相似历史记录，可较稳定估时。`,
    startedTodayMinutes: momentum.startedTodayMinutes,
  };
}

function pickPlanningWindow(today: string, nowMs: number): { startMs: number; endMs: number } {
  const [year, month, day] = today.split('-').map(Number);
  const start = new Date(year, month - 1, day, 9, 0, 0, 0).getTime();
  const end = new Date(year, month - 1, day, 22, 0, 0, 0).getTime();
  return {
    startMs: Math.max(start, roundToNextHalfHour(nowMs)),
    endMs: end,
  };
}

function sortEstimates(reminders: ContextItem[], activities: Activity[], todayWorkblocks: Workblock[], nowMs: number): ReminderEstimate[] {
  const lateNight = new Date(nowMs).getHours() >= 20;
  return reminders
    .map((item) => summarizeHistoricalEstimate(item, activities, todayWorkblocks))
    .sort((left, right) => {
      const confidenceWeight = { 高: 3, 中: 2, 低: 1 } as const;
      const energyWeight = (value: ReminderEstimate) => {
        const energy = inferEnergy(value.title);
        if (lateNight) {
          return energy === '低压' ? 3 : energy === '中专注' ? 2 : 1;
        }
        return energy === '高专注' ? 3 : energy === '中专注' ? 2 : 1;
      };
      return right.priorityScore - left.priorityScore
        || confidenceWeight[right.confidence] - confidenceWeight[left.confidence]
        || energyWeight(right) - energyWeight(left)
        || right.estimatedMinutes - left.estimatedMinutes;
    });
}

function findNextFreeStart(cursorMs: number, busySlots: BusySlot[]): number {
  let current = cursorMs;
  for (const slot of busySlots) {
    if (current >= slot.endMs) continue;
    if (current >= slot.startMs && current < slot.endMs) {
      current = slot.endMs;
      continue;
    }
    if (current < slot.startMs) {
      return current;
    }
  }
  return current;
}

function isOverlapping(startMs: number, endMs: number, slot: BusySlot): boolean {
  return startMs < slot.endMs && endMs > slot.startMs;
}

function fitBlock(startMs: number, durationMinutes: number, busySlots: BusySlot[], endBoundaryMs: number): { startMs: number; endMs: number } | null {
  let cursor = startMs;
  while (cursor + durationMinutes * CHINESE_MINUTE <= endBoundaryMs) {
    const next = findNextFreeStart(cursor, busySlots);
    const endMs = next + durationMinutes * CHINESE_MINUTE;
    const overlap = busySlots.find((slot) => isOverlapping(next, endMs, slot));
    if (!overlap) {
      return { startMs: next, endMs };
    }
    cursor = overlap.endMs;
  }
  return null;
}

export function buildFallbackPlan(
  today: string,
  reminders: ContextItem[],
  calendarEvents: ContextItem[],
  recentActivities: Activity[],
  todayWorkblocks: Workblock[],
  nowMs: number,
): DailyPlanSuggestion {
  const estimates = sortEstimates(reminders, recentActivities, todayWorkblocks, nowMs).slice(0, 5);
  const busySlots = buildBusySlots(calendarEvents, today);
  const { startMs, endMs } = pickPlanningWindow(today, nowMs);
  const blocks: PlanBlock[] = [];
  const deferredReminders: string[] = [];
  let cursor = startMs;

  for (const estimate of estimates) {
    const fitted = fitBlock(cursor, estimate.estimatedMinutes, busySlots, endMs);
    if (!fitted) {
      deferredReminders.push(estimate.title);
      continue;
    }
    blocks.push({
      title: estimate.title,
      startTime: toLocalIsoMinute(fitted.startMs),
      endTime: toLocalIsoMinute(fitted.endMs),
      durationMinutes: estimate.estimatedMinutes,
      sourceReminder: estimate.title,
      confidence: estimate.confidence,
      rationale: estimate.evidence,
      nextAction: inferNextAction(estimate.title),
      prepHint: inferPrepHint(estimate.title),
      energy: inferEnergy(estimate.title),
      priorityReason: estimate.priorityReason,
    });
    cursor = fitted.endMs + 10 * CHINESE_MINUTE;
  }

  const headline = blocks.length > 0
    ? `先把今天最值得推进的 ${blocks.length} 件事塞进剩余空档，不强行排满整天。`
    : '今天剩余空档不多，建议只保留最重要的 1 到 2 件事。';

  return {
    headline,
    blocks,
    deferredReminders,
    basis: [
      `已读取 ${reminders.length} 个未完成提醒事项`,
      `参考今日 ${calendarEvents.length} 个日历事件空档`,
      todayWorkblocks.length > 0 ? `优先延续今天已经启动的主线，减少无谓切换` : '今天还没有明显主线延续信号',
      `参考最近 ${recentActivities.length} 条本地活动记录做轻量估时`,
    ],
    generatedAt: Date.now(),
    method: 'fallback',
  };
}

export function buildPlanningPrompt(
  today: string,
  nowMs: number,
  reminders: ContextItem[],
  calendarEvents: ContextItem[],
  recentActivities: Activity[],
  todayWorkblocks: Workblock[],
  fallback: DailyPlanSuggestion,
): string {
  const now = new Date(nowMs);
  const reminderLines = reminders.slice(0, 10).map((item) => `- ${item.title}（${item.source}）`).join('\n') || '- 无';
  const calendarLines = calendarEvents
    .filter((item) => (item.startTimeMs ?? 0) > 0 && (item.endTimeMs ?? 0) > (item.startTimeMs ?? 0))
    .slice(0, 12)
    .map((item) => {
      const start = item.startTimeMs ? toLocalIsoMinute(item.startTimeMs).slice(11, 16) : '未知';
      const end = item.endTimeMs ? toLocalIsoMinute(item.endTimeMs).slice(11, 16) : '未知';
      return `- ${start}-${end} ${item.title}`;
    })
    .join('\n') || '- 无';
  const recentLines = recentActivities
    .slice(-30)
    .map((activity) => `- ${activity.description || activity.contextKey || activity.windowTitle || activity.name}｜${Math.round(activity.duration)} 分钟`)
    .join('\n') || '- 无';
  const todayLines = todayWorkblocks
    .slice(0, 8)
    .map((block) => `- ${block.title}｜${Math.round(block.duration)} 分钟｜${block.matchedReminder?.title || block.linkedReminderTitle || '未稳定归因'}`)
    .join('\n') || '- 无';
  const fallbackLines = fallback.blocks
    .map((block) => `- ${block.startTime.slice(11, 16)}-${block.endTime.slice(11, 16)} ${block.title}｜${block.durationMinutes} 分钟｜${block.priorityReason || block.rationale}`)
    .join('\n') || '- 无';

  return [
    '你是一个严格克制的个人工作计划助手。',
    '请根据今天剩余时间，把提醒事项排成一个轻量计划。',
    '要求：',
    '1. 只安排今天剩余时间，不安排已经过去的时间。',
    '2. 不要强行排满整天，只排最值得推进的 3 到 5 件事。',
    '3. 如果提醒事项过于简单，要结合最近活动历史和常识，给出合理时长。',
    '4. 如果今天已经开始推进某个事项，优先延续这条主线，除非提醒事项里有更强的截止信号。',
    '5. 避开已有日历事件时间段。',
    '6. 输出必须是 JSON，不要加解释。',
    '7. JSON 结构：{"headline":"...","blocks":[{"title":"...","start":"HH:MM","end":"HH:MM","durationMinutes":45,"sourceReminder":"...","confidence":"高|中|低","rationale":"...","nextAction":"...","prepHint":"...","energy":"高专注|中专注|低压","priorityReason":"..."}],"deferredReminders":["..."],"basis":["..."]}',
    '8. nextAction 要非常具体，像用户下一步立刻可以做的动作；prepHint 写开始前最好先准备什么；energy 表示这块更适合高专注、中专注还是低压状态；priorityReason 说明为什么这个块被排在前面。',
    `今天日期：${today}`,
    `当前时间：${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    '今日未完成提醒事项：',
    reminderLines,
    '今天已经发生的工作块（优先判断是否要延续）：',
    todayLines,
    '今日已有日历事件：',
    calendarLines,
    '最近本地活动记录（仅供估时和判断任务形态）：',
    recentLines,
    '如果信息不足，可参考这个保守的 fallback 计划：',
    fallbackLines,
  ].join('\n');
}

function normalizeConfidence(value?: string): '高' | '中' | '低' {
  if (value === '高' || value === '中' || value === '低') return value;
  if (!value) return '中';
  if (value.includes('high')) return '高';
  if (value.includes('low')) return '低';
  return '中';
}

export function parseAiPlan(
  raw: string,
  today: string,
  nowMs: number,
  reminders: ContextItem[],
  calendarEvents: ContextItem[],
): DailyPlanSuggestion | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as {
      headline?: string;
      blocks?: RawAiPlanBlock[];
      deferredReminders?: string[];
      basis?: string[];
    };
    if (!Array.isArray(parsed.blocks)) return null;

    const busySlots = buildBusySlots(calendarEvents, today);
    const { startMs, endMs } = pickPlanningWindow(today, nowMs);
    const reminderTitles = new Set(reminders.map((item) => item.title));
    const blocks: PlanBlock[] = [];

    for (const item of parsed.blocks) {
      const startParsed = parseTimeLiteral(new Date(startMs), item.start);
      const endParsed = parseTimeLiteral(new Date(startMs), item.end);
      const duration = clampDuration(item.durationMinutes ?? ((startParsed && endParsed) ? Math.round((endParsed - startParsed) / CHINESE_MINUTE) : 45));
      if (!item.title || !item.sourceReminder || !reminderTitles.has(item.sourceReminder)) continue;
      const startCandidate = startParsed ?? startMs;
      const endCandidate = endParsed ?? (startCandidate + duration * CHINESE_MINUTE);
      if (startCandidate < startMs || endCandidate > endMs) continue;
      if (busySlots.some((slot) => isOverlapping(startCandidate, endCandidate, slot))) continue;
      blocks.push({
        title: item.title.trim(),
        startTime: toLocalIsoMinute(startCandidate),
        endTime: toLocalIsoMinute(endCandidate),
        durationMinutes: duration,
        sourceReminder: item.sourceReminder,
        confidence: normalizeConfidence(item.confidence),
        rationale: item.rationale?.trim() || '本地 AI 根据提醒事项与最近上下文做了轻量推断。',
        nextAction: item.nextAction?.trim() || inferNextAction(item.title.trim()),
        prepHint: item.prepHint?.trim() || inferPrepHint(item.title.trim()),
        energy: normalizeEnergy(item.energy),
        priorityReason: item.priorityReason?.trim() || '当前优先级由提醒事项语义、今日主线和历史记录综合判断。',
      });
    }

    if (blocks.length === 0) return null;

    return {
      headline: parsed.headline?.trim() || `今天先推进 ${blocks.length} 个最值得做的事项。`,
      blocks: blocks.sort((a, b) => a.startTime.localeCompare(b.startTime)),
      deferredReminders: Array.isArray(parsed.deferredReminders) ? parsed.deferredReminders.slice(0, 6) : [],
      basis: Array.isArray(parsed.basis) ? parsed.basis.slice(0, 4) : ['基于提醒事项、今日日历空档和最近历史记录生成。'],
      generatedAt: Date.now(),
      method: 'ai',
    };
  } catch {
    return null;
  }
}

export function buildPlanCacheKey(today: string, settings: AppSettings, reminders: ContextItem[]): string {
  const signature = reminders.map((item) => item.title).sort().join('|');
  return `${today}:${settings.aiSummaryModel}:${signature}`;
}

export function evaluatePlanExecution(plan: DailyPlanSuggestion | null, workblocks: Workblock[], nowMs: number): PlanExecutionSummary | null {
  if (!plan || plan.blocks.length === 0) return null;

  const blocks: PlanExecutionBlock[] = plan.blocks.map((block) => {
    const planStart = new Date(block.startTime).getTime();
    const planEnd = new Date(block.endTime).getTime();
    const matchedWorkblocks = workblocks
      .filter((item) => {
        const workStart = new Date(item.startTime).getTime();
        const workEnd = new Date(item.endTime).getTime();
        const overlapMinutes = intervalOverlapMinutes(planStart, planEnd, workStart, workEnd);
        if (overlapMinutes >= 10) return true;
        const titleScore = overlapScore(block.title, item.title);
        const reminderScore = overlapScore(block.sourceReminder, item.title);
        return overlapMinutes >= 5 && (titleScore >= 2 || reminderScore >= 2);
      })
      .sort((left, right) => right.duration - left.duration);

    const actualMinutes = Math.round(matchedWorkblocks.reduce((sum, item) => {
      const workStart = new Date(item.startTime).getTime();
      const workEnd = new Date(item.endTime).getTime();
      return sum + intervalOverlapMinutes(planStart, planEnd, workStart, workEnd);
    }, 0));
    const progressRatio = block.durationMinutes > 0 ? Math.min(1.6, actualMinutes / block.durationMinutes) : 0;
    const matchedTitle = matchedWorkblocks[0]?.title || '';

    let status: PlanExecutionBlock['status'] = '待开始';
    let statusReason = '当前还没有明显对应的执行记录。';
    const hasPastEnd = nowMs > planEnd;
    const hasPastStart = nowMs >= planStart;

    if (actualMinutes >= Math.max(block.durationMinutes * 0.8, 20)) {
      status = '已完成';
      statusReason = matchedTitle
        ? `已和“${matchedTitle}”形成较完整对应，基本达到计划时长。`
        : '已经形成较完整的执行记录。';
    } else if (actualMinutes >= Math.max(block.durationMinutes * 0.45, 15)) {
      status = '推进中';
      statusReason = matchedTitle
        ? `已经围绕“${matchedTitle}”推进，仍可能需要收尾。`
        : '已经明显开始推进，但还没达到计划时长。';
    } else if (actualMinutes >= 5) {
      status = '已开始';
      statusReason = matchedTitle
        ? `已经开始做“${matchedTitle}”，但还只是浅推进。`
        : '已经有启动迹象，但推进不深。';
    } else if (hasPastEnd) {
      status = '明显偏移';
      statusReason = '这个时间段已经过去，但还没找到明显对应执行。';
    } else if (hasPastStart) {
      status = '待开始';
      statusReason = '计划时间已到，建议尽快进入这个块。';
    }

    return {
      block,
      actualMinutes,
      matchedWorkblocks,
      status,
      statusReason,
      matchedTitle,
      progressRatio,
    };
  });

  const totalPlannedMinutes = blocks.reduce((sum, item) => sum + item.block.durationMinutes, 0);
  const totalActualMinutes = blocks.reduce((sum, item) => sum + item.actualMinutes, 0);
  const completedCount = blocks.filter((item) => item.status === '已完成').length;
  const startedCount = blocks.filter((item) => ['已完成', '推进中', '已开始'].includes(item.status)).length;
  const driftCount = blocks.filter((item) => item.status === '明显偏移').length;

  return {
    totalPlannedMinutes,
    totalActualMinutes,
    completionRate: totalPlannedMinutes > 0 ? Math.min(100, (totalActualMinutes / totalPlannedMinutes) * 100) : 0,
    startedCount,
    completedCount,
    driftCount,
    blocks,
  };
}
