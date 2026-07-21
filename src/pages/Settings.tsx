import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppWindow, BrainCircuit, CalendarClock, ListTree as ListTreeIcon, Moon, Play, RefreshCw, ShieldAlert, Square, Sun, Tags, Trash2 } from 'lucide-react';
import dataService, { type LearnedRule, type TrackingRuntimeStatus } from '../services/dataService';
import { trackingService } from '../services/trackingService';
import { useAppStore } from '../store/useAppStore';
import { useToast } from '../components/ui/Toast';

export default function Settings() {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const clearAllData = useAppStore((state) => state.clearAllData);
  const [isTracking, setIsTracking] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [calendarNameDraft, setCalendarNameDraft] = useState(settings.calendarName);
  const [ignoredInput, setIgnoredInput] = useState(settings.ignoredApplications.join('\n'));
  const [reminderListsInput, setReminderListsInput] = useState(settings.reminderLists.join('\n'));
  const [availableReminderLists, setAvailableReminderLists] = useState<string[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedRule[]>([]);
  const [loadingLearnedRules, setLoadingLearnedRules] = useState(false);
  const [categoryRulesDraft, setCategoryRulesDraft] = useState(settings.categoryRulesDraft);
  const [syncing, setSyncing] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<TrackingRuntimeStatus | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setIgnoredInput(settings.ignoredApplications.join('\n'));
  }, [settings.ignoredApplications]);

  useEffect(() => {
    setCalendarNameDraft(settings.calendarName);
  }, [settings.calendarName]);

  useEffect(() => {
    setReminderListsInput(settings.reminderLists.join('\n'));
  }, [settings.reminderLists]);

  useEffect(() => {
    setCategoryRulesDraft(settings.categoryRulesDraft);
  }, [settings.categoryRulesDraft]);

  useEffect(() => {
    const unsubscribe = trackingService.subscribe(setIsTracking);
    void trackingService.sync().catch((error) => {
      console.error(error);
      toast('读取追溯状态失败', 'error');
    });
    return unsubscribe;
  }, [toast]);

  useEffect(() => {
    void dataService.getReminderLists().then(setAvailableReminderLists).catch((error) => {
      console.error(error);
    });
  }, []);

  useEffect(() => {
    setLoadingLearnedRules(true);
    void dataService.getLearnedRules()
      .then(setLearnedRules)
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setLoadingLearnedRules(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadRuntimeStatus() {
      try {
        const next = await dataService.getTrackingRuntimeStatus();
        if (!cancelled) setRuntimeStatus(next);
      } catch (error) {
        console.error(error);
      }
    }
    void loadRuntimeStatus();
    const timerId = window.setInterval(() => {
      void loadRuntimeStatus();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, []);

  const recentLearnedRules = useMemo(() => learnedRules.slice(0, 10), [learnedRules]);

  async function handleTrackingToggle() {
    if (trackingBusy) return;
    setTrackingBusy(true);
    try {
      const next = await trackingService.toggle();
      toast(next ? '已开始追溯' : '已暂停追溯', 'success');
    } catch (error) {
      console.error(error);
      toast('切换追溯状态失败', 'error');
    } finally {
      setTrackingBusy(false);
    }
  }

  async function handleIgnoredAppsSave() {
    const ignoredApplications = ignoredInput
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    try {
      await updateSettings({ ignoredApplications });
      toast('忽略应用已保存', 'success');
    } catch (error) {
      console.error(error);
      toast('保存忽略应用失败', 'error');
    }
  }

  async function handleReminderListsSave() {
    const reminderLists = reminderListsInput
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    try {
      await updateSettings({ reminderLists });
      toast('提醒事项列表已保存', 'success');
    } catch (error) {
      console.error(error);
      toast('保存提醒事项列表失败', 'error');
    }
  }

  async function handleCategoryRulesSave() {
    try {
      await updateSettings({
        categoryRulesDraft,
        categoryRulesVersion: settings.categoryRulesVersion + 1,
      });
      toast('分类关键词已保存并立即生效', 'success');
    } catch (error) {
      console.error(error);
      toast('保存分类关键词失败', 'error');
    }
  }

  async function handleCalendarSync() {
    setSyncing(true);
    try {
      const count = await dataService.syncCalendarToday();
      toast(count > 0 ? `已同步 ${count} 个日历事件` : '当前还没有达到最短写入时长的工作块', count > 0 ? 'success' : 'warning');
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      toast(`日历同步失败：${message}`, 'error');
    } finally {
      setSyncing(false);
    }
  }

  async function handleClearData() {
    if (!window.confirm('确定清除 Trace 本地追溯数据吗？系统日历事件不会自动删除。')) return;
    try {
      await clearAllData();
      toast('本地追溯数据已清除', 'success');
    } catch (error) {
      console.error(error);
      toast('清除本地数据失败', 'error');
    }
  }

  async function handleClearLearnedRules() {
    if (!window.confirm('确定清除本地学习规则吗？后续相似活动会回到重新学习状态。')) return;
    try {
      await dataService.clearLearnedRules();
      setLearnedRules([]);
      toast('学习规则已清除', 'success');
    } catch (error) {
      console.error(error);
      toast('清除学习规则失败', 'error');
    }
  }

  return (
    <div className="min-h-screen p-8 lg:p-10">
      <header className="mb-8 rounded-[32px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] px-7 py-7 shadow-[var(--shadow-card)] backdrop-blur-xl">
        <div className="mb-4 inline-flex rounded-full bg-[var(--color-bg-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--color-green-hover)]">
          macOS native setup
        </div>
        <h1 className="mb-3 text-[30px] leading-[1.05] font-semibold tracking-[-0.04em]">设置与本地规则</h1>
        <p className="max-w-2xl text-sm leading-7 text-[var(--color-text-muted)]">
          这里不做复杂系统配置，只保留追溯、提醒事项、日历、AI 总结和本地学习规则这些真正会影响日常体验的项。
        </p>
      </header>

      <div className="max-w-3xl space-y-6">
        <Section icon={AppWindow} title="追溯状态" description="控制后台是否继续记录当前活动窗口。">
          <button
            onClick={() => void handleTrackingToggle()}
            disabled={trackingBusy}
            className="flex items-center gap-3 px-5 py-3 rounded-xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-2)] font-semibold disabled:opacity-60"
          >
            {isTracking ? <Square size={18} /> : <Play size={18} />}
            {isTracking ? '暂停追溯' : '开始追溯'}
          </button>
          <div className="mt-3 text-sm text-[var(--color-text-muted)]">
            当前状态：{isTracking ? '追溯中' : '暂停中'}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <RuntimeStatusTile
              label="睡眠后处理"
              value={runtimeStatus?.last_recovery_reason === 'sleep_wake_gap' ? '已暂停' : '待机'}
              detail={
                runtimeStatus?.last_recovery_at_ms
                  ? `上次睡眠/唤醒：${formatRuleTime(runtimeStatus.last_recovery_at_ms)}，需要手动点击开始`
                  : '尚未检测到睡眠/唤醒'
              }
              tone={runtimeStatus?.last_recovery_reason === 'sleep_wake_gap' ? 'warning' : 'default'}
            />
            <RuntimeStatusTile
              label="日历权限退避"
              value={runtimeStatus?.calendar_permission_backoff_active ? '稍后重试' : '正常'}
              detail={
                runtimeStatus?.calendar_permission_backoff_until_ms
                  ? `Trace 会在 ${formatRelativeSeconds(runtimeStatus.calendar_permission_backoff_until_ms)} 后再读写日历`
                  : '没有检测到日历权限阻塞'
              }
              tone={runtimeStatus?.calendar_permission_backoff_active ? 'warning' : 'default'}
            />
            <RuntimeStatusTile
              label="最近恢复原因"
              value={runtimeStatus?.last_recovery_reason === 'sleep_wake_gap' ? '睡眠后暂停' : '暂无'}
              detail={
                runtimeStatus?.last_recovery_gap_ms
                  ? `检测到 ${(runtimeStatus.last_recovery_gap_ms / 1000).toFixed(0)} 秒采集间隔，已停止写入新记录`
                  : '没有需要处理的异常间隔'
              }
            />
            <RuntimeStatusTile
              label="运行状态来源"
              value={runtimeStatus?.is_tracking ? '后台追溯中' : '已暂停'}
              detail="这里只读取状态，不会触发新的系统权限弹窗。"
            />
          </div>
        </Section>

        <Section icon={Sun} title="外观" description="只保留浅色/深色主题。">
          <div className="grid grid-cols-2 gap-3">
            {[
              { value: 'light' as const, label: '浅色', icon: Sun },
              { value: 'dark' as const, label: '深色', icon: Moon },
            ].map((option) => {
              const Icon = option.icon;
              const active = settings.theme === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => void updateSettings({ theme: option.value })}
                  className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 font-semibold ${
                    active
                      ? 'border-[var(--color-blue)] bg-[var(--color-blue-soft)] text-[var(--color-blue-hover)]'
                      : 'border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)]'
                  }`}
                >
                  <Icon size={18} />
                  {option.label}
                </button>
              );
            })}
          </div>
        </Section>

        <Section icon={CalendarClock} title="系统日历" description="Trace 会把聚合后的追溯块写入指定系统日历。">
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4">
              <span className="font-medium">自动同步到日历</span>
              <input
                type="checkbox"
                checked={settings.calendarSyncEnabled}
                onChange={(event) => void updateSettings({ calendarSyncEnabled: event.target.checked })}
                className="w-5 h-5"
              />
            </label>

            <label className="flex items-center justify-between gap-4">
              <span className="font-medium">读取 Calendar 做计划对照</span>
              <input
                type="checkbox"
                checked={settings.calendarInsightsEnabled}
                onChange={(event) => void updateSettings({ calendarInsightsEnabled: event.target.checked })}
                className="w-5 h-5"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium">日历名称</span>
              <input
                value={calendarNameDraft}
                onChange={(event) => setCalendarNameDraft(event.target.value)}
                onBlur={() => {
                  const nextName = calendarNameDraft.trim();
                  if (!nextName) {
                    setCalendarNameDraft(settings.calendarName);
                    toast('日历名称不能为空', 'warning');
                    return;
                  }
                  if (nextName !== settings.calendarName) {
                    void updateSettings({ calendarName: nextName }).catch((error) => {
                      console.error(error);
                      setCalendarNameDraft(settings.calendarName);
                      toast('保存日历名称失败', 'error');
                    });
                  }
                }}
                className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none"
              />
            </label>

            <div className="grid grid-cols-2 gap-4">
              <NumberSetting
                label="最短写入时长（分钟）"
                value={settings.minActivityMinutes}
                min={5}
                max={60}
                step={1}
                onChange={(value) => void updateSettings({ minActivityMinutes: value })}
              />
              <NumberSetting
                label="聚合间隔（分钟）"
                value={settings.mergeGapMinutes}
                min={15}
                max={120}
                step={5}
                onChange={(value) => void updateSettings({ mergeGapMinutes: value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <SegmentedSetting
                label="后台静默更新"
                value={settings.activityRefreshMinutes}
                options={[1, 5, 15, 30]}
                suffix="分钟"
                onChange={(value) => void updateSettings({ activityRefreshMinutes: value as 1 | 5 | 15 | 30 | 60 })}
              />
              <SegmentedSetting
                label="日历自动同步"
                value={settings.calendarSyncIntervalMinutes}
                options={[5, 15, 30, 60]}
                suffix="分钟"
                onChange={(value) => void updateSettings({ calendarSyncIntervalMinutes: value as 5 | 15 | 30 | 60 })}
              />
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              这里控制的是后台默默更新当前可见范围和今日追溯状态，不会每次都把所有历史范围整页重刷。
            </p>

            <button
              onClick={() => void handleCalendarSync()}
              disabled={syncing}
              className="flex items-center gap-2 px-5 py-3 rounded-xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-2)] font-semibold disabled:opacity-60"
            >
              {syncing ? <RefreshCw size={18} className="animate-spin" /> : <CalendarClock size={18} />}
              立即同步今天的日历事件
            </button>
          </div>
        </Section>

        <Section icon={ListTreeIcon} title="提醒事项" description="Trace 会读取系统提醒事项做计划对照。建议只保留你真正想参与计划匹配的列表。">
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4">
              <span className="font-medium">启用提醒事项对照</span>
              <input
                type="checkbox"
                checked={settings.remindersEnabled}
                onChange={(event) => void updateSettings({ remindersEnabled: event.target.checked })}
                className="w-5 h-5"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium">参与匹配的提醒事项列表</span>
              <textarea
                value={reminderListsInput}
                onChange={(event) => setReminderListsInput(event.target.value)}
                rows={4}
                className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none"
                placeholder="每行一个列表名；留空则默认读取全部列表"
              />
            </label>

            {availableReminderLists.length > 0 ? (
              <div>
                <div className="text-xs font-semibold text-[var(--color-text-muted)] mb-2">系统中检测到的列表</div>
                <div className="flex flex-wrap gap-2">
                  {availableReminderLists.map((item) => (
                    <button
                      key={item}
                      onClick={() => {
                        const current = reminderListsInput
                          .split('\n')
                          .map((value) => value.trim())
                          .filter(Boolean);
                        if (current.includes(item)) return;
                        setReminderListsInput([...current, item].join('\n'));
                      }}
                      className="rounded-full border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-3 py-1 text-xs"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <button
              onClick={() => void handleReminderListsSave()}
              className="px-5 py-3 rounded-xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-2)] font-semibold"
            >
              保存提醒事项列表
            </button>
            <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4 text-sm leading-7 text-[var(--color-text-secondary)]">
              分析页里和“目标 / 计划”相关的指标，当前默认只基于这里启用的提醒事项列表来计算。
              Trace 会先用标题匹配、时间重叠和工作块语义来判断“这段时间是否在推进某个提醒事项”。
              如果你希望这个指标更接近“当前主线目标”，就把主线任务写进这里选中的提醒事项列表里。
              如果用户没有维护提醒事项，这个指标就不应该被解读成真正的长期目标一致性。
            </div>
          </div>
        </Section>

        <Section icon={ShieldAlert} title="忽略应用" description="每行一个应用名，匹配后不记录。建议保留 Trace，避免记录自己。">
          <textarea
            value={ignoredInput}
            onChange={(event) => setIgnoredInput(event.target.value)}
            rows={5}
            className="w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none"
          />
          <button
            onClick={() => void handleIgnoredAppsSave()}
            className="mt-3 px-5 py-3 rounded-xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-2)] font-semibold"
          >
            保存忽略列表
          </button>
        </Section>

        <Section icon={Tags} title="分类关键词" description="这组关键词会直接参与本地工作块归类，适合把浏览网页、整理文件这类泛分类压回真实意图。">
          <textarea
            value={categoryRulesDraft}
            onChange={(event) => setCategoryRulesDraft(event.target.value)}
            rows={6}
            className="w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none leading-relaxed"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-text-muted)]">
              格式建议：分类名：关键词、关键词。保存后会立即影响 Today / Timeline / Review 里的本地归类结果。
            </p>
            <button
              onClick={() => void handleCategoryRulesSave()}
              className="shrink-0 px-5 py-3 rounded-xl border-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface-2)] font-semibold"
            >
              保存并生效
            </button>
          </div>
        </Section>

        <Section icon={BrainCircuit} title="本地 AI 总结" description="使用本机 Ollama 的 qwen3 模型生成复盘总结。按小时级缓存，不会随着页面实时刷新。">
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4">
              <span className="font-medium">启用 AI 总结</span>
              <input
                type="checkbox"
                checked={settings.aiSummariesEnabled}
                onChange={(event) => void updateSettings({ aiSummariesEnabled: event.target.checked })}
                className="w-5 h-5"
              />
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium">本地模型</span>
                <select
                  value={settings.aiSummaryModel}
                  onChange={(event) => void updateSettings({ aiSummaryModel: event.target.value as 'qwen3:1.7b' | 'qwen3:4b' })}
                  className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none"
                >
                  <option value="qwen3:1.7b">qwen3:1.7b</option>
                  <option value="qwen3:4b">qwen3:4b</option>
                </select>
              </label>

              <div>
                <div className="text-sm font-medium mb-2">刷新间隔</div>
                <div className="grid grid-cols-4 rounded-lg border-2 border-[var(--color-border-light)] overflow-hidden">
                  {([2, 4, 6, 12] as const).map((hours) => (
                    <button
                      key={hours}
                      onClick={() => void updateSettings({ aiSummaryRefreshHours: hours })}
                      className={`px-3 py-2 text-sm font-semibold ${
                        settings.aiSummaryRefreshHours === hours ? 'bg-[var(--color-blue)] text-white' : 'bg-[var(--color-bg-surface-2)]'
                      }`}
                    >
                      {hours}h
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <p className="text-xs text-[var(--color-text-muted)]">
              默认建议使用 `qwen3:4b` 做更稳定的本地归纳；如果更在意速度，再切回 `qwen3:1.7b`。Trace 会按所选模型和时间范围缓存总结。
            </p>
          </div>
        </Section>

        <Section icon={ShieldAlert} title="隐私说明" description="Trace 当前版本强调本地优先和轻读取，不做重监控。">
          <div className="space-y-3 text-sm leading-7 text-[var(--color-text-secondary)]">
            <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
              Trace 只记录前台窗口活动、持续时长和轻量上下文，不截图，也不记录按键内容。
            </div>
            <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
              Reminders 和 Calendar 只用于本地计划对照。你可以分别关闭提醒事项对照和 Calendar 对照。
            </div>
            <div className="rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-4">
              本地 AI 总结默认走你本机的 Ollama 模型，不会把复盘内容发到远程服务。
            </div>
          </div>
        </Section>

        <Section icon={Tags} title="学习规则" description="这里显示 Trace 通过你的修正沉淀下来的本地学习规则，用于后续命中相似活动。">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="text-sm text-[var(--color-text-muted)]">
              当前共 {learnedRules.length} 条规则
            </div>
            <button
              onClick={() => void handleClearLearnedRules()}
              disabled={learnedRules.length === 0}
              className="px-4 py-2 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] text-sm font-semibold disabled:opacity-40"
            >
              清除学习规则
            </button>
          </div>

          {loadingLearnedRules ? (
            <div className="text-sm text-[var(--color-text-muted)]">正在读取学习规则...</div>
          ) : recentLearnedRules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border-light)] px-4 py-4 text-sm text-[var(--color-text-muted)]">
              还没有学习规则。你在时间线里修正几次之后，这里就会开始出现。
            </div>
          ) : (
            <div className="space-y-3">
              {recentLearnedRules.map((rule) => (
                <div key={`${rule.appName}:${rule.contextKey}:${rule.updatedAtMs}`} className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold leading-6">{rule.correctedDescription || rule.title || '未命名规则'}</div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                        {rule.appName} · {rule.correctedCategory || '未分类'} · {rule.correctedActivityType || '未设 activity type'}
                      </div>
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                      {formatRuleTime(rule.updatedAtMs)}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                    触发键：{rule.contextKey || rule.activityType || rule.title || rule.appName}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={Trash2} title="危险操作" description="只清除 Trace 本地追溯数据，不删除系统日历中的历史事件。">
          <button
            onClick={() => void handleClearData()}
            className="flex items-center gap-2 px-5 py-3 rounded-xl border-2 border-[var(--color-coral)] bg-[var(--color-coral-soft)] text-[var(--color-coral-hover)] font-semibold"
          >
            <Trash2 size={18} />
            清除本地追溯数据
          </button>
        </Section>
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

function formatRelativeSeconds(timestamp: number): string {
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function RuntimeStatusTile({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${
      tone === 'warning'
        ? 'border-[rgba(216,179,108,0.45)] bg-[rgba(255,248,229,0.85)]'
        : 'border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)]'
    }`}
    >
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[var(--color-text-primary)]">{value}</div>
      <div className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{detail}</div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof CalendarClock;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-[var(--color-border-light)] bg-[var(--color-bg-surface-1)] p-6 shadow-[var(--shadow-card)] backdrop-blur-xl">
      <h2 className="mb-1 flex items-center gap-3 font-semibold">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--color-bg-surface-2)] text-[var(--color-green-hover)]">
          <Icon size={18} />
        </span>
        {title}
      </h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-5">{description}</p>
      {children}
    </section>
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-[var(--color-border-light)] bg-[var(--color-bg-surface-2)] outline-none"
      />
    </label>
  );
}

function SegmentedSetting({
  label,
  value,
  options,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="text-sm font-medium mb-2">{label}</div>
      <div
        className="grid rounded-lg border-2 border-[var(--color-border-light)] overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <button
            key={option}
            onClick={() => onChange(option)}
            className={`px-3 py-2 text-sm font-semibold ${
              value === option ? 'bg-[var(--color-blue)] text-white' : 'bg-[var(--color-bg-surface-2)]'
            }`}
          >
            {option} {suffix}
          </button>
        ))}
      </div>
    </div>
  );
}
