type Activity = {
  id: string;
  name: string;
  windowTitle: string;
  rawWindowTitle?: string;
  category: '开发' | '工作' | '学习' | '会议' | '沟通' | '浏览网页' | '整理文件' | '提醒事项' | '休息' | '娱乐' | '其他';
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
};

type ContextItem = {
  title: string;
  source: string;
  startTimeMs?: number;
  endTimeMs?: number;
};

type WeekContext = {
  goals: ContextItem[];
  reminders: ContextItem[];
  calendar_events: ContextItem[];
  warnings: string[];
};

import {
  MANUAL_UNLINKED_CALENDAR_SOURCE,
  MANUAL_UNLINKED_REMINDER_SOURCE,
  aggregateWorkblocks,
  alignWorkblocksWithContext,
  buildDailyDigest,
  findMissedCalendarEvents,
} from '../src/utils/workblocks.js';
import {
  buildFallbackPlan,
  evaluatePlanExecution,
  parseAiPlan,
} from '../src/utils/planning.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} | actual=${String(actual)} expected=${String(expected)}`);
  }
}

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'activity-1',
    name: 'Cursor',
    windowTitle: 'Write PRD',
    rawWindowTitle: 'Write PRD',
    category: '开发',
    activityType: '深度开发',
    description: 'Write PRD',
    focusScore: 86,
    contextKey: 'trace-v2-prd',
    startTime: '2026-06-08T09:00:00.000Z',
    endTime: '2026-06-08T09:40:00.000Z',
    duration: 40,
    isManual: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<WeekContext> = {}): WeekContext {
  return {
    goals: [],
    reminders: [],
    calendar_events: [],
    warnings: [],
    ...overrides,
  };
}

function makeReminder(title: string): ContextItem {
  return { title, source: '提醒事项/Today' };
}

function makeEvent(title: string, startTimeMs: number, endTimeMs: number): ContextItem {
  return { title, source: 'Calendar/Today', startTimeMs, endTimeMs };
}

function scenarioReminderRelink(): void {
  const activity = makeActivity({
    linkedReminderTitle: 'Ship Trace V2',
    linkedReminderSource: '提醒事项/手动关联',
    description: 'General coding',
  });
  const context = makeContext({
    reminders: [makeReminder('Wrong Reminder'), makeReminder('Ship Trace V2')],
  });
  const [block] = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  assertEqual(block?.matchedReminder?.title, 'Ship Trace V2', '显式 reminder 重绑后应优先命中用户确认的提醒事项');
}

function scenarioReminderUnlinkSuppression(): void {
  const activity = makeActivity({
    description: 'Ship Trace V2',
    linkedReminderTitle: '',
    linkedReminderSource: MANUAL_UNLINKED_REMINDER_SOURCE,
  });
  const context = makeContext({
    reminders: [makeReminder('Ship Trace V2')],
  });
  const [block] = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  assertEqual(block?.matchedReminder, undefined, '显式解绑 reminder 后不应被弱匹配自动绑回');
}

function scenarioCalendarOverlap(): void {
  const activity = makeActivity({
    description: 'Focus block',
    startTime: '2026-06-08T09:00:00.000Z',
    endTime: '2026-06-08T09:45:00.000Z',
    duration: 45,
  });
  const context = makeContext({
    calendar_events: [
      makeEvent(
        'Design review',
        Date.parse('2026-06-08T09:10:00.000Z'),
        Date.parse('2026-06-08T09:35:00.000Z'),
      ),
    ],
  });
  const [block] = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  assertEqual(block?.matchedCalendarEvent?.title, 'Design review', '真实时间重叠应能命中日历事件');
}

function scenarioCalendarUnlinkSuppression(): void {
  const activity = makeActivity({
    description: 'Design review',
    linkedCalendarTitle: '',
    linkedCalendarSource: MANUAL_UNLINKED_CALENDAR_SOURCE,
  });
  const context = makeContext({
    calendar_events: [
      makeEvent(
        'Design review',
        Date.parse('2026-06-08T09:10:00.000Z'),
        Date.parse('2026-06-08T09:35:00.000Z'),
      ),
    ],
  });
  const [block] = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  assertEqual(block?.matchedCalendarEvent, undefined, '显式解绑 calendar 后不应被弱匹配自动绑回');
}

function scenarioMissedCalendarEvent(): void {
  const activity = makeActivity({
    startTime: '2026-06-08T09:00:00.000Z',
    endTime: '2026-06-08T09:30:00.000Z',
    duration: 30,
  });
  const context = makeContext({
    calendar_events: [
      makeEvent('Happened', Date.parse('2026-06-08T09:05:00.000Z'), Date.parse('2026-06-08T09:20:00.000Z')),
      makeEvent('Missed planning', Date.parse('2026-06-08T11:00:00.000Z'), Date.parse('2026-06-08T11:30:00.000Z')),
    ],
  });
  const blocks = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  const missed = findMissedCalendarEvents(blocks, context, 4);
  assertEqual(missed.length, 1, '无重叠的日历事件应进入落空事件列表');
  assertEqual(missed[0]?.title, 'Missed planning', '落空事件标题应正确');
}

function scenarioLowValueDetection(): void {
  const activity = makeActivity({
    category: '娱乐',
    activityType: '视频',
    description: 'Watch random videos',
    focusScore: 24,
    duration: 35,
    startTime: '2026-06-08T14:00:00.000Z',
    endTime: '2026-06-08T14:35:00.000Z',
  });
  const context = makeContext();
  const blocks = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  const digest = buildDailyDigest(blocks, context);
  assert(blocks[0]?.isLowValue === true, '低价值活动块应被标记');
  assertEqual(digest.lowValueBlocks.length, 1, '低价值活动块应进入 digest');
}

function scenarioFallbackPlanAddsExecutionHints(): void {
  const reminders = [makeReminder('写 Trace 计划方案')];
  const plan = buildFallbackPlan('2026-06-08', reminders, [], [], [], Date.parse('2026-06-08T10:05:00.000Z'));
  assertEqual(plan.blocks.length, 1, 'fallback 计划应为简单提醒事项生成一个计划块');
  assert(Boolean(plan.blocks[0]?.nextAction), 'fallback 计划块应包含下一步动作');
  assert(Boolean(plan.blocks[0]?.prepHint), 'fallback 计划块应包含准备项');
  assert(Boolean(plan.blocks[0]?.energy), 'fallback 计划块应包含专注强度');
  assert(Boolean(plan.blocks[0]?.priorityReason), 'fallback 计划块应包含排序依据');
}

function scenarioAiPlanParserKeepsRichFields(): void {
  const raw = JSON.stringify({
    headline: '下午先做两个主块',
    blocks: [
      {
        title: '完善 Trace 今日计划交互',
        start: '14:00',
        end: '14:45',
        durationMinutes: 45,
        sourceReminder: '完善 Trace 今日计划交互',
        confidence: '高',
        rationale: '最近同类工作常见在 40 到 60 分钟。',
        nextAction: '先打开 Today 页面和 planning.ts，对照现有问题清单。',
        prepHint: '提前准备今天的提醒事项和最近工作块样本。',
        energy: '高专注',
      },
    ],
    deferredReminders: [],
    basis: ['已读取 1 个提醒事项'],
  });
  const parsed = parseAiPlan(
    raw,
    '2026-06-08',
    Date.parse('2026-06-08T13:00:00'),
    [makeReminder('完善 Trace 今日计划交互')],
    [],
  );
  assert(Boolean(parsed), 'AI 计划 JSON 应成功解析');
  assertEqual(parsed?.blocks[0]?.nextAction, '先打开 Today 页面和 planning.ts，对照现有问题清单。', 'AI 计划应保留 nextAction');
  assertEqual(parsed?.blocks[0]?.prepHint, '提前准备今天的提醒事项和最近工作块样本。', 'AI 计划应保留 prepHint');
  assertEqual(parsed?.blocks[0]?.energy, '高专注', 'AI 计划应保留 energy');
}

function scenarioPlanExecutionMatchesActualProgress(): void {
  const reminders = [makeReminder('Ship Trace V2')];
  const plan = buildFallbackPlan('2026-06-08', reminders, [], [], [], Date.parse('2026-06-08T09:00:00.000Z'));
  const activity = makeActivity({
    description: 'Ship Trace V2',
    linkedReminderTitle: 'Ship Trace V2',
    linkedReminderSource: '提醒事项/手动关联',
    startTime: plan.blocks[0]!.startTime,
    endTime: plan.blocks[0]!.endTime,
    duration: plan.blocks[0]!.durationMinutes,
  });
  const context = makeContext({ reminders });
  const blocks = alignWorkblocksWithContext(aggregateWorkblocks([activity], 10), context);
  const execution = evaluatePlanExecution(plan, blocks, Date.parse('2026-06-08T18:00:00.000Z'));
  assert(Boolean(execution), '计划执行情况应可计算');
  assertEqual(execution?.completedCount, 1, '完整命中的计划块应视为已完成');
  assertEqual(execution?.blocks[0]?.status, '已完成', '完整命中的计划块状态应为已完成');
}

function scenarioStartedTodayReminderGetsPriority(): void {
  const reminders = [makeReminder('写周总结'), makeReminder('整理收据')];
  const currentBlock = {
    ...alignWorkblocksWithContext(
      aggregateWorkblocks([
        makeActivity({
          id: 'activity-continue',
          description: '写周总结',
          startTime: '2026-06-08T10:00:00.000Z',
          endTime: '2026-06-08T10:35:00.000Z',
          duration: 35,
          linkedReminderTitle: '写周总结',
          linkedReminderSource: '提醒事项/手动关联',
        }),
      ], 10),
      makeContext({ reminders }),
    )[0]!,
  };
  const plan = buildFallbackPlan(
    '2026-06-08',
    reminders,
    [],
    [],
    [currentBlock],
    Date.parse('2026-06-08T11:00:00.000Z'),
  );
  assertEqual(plan.blocks[0]?.sourceReminder, '写周总结', '今天已经开始推进的事项应优先进入计划首位');
  assert(Boolean(plan.blocks[0]?.priorityReason?.includes('今天已经')), '排序依据应解释今日主线延续原因');
}

function scenarioCrossWindowSameTaskMerges(): void {
  const activities = [
    makeActivity({
      id: 'codex-trace-fix',
      name: 'Codex',
      windowTitle: 'Trace_V2 日历同步与卡顿优化',
      rawWindowTitle: 'Trace_V2 日历同步与卡顿优化',
      category: '开发',
      activityType: 'AI 编程',
      description: '优化 Trace 日历同步和刷新卡顿',
      contextKey: 'trace-calendar-performance',
      startTime: '2026-06-08T09:00:00.000Z',
      endTime: '2026-06-08T09:10:00.000Z',
      duration: 10,
    }),
    makeActivity({
      id: 'chrome-trace-docs',
      name: 'Google Chrome',
      windowTitle: 'Tauri Calendar permission docs - Google Chrome',
      rawWindowTitle: 'Tauri Calendar permission docs - Google Chrome',
      category: '学习',
      activityType: '搜索资料',
      description: '研究 Trace 日历权限和同步资料',
      contextKey: 'trace-calendar-performance',
      startTime: '2026-06-08T09:10:30.000Z',
      endTime: '2026-06-08T09:16:00.000Z',
      duration: 5.5,
    }),
    makeActivity({
      id: 'terminal-trace-check',
      name: 'Terminal',
      windowTitle: 'Trace_V2 cargo check',
      rawWindowTitle: 'Trace_V2 cargo check',
      category: '开发',
      activityType: '命令行开发',
      description: '验证 Trace 日历同步和卡顿修复',
      contextKey: 'trace-calendar-performance',
      startTime: '2026-06-08T09:16:20.000Z',
      endTime: '2026-06-08T09:22:00.000Z',
      duration: 5.7,
    }),
  ];
  const blocks = aggregateWorkblocks(activities, 10);
  assertEqual(blocks.length, 1, '同一 Trace 任务里的 Codex/Chrome/Terminal 跳转应归并成一个工作块');
  assertEqual(blocks[0]?.activityIds.length, 3, '归并后的工作块应保留全部活动证据');
}

function run(): void {
  scenarioReminderRelink();
  scenarioReminderUnlinkSuppression();
  scenarioCalendarOverlap();
  scenarioCalendarUnlinkSuppression();
  scenarioMissedCalendarEvent();
  scenarioLowValueDetection();
  scenarioFallbackPlanAddsExecutionHints();
  scenarioAiPlanParserKeepsRichFields();
  scenarioPlanExecutionMatchesActualProgress();
  scenarioStartedTodayReminderGetsPriority();
  scenarioCrossWindowSameTaskMerges();
  console.info('Trace V2 workblock validations passed.');
}

run();
