pub mod calendar;
pub mod transform;
pub mod watcher;

use anyhow::{anyhow, Result};
use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static INSTANCE_LOCK: OnceLock<File> = OnceLock::new();
static LEARNED_RULES_CACHE: OnceLock<Mutex<Vec<LearnedDescriptionRule>>> = OnceLock::new();
static MANUAL_CALENDAR_CHECK_CACHE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static CALENDAR_CONTEXT_CACHE: OnceLock<Mutex<HashMap<String, CachedContextItems>>> =
    OnceLock::new();
static REMINDER_CONTEXT_CACHE: OnceLock<Mutex<Option<CachedReminderContext>>> = OnceLock::new();
static CALENDAR_PERMISSION_BACKOFF_UNTIL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static AUTOMATION_SUPPRESSION_UNTIL: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static JSON_FILE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CORRUPT_ACTIVITY_DATES: OnceLock<Mutex<HashSet<NaiveDate>>> = OnceLock::new();
const SLEEP_GAP_THRESHOLD: Duration = Duration::from_secs(10);
const CALENDAR_PERMISSION_RETRY_COOLDOWN: Duration = Duration::from_secs(30 * 60);
const MANUAL_CALENDAR_RECONCILE_LOOKBACK_DAYS: i64 = 7;
const MANUAL_CALENDAR_CHECK_COOLDOWN: Duration = Duration::from_secs(180);
const OLLAMA_SUMMARY_TIMEOUT_1_7B: Duration = Duration::from_secs(25);
const OLLAMA_SUMMARY_TIMEOUT_4B: Duration = Duration::from_secs(45);
const CALENDAR_CONTEXT_CACHE_TTL: Duration = Duration::from_secs(120);
const REMINDER_CONTEXT_CACHE_TTL: Duration = Duration::from_secs(300);
const CALENDAR_AUTOMATION_SUPPRESSION: Duration = Duration::from_secs(90);
const REMINDER_AUTOMATION_SUPPRESSION: Duration = Duration::from_secs(45);
const TRAY_ID: &str = "trace-status";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub id: String,
    pub name: String,
    pub window_title: String,
    #[serde(default)]
    pub raw_window_title: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub activity_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub focus_score: Option<u8>,
    #[serde(default)]
    pub context_key: Option<String>,
    #[serde(default)]
    pub linked_reminder_title: Option<String>,
    #[serde(default)]
    pub linked_reminder_source: Option<String>,
    #[serde(default)]
    pub linked_calendar_title: Option<String>,
    #[serde(default)]
    pub linked_calendar_source: Option<String>,
    pub start_time_ms: i64,
    pub duration_minutes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeekContext {
    pub goals: Vec<ContextItem>,
    pub calendar_events: Vec<ContextItem>,
    pub reminders: Vec<ContextItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextItem {
    pub title: String,
    pub source: String,
    #[serde(default)]
    pub start_time_ms: Option<i64>,
    #[serde(default)]
    pub end_time_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub auto_start_tracking: bool,
    pub calendar_sync_enabled: bool,
    pub calendar_insights_enabled: bool,
    pub calendar_name: String,
    pub min_activity_minutes: f64,
    pub merge_gap_minutes: i64,
    pub activity_refresh_minutes: i64,
    pub calendar_sync_interval_minutes: i64,
    pub ignored_applications: Vec<String>,
    pub reminders_enabled: bool,
    pub reminder_lists: Vec<String>,
    pub ai_summaries_enabled: bool,
    pub ai_summary_model: String,
    pub ai_summary_refresh_hours: i64,
    pub category_rules_draft: String,
    pub category_rules_version: i64,
    #[serde(default = "default_goal_metric_mode")]
    pub goal_metric_mode: String,
}

#[derive(Debug, Clone, Serialize)]
struct TrackingOverview {
    is_tracking: bool,
    active_app: String,
    active_title: String,
    active_ignored: bool,
    last_capture_at_ms: Option<i64>,
    current_block_title: String,
    current_block_minutes: f64,
    min_calendar_minutes: f64,
    calendar_sync_enabled: bool,
    calendar_pending: bool,
    calendar_sync_running: bool,
    last_calendar_sync_at_ms: Option<i64>,
    last_calendar_sync_error: Option<String>,
    last_calendar_write_count: usize,
    today_activity_count: usize,
    today_captured_minutes: f64,
}

#[derive(Debug, Clone)]
struct TrackingRecoverySnapshot {
    at_ms: i64,
    gap_ms: i64,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
struct TrackingRuntimeStatus {
    is_tracking: bool,
    recovery_active: bool,
    recovery_until_ms: Option<i64>,
    last_recovery_at_ms: Option<i64>,
    last_recovery_gap_ms: Option<i64>,
    last_recovery_reason: Option<String>,
    calendar_permission_backoff_active: bool,
    calendar_permission_backoff_until_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct PlannedCalendarBlockInput {
    title: String,
    start_time_ms: i64,
    end_time_ms: i64,
    source_reminder: String,
    rationale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            auto_start_tracking: false,
            calendar_sync_enabled: true,
            calendar_insights_enabled: true,
            calendar_name: "Trace AI 时间追踪".to_string(),
            min_activity_minutes: 5.0,
            merge_gap_minutes: 30,
            activity_refresh_minutes: 5,
            calendar_sync_interval_minutes: 15,
            ignored_applications: vec![
                "UserNotificationCenter".to_string(),
                "Notification Center".to_string(),
                "通知中心".to_string(),
                "Control Center".to_string(),
                "控制中心".to_string(),
                "Window Server".to_string(),
                "loginwindow".to_string(),
                "Dock".to_string(),
            ],
            reminders_enabled: true,
            reminder_lists: Vec::new(),
            ai_summaries_enabled: true,
            ai_summary_model: "qwen3:4b".to_string(),
            ai_summary_refresh_hours: 6,
            category_rules_draft: "项目推进：项目、方案、计划、交付、复盘\n文档写作：文档、报告、说明、案例、总结\n沟通协作：会议、回复、确认、讨论、同步\n开发构建：代码、调试、构建、测试、发布\n研究学习：搜索、资料、论文、阅读、分析\n休息娱乐：休息、音乐、视频、电影、剧集".to_string(),
            category_rules_version: 1,
            goal_metric_mode: "reminders".to_string(),
        }
    }
}

fn default_goal_metric_mode() -> String {
    "reminders".to_string()
}

#[derive(Debug, Deserialize)]
struct SettingsPatch {
    theme: Option<String>,
    calendar_sync_enabled: Option<bool>,
    calendar_insights_enabled: Option<bool>,
    calendar_name: Option<String>,
    min_activity_minutes: Option<f64>,
    merge_gap_minutes: Option<i64>,
    activity_refresh_minutes: Option<i64>,
    calendar_sync_interval_minutes: Option<i64>,
    ignored_applications: Option<Vec<String>>,
    reminders_enabled: Option<bool>,
    reminder_lists: Option<Vec<String>>,
    ai_summaries_enabled: Option<bool>,
    ai_summary_model: Option<String>,
    ai_summary_refresh_hours: Option<i64>,
    category_rules_draft: Option<String>,
    category_rules_version: Option<i64>,
    goal_metric_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedContextItems {
    items: Vec<ContextItem>,
    cached_at: Instant,
}

#[derive(Debug, Clone)]
struct CachedReminderContext {
    items: Vec<ContextItem>,
    cached_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LearnedDescriptionRule {
    app_name: String,
    activity_type: String,
    context_key: String,
    title: String,
    #[serde(default)]
    corrected_category: String,
    #[serde(default)]
    corrected_activity_type: String,
    #[serde(default)]
    corrected_context_key: String,
    #[serde(default)]
    corrected_description: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
struct LearnedRuleView {
    app_name: String,
    activity_type: String,
    context_key: String,
    title: String,
    corrected_category: String,
    corrected_activity_type: String,
    corrected_context_key: String,
    corrected_description: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct ActivityCorrectionPatch {
    description: Option<String>,
    category: Option<String>,
    activity_type: Option<String>,
    context_key: Option<String>,
    linked_reminder_title: Option<String>,
    linked_reminder_source: Option<String>,
    linked_calendar_title: Option<String>,
    linked_calendar_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiSummaryCacheEntry {
    key: String,
    model: String,
    summary: String,
    generated_at_ms: i64,
}

#[derive(Clone)]
pub struct AppState {
    activities: Arc<Mutex<Vec<Activity>>>,
    current_date: Arc<Mutex<NaiveDate>>,
    settings: Arc<Mutex<Settings>>,
    is_tracking: Arc<Mutex<bool>>,
    heartbeat_manager: Arc<Mutex<transform::HeartbeatManager>>,
    window_watcher: Arc<Mutex<watcher::WindowWatcher>>,
    last_tick: Arc<Mutex<Instant>>,
    wake_guard_until: Arc<Mutex<Option<Instant>>>,
    activities_dirty: Arc<Mutex<bool>>,
    calendar_dirty: Arc<Mutex<bool>>,
    calendar_sync_running: Arc<Mutex<bool>>,
    last_save_time: Arc<Mutex<Instant>>,
    last_calendar_sync_time: Arc<Mutex<Instant>>,
    last_capture_at_ms: Arc<Mutex<Option<i64>>>,
    last_calendar_sync_at_ms: Arc<Mutex<Option<i64>>>,
    last_calendar_sync_error: Arc<Mutex<Option<String>>>,
    last_calendar_write_count: Arc<Mutex<usize>>,
    last_recovery: Arc<Mutex<Option<TrackingRecoverySnapshot>>>,
}

fn get_data_dir() -> Result<PathBuf> {
    let app_dir = APP_DATA_DIR
        .get()
        .cloned()
        .or_else(|| dirs::data_dir().map(|dir| dir.join("trace")))
        .ok_or_else(|| anyhow!("无法获取 Trace 数据目录"))?;
    fs::create_dir_all(&app_dir)?;
    Ok(app_dir)
}

fn get_settings_path() -> Result<PathBuf> {
    Ok(get_data_dir()?.join("settings.json"))
}

fn get_learned_rules_path() -> Result<PathBuf> {
    Ok(get_data_dir()?.join("learned_description_rules.json"))
}

fn get_ai_summary_cache_path() -> Result<PathBuf> {
    Ok(get_data_dir()?.join("ai_summary_cache.json"))
}

fn acquire_instance_lock() -> Result<()> {
    let lock_path = get_data_dir()?.join("trace.instance.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;

    file.try_lock()
        .map_err(|_| anyhow!("Trace 已经在运行。请先退出旧版应用或关闭另一个 Trace 实例。"))?;

    let _ = INSTANCE_LOCK.set(file);
    Ok(())
}

fn get_activities_path(date: NaiveDate) -> Result<PathBuf> {
    Ok(get_data_dir()?.join(format!("activities_{}.json", date)))
}

fn read_activities(date: NaiveDate) -> Result<Vec<Activity>> {
    let path = get_activities_path(date)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)?;
    match serde_json::from_str::<Vec<Activity>>(&content) {
        Ok(activities) => Ok(activities),
        Err(error) => {
            let backup_path = path.with_extension(format!(
                "json.corrupt-{}",
                chrono::Utc::now().timestamp_millis()
            ));
            let _ = fs::copy(&path, &backup_path);
            corrupt_activity_dates()
                .lock()
                .unwrap_or_else(|lock_error| lock_error.into_inner())
                .insert(date);
            append_runtime_log(&format!(
                "[Trace] activity file parse failed for {date}: {error}; preserved backup at {}",
                backup_path.display(),
            ));
            Ok(Vec::new())
        }
    }
}

fn corrupt_activity_dates() -> &'static Mutex<HashSet<NaiveDate>> {
    CORRUPT_ACTIVITY_DATES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn json_file_write_lock() -> &'static Mutex<()> {
    JSON_FILE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn atomic_write_text(path: &Path, content: &str) -> Result<()> {
    let _guard = json_file_write_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("trace-data");
    let tmp_path = path.with_file_name(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp_path, path).or_else(|rename_error| {
        let _ = fs::remove_file(&tmp_path);
        Err(rename_error)
    })?;
    Ok(())
}

fn write_activities(date: NaiveDate, activities: &[Activity]) -> Result<()> {
    let path = get_activities_path(date)?;
    let json = serde_json::to_string_pretty(activities)?;
    atomic_write_text(&path, &json)?;
    corrupt_activity_dates()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&date);
    Ok(())
}

fn append_runtime_log(message: &str) {
    let Ok(data_dir) = get_data_dir() else {
        return;
    };
    let path = data_dir.join("trace-runtime.log");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {}", Local::now().to_rfc3339(), message);
}

fn install_runtime_panic_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .map(|value| format!("{}:{}", value.file(), value.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_string())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_string());
        append_runtime_log(&format!("[Trace] panic captured at {location}: {payload}"));
    }));
}

fn load_current_date(state: &AppState, date: NaiveDate) -> Result<()> {
    let mut activities = read_activities(date)?;
    let migrated = migrate_legacy_descriptions(&mut activities);
    if migrated {
        write_activities(date, &activities)?;
    }
    *state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = activities;
    *state
        .current_date
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = date;
    state
        .heartbeat_manager
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear_all();
    *state
        .last_tick
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Instant::now();
    Ok(())
}

fn migrate_legacy_descriptions(activities: &mut [Activity]) -> bool {
    let mut changed = false;
    for activity in activities {
        if activity.activity_type.as_deref() == Some("用户修正") {
            continue;
        }
        let description = activity.description.as_deref().unwrap_or("");
        let app_name = activity.name.trim();
        let generic_app_usage = description == format!("使用 {app_name}")
            || description == format!("使用 {app_name} 浏览网页")
            || description == format!("使用 {app_name} 沟通")
            || description == format!("使用 {app_name} 进行 AI 编程");
        let is_legacy = description.starts_with('[')
            || description == "用 AI 工具 进行 AI 编程"
            || description.trim().is_empty()
            || generic_app_usage;
        if !is_legacy {
            continue;
        }

        let analysis = analyze_activity(
            &activity.name,
            &activity.window_title,
            activity.raw_window_title.as_deref().unwrap_or(""),
        );
        activity.category = Some(analysis.category);
        activity.activity_type = Some(analysis.activity_type);
        activity.description = Some(analysis.description);
        activity.focus_score = Some(analysis.focus_score);
        activity.context_key = Some(analysis.context_key);
        apply_learned_description(activity);
        changed = true;
    }
    changed
}

fn save_current_activities(state: &AppState) -> Result<()> {
    let date = *state
        .current_date
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dirty = *state
        .activities_dirty
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let file_was_corrupt = corrupt_activity_dates()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains(&date);
    if file_was_corrupt && !dirty {
        append_runtime_log(&format!(
            "[Trace] skipped clean save for {date} because the activity file was corrupt and preserved as backup",
        ));
        return Ok(());
    }
    let activities = state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    write_activities(date, &activities)
}

fn matches_ignored_application(app_name: &str, ignored_applications: &[String]) -> bool {
    let normalized = app_name.to_lowercase();
    ignored_applications
        .iter()
        .any(|ignored| !ignored.trim().is_empty() && normalized.contains(&ignored.to_lowercase()))
}

fn normalize_ignored_applications(apps: Vec<String>) -> Vec<String> {
    apps.into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty() && item.to_lowercase() != "trace")
        .collect()
}

fn load_settings() -> Settings {
    let Ok(path) = get_settings_path() else {
        return Settings::default();
    };

    if !path.exists() {
        return Settings::default();
    }

    let mut settings = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Settings>(&content).ok())
        .unwrap_or_default();
    settings.min_activity_minutes = settings.min_activity_minutes.clamp(5.0, 60.0);
    settings.merge_gap_minutes = settings.merge_gap_minutes.max(15);
    settings.activity_refresh_minutes =
        normalize_activity_refresh_minutes(settings.activity_refresh_minutes);
    settings.calendar_sync_interval_minutes =
        normalize_calendar_refresh_minutes(settings.calendar_sync_interval_minutes);
    settings.ignored_applications = normalize_ignored_applications(settings.ignored_applications);
    settings.reminder_lists = settings
        .reminder_lists
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    settings.ai_summary_model = normalize_ai_summary_model(&settings.ai_summary_model);
    settings.ai_summary_refresh_hours =
        normalize_ai_summary_refresh_hours(settings.ai_summary_refresh_hours);
    if settings.category_rules_version < 1 {
        settings.category_rules_version = 1;
    }
    settings.goal_metric_mode = normalize_goal_metric_mode(&settings.goal_metric_mode);
    settings
}

fn write_settings(settings: &Settings) -> Result<()> {
    let path = get_settings_path()?;
    let content = serde_json::to_string_pretty(settings)?;
    atomic_write_text(&path, &content)?;
    Ok(())
}

fn read_learned_rules() -> Vec<LearnedDescriptionRule> {
    let Ok(path) = get_learned_rules_path() else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Vec<LearnedDescriptionRule>>(&content).ok())
        .unwrap_or_default()
}

fn learned_rules_cache() -> &'static Mutex<Vec<LearnedDescriptionRule>> {
    LEARNED_RULES_CACHE.get_or_init(|| Mutex::new(read_learned_rules()))
}

fn read_cached_learned_rules() -> Vec<LearnedDescriptionRule> {
    learned_rules_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn replace_cached_learned_rules(rules: &[LearnedDescriptionRule]) {
    *learned_rules_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = rules.to_vec();
}

fn write_learned_rules(rules: &[LearnedDescriptionRule]) -> Result<()> {
    let path = get_learned_rules_path()?;
    let content = serde_json::to_string_pretty(rules)?;
    atomic_write_text(&path, &content)?;
    replace_cached_learned_rules(rules);
    Ok(())
}

fn remember_learned_rules(next_rules: Vec<LearnedDescriptionRule>) -> Result<()> {
    if next_rules.is_empty() {
        return Ok(());
    }

    let mut rules = read_cached_learned_rules();
    for next_rule in next_rules {
        if let Some(existing) = rules.iter_mut().find(|rule| {
            rule.app_name.eq_ignore_ascii_case(&next_rule.app_name)
                && rule.activity_type == next_rule.activity_type
                && rule.context_key == next_rule.context_key
        }) {
            *existing = next_rule;
        } else {
            rules.push(next_rule);
        }
    }
    rules.sort_by_key(|rule| std::cmp::Reverse(rule.updated_at_ms));
    rules.truncate(120);
    write_learned_rules(&rules)
}

fn to_learned_rule_view(rule: LearnedDescriptionRule) -> LearnedRuleView {
    LearnedRuleView {
        app_name: rule.app_name,
        activity_type: rule.activity_type,
        context_key: rule.context_key,
        title: rule.title,
        corrected_category: rule.corrected_category,
        corrected_activity_type: rule.corrected_activity_type,
        corrected_context_key: rule.corrected_context_key,
        corrected_description: rule.corrected_description,
        updated_at_ms: rule.updated_at_ms,
    }
}

fn read_ai_summary_cache() -> Vec<AiSummaryCacheEntry> {
    let Ok(path) = get_ai_summary_cache_path() else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Vec<AiSummaryCacheEntry>>(&content).ok())
        .unwrap_or_default()
}

fn write_ai_summary_cache(entries: &[AiSummaryCacheEntry]) -> Result<()> {
    let path = get_ai_summary_cache_path()?;
    let content = serde_json::to_string_pretty(entries)?;
    atomic_write_text(&path, &content)?;
    Ok(())
}

fn build_rule_from_activity(before: &Activity, after: &Activity) -> LearnedDescriptionRule {
    let fallback_title = after.description.clone().unwrap_or_else(|| {
        after.context_key.clone().unwrap_or_else(|| {
            before
                .description
                .clone()
                .unwrap_or_else(|| before.name.clone())
        })
    });

    LearnedDescriptionRule {
        app_name: before.name.clone(),
        activity_type: before.activity_type.clone().unwrap_or_default(),
        context_key: before.context_key.clone().unwrap_or_default(),
        title: fallback_title.clone(),
        corrected_category: after.category.clone().unwrap_or_default(),
        corrected_activity_type: after.activity_type.clone().unwrap_or_default(),
        corrected_context_key: after
            .context_key
            .clone()
            .unwrap_or_else(|| fallback_title.clone()),
        corrected_description: after.description.clone().unwrap_or(fallback_title),
        updated_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

fn sanitize_optional_text(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn apply_correction_to_activity(activity: &mut Activity, correction: &ActivityCorrectionPatch) {
    if let Some(description) = sanitize_optional_text(&correction.description) {
        activity.description = Some(description.clone());
        if sanitize_optional_text(&correction.context_key).is_none() {
            activity.context_key = Some(description);
        }
    }
    if let Some(category) = sanitize_optional_text(&correction.category) {
        activity.category = Some(category);
    }
    if let Some(activity_type) = sanitize_optional_text(&correction.activity_type) {
        activity.activity_type = Some(activity_type);
    } else if correction.description.is_some() {
        activity.activity_type = Some("用户修正".to_string());
    }
    if let Some(context_key) = sanitize_optional_text(&correction.context_key) {
        activity.context_key = Some(context_key);
    }
    if correction.linked_reminder_title.is_some() || correction.linked_reminder_source.is_some() {
        activity.linked_reminder_title = sanitize_optional_text(&correction.linked_reminder_title);
        activity.linked_reminder_source =
            sanitize_optional_text(&correction.linked_reminder_source);
    }
    if correction.linked_calendar_title.is_some() || correction.linked_calendar_source.is_some() {
        activity.linked_calendar_title = sanitize_optional_text(&correction.linked_calendar_title);
        activity.linked_calendar_source =
            sanitize_optional_text(&correction.linked_calendar_source);
    }
}

fn update_activities_in_memory(
    activities: &mut [Activity],
    activity_ids: &[String],
    correction: &ActivityCorrectionPatch,
) -> (Vec<Activity>, Vec<LearnedDescriptionRule>) {
    let mut updated = Vec::new();
    let mut rules = Vec::new();
    for activity in activities.iter_mut() {
        if !activity_ids.iter().any(|id| id == &activity.id) {
            continue;
        }
        let before = activity.clone();
        apply_correction_to_activity(activity, correction);
        updated.push(activity.clone());
        rules.push(build_rule_from_activity(&before, activity));
    }
    (updated, rules)
}

fn save_activity_corrections_internal(
    activity_ids: &[String],
    correction: &ActivityCorrectionPatch,
    state: &AppState,
) -> Result<Vec<Activity>> {
    if activity_ids.is_empty() {
        return Ok(Vec::new());
    }

    let loaded_date = *state
        .current_date
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    append_runtime_log(&format!(
        "[Trace] save activity corrections started: ids={} date={} has_description={} has_category={} has_activity_type={}",
        activity_ids.len(),
        loaded_date,
        correction.description.as_ref().is_some_and(|value| !value.trim().is_empty()),
        correction.category.as_ref().is_some_and(|value| !value.trim().is_empty()),
        correction.activity_type.as_ref().is_some_and(|value| !value.trim().is_empty()),
    ));
    let mut updated_items = Vec::new();
    let mut next_rules = Vec::new();

    {
        let mut current = state
            .activities
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (updated, rules) = update_activities_in_memory(&mut current, activity_ids, correction);
        if !updated.is_empty() {
            updated_items.extend(updated);
            next_rules.extend(rules);
            write_activities(loaded_date, &current)?;
            *state
                .activities_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = false;
            *state
                .calendar_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = true;
        }
    }

    let data_dir = get_data_dir()?;
    for entry in fs::read_dir(data_dir)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with("activities_") || !name.ends_with(".json") {
            continue;
        }
        let date_value = name
            .trim_start_matches("activities_")
            .trim_end_matches(".json");
        let Ok(file_date) = NaiveDate::parse_from_str(date_value, "%Y-%m-%d") else {
            continue;
        };
        if file_date == loaded_date {
            continue;
        }

        let mut activities = read_activities(file_date)?;
        let (updated, rules) =
            update_activities_in_memory(&mut activities, activity_ids, correction);
        if updated.is_empty() {
            continue;
        }
        write_activities(file_date, &activities)?;
        updated_items.extend(updated);
        next_rules.extend(rules);
    }

    if !next_rules.is_empty() {
        remember_learned_rules(next_rules)?;
    }

    append_runtime_log(&format!(
        "[Trace] save activity corrections finished: updated_items={} date={}",
        updated_items.len(),
        loaded_date
    ));

    Ok(updated_items)
}

fn normalize_activity_refresh_minutes(value: i64) -> i64 {
    match value {
        1 | 5 | 15 | 30 | 60 => value,
        value if value <= 1 => 1,
        value if value <= 5 => 5,
        value if value <= 15 => 15,
        value if value <= 30 => 30,
        _ => 60,
    }
}

fn normalize_calendar_refresh_minutes(value: i64) -> i64 {
    match value {
        5 | 15 | 30 | 60 => value,
        value if value <= 5 => 5,
        value if value <= 15 => 15,
        value if value <= 30 => 30,
        _ => 60,
    }
}

fn normalize_ai_summary_refresh_hours(value: i64) -> i64 {
    match value {
        2 | 4 | 6 | 12 => value,
        value if value <= 2 => 2,
        value if value <= 4 => 4,
        value if value <= 6 => 6,
        _ => 12,
    }
}

fn normalize_ai_summary_model(value: &str) -> String {
    match value.trim() {
        "qwen3:4b" => "qwen3:4b".to_string(),
        _ => "qwen3:1.7b".to_string(),
    }
}

fn normalize_goal_metric_mode(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("reminders") {
        "reminders".to_string()
    } else {
        default_goal_metric_mode()
    }
}

fn apply_settings_to_watchers(state: &AppState) {
    let ignored = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .ignored_applications
        .clone();
    state
        .window_watcher
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .set_ignored_apps(ignored);
}

fn set_tracking_enabled(state: &AppState, enable: bool) {
    *state
        .is_tracking
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = enable;
    *state
        .last_tick
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Instant::now();
    *state
        .wake_guard_until
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    state
        .heartbeat_manager
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear_all();
}

fn update_tray_status(app_handle: &AppHandle, state: &AppState) {
    let is_tracking = *state
        .is_tracking
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let last_capture_at_ms = *state
        .last_capture_at_ms
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let capture_is_recent = last_capture_at_ms
        .map(|timestamp| {
            chrono::Utc::now()
                .timestamp_millis()
                .saturating_sub(timestamp)
                <= 90_000
        })
        .unwrap_or(false);

    let (title, tooltip) = if !is_tracking {
        ("Trace · 已暂停", "Trace 已暂停追溯。需要手动点击开始")
    } else if capture_is_recent {
        (
            "Trace · 追溯中",
            "Trace 最近已捕获活动，达到时长后会轻量写入日历",
        )
    } else {
        (
            "Trace · 等待捕获",
            "追溯开关已开启，但最近还没有捕获到有效前台活动",
        )
    };
    if let Some(tray) = app_handle.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(title));
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn request_calendar_sync_now(state: &AppState) {
    *state
        .calendar_dirty
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = true;
    let mut last_calendar_sync = state
        .last_calendar_sync_time
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *last_calendar_sync = Instant::now()
        .checked_sub(Duration::from_secs(24 * 60 * 60))
        .unwrap_or_else(Instant::now);
}

fn classify_by_rules(app_name: &str, window_title: &str) -> String {
    let app = app_name.to_lowercase();
    let title = window_title.to_lowercase();
    let combined = format!("{app} {title}");

    if ["reminders", "reminder", "提醒事项", "提醒", "待办"]
        .iter()
        .any(|keyword| combined.contains(keyword))
    {
        return "提醒事项".to_string();
    }

    if [
        "应用构建",
        "应用构建",
        "氛围编程",
        "best app",
        "高质量 app",
        "最好的app",
    ]
    .iter()
    .any(|keyword| combined.contains(keyword))
    {
        return "学习".to_string();
    }

    if [
        "code", "editor", "editor", "ide", "webstorm", "intellij", "pycharm", "terminal",
        "terminal", "terminal", "terminal",
    ]
    .iter()
    .any(|keyword| combined.contains(keyword))
    {
        return "开发".to_string();
    }

    if ["chrome", "safari", "firefox", "edge", "arc", "brave"]
        .iter()
        .any(|keyword| app.contains(keyword))
    {
        if ["code repository", "docs", "stackoverflow", "developer", "api"]
            .iter()
            .any(|keyword| title.contains(keyword))
        {
            return "学习".to_string();
        }
        if ["youtube", "bilibili", "netflix", "视频"]
            .iter()
            .any(|keyword| title.contains(keyword))
        {
            return "娱乐".to_string();
        }
        return "浏览网页".to_string();
    }

    if ["finder", "访达"]
        .iter()
        .any(|keyword| app.contains(keyword))
    {
        return "整理文件".to_string();
    }

    if [
        "lark", "feishu", "slack", "wechat", "微信", "telegram", "discord",
    ]
    .iter()
    .any(|keyword| app.contains(keyword))
    {
        return "沟通".to_string();
    }

    if [
        "word",
        "excel",
        "powerpoint",
        "pages",
        "numbers",
        "keynote",
        "wps",
    ]
    .iter()
    .any(|keyword| app.contains(keyword))
    {
        return "工作".to_string();
    }

    "其他".to_string()
}

#[derive(Debug, Clone)]
struct ActivityAnalysis {
    category: String,
    activity_type: String,
    description: String,
    focus_score: u8,
    context_key: String,
}

fn analyze_activity(app_name: &str, clean_title: &str, raw_title: &str) -> ActivityAnalysis {
    let app = app_name.to_lowercase();
    let title = clean_title.to_lowercase();
    let raw = raw_title.to_lowercase();
    let combined = format!("{app} {title} {raw}");
    let category = classify_by_rules(app_name, clean_title);

    if ["reminders", "reminder", "提醒事项", "提醒", "待办"]
        .iter()
        .any(|keyword| combined.contains(keyword))
    {
        let subject = best_title_fragment(clean_title, raw_title, app_name);
        let description = if subject == app_name {
            "查看和整理提醒事项".to_string()
        } else {
            format!("整理提醒事项：{}", truncate_text(&subject, 48))
        };
        return ActivityAnalysis {
            category: "提醒事项".to_string(),
            activity_type: if combined.contains("calendar") || combined.contains("日历") {
                "处理日程和提醒".to_string()
            } else {
                "处理提醒事项".to_string()
            },
            description,
            focus_score: 72,
            context_key: "处理提醒事项".to_string(),
        };
    }

    if mentions_product_work_text(&combined) {
        let subject = best_title_fragment(clean_title, raw_title, app_name);
        let detail = if combined.contains("ai tool") {
            format!("用 AI 工具 产品优化：{}", truncate_text(&subject, 42))
        } else {
            format!("产品优化：{}", truncate_text(&subject, 42))
        };
        return ActivityAnalysis {
            category: "开发".to_string(),
            activity_type: "产品优化".to_string(),
            description: detail,
            focus_score: 92,
            context_key: "产品优化".to_string(),
        };
    }

    if mentions_vibe_coding_research(&combined) {
        let subject = best_title_fragment(clean_title, raw_title, app_name);
        return ActivityAnalysis {
            category: "学习".to_string(),
            activity_type: "研究 App 方案".to_string(),
            description: format!(
                "研究如何 应用构建 出更好的 App：{}",
                truncate_text(&subject, 42)
            ),
            focus_score: 83,
            context_key: "研究：如何构建高质量应用".to_string(),
        };
    }

    let activity_type = infer_activity_type(app_name, clean_title, &combined, &category);
    let description =
        build_activity_description(app_name, clean_title, raw_title, &category, &activity_type);
    let focus_score = calculate_focus_score(&category, &combined, &activity_type);
    let context_key = infer_context_key_from_text(app_name, clean_title, &category, &activity_type);

    ActivityAnalysis {
        category,
        activity_type,
        description,
        focus_score,
        context_key,
    }
}

fn apply_learned_description(activity: &mut Activity) {
    let rules = read_cached_learned_rules();
    let Some(rule) = rules
        .into_iter()
        .find(|rule| learned_rule_matches(activity, rule))
    else {
        return;
    };
    if !rule.corrected_category.trim().is_empty() {
        activity.category = Some(rule.corrected_category.trim().to_string());
    }

    let corrected_description = if !rule.corrected_description.trim().is_empty() {
        Some(rule.corrected_description.trim().to_string())
    } else if !rule.title.trim().is_empty() {
        Some(rule.title.trim().to_string())
    } else {
        None
    };
    if let Some(description) = corrected_description.clone() {
        activity.description = Some(description.clone());
        if rule.corrected_context_key.trim().is_empty() {
            activity.context_key = Some(description);
        }
    }

    if !rule.corrected_activity_type.trim().is_empty() {
        activity.activity_type = Some(rule.corrected_activity_type.trim().to_string());
    } else if corrected_description.is_some() {
        activity.activity_type = Some("用户修正".to_string());
    }

    if !rule.corrected_context_key.trim().is_empty() {
        activity.context_key = Some(rule.corrected_context_key.trim().to_string());
    }
}

fn normalize_matching_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_was_space = true;

    for ch in value.chars().flat_map(|ch| ch.to_lowercase()) {
        let keep = ch.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if keep {
            normalized.push(ch);
            previous_was_space = false;
        } else if !previous_was_space {
            normalized.push(' ');
            previous_was_space = true;
        }
    }

    normalized.trim().to_string()
}

fn extract_matching_tokens(value: &str) -> Vec<String> {
    normalize_matching_text(value)
        .split_whitespace()
        .filter(|token| token.chars().count() >= 2)
        .map(|token| token.to_string())
        .collect()
}

fn candidate_match_score(activity_text: &str, candidate: &str) -> i32 {
    let normalized_candidate = normalize_matching_text(candidate);
    if normalized_candidate.is_empty() {
        return 0;
    }

    let condensed_activity = activity_text.replace(' ', "");
    let condensed_candidate = normalized_candidate.replace(' ', "");

    let mut score = 0;
    if condensed_candidate.chars().count() >= 2
        && (condensed_activity.contains(&condensed_candidate)
            || condensed_candidate.contains(&condensed_activity))
    {
        score += 3;
    }

    let activity_tokens = extract_matching_tokens(activity_text);
    let candidate_tokens = extract_matching_tokens(&normalized_candidate);
    if !activity_tokens.is_empty() && !candidate_tokens.is_empty() {
        let mut overlaps = 0;
        for token in candidate_tokens {
            if activity_tokens
                .iter()
                .any(|activity_token| activity_token == &token)
            {
                overlaps += 1;
            }
        }
        score += overlaps;
    }

    score
}

fn learned_rule_matches(activity: &Activity, rule: &LearnedDescriptionRule) -> bool {
    if !activity.name.eq_ignore_ascii_case(&rule.app_name) {
        return false;
    }

    let activity_type = activity.activity_type.as_deref().unwrap_or("");
    let context_key = activity.context_key.as_deref().unwrap_or("");
    if activity_type == rule.activity_type || context_key == rule.context_key {
        return true;
    }

    let combined = normalize_matching_text(&format!(
        "{} {} {} {}",
        activity.name,
        activity.window_title,
        activity.description.as_deref().unwrap_or(""),
        context_key
    ));

    let candidates = [
        rule.corrected_context_key.as_str(),
        rule.corrected_description.as_str(),
        rule.title.as_str(),
        rule.context_key.as_str(),
        rule.activity_type.as_str(),
    ];

    candidates
        .into_iter()
        .any(|candidate| candidate_match_score(&combined, candidate) >= 2)
}

fn infer_activity_type(
    app_name: &str,
    clean_title: &str,
    combined: &str,
    category: &str,
) -> String {
    let title = clean_title.to_lowercase();
    let app = app_name.to_lowercase();

    let keyword_types = [
        (
            &["pull request", "pr", "commit", "issue", "code repository", "code repository"][..],
            "代码协作",
        ),
        (
            &["debug", "报错", "error", "bug", "fix", "panic"][..],
            "调试修复",
        ),
        (&["calendar", "日历", "schedule", "event"][..], "处理日程"),
        (
            &["search", "搜索", "google", "perplexity", "baidu"][..],
            "搜索资料",
        ),
        (
            &["doc", "文档", "notion", "obsidian", "写作", "总结"][..],
            "文档整理",
        ),
        (
            &["youtube", "bilibili", "课程", "tutorial", "paper", "arxiv"][..],
            "学习研究",
        ),
        (
            &["finder", "访达", "downloads", "desktop", "文件"][..],
            "整理文件",
        ),
        (
            &["wechat", "slack", "telegram", "lark", "feishu", "discord"][..],
            "沟通协作",
        ),
        (
            &[
                "movie", "mp4", "video", "netflix", "player", "vlc", "iina", "剧",
            ][..],
            "观看视频",
        ),
    ];

    for (keywords, label) in keyword_types {
        if keywords.iter().any(|keyword| combined.contains(keyword)) {
            return label.to_string();
        }
    }

    match category {
        "开发" => {
            if app.contains("ai tool") || title.contains("ai tool") {
                "AI 编程".to_string()
            } else if app.contains("editor") || app.contains("code") || app.contains("ide") {
                "编写代码".to_string()
            } else if app.contains("terminal")
                || app.contains("terminal")
                || app.contains("terminal")
                || app.contains("terminal")
            {
                "命令行开发".to_string()
            } else {
                "开发工作".to_string()
            }
        }
        "学习" => "学习研究".to_string(),
        "工作" => "处理工作内容".to_string(),
        "沟通" => "沟通协作".to_string(),
        "浏览网页" => "网页浏览".to_string(),
        "整理文件" => "整理文件".to_string(),
        "娱乐" => "娱乐内容".to_string(),
        _ => format!("使用 {}", app_name),
    }
}

fn build_activity_description(
    app_name: &str,
    clean_title: &str,
    raw_title: &str,
    category: &str,
    activity_type: &str,
) -> String {
    let subject = best_title_fragment(clean_title, raw_title, app_name);
    let normalized_app = app_name.to_lowercase();
    let concise_subject = truncate_text(&subject, 72);
    if subject == app_name {
        if normalized_app == "信息" || normalized_app.contains("messages") {
            return "查看或回复信息".to_string();
        }
        if normalized_app.contains("calendar") || normalized_app == "日历" {
            return "查看或整理日程".to_string();
        }
        if normalized_app.contains("system settings") || normalized_app == "系统设置" {
            return "调整系统设置".to_string();
        }
    }
    if activity_type == "AI 编程" && subject == app_name {
        return format!("使用 {} 进行 AI 编程", app_name);
    }
    if activity_type == "AI 编程" {
        return format!(
            "在 {} 中进行 AI 编程，主要处理 {}",
            app_name, concise_subject
        );
    }
    if category == "浏览网页" && subject == app_name {
        return format!("使用 {} 浏览网页", app_name);
    }
    if category == "浏览网页" {
        if activity_type == "搜索资料" {
            return format!("在 {} 中搜索并查看：{}", app_name, concise_subject);
        }
        return format!("在 {} 中查看并处理：{}", app_name, concise_subject);
    }
    if category == "学习" && subject != app_name {
        return format!("在 {} 中学习或研究：{}", app_name, concise_subject);
    }
    if category == "工作" && subject != app_name {
        return format!("在 {} 中处理：{}", app_name, concise_subject);
    }
    if category == "沟通" && subject == app_name {
        return format!("使用 {} 沟通", app_name);
    }
    if category == "沟通" {
        return format!("在 {} 中围绕 {} 沟通协作", app_name, concise_subject);
    }
    if category == "整理文件" && subject == app_name {
        return "整理文件".to_string();
    }
    if category == "整理文件" {
        return format!("整理文件：{}", concise_subject);
    }
    if category == "其他" && subject == app_name {
        return format!("使用 {}", app_name);
    }
    if subject.is_empty() {
        return activity_type.to_string();
    }
    if subject == app_name {
        return format!("使用 {}", app_name);
    }
    format!("{}：{}", activity_type, concise_subject)
}

fn calculate_focus_score(category: &str, combined: &str, activity_type: &str) -> u8 {
    let mut score: u8 = match category {
        "开发" => 88,
        "学习" => 80,
        "工作" => 74,
        "整理文件" => 62,
        "沟通" => 58,
        "提醒事项" => 70,
        "浏览网页" => 52,
        "娱乐" => 24,
        _ => 50,
    };

    if activity_type.contains("调试")
        || activity_type.contains("AI 编程")
        || combined.contains("trace")
    {
        score = score.saturating_add(6);
    }
    if combined.contains("youtube") || combined.contains("bilibili") || combined.contains("mp4") {
        score = score.saturating_sub(18);
    }
    score.clamp(5, 98)
}

fn infer_context_key_from_text(
    app_name: &str,
    clean_title: &str,
    category: &str,
    activity_type: &str,
) -> String {
    if category == "提醒事项" {
        return "处理提醒事项".to_string();
    }
    let combined = format!("{} {}", app_name, clean_title).to_lowercase();
    if activity_type.contains("Trace") || (activity_type == "AI 编程" && combined.contains("trace"))
    {
        return "产品优化".to_string();
    }
    if activity_type == "AI 编程" {
        return "AI 编程".to_string();
    }
    let subject = best_title_fragment(clean_title, clean_title, app_name);
    if subject == app_name {
        format!("{category}::{activity_type}")
    } else {
        format!("{activity_type}::{subject}")
    }
}

fn best_title_fragment(clean_title: &str, raw_title: &str, fallback: &str) -> String {
    let mut best = String::new();
    let mut best_score = i32::MIN;

    for source in [clean_title.trim(), raw_title.trim()] {
        if source.is_empty() {
            continue;
        }
        for candidate in split_title_candidates(source) {
            let simplified = simplify_title(&candidate);
            if simplified.is_empty() {
                continue;
            }
            let score = title_candidate_score(&simplified, fallback);
            if score > best_score {
                best_score = score;
                best = simplified;
            }
        }
    }

    if !best.is_empty() {
        return best;
    }

    fallback.to_string()
}

fn split_title_candidates(title: &str) -> Vec<String> {
    let normalized = title.trim();
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut candidates = vec![normalized.to_string()];
    for separator in [" | ", " — ", " - ", " · ", " • ", " :: ", "｜"] {
        for part in normalized.split(separator) {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !candidates.iter().any(|existing| existing == trimmed) {
                candidates.push(trimmed.to_string());
            }
        }
    }
    candidates
}

fn simplify_title(title: &str) -> String {
    let mut cleaned = title.trim().to_string();
    for suffix in [
        " - Google Chrome",
        " - Chrome",
        " - Safari",
        " — Safari",
        " - Microsoft Edge",
        " - Arc",
        " - Brave Browser",
        " - Visual Studio Code",
        " - Editor",
        " - AI 工具",
    ] {
        if cleaned.ends_with(suffix) {
            cleaned.truncate(cleaned.len().saturating_sub(suffix.len()));
        }
    }
    cleaned.trim().chars().take(96).collect()
}

fn title_candidate_score(title: &str, fallback: &str) -> i32 {
    let normalized = title.trim();
    if normalized.is_empty() {
        return -100;
    }

    let lower = normalized.to_lowercase();
    let fallback_lower = fallback.trim().to_lowercase();
    let mut score = normalized.chars().count() as i32;

    if lower == fallback_lower {
        score -= 40;
    }
    if [
        "google chrome",
        "chrome",
        "safari",
        "arc",
        "brave browser",
        "finder",
        "访达",
        "新标签页",
        "new tab",
        "untitled",
        "calendar",
        "日历",
        "messages",
        "信息",
    ]
    .iter()
    .any(|generic| lower == *generic)
    {
        score -= 80;
    }
    if lower.contains("http://") || lower.contains("https://") {
        score -= 24;
    }
    if lower.contains("trace") {
        score += 18;
    }
    if [
        "ai tool", "editor", "code repository", "calendar", "日历", "提醒", "reminder", "产品", "分析",
        "设置", "研究", "项目", "沟通", "文档",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
    {
        score += 16;
    }
    if normalized.chars().count() < 4 {
        score -= 20;
    }
    if normalized.chars().count() > 72 {
        score -= 8;
    }

    score
}

fn mentions_product_work_text(combined: &str) -> bool {
    combined.contains("trace")
        && [
            "ai tool", "editor", "code", "editor", "优化", "产品", "calendar", "日历", "分析",
            "设置", "desktop runtime",
        ]
        .iter()
        .any(|keyword| combined.contains(keyword))
}

fn mentions_vibe_coding_research(combined: &str) -> bool {
    combined.contains("应用构建")
        || combined.contains("应用构建")
        || combined.contains("vibe-coding")
        || combined.contains("氛围编程")
        || ((combined.contains("vibe")
            || combined.contains("best app")
            || combined.contains("高质量 app"))
            && (combined.contains("coding") || combined.contains("app")))
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

fn run_osascript_timeout(script: &str, timeout: Duration) -> Result<String> {
    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let started_at = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started_at.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("系统应用读取超时"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_calendar_osascript_timeout(script: &str, timeout: Duration) -> Result<String> {
    let calendar_ready_script = format!(
        r#"
tell application "Calendar" to launch
{script}
"#
    );
    run_osascript_timeout(&calendar_ready_script, timeout)
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\u{1b}' {
            index += 1;
            if index < chars.len() && chars[index] == '[' {
                index += 1;
                while index < chars.len() {
                    let ch = chars[index];
                    index += 1;
                    if ('@'..='~').contains(&ch) {
                        break;
                    }
                }
            }
            continue;
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

fn extract_final_ollama_text(raw_output: &str) -> String {
    let cleaned = strip_ansi_sequences(raw_output)
        .replace('\r', "\n")
        .replace("\u{8}", "")
        .replace("⠙", "")
        .replace("⠹", "")
        .replace("⠸", "")
        .replace("⠼", "")
        .replace("⠦", "")
        .replace("⠇", "")
        .replace("⠏", "");

    let after_thinking = if let Some(index) = cleaned.rfind("...done thinking.") {
        cleaned[index + "...done thinking.".len()..].to_string()
    } else if let Some(index) = cleaned.rfind("Thinking...") {
        cleaned[index + "Thinking...".len()..].to_string()
    } else {
        cleaned
    };

    after_thinking
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter(|line| *line != "Thinking..." && *line != "...done thinking.")
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn run_ollama_summary(model: &str, prompt: &str) -> Result<String> {
    let instruction = format!(
        "你是 Trace 的本地复盘助手。不要输出思考过程，不要解释你的推理。只输出最终中文总结，控制在 3 到 6 句，先给结论，再给 1 到 3 条行动建议。\n\n{}",
        prompt
    );
    let timeout = if model == "qwen3:4b" {
        OLLAMA_SUMMARY_TIMEOUT_4B
    } else {
        OLLAMA_SUMMARY_TIMEOUT_1_7B
    };

    let mut child = Command::new("ollama")
        .arg("run")
        .arg(model)
        .arg(instruction)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let started_at = Instant::now();
    loop {
        if let Some(_status) = child.try_wait()? {
            let output = child.wait_with_output()?;
            if !output.status.success() {
                return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .to_string()));
            }

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let final_text = extract_final_ollama_text(&stdout);
            if final_text.trim().is_empty() {
                return Err(anyhow!("本地模型没有返回可用总结"));
            }
            return Ok(final_text);
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("本地 AI 总结超时，请稍后重试或切换到更轻的模型"));
        }

        std::thread::sleep(Duration::from_millis(150));
    }
}

fn get_cached_ai_summary(key: &str, model: &str, refresh_hours: i64) -> Option<String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let refresh_ms = refresh_hours.max(1) * 60 * 60 * 1000;
    read_ai_summary_cache()
        .into_iter()
        .find(|entry| {
            entry.key == key && entry.model == model && now_ms - entry.generated_at_ms < refresh_ms
        })
        .map(|entry| entry.summary)
}

fn cache_ai_summary(key: &str, model: &str, summary: &str) -> Result<()> {
    let mut entries = read_ai_summary_cache();
    let next = AiSummaryCacheEntry {
        key: key.to_string(),
        model: model.to_string(),
        summary: summary.to_string(),
        generated_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    if let Some(existing) = entries
        .iter_mut()
        .find(|entry| entry.key == key && entry.model == model)
    {
        *existing = next;
    } else {
        entries.push(next);
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.generated_at_ms));
    entries.truncate(40);
    write_ai_summary_cache(&entries)
}

fn week_start(date: NaiveDate) -> NaiveDate {
    date - ChronoDuration::days(date.weekday().num_days_from_monday() as i64)
}

fn scan_life_organization_goals() -> Result<Vec<ContextItem>> {
    let Ok(root_dir) = std::env::var("TRACE_GOALS_DIR") else {
        return Ok(Vec::new());
    };
    let root = PathBuf::from(root_dir);
    let mut items = Vec::new();
    if !root.exists() {
        return Ok(items);
    }

    let mut files = Vec::new();
    collect_markdown_files(&root, &mut files)?;
    files.sort_by_key(|path| goal_file_score(path));
    files.reverse();

    for path in files.into_iter().take(12) {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let source = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .display()
            .to_string();
        for line in content.lines().take(260) {
            let cleaned = clean_goal_line(line);
            if cleaned.is_empty() || cleaned.chars().count() < 4 {
                continue;
            }
            if is_goal_like_line(line, &source) {
                push_context_item(&mut items, cleaned, source.clone(), 24, None, None);
            }
        }
    }

    Ok(items)
}

fn collect_markdown_files(dir: &PathBuf, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_markdown_files(&path, files)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
}

fn goal_file_score(path: &PathBuf) -> i32 {
    let value = path.to_string_lossy();
    let mut score = 0;
    for keyword in [
        "本周",
        "每周",
        "目标",
        "计划",
        "打开我",
        "工作",
        "现金流",
        "人生主线",
        "现在怎么活",
    ] {
        if value.contains(keyword) {
            score += 10;
        }
    }
    score
}

fn is_goal_like_line(line: &str, source: &str) -> bool {
    let lower = line.to_lowercase();
    let source_lower = source.to_lowercase();
    line.contains("本周")
        || line.contains("目标")
        || line.contains("计划")
        || line.contains("重点")
        || line.contains("主线")
        || line.contains("必须")
        || line.contains("应该")
        || line.contains("要做")
        || line.contains("复盘")
        || line.trim_start().starts_with("- [ ]")
        || line.trim_start().starts_with("- ")
        || source_lower.contains("目标")
        || source_lower.contains("每周")
        || lower.contains("todo")
}

fn clean_goal_line(line: &str) -> String {
    line.trim()
        .trim_start_matches('#')
        .trim_start_matches('-')
        .trim_start_matches('*')
        .trim_start_matches("[ ]")
        .trim()
        .chars()
        .take(120)
        .collect()
}

fn push_context_item(
    items: &mut Vec<ContextItem>,
    title: String,
    source: String,
    limit: usize,
    start_time_ms: Option<i64>,
    end_time_ms: Option<i64>,
) {
    if items.len() >= limit
        || items
            .iter()
            .any(|item| item.title == title && item.source == source)
    {
        return;
    }
    items.push(ContextItem {
        title,
        source,
        start_time_ms,
        end_time_ms,
    });
}

fn is_context_timeout_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("系统应用读取超时")
}

fn is_calendar_permission_error_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("not authorized")
        || lower.contains("not authorised")
        || lower.contains("access not allowed")
        || message.contains("没有权限")
        || message.contains("未获授权")
        || message.contains("(-1743)")
        || message.contains("(-10004)")
}

fn is_calendar_transient_error_message(message: &str) -> bool {
    message.contains("Calendar 响应超时")
        || message.contains("Calendar 没有响应")
        || message.contains("应用程序没有运行")
        || message.contains("Connection invalid")
        || message.contains("系统应用读取超时")
        || message.contains("(-600)")
}

fn calendar_permission_backoff() -> &'static Mutex<Option<Instant>> {
    CALENDAR_PERMISSION_BACKOFF_UNTIL.get_or_init(|| Mutex::new(None))
}

fn should_skip_calendar_access_due_to_permission_backoff() -> bool {
    let guard = calendar_permission_backoff()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.is_some_and(|until| Instant::now() < until)
}

fn remember_calendar_permission_backoff() {
    *calendar_permission_backoff()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) =
        Some(Instant::now() + CALENDAR_PERMISSION_RETRY_COOLDOWN);
}

fn instant_to_timestamp_ms(instant: Instant) -> Option<i64> {
    let now_instant = Instant::now();
    if instant <= now_instant {
        return None;
    }
    let remaining = instant.duration_since(now_instant).as_millis() as i64;
    Some(chrono::Utc::now().timestamp_millis() + remaining)
}

fn current_calendar_permission_backoff_until_ms() -> Option<i64> {
    let guard = calendar_permission_backoff()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard
        .as_ref()
        .and_then(|until| instant_to_timestamp_ms(*until))
}

fn calendar_context_cache() -> &'static Mutex<HashMap<String, CachedContextItems>> {
    CALENDAR_CONTEXT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reminder_context_cache() -> &'static Mutex<Option<CachedReminderContext>> {
    REMINDER_CONTEXT_CACHE.get_or_init(|| Mutex::new(None))
}

fn automation_suppression_cache() -> &'static Mutex<HashMap<String, Instant>> {
    AUTOMATION_SUPPRESSION_UNTIL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_app_identity(name: &str) -> String {
    name.trim().to_lowercase()
}

fn mark_suppressed_apps(apps: &[&str], duration: Duration) {
    let until = Instant::now() + duration;
    let mut cache = automation_suppression_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for app in apps {
        cache.insert(normalize_app_identity(app), until);
    }
}

fn mark_calendar_automation_suppression() {
    mark_suppressed_apps(
        &[
            "Calendar",
            "日历",
            "System Settings",
            "系统设置",
            "universalAccessAuthWarn",
        ],
        CALENDAR_AUTOMATION_SUPPRESSION,
    );
}

fn mark_reminder_automation_suppression() {
    mark_suppressed_apps(
        &[
            "Reminders",
            "提醒事项",
            "System Settings",
            "系统设置",
            "universalAccessAuthWarn",
        ],
        REMINDER_AUTOMATION_SUPPRESSION,
    );
}

fn should_suppress_active_app(app_name: &str) -> bool {
    let normalized = normalize_app_identity(app_name);
    let now = Instant::now();
    let mut cache = automation_suppression_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.retain(|_, until| *until > now);
    cache.get(&normalized).is_some_and(|until| *until > now)
}

fn read_calendar_context(
    start: NaiveDate,
    end: NaiveDate,
    trace_calendar_name: Option<&str>,
) -> Result<Vec<ContextItem>> {
    if should_skip_calendar_access_due_to_permission_backoff() {
        return Ok(Vec::new());
    }
    let cache_key = format!(
        "{}:{}:{}",
        start.format("%Y-%m-%d"),
        end.format("%Y-%m-%d"),
        trace_calendar_name.unwrap_or_default()
    );
    if let Some(cached) = calendar_context_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&cache_key)
        .cloned()
    {
        if cached.cached_at.elapsed() <= CALENDAR_CONTEXT_CACHE_TTL {
            return Ok(cached.items);
        }
    }

    let trace_calendar_condition = trace_calendar_name
        .map(|name| {
            format!(
                r#" and (name of cal as string) is not "{}""#,
                name.replace('"', "\\\"")
            )
        })
        .unwrap_or_default();
    let script = format!(
        r#"
tell application "Calendar"
    set startDate to current date
    set year of startDate to {start_year}
    set month of startDate to {start_month}
    set day of startDate to {start_day}
    set hours of startDate to 0
    set minutes of startDate to 0
    set seconds of startDate to 0
    set endDate to current date
    set year of endDate to {end_year}
    set month of endDate to {end_month}
    set day of endDate to {end_day}
    set hours of endDate to 23
    set minutes of endDate to 59
    set seconds of endDate to 59
    set output to ""
    repeat with cal in calendars
        if true{trace_calendar_condition} then
        repeat with evt in (events of cal whose start date ≥ startDate and start date ≤ endDate)
            set eventSummary to summary of evt as string
            set eventDescription to ""
            try
                set eventDescription to description of evt as string
            end try
            if eventDescription contains "Trace 自动追溯记录" then
                set eventSummary to ""
            end if
            set startDateValue to start date of evt
            set endDateValue to end date of evt
            set eventStart to (year of startDateValue as string) & "-" & text -2 thru -1 of ("0" & (month of startDateValue as integer)) & "-" & text -2 thru -1 of ("0" & (day of startDateValue)) & "T" & text -2 thru -1 of ("0" & (hours of startDateValue)) & ":" & text -2 thru -1 of ("0" & (minutes of startDateValue)) & ":" & text -2 thru -1 of ("0" & (seconds of startDateValue))
            set eventEnd to (year of endDateValue as string) & "-" & text -2 thru -1 of ("0" & (month of endDateValue as integer)) & "-" & text -2 thru -1 of ("0" & (day of endDateValue)) & "T" & text -2 thru -1 of ("0" & (hours of endDateValue)) & ":" & text -2 thru -1 of ("0" & (minutes of endDateValue)) & ":" & text -2 thru -1 of ("0" & (seconds of endDateValue))
            if eventSummary is not "" then
                set output to output & eventSummary & "||Calendar||" & eventStart & "||" & eventEnd & linefeed
            end if
        end repeat
        end if
    end repeat
    return output
end tell
"#,
        start_year = start.year(),
        start_month = start.month(),
        start_day = start.day(),
        end_year = end.year(),
        end_month = end.month(),
        end_day = end.day(),
        trace_calendar_condition = trace_calendar_condition
    );
    mark_calendar_automation_suppression();
    let raw = match run_calendar_osascript_timeout(&script, Duration::from_secs(6)) {
        Ok(raw) => raw,
        Err(error) => {
            if is_calendar_permission_error_message(&error.to_string()) {
                remember_calendar_permission_backoff();
            }
            return Err(error);
        }
    };
    let items = parse_calendar_context_output(&raw, 30)?;
    calendar_context_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            cache_key,
            CachedContextItems {
                items: items.clone(),
                cached_at: Instant::now(),
            },
        );
    Ok(items)
}

fn read_reminders_context(list_filter: &[String]) -> Result<Vec<ContextItem>> {
    let normalized_filter: Vec<String> = list_filter
        .iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect();

    if let Some(cached) = reminder_context_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
    {
        if cached.cached_at.elapsed() <= REMINDER_CONTEXT_CACHE_TTL {
            if normalized_filter.is_empty() {
                return Ok(cached.items.into_iter().take(40).collect());
            }
            let filtered = cached
                .items
                .into_iter()
                .filter(|item| {
                    let source = item.source.to_lowercase();
                    normalized_filter
                        .iter()
                        .any(|filter| source.ends_with(filter))
                })
                .take(40)
                .collect();
            return Ok(filtered);
        }
    }

    let selected_lists: Vec<String> = list_filter
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect();

    let list_selector = if selected_lists.is_empty() {
        "set targetLists to lists".to_string()
    } else {
        let names = selected_lists
            .iter()
            .map(|item| format!("\"{}\"", item.replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"set allowedListNames to {{{names}}}
    set targetLists to {{}}
    repeat with listRef in lists
        set listName to name of listRef as string
        if allowedListNames contains listName then
            copy listRef to end of targetLists
        end if
    end repeat"#,
            names = names
        )
    };

    let script = format!(
        r#"
tell application "Reminders"
    set output to ""
    set collectedCount to 0
    {list_selector}
    repeat with listRef in targetLists
        repeat with reminderRef in (reminders of listRef whose completed is false)
            set reminderName to name of reminderRef as string
            set listName to name of listRef as string
            set output to output & reminderName & "||提醒事项/" & listName & linefeed
            set collectedCount to collectedCount + 1
            if collectedCount ≥ 80 then
                return output
            end if
        end repeat
    end repeat
    return output
end tell
"#,
        list_selector = list_selector
    );
    mark_reminder_automation_suppression();
    let items = parse_context_output(&run_osascript_timeout(&script, Duration::from_secs(8))?, 80)?;
    *reminder_context_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(CachedReminderContext {
        items: items.clone(),
        cached_at: Instant::now(),
    });
    if normalized_filter.is_empty() {
        return Ok(items.into_iter().take(40).collect());
    }

    let filtered = items
        .into_iter()
        .filter(|item| {
            let source = item.source.to_lowercase();
            normalized_filter
                .iter()
                .any(|filter| source.ends_with(filter))
        })
        .take(40)
        .collect();
    Ok(filtered)
}

fn read_reminder_list_names() -> Result<Vec<String>> {
    let script = r#"
tell application "Reminders"
    set output to ""
    repeat with listRef in lists
        set listName to name of listRef as string
        set output to output & listName & linefeed
    end repeat
    return output
end tell
"#;
    mark_reminder_automation_suppression();
    let raw = run_osascript_timeout(script, Duration::from_secs(8))?;
    let mut items = Vec::new();
    for line in raw.lines() {
        let name = line.trim();
        if name.is_empty() || items.iter().any(|item| item == name) {
            continue;
        }
        items.push(name.to_string());
    }
    Ok(items)
}

fn parse_context_output(output: &str, limit: usize) -> Result<Vec<ContextItem>> {
    let mut items = Vec::new();
    for line in output.lines() {
        let Some((title, source)) = line.split_once("||") else {
            continue;
        };
        let title = title.trim();
        if title.is_empty() || title.contains("Trace 自动追溯") {
            continue;
        }
        push_context_item(
            &mut items,
            title.chars().take(100).collect(),
            source.trim().to_string(),
            limit,
            None,
            None,
        );
    }
    Ok(items)
}

fn parse_calendar_context_output(output: &str, limit: usize) -> Result<Vec<ContextItem>> {
    let mut items = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split("||").collect();
        if parts.len() < 4 {
            continue;
        }
        let title = parts[0].trim();
        if title.is_empty() || title.contains("Trace 自动追溯") {
            continue;
        }
        push_context_item(
            &mut items,
            title.chars().take(100).collect(),
            parts[1].trim().to_string(),
            limit,
            parse_applescript_datetime(parts[2].trim()),
            parse_applescript_datetime(parts[3].trim()),
        );
    }
    Ok(items)
}

fn parse_applescript_datetime(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .and_then(|datetime| Local.from_local_datetime(&datetime).single())
        .map(|datetime| datetime.timestamp_millis())
}

fn poll_active_window(state: &AppState, app_handle: Option<&AppHandle>) -> Result<()> {
    let now = Instant::now();
    let mut last_tick = state
        .last_tick
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let elapsed = now.duration_since(*last_tick);
    *last_tick = now;
    drop(last_tick);

    if let Some(app_handle) = app_handle {
        update_tray_status(app_handle, state);
    }

    if let Some(until) = *state
        .wake_guard_until
        .lock()
        .unwrap_or_else(|error| error.into_inner())
    {
        if now < until {
            if let Some(app_handle) = app_handle {
                update_tray_status(app_handle, state);
            }
            return Ok(());
        }
        *state
            .wake_guard_until
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    let is_tracking = *state
        .is_tracking
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !is_tracking {
        state
            .heartbeat_manager
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear_all();
        if let Some(app_handle) = app_handle {
            update_tray_status(app_handle, state);
        }
        return Ok(());
    }

    if elapsed > SLEEP_GAP_THRESHOLD {
        set_tracking_enabled(state, false);
        if *state
            .activities_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner())
        {
            let _ = save_current_activities(state);
            *state
                .activities_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = false;
        }
        state
            .heartbeat_manager
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear_all();
        append_runtime_log("[Trace] sleep/wake gap detected; tracking paused until manual start");
        if let Some(app_handle) = app_handle {
            update_tray_status(app_handle, state);
        }
        *state
            .last_recovery
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(TrackingRecoverySnapshot {
            at_ms: chrono::Utc::now().timestamp_millis(),
            gap_ms: elapsed.as_millis() as i64,
            reason: "sleep_wake_gap".to_string(),
        });
        return Ok(());
    }

    let window_info = {
        let watcher = state
            .window_watcher
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        watcher.get_active_window()?
    };

    let Some(window_info) = window_info else {
        return Ok(());
    };

    if should_suppress_active_app(&window_info.app_name) {
        return Ok(());
    }

    let duration_ms = elapsed.as_millis() as i64;
    if duration_ms <= 0 {
        return Ok(());
    }

    let timestamp_ms = chrono::Utc::now().timestamp_millis() - duration_ms;
    let heartbeat_event = transform::TrackEvent {
        id: None,
        timestamp_ms,
        duration_ms,
        data: transform::EventData {
            app_name: window_info.app_name.clone(),
            window_title: window_info.clean_title.clone(),
            extra: std::collections::HashMap::new(),
        },
    };

    let mut heartbeat_manager = state
        .heartbeat_manager
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let heartbeat_result = heartbeat_manager.process_heartbeat("window", heartbeat_event, 2_500);

    match heartbeat_result {
        transform::HeartbeatResult::Merged(merged) => {
            if let Some(id) = merged.id {
                let mut activities = state
                    .activities
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if let Some(activity) = activities.iter_mut().find(|activity| activity.id == id) {
                    let previous_duration_minutes = activity.duration_minutes;
                    activity.duration_minutes = (merged.duration_ms as f64) / 60_000.0;
                    *state
                        .activities_dirty
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = true;
                    *state
                        .calendar_dirty
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = true;
                    *state
                        .last_capture_at_ms
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) =
                        Some(chrono::Utc::now().timestamp_millis());
                    let min_calendar_minutes = state
                        .settings
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .min_activity_minutes;
                    if previous_duration_minutes < min_calendar_minutes
                        && activity.duration_minutes >= min_calendar_minutes
                    {
                        request_calendar_sync_now(state);
                    }
                }
            }
        }
        transform::HeartbeatResult::NewEvent(new_event) => {
            let id = Uuid::new_v4().to_string();
            if let Some(last_event) = heartbeat_manager.get_last_event_mut("window") {
                last_event.id = Some(id.clone());
            }
            let analysis = analyze_activity(
                &window_info.app_name,
                &window_info.clean_title,
                &window_info.raw_title,
            );

            let mut activity = Activity {
                id,
                name: window_info.app_name.clone(),
                window_title: window_info.clean_title.clone(),
                raw_window_title: Some(window_info.raw_title.clone()),
                category: Some(analysis.category),
                activity_type: Some(analysis.activity_type),
                description: Some(analysis.description),
                focus_score: Some(analysis.focus_score),
                context_key: Some(analysis.context_key),
                linked_reminder_title: None,
                linked_reminder_source: None,
                linked_calendar_title: None,
                linked_calendar_source: None,
                start_time_ms: new_event.timestamp_ms,
                duration_minutes: (new_event.duration_ms as f64) / 60_000.0,
            };
            apply_learned_description(&mut activity);
            let should_sync_now = {
                let min_calendar_minutes = state
                    .settings
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .min_activity_minutes;
                activity.duration_minutes >= min_calendar_minutes
            };

            state
                .activities
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(activity);
            *state
                .activities_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = true;
            *state
                .calendar_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = true;
            if should_sync_now {
                request_calendar_sync_now(state);
            }
            *state
                .last_capture_at_ms
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                Some(chrono::Utc::now().timestamp_millis());
        }
    }

    if let Some(app_handle) = app_handle {
        update_tray_status(app_handle, state);
    }

    Ok(())
}

fn try_begin_calendar_sync(state: &AppState) -> bool {
    let mut sync_running = state
        .calendar_sync_running
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if *sync_running {
        return false;
    }
    *sync_running = true;
    true
}

fn finish_calendar_sync(state: &AppState) {
    *state
        .calendar_sync_running
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = false;
}

struct CalendarSyncGuard<'a> {
    state: &'a AppState,
}

impl Drop for CalendarSyncGuard<'_> {
    fn drop(&mut self) {
        finish_calendar_sync(self.state);
    }
}

fn try_calendar_sync_guard(state: &AppState) -> Option<CalendarSyncGuard<'_>> {
    if try_begin_calendar_sync(state) {
        Some(CalendarSyncGuard { state })
    } else {
        None
    }
}

fn sync_current_day_to_calendar_blocking(state: &AppState) -> Result<usize> {
    let Some(_guard) = try_calendar_sync_guard(state) else {
        return Err(anyhow!("Calendar 同步正在进行中"));
    };
    *state
        .last_calendar_sync_time
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Instant::now();
    sync_current_day_to_calendar_unlocked(state)
}

fn sync_current_day_to_calendar_unlocked(state: &AppState) -> Result<usize> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if !settings.calendar_sync_enabled {
        return Ok(0);
    }
    if should_skip_calendar_access_due_to_permission_backoff() {
        return Err(anyhow!(
            "Calendar 没有响应。请检查系统设置中 Trace/终端是否有“日历”和“自动化”权限。"
        ));
    }

    let date = *state
        .current_date
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut activities_for_reconcile = state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    mark_calendar_automation_suppression();
    match reconcile_calendar_manual_edits_for_date(date, &mut activities_for_reconcile, &settings) {
        Ok(true) => {
            *state
                .activities
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = activities_for_reconcile;
        }
        Ok(false) => {}
        Err(error) => {
            append_runtime_log(&format!(
                "[Trace] manual calendar reconcile skipped for {date}: {error}"
            ));
        }
    }
    let activities = state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    mark_calendar_automation_suppression();
    let result = calendar::sync_activities_for_date(&activities, date, &settings)
        .map_err(anyhow::Error::msg);
    *state
        .last_calendar_sync_at_ms
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(chrono::Utc::now().timestamp_millis());
    match &result {
        Ok(count) => {
            append_runtime_log(&format!(
                "[Trace] calendar sync wrote {count} events for {date}"
            ));
            *state
                .last_calendar_sync_error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
            *state
                .last_calendar_write_count
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = *count;
        }
        Err(error) => {
            if is_calendar_permission_error_message(&error.to_string()) {
                remember_calendar_permission_backoff();
            }
            *state
                .last_calendar_sync_error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(error.to_string());
        }
    }
    result
}

fn spawn_calendar_sync(state: AppState, force: bool) -> bool {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if !settings.calendar_sync_enabled {
        return false;
    }

    if !try_begin_calendar_sync(&state) {
        return false;
    }

    *state
        .last_calendar_sync_time
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Instant::now();

    let state_for_calendar_sync = state.clone();
    std::thread::spawn(move || {
        if force {
            *state_for_calendar_sync
                .calendar_dirty
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = true;
            if let Err(error) = save_current_activities(&state_for_calendar_sync) {
                append_runtime_log(&format!(
                    "[Trace] queued calendar sync save failed: {error}"
                ));
            }
        }

        let result = sync_current_day_to_calendar_unlocked(&state_for_calendar_sync);
        match result {
            Ok(_) => {
                *state_for_calendar_sync
                    .calendar_dirty
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = false;
            }
            Err(error) => {
                let message = if force {
                    format!("[Trace] queued calendar sync failed: {error}")
                } else {
                    format!("[Trace] realtime calendar sync failed: {error}")
                };
                eprintln!("{message}");
                append_runtime_log(&message);
            }
        }
        finish_calendar_sync(&state_for_calendar_sync);
    });

    true
}

fn should_backoff_calendar_sync(state: &AppState) -> bool {
    let last_error = state
        .last_calendar_sync_error
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let Some(last_error) = last_error else {
        return false;
    };
    if !is_calendar_permission_error_message(&last_error) {
        return false;
    }
    let last_sync_time = state
        .last_calendar_sync_time
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    last_sync_time.elapsed() < CALENDAR_PERMISSION_RETRY_COOLDOWN
}

fn should_reconcile_calendar_manual_edits(date: NaiveDate) -> bool {
    let today = Local::now().date_naive();
    date >= today - ChronoDuration::days(MANUAL_CALENDAR_RECONCILE_LOOKBACK_DAYS)
        && date <= today + ChronoDuration::days(1)
}

fn manual_calendar_check_cache() -> &'static Mutex<HashMap<String, i64>> {
    MANUAL_CALENDAR_CHECK_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn should_skip_manual_calendar_check(date: NaiveDate) -> bool {
    let key = date.format("%Y-%m-%d").to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cooldown_ms = MANUAL_CALENDAR_CHECK_COOLDOWN.as_millis() as i64;
    let cache = manual_calendar_check_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache
        .get(&key)
        .is_some_and(|last_checked_at_ms| now_ms - *last_checked_at_ms < cooldown_ms)
}

fn mark_manual_calendar_checked(date: NaiveDate) {
    let key = date.format("%Y-%m-%d").to_string();
    manual_calendar_check_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, chrono::Utc::now().timestamp_millis());
}

fn infer_manual_category_from_title(title: &str) -> Option<String> {
    let normalized = title.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }

    let mappings = [
        ("娱乐", "娱乐"),
        ("休息", "休息"),
        ("会议", "会议"),
        ("沟通", "沟通"),
        ("提醒", "提醒事项"),
        ("reminder", "提醒事项"),
        ("calendar", "会议"),
        ("日历", "会议"),
        ("开发", "开发"),
        ("编程", "开发"),
        ("代码", "开发"),
        ("学习", "学习"),
        ("研究", "学习"),
        ("资料", "学习"),
        ("文档", "学习"),
        ("整理", "整理文件"),
        ("文件", "整理文件"),
        ("finder", "整理文件"),
        ("网页", "浏览网页"),
        ("搜索", "浏览网页"),
        ("browser", "浏览网页"),
        ("工作", "工作"),
    ];

    for (keyword, category) in mappings {
        if normalized == keyword || normalized.contains(keyword) {
            return Some(category.to_string());
        }
    }

    None
}

fn reconcile_calendar_manual_edits_for_date(
    date: NaiveDate,
    activities: &mut Vec<Activity>,
    settings: &Settings,
) -> Result<bool> {
    if !settings.calendar_sync_enabled || !should_reconcile_calendar_manual_edits(date) {
        return Ok(false);
    }
    if should_skip_calendar_access_due_to_permission_backoff() {
        return Ok(false);
    }
    if should_skip_manual_calendar_check(date) {
        return Ok(false);
    }

    mark_calendar_automation_suppression();
    let edits = match calendar::read_manual_trace_edits_for_date(&settings.calendar_name, date) {
        Ok(edits) => edits,
        Err(error) => {
            mark_manual_calendar_checked(date);
            append_runtime_log(&format!(
                "[Trace] read manual calendar edits failed for {date}: {error}"
            ));
            return Ok(false);
        }
    };
    mark_manual_calendar_checked(date);
    if edits.is_empty() {
        return Ok(false);
    }

    let learned_rules = apply_calendar_manual_edits(activities, &edits);
    if learned_rules.is_empty() {
        return Ok(false);
    }

    remember_learned_rules(learned_rules)?;
    write_activities(date, activities)?;
    Ok(true)
}

fn get_reconciled_activities_for_date(
    date: NaiveDate,
    state: &AppState,
) -> Result<Vec<Activity>, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let loaded_date = *state
        .current_date
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    if loaded_date == date {
        let mut activities = state
            .activities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        match reconcile_calendar_manual_edits_for_date(date, &mut activities, &settings) {
            Ok(true) => {
                *state
                    .activities
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = activities.clone();
            }
            Ok(false) => {}
            Err(error) => {
                append_runtime_log(&format!(
                    "[Trace] manual calendar reconcile skipped for {date}: {error}"
                ));
            }
        }
        return Ok(activities);
    }

    let mut activities = read_activities(date).map_err(|error| error.to_string())?;
    if let Err(error) = reconcile_calendar_manual_edits_for_date(date, &mut activities, &settings) {
        append_runtime_log(&format!(
            "[Trace] manual calendar reconcile skipped for {date}: {error}"
        ));
    }
    Ok(activities)
}

fn apply_calendar_manual_edits(
    activities: &mut [Activity],
    edits: &[calendar::CalendarManualEdit],
) -> Vec<LearnedDescriptionRule> {
    let mut learned_rules = Vec::new();
    for edit in edits {
        for activity in activities.iter_mut() {
            let activity_start = activity.start_time_ms;
            let activity_end =
                activity.start_time_ms + (activity.duration_minutes * 60_000.0) as i64;
            let overlap_start = activity_start.max(edit.start_time_ms);
            let overlap_end = activity_end.min(edit.end_time_ms);
            if overlap_end <= overlap_start {
                continue;
            }
            let overlap_minutes = (overlap_end - overlap_start) as f64 / 60_000.0;
            if overlap_minutes < 0.25 {
                continue;
            }
            let next_description = edit.title.trim().to_string();
            let next_category = infer_manual_category_from_title(&next_description);
            let next_activity_type = if let Some(category) = next_category.as_ref() {
                format!("用户修正：{category}")
            } else {
                "用户修正".to_string()
            };
            let category_changed = next_category
                .as_ref()
                .is_some_and(|category| activity.category.as_deref() != Some(category.as_str()));
            if activity.description.as_deref() != Some(next_description.as_str())
                || activity.activity_type.as_deref() != Some(next_activity_type.as_str())
                || activity.context_key.as_deref() != Some(next_description.as_str())
                || category_changed
            {
                learned_rules.push(LearnedDescriptionRule {
                    app_name: activity.name.clone(),
                    activity_type: activity.activity_type.clone().unwrap_or_default(),
                    context_key: activity.context_key.clone().unwrap_or_default(),
                    title: next_description.clone(),
                    corrected_category: next_category
                        .clone()
                        .unwrap_or_else(|| activity.category.clone().unwrap_or_default()),
                    corrected_activity_type: next_activity_type.clone(),
                    corrected_context_key: next_description.clone(),
                    corrected_description: next_description.clone(),
                    updated_at_ms: chrono::Utc::now().timestamp_millis(),
                });
                activity.description = Some(next_description.clone());
                activity.activity_type = Some(next_activity_type);
                activity.context_key = Some(next_description.clone());
                if let Some(category) = next_category.clone() {
                    activity.category = Some(category);
                }
            }
        }
    }
    learned_rules
}

fn run_tracking_loop(state: AppState, app_handle: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));

        let today = Local::now().date_naive();
        let loaded_date = *state
            .current_date
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if loaded_date != today {
            let _ = save_current_activities(&state);
            let _ = sync_current_day_to_calendar_blocking(&state);
            let _ = load_current_date(&state, today);
        }

        if let Err(error) = poll_active_window(&state, Some(&app_handle)) {
            eprintln!("[Trace] window polling failed: {error}");
        }

        let dirty = *state
            .activities_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut last_save = state
            .last_save_time
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if dirty && last_save.elapsed() >= Duration::from_secs(10) {
            if let Err(error) = save_current_activities(&state) {
                eprintln!("[Trace] activity save failed: {error}");
            } else {
                *state
                    .activities_dirty
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = false;
                *last_save = Instant::now();
            }
        }
        drop(last_save);

        let calendar_dirty = *state
            .calendar_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let calendar_interval = {
            let settings = state
                .settings
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            Duration::from_secs(
                (normalize_calendar_refresh_minutes(settings.calendar_sync_interval_minutes) * 60)
                    as u64,
            )
        };
        let should_sync_calendar = {
            let last_calendar_sync = state
                .last_calendar_sync_time
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            calendar_dirty && last_calendar_sync.elapsed() >= calendar_interval
        };
        if should_sync_calendar && !should_backoff_calendar_sync(&state) {
            let _ = spawn_calendar_sync(state.clone(), false);
        }
    });
}

#[tauri::command]
fn get_activities_by_date(
    date_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Activity>, String> {
    let date =
        NaiveDate::parse_from_str(&date_str, "%Y-%m-%d").map_err(|error| error.to_string())?;
    get_reconciled_activities_for_date(date, state.inner())
}

#[tauri::command]
fn get_activities_by_range(
    start_date: String,
    end_date: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Activity>, String> {
    let start =
        NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let end =
        NaiveDate::parse_from_str(&end_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };
    let mut activities = Vec::new();
    let mut date = start;
    while date <= end {
        activities.extend(get_reconciled_activities_for_date(date, state.inner())?);
        date += ChronoDuration::days(1);
    }
    Ok(activities)
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

#[tauri::command]
fn save_settings(
    settings: SettingsPatch,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let next = {
        let mut current = state
            .settings
            .lock()
            .unwrap_or_else(|error| error.into_inner());

        if let Some(theme) = settings.theme {
            current.theme = theme;
        }
        current.auto_start_tracking = false;
        if let Some(calendar_sync_enabled) = settings.calendar_sync_enabled {
            current.calendar_sync_enabled = calendar_sync_enabled;
        }
        if let Some(calendar_insights_enabled) = settings.calendar_insights_enabled {
            current.calendar_insights_enabled = calendar_insights_enabled;
        }
        if let Some(calendar_name) = settings.calendar_name {
            current.calendar_name = calendar_name;
        }
        if let Some(min_activity_minutes) = settings.min_activity_minutes {
            current.min_activity_minutes = min_activity_minutes.clamp(5.0, 60.0);
        }
        if let Some(merge_gap_minutes) = settings.merge_gap_minutes {
            current.merge_gap_minutes = merge_gap_minutes.max(15);
        }
        if let Some(activity_refresh_minutes) = settings.activity_refresh_minutes {
            current.activity_refresh_minutes =
                normalize_activity_refresh_minutes(activity_refresh_minutes);
        }
        if let Some(calendar_sync_interval_minutes) = settings.calendar_sync_interval_minutes {
            current.calendar_sync_interval_minutes =
                normalize_calendar_refresh_minutes(calendar_sync_interval_minutes);
        }
        if let Some(ignored_applications) = settings.ignored_applications {
            current.ignored_applications = normalize_ignored_applications(ignored_applications);
        }
        if let Some(reminders_enabled) = settings.reminders_enabled {
            current.reminders_enabled = reminders_enabled;
        }
        if let Some(reminder_lists) = settings.reminder_lists {
            current.reminder_lists = reminder_lists
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
        if let Some(ai_summaries_enabled) = settings.ai_summaries_enabled {
            current.ai_summaries_enabled = ai_summaries_enabled;
        }
        if let Some(ai_summary_model) = settings.ai_summary_model {
            current.ai_summary_model = normalize_ai_summary_model(&ai_summary_model);
        }
        if let Some(ai_summary_refresh_hours) = settings.ai_summary_refresh_hours {
            current.ai_summary_refresh_hours =
                normalize_ai_summary_refresh_hours(ai_summary_refresh_hours);
        }
        if let Some(category_rules_draft) = settings.category_rules_draft {
            current.category_rules_draft = category_rules_draft;
        }
        if let Some(category_rules_version) = settings.category_rules_version {
            current.category_rules_version = category_rules_version.max(1);
        }
        if let Some(goal_metric_mode) = settings.goal_metric_mode {
            current.goal_metric_mode = if goal_metric_mode.trim().eq_ignore_ascii_case("reminders")
            {
                "reminders".to_string()
            } else {
                "reminders".to_string()
            };
        }

        current.clone()
    };

    write_settings(&next).map_err(|error| error.to_string())?;
    apply_settings_to_watchers(&state);
    Ok(next)
}

#[tauri::command]
fn toggle_tracking(enable: bool, state: tauri::State<'_, AppState>, app_handle: AppHandle) -> bool {
    set_tracking_enabled(&state, enable);
    update_tray_status(&app_handle, &state);
    enable
}

#[tauri::command]
fn check_tracking_status(state: tauri::State<'_, AppState>) -> bool {
    *state
        .is_tracking
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

#[tauri::command]
fn get_tracking_overview(state: tauri::State<'_, AppState>) -> TrackingOverview {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let activities = state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let active_window = state
        .window_watcher
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get_active_window_unfiltered()
        .ok()
        .flatten();
    let last_activity = activities.last().cloned();
    let active_app = active_window
        .as_ref()
        .map(|window| window.app_name.clone())
        .unwrap_or_default();

    let active_ignored = matches_ignored_application(&active_app, &settings.ignored_applications)
        || should_suppress_active_app(&active_app);

    TrackingOverview {
        is_tracking: *state
            .is_tracking
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        active_app: active_app.clone(),
        active_title: active_window
            .as_ref()
            .map(|window| window.clean_title.clone())
            .unwrap_or_default(),
        active_ignored,
        last_capture_at_ms: *state
            .last_capture_at_ms
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        current_block_title: last_activity
            .as_ref()
            .and_then(|activity| {
                activity
                    .description
                    .clone()
                    .or_else(|| Some(activity.window_title.clone()))
            })
            .unwrap_or_default(),
        current_block_minutes: last_activity
            .as_ref()
            .map(|activity| activity.duration_minutes)
            .unwrap_or(0.0),
        min_calendar_minutes: settings.min_activity_minutes,
        calendar_sync_enabled: settings.calendar_sync_enabled,
        calendar_pending: *state
            .calendar_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        calendar_sync_running: *state
            .calendar_sync_running
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        last_calendar_sync_at_ms: *state
            .last_calendar_sync_at_ms
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        last_calendar_sync_error: state
            .last_calendar_sync_error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone(),
        last_calendar_write_count: *state
            .last_calendar_write_count
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        today_activity_count: activities.len(),
        today_captured_minutes: activities
            .iter()
            .map(|activity| activity.duration_minutes)
            .sum::<f64>(),
    }
}

#[tauri::command]
fn get_tracking_runtime_status(state: tauri::State<'_, AppState>) -> TrackingRuntimeStatus {
    let now = Instant::now();
    let recovery_until = *state
        .wake_guard_until
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let recovery_until_ms = recovery_until.and_then(instant_to_timestamp_ms);
    let last_recovery = state
        .last_recovery
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let calendar_permission_backoff_until_ms = current_calendar_permission_backoff_until_ms();

    TrackingRuntimeStatus {
        is_tracking: *state
            .is_tracking
            .lock()
            .unwrap_or_else(|error| error.into_inner()),
        recovery_active: recovery_until.is_some_and(|until| until > now),
        recovery_until_ms,
        last_recovery_at_ms: last_recovery.as_ref().map(|value| value.at_ms),
        last_recovery_gap_ms: last_recovery.as_ref().map(|value| value.gap_ms),
        last_recovery_reason: last_recovery.map(|value| value.reason),
        calendar_permission_backoff_active: calendar_permission_backoff_until_ms.is_some(),
        calendar_permission_backoff_until_ms,
    }
}

#[tauri::command]
fn sync_calendar_today(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    save_current_activities(&state).map_err(|error| error.to_string())?;
    sync_current_day_to_calendar_blocking(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn queue_calendar_sync(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    *state
        .calendar_dirty
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = true;
    Ok(spawn_calendar_sync(state.inner().clone(), true))
}

#[tauri::command]
fn write_plan_blocks_to_calendar(
    date: String,
    blocks: Vec<PlannedCalendarBlockInput>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let target_date =
        NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let calendar_name = format!("{} - 今日计划", settings.calendar_name);
    let mapped: Vec<calendar::PlannedCalendarBlock> = blocks
        .into_iter()
        .map(|item| calendar::PlannedCalendarBlock {
            title: item.title.trim().to_string(),
            start_time_ms: item.start_time_ms,
            end_time_ms: item.end_time_ms,
            source_reminder: item.source_reminder.trim().to_string(),
            rationale: item.rationale.trim().to_string(),
        })
        .filter(|item| !item.title.is_empty() && item.end_time_ms > item.start_time_ms)
        .collect();

    let Some(_guard) = try_calendar_sync_guard(&state) else {
        return Err("Calendar 同步正在进行中，请稍后再试".to_string());
    };
    calendar::sync_plan_blocks_for_date(&calendar_name, target_date, &mapped)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_all_activities(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if *state
        .calendar_sync_running
        .lock()
        .unwrap_or_else(|error| error.into_inner())
    {
        return Err("Calendar 同步正在进行中，请稍后再清除本地数据".to_string());
    }
    state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
    *state
        .activities_dirty
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = false;
    *state
        .calendar_dirty
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = false;

    let data_dir = get_data_dir().map_err(|error| error.to_string())?;
    for entry in fs::read_dir(data_dir)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("activities_") && name.ends_with(".json"))
        {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn save_activity_corrections(
    activity_ids: Vec<String>,
    correction: ActivityCorrectionPatch,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Activity>, String> {
    save_activity_corrections_internal(&activity_ids, &correction, state.inner())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_learned_rules() -> Vec<LearnedRuleView> {
    read_cached_learned_rules()
        .into_iter()
        .map(to_learned_rule_view)
        .collect()
}

#[tauri::command]
fn clear_learned_rules() -> Result<(), String> {
    write_learned_rules(&[]).map_err(|error| error.to_string())
}

#[tauri::command]
fn generate_ai_summary(
    prompt: String,
    model: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if !settings.ai_summaries_enabled {
        return Err("本地 AI 总结已关闭".to_string());
    }

    let chosen_model = model
        .map(|value| normalize_ai_summary_model(&value))
        .unwrap_or_else(|| normalize_ai_summary_model(&settings.ai_summary_model));
    let refresh_hours = normalize_ai_summary_refresh_hours(settings.ai_summary_refresh_hours);
    let cache_key = format!("{}::{}", chosen_model, prompt.trim());

    if let Some(summary) = get_cached_ai_summary(&cache_key, &chosen_model, refresh_hours) {
        return Ok(summary);
    }

    let summary = run_ollama_summary(&chosen_model, &prompt).map_err(|error| error.to_string())?;
    cache_ai_summary(&cache_key, &chosen_model, &summary).map_err(|error| error.to_string())?;
    Ok(summary)
}

#[tauri::command]
fn get_reminder_lists(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let mut lists = read_reminder_list_names().map_err(|error| error.to_string())?;
    for item in settings.reminder_lists {
        if !lists.iter().any(|value| value == &item) {
            lists.push(item);
        }
    }
    lists.sort();
    Ok(lists)
}

#[tauri::command]
fn get_week_context() -> WeekContext {
    let today = Local::now().date_naive();
    let start = week_start(today);
    let end = start + ChronoDuration::days(6);
    build_context_for_range(start, end, true, true, true, &Settings::default())
}

fn build_context_for_range(
    start: NaiveDate,
    end: NaiveDate,
    include_goals: bool,
    include_calendar: bool,
    include_reminders: bool,
    settings: &Settings,
) -> WeekContext {
    let mut warnings = Vec::new();

    let goals = if include_goals {
        scan_life_organization_goals().unwrap_or_else(|error| {
            warnings.push(format!("读取目标目录失败：{error}"));
            Vec::new()
        })
    } else {
        Vec::new()
    };

    let calendar_events = if include_calendar {
        read_calendar_context(start, end, Some(&settings.calendar_name)).unwrap_or_else(|error| {
            if is_context_timeout_error(&error)
                || is_calendar_transient_error_message(&error.to_string())
            {
                append_runtime_log("[Trace] calendar context timed out; skipped non-critical read");
            } else {
                warnings.push(format!("读取系统日历失败：{error}"));
            }
            Vec::new()
        })
    } else {
        Vec::new()
    };

    let reminders = if include_reminders && settings.reminders_enabled {
        read_reminders_context(&settings.reminder_lists).unwrap_or_else(|error| {
            if is_context_timeout_error(&error) {
                append_runtime_log("[Trace] reminder context timed out; skipped non-critical read");
            } else {
                warnings.push(format!("读取提醒事项失败：{error}"));
            }
            Vec::new()
        })
    } else {
        Vec::new()
    };

    WeekContext {
        goals,
        calendar_events,
        reminders,
        warnings,
    }
}

#[tauri::command]
fn get_context_sources(
    start_date: String,
    end_date: String,
    include_goals: bool,
    include_calendar: bool,
    include_reminders: bool,
    state: tauri::State<'_, AppState>,
) -> Result<WeekContext, String> {
    let start =
        NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let end =
        NaiveDate::parse_from_str(&end_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    Ok(build_context_for_range(
        start,
        end,
        include_goals,
        include_calendar,
        include_reminders,
        &settings,
    ))
}

#[allow(dead_code)]
fn build_full_context_for_range(start: NaiveDate, end: NaiveDate) -> WeekContext {
    let mut warnings = Vec::new();
    let settings = Settings::default();

    let goals = scan_life_organization_goals().unwrap_or_else(|error| {
        warnings.push(format!("读取目标目录失败：{error}"));
        Vec::new()
    });

    let calendar_events = read_calendar_context(start, end, Some(&settings.calendar_name))
        .unwrap_or_else(|error| {
            if is_context_timeout_error(&error)
                || is_calendar_transient_error_message(&error.to_string())
            {
                append_runtime_log(
                    "[Trace] full calendar context timed out; skipped non-critical read",
                );
            } else {
                warnings.push(format!("读取系统日历失败：{error}"));
            }
            Vec::new()
        });

    let reminders = read_reminders_context(&[]).unwrap_or_else(|error| {
        if is_context_timeout_error(&error) {
            append_runtime_log(
                "[Trace] full reminder context timed out; skipped non-critical read",
            );
        } else {
            warnings.push(format!("读取提醒事项失败：{error}"));
        }
        Vec::new()
    });

    WeekContext {
        goals,
        calendar_events,
        reminders,
        warnings,
    }
}

#[tauri::command]
fn get_context_for_range(
    start_date: String,
    end_date: String,
    state: tauri::State<'_, AppState>,
) -> Result<WeekContext, String> {
    let start =
        NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let end =
        NaiveDate::parse_from_str(&end_date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    Ok(build_context_for_range(
        start, end, true, true, true, &settings,
    ))
}

fn main() {
    install_runtime_panic_hook();
    let today = Local::now().date_naive();
    let mut settings = load_settings();
    settings.auto_start_tracking = false;

    let state = AppState {
        activities: Arc::new(Mutex::new(Vec::new())),
        current_date: Arc::new(Mutex::new(today)),
        settings: Arc::new(Mutex::new(settings.clone())),
        is_tracking: Arc::new(Mutex::new(false)),
        heartbeat_manager: Arc::new(Mutex::new(transform::HeartbeatManager::new())),
        window_watcher: Arc::new(Mutex::new(watcher::WindowWatcher::new())),
        last_tick: Arc::new(Mutex::new(Instant::now())),
        wake_guard_until: Arc::new(Mutex::new(None)),
        activities_dirty: Arc::new(Mutex::new(false)),
        calendar_dirty: Arc::new(Mutex::new(false)),
        calendar_sync_running: Arc::new(Mutex::new(false)),
        last_save_time: Arc::new(Mutex::new(Instant::now())),
        last_calendar_sync_time: Arc::new(Mutex::new(Instant::now())),
        last_capture_at_ms: Arc::new(Mutex::new(None)),
        last_calendar_sync_at_ms: Arc::new(Mutex::new(None)),
        last_calendar_sync_error: Arc::new(Mutex::new(None)),
        last_calendar_write_count: Arc::new(Mutex::new(0)),
        last_recovery: Arc::new(Mutex::new(None)),
    };

    apply_settings_to_watchers(&state);
    let state_for_setup = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state)
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("trace"));
            let _ = APP_DATA_DIR.set(app_data_dir);
            acquire_instance_lock().map_err(|error| error.to_string())?;

            load_current_date(&state_for_setup, Local::now().date_naive())
                .map_err(|error| error.to_string())?;
            let state_for_initial_calendar_sync = state_for_setup.clone();
            std::thread::spawn(move || {
                if let Err(error) = save_current_activities(&state_for_initial_calendar_sync) {
                    append_runtime_log(&format!("[Trace] initial activity save failed: {error}"));
                }
            });
            run_tracking_loop(state_for_setup.clone(), app.handle().clone());

            let show_main_window =
                tauri::menu::MenuItem::new(app, "打开主窗口", true, None::<&str>)?;
            let toggle_tracking =
                tauri::menu::MenuItem::new(app, "切换追溯状态", true, None::<&str>)?;
            let quit_app = tauri::menu::MenuItem::new(app, "退出应用", true, None::<&str>)?;
            let tray_menu = tauri::menu::MenuBuilder::new(app)
                .item(&show_main_window)
                .item(&toggle_tracking)
                .separator()
                .item(&quit_app)
                .build()?;

            tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
                .menu(&tray_menu)
                .title("Trace · 已暂停")
                .tooltip("Trace 已暂停追溯。需要手动点击开始")
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_activities_by_date,
            get_activities_by_range,
            get_settings,
            save_settings,
            toggle_tracking,
            check_tracking_status,
            get_tracking_overview,
            get_tracking_runtime_status,
            sync_calendar_today,
            queue_calendar_sync,
            write_plan_blocks_to_calendar,
            clear_all_activities,
            save_activity_corrections,
            get_learned_rules,
            clear_learned_rules,
            generate_ai_summary,
            get_reminder_lists,
            get_week_context,
            get_context_for_range,
            get_context_sources,
        ])
        .on_menu_event(|app_handle, event| match event.id().0.as_str() {
            "打开主窗口" => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "切换追溯状态" => {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let is_tracking = *state
                        .is_tracking
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    set_tracking_enabled(&state, !is_tracking);
                    update_tray_status(app_handle, &state);
                }
            }
            "退出应用" => app_handle.exit(0),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                append_runtime_log(&format!(
                    "[Trace] close requested for window {}",
                    window.label()
                ));
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Trace");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_manual_category_matches_entertainment_title() {
        assert_eq!(
            infer_manual_category_from_title("娱乐"),
            Some("娱乐".to_string())
        );
        assert_eq!(
            infer_manual_category_from_title("休息放松"),
            Some("休息".to_string())
        );
    }

    #[test]
    fn infer_manual_category_matches_dev_and_learning_titles() {
        assert_eq!(
            infer_manual_category_from_title("开发 Trace"),
            Some("开发".to_string())
        );
        assert_eq!(
            infer_manual_category_from_title("搜索资料"),
            Some("学习".to_string())
        );
        assert_eq!(
            infer_manual_category_from_title("研究文档"),
            Some("学习".to_string())
        );
    }

    #[test]
    fn timeout_error_is_detected_by_message() {
        let error = anyhow!("系统应用读取超时");
        assert!(is_context_timeout_error(&error));
        let other_error = anyhow!("权限不足");
        assert!(!is_context_timeout_error(&other_error));
    }
}
