use crate::{Activity, Settings};
use chrono::{DateTime, Datelike, Local, NaiveDate, Timelike};
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const TRACE_MARKER: &str = "Trace 自动追溯记录";
const TRACE_AUTO_MANAGED_MARKER: &str = "Trace 自动管理：未手动编辑";
const TRACE_GENERATED_TITLE_PREFIX: &str = "Trace 生成标题：";
const TRACE_PLAN_MARKER: &str = "Trace 今日计划建议";
const TRACE_PLAN_MANAGED_MARKER: &str = "Trace 自动计划：未手动编辑";
const MAX_CALENDAR_BLOCK_MINUTES: f64 = 120.0;
const AI_BLOCK_SUMMARY_TIMEOUT_1_7B: Duration = Duration::from_secs(18);
const AI_BLOCK_SUMMARY_TIMEOUT_4B: Duration = Duration::from_secs(32);
const PRODUCTIVE_APP_HINTS: &[&str] = &[
    "editor", "ide", "terminal", "browser", "document", "notes", "research", "design",
];
const GENERIC_TASK_TOKENS: &[&str] = &[
    "进行", "处理", "查看", "使用", "工作", "开发", "学习", "研究", "浏览", "网页", "内容", "任务",
    "app", "editor", "terminal", "browser", "document", "calendar", "window", "page", "pages", "info",
];
static AI_BLOCK_SUMMARY_CACHE: OnceLock<Mutex<HashMap<String, AiBlockNarrative>>> = OnceLock::new();

#[derive(Debug, Clone)]
struct ActivityBlock {
    key: String,
    category: String,
    activity_type: String,
    start_time_ms: i64,
    end_time_ms: i64,
    total_minutes: f64,
    focus_scores: Vec<u8>,
    apps: Vec<String>,
    themes: Vec<String>,
    details: Vec<String>,
    ai_title: Option<String>,
    ai_summary: Option<String>,
}

#[derive(Debug, Clone)]
struct AiBlockNarrative {
    title: String,
    summary: String,
}

#[derive(Debug, Clone)]
pub struct CalendarManualEdit {
    pub start_time_ms: i64,
    pub end_time_ms: i64,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct PlannedCalendarBlock {
    pub title: String,
    pub start_time_ms: i64,
    pub end_time_ms: i64,
    pub source_reminder: String,
    pub rationale: String,
}

pub fn sync_activities_for_date(
    activities: &[Activity],
    date: NaiveDate,
    settings: &Settings,
) -> Result<usize, String> {
    ensure_calendar_exists(&settings.calendar_name)?;
    let has_existing_trace_events =
        managed_trace_events_exist_for_date(&settings.calendar_name, date)?;
    let mut blocks = aggregate_activities(activities, settings);
    enrich_blocks_with_ai(&mut blocks, settings);
    let start_of_day_ms = date
        .and_hms_opt(0, 0, 0)
        .and_then(|value| value.and_local_timezone(Local).single())
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| Local::now().timestamp_millis());
    let incremental_cutoff_ms =
        Local::now().timestamp_millis() - ((settings.merge_gap_minutes.max(15) + 5) * 60_000);
    let rewrite_from_ms = incremental_cutoff_ms.max(start_of_day_ms);
    let rewrite_all = !has_existing_trace_events;
    if rewrite_all {
        delete_trace_events_for_date(&settings.calendar_name, date, None)?;
    } else {
        delete_trace_events_for_date(&settings.calendar_name, date, Some(rewrite_from_ms))?;
        blocks.retain(|block| block.end_time_ms >= rewrite_from_ms);
    }

    let mut count = 0;

    for block in blocks {
        let title = build_event_title(&block);
        let notes = build_notes(&block);
        create_event(
            &settings.calendar_name,
            &title,
            block.start_time_ms,
            block.end_time_ms,
            &notes,
            (!rewrite_all).then_some(rewrite_from_ms),
        )?;
        count += 1;
    }

    Ok(count)
}

pub fn sync_plan_blocks_for_date(
    calendar_name: &str,
    date: NaiveDate,
    blocks: &[PlannedCalendarBlock],
) -> Result<usize, String> {
    ensure_calendar_exists(calendar_name)?;
    delete_plan_events_for_date(calendar_name, date)?;

    let mut count = 0;
    for block in blocks {
        let notes = format!(
            "{marker}\n{managed}\n来源提醒事项：{source}\n\n建议说明：{rationale}\n\n说明：如果你手动修改这个计划事件的标题或详情，Trace 后续不会覆盖它。",
            marker = TRACE_PLAN_MARKER,
            managed = TRACE_PLAN_MANAGED_MARKER,
            source = block.source_reminder,
            rationale = block.rationale,
        );
        create_event_with_marker(
            calendar_name,
            &block.title,
            block.start_time_ms,
            block.end_time_ms,
            &notes,
            TRACE_PLAN_MARKER,
            TRACE_PLAN_MANAGED_MARKER,
            "",
            None,
        )?;
        count += 1;
    }

    Ok(count)
}

fn aggregate_activities(activities: &[Activity], settings: &Settings) -> Vec<ActivityBlock> {
    let mut sorted: Vec<Activity> = activities
        .iter()
        .filter(|activity| activity.duration_minutes >= 0.25)
        .cloned()
        .collect();
    sorted.sort_by_key(|activity| activity.start_time_ms);

    let mut blocks: Vec<ActivityBlock> = Vec::new();
    let merge_gap_ms = settings.merge_gap_minutes * 60 * 1000;

    for activity in sorted {
        let end_time_ms = activity.start_time_ms + (activity.duration_minutes * 60_000.0) as i64;
        let key = infer_context_key(&activity);
        let category = activity
            .category
            .clone()
            .unwrap_or_else(|| "其他".to_string());
        let activity_type = activity
            .activity_type
            .clone()
            .unwrap_or_else(|| category.clone());
        let detail = build_activity_detail(&activity);
        let focus_score = activity
            .focus_score
            .unwrap_or_else(|| estimate_focus_score(&category));
        let theme = activity_theme(&activity);

        if let Some(last) = blocks.last_mut() {
            let gap = activity.start_time_ms - last.end_time_ms;
            if should_merge_blocks(last, &activity, &key, gap, merge_gap_ms) {
                last.end_time_ms = last.end_time_ms.max(end_time_ms);
                last.total_minutes += activity.duration_minutes;
                if last.activity_type != activity_type && activity.duration_minutes > 1.5 {
                    last.activity_type = activity_type.clone();
                }
                if last.focus_scores.len() < 24 {
                    last.focus_scores.push(focus_score);
                }
                push_unique(&mut last.apps, activity.name.clone(), 8);
                push_unique(&mut last.themes, theme, 8);
                push_unique(&mut last.details, detail, 12);
                continue;
            }
        }

        blocks.push(ActivityBlock {
            key,
            category,
            activity_type,
            start_time_ms: activity.start_time_ms,
            end_time_ms,
            total_minutes: activity.duration_minutes,
            focus_scores: vec![focus_score],
            apps: vec![activity.name.clone()],
            themes: vec![theme],
            details: vec![detail],
            ai_title: None,
            ai_summary: None,
        });
    }

    let min_minutes = settings.min_activity_minutes.max(5.0);
    blocks
        .into_iter()
        .filter(|block| block.total_minutes >= min_minutes)
        .collect()
}

fn should_merge_blocks(
    last: &ActivityBlock,
    activity: &Activity,
    key: &str,
    gap_ms: i64,
    merge_gap_ms: i64,
) -> bool {
    if gap_ms < 0 || gap_ms > merge_gap_ms {
        return false;
    }

    let current_span_minutes = ((last.end_time_ms - last.start_time_ms).max(0) as f64) / 60_000.0;
    if current_span_minutes >= MAX_CALENDAR_BLOCK_MINUTES {
        return false;
    }

    if last.key == key {
        return true;
    }

    let next_theme = activity_theme(activity);
    if last.themes.iter().any(|theme| theme == &next_theme) {
        return true;
    }

    let last_is_research = last.key.starts_with("研究：");
    let next_is_research = key.starts_with("研究：");
    if last_is_research && next_is_research {
        return true;
    }

    if last.key == "产品优化" && mentions_product_work(activity) {
        return true;
    }

    let block_cluster = infer_block_merge_cluster(last);
    let next_cluster = infer_activity_merge_cluster(activity);
    if !block_cluster.is_empty() && block_cluster == next_cluster {
        return true;
    }

    if should_merge_cross_window_task_flow(last, activity, gap_ms, merge_gap_ms) {
        return true;
    }

    if titles_look_related(last, activity) && gap_ms <= 8 * 60 * 1000 {
        return true;
    }

    let next_category = activity
        .category
        .clone()
        .unwrap_or_else(|| "其他".to_string());
    let same_app = last
        .apps
        .iter()
        .any(|app| app.eq_ignore_ascii_case(&activity.name));
    let short_gap = gap_ms <= 2 * 60 * 1000;
    let tiny_bridge = last.total_minutes <= 2.0 || activity.duration_minutes <= 2.0;

    if is_background_companion(activity)
        && short_gap
        && (REVIEW_CATEGORIES.contains(&last.category.as_str()) || !block_cluster.is_empty())
    {
        return true;
    }

    (same_app && short_gap && tiny_bridge)
        || (last.category == next_category && short_gap && tiny_bridge)
}

fn should_merge_cross_window_task_flow(
    last: &ActivityBlock,
    activity: &Activity,
    gap_ms: i64,
    merge_gap_ms: i64,
) -> bool {
    if gap_ms > std::cmp::max(merge_gap_ms, 8 * 60 * 1000) {
        return false;
    }
    if !focus_like_category(&last.category)
        || !focus_like_category(
            &activity
                .category
                .clone()
                .unwrap_or_else(|| "其他".to_string()),
        )
    {
        return false;
    }

    let block_key = infer_block_semantic_key(last);
    let activity_key = infer_activity_semantic_key(activity);
    let overlap = semantic_overlap(
        &[
            last.key.clone(),
            last.activity_type.clone(),
            last.details.join(" "),
            last.themes.join(" "),
        ],
        &[
            activity.window_title.clone(),
            activity.raw_window_title.clone().unwrap_or_default(),
            activity.description.clone().unwrap_or_default(),
            activity.context_key.clone().unwrap_or_default(),
            activity.activity_type.clone().unwrap_or_default(),
        ],
    );
    let productive_flow =
        last.apps.iter().any(|app| is_productive_app(app)) && is_productive_app(&activity.name);

    (productive_flow && !block_key.is_empty() && block_key == activity_key)
        || (productive_flow && overlap >= 2)
        || overlap >= 3
}

const REVIEW_CATEGORIES: &[&str] = &["开发", "工作", "学习"];

fn focus_like_category(category: &str) -> bool {
    REVIEW_CATEGORIES.contains(&category) || category == "浏览网页"
}

fn infer_activity_merge_cluster(activity: &Activity) -> String {
    if mentions_product_work(activity) {
        return "product-work".to_string();
    }

    let combined = format!(
        "{} {} {} {} {}",
        activity.name,
        activity.window_title,
        activity.raw_window_title.as_deref().unwrap_or(""),
        activity.description.as_deref().unwrap_or(""),
        activity.context_key.as_deref().unwrap_or("")
    )
    .to_lowercase();

    if mentions_project_or_collaboration(&combined) {
        return "project-work".to_string();
    }
    if mentions_reminders(&combined) {
        return "reminders".to_string();
    }
    if contains_any(
        &combined,
        &[
            "代码", "开发", "调试", "构建", "发布", "terminal", "editor", "ide",
        ],
    ) && contains_any(
        &combined,
        &[
            "ai 编程",
            "编写代码",
            "命令行开发",
            "代码协作",
            "调试修复",
            "搜索资料",
            "文档整理",
            "开发",
            "研究",
            "产品",
            "app",
        ],
    ) {
        return "build-flow".to_string();
    }

    String::new()
}

fn infer_block_merge_cluster(block: &ActivityBlock) -> String {
    if block.key.contains("产品") || block.themes.iter().any(|theme| theme.contains("产品")) {
        return "product-work".to_string();
    }

    let text = block_search_text(block);
    if mentions_project_or_collaboration(&text) {
        return "project-work".to_string();
    }
    if contains_any(
        &text,
        &[
            "代码", "开发", "调试", "构建", "发布", "terminal", "editor", "ide",
        ],
    ) && contains_any(
        &text,
        &[
            "ai 编程",
            "编写代码",
            "命令行开发",
            "代码协作",
            "调试修复",
            "搜索资料",
            "文档整理",
            "开发",
            "研究",
            "产品",
            "app",
        ],
    ) {
        return "build-flow".to_string();
    }

    String::new()
}

fn titles_look_related(block: &ActivityBlock, activity: &Activity) -> bool {
    let last_title = best_evidence_title(block).unwrap_or_else(|| block_headline(block));
    let next_title = normalize_title(
        activity
            .raw_window_title
            .as_deref()
            .unwrap_or(&activity.window_title),
    );
    if last_title.trim().is_empty() || next_title.trim().is_empty() {
        return false;
    }

    let left = normalize_merge_text(&last_title);
    let right = normalize_merge_text(&next_title);
    if left.is_empty() || right.is_empty() {
        return false;
    }

    let left_condensed = left.replace(' ', "");
    let right_condensed = right.replace(' ', "");
    if left_condensed.contains(&right_condensed) || right_condensed.contains(&left_condensed) {
        return true;
    }

    merge_overlap_score(&left, &right) >= 2 || merge_overlap_score(&right, &left) >= 2
}

fn is_background_companion(activity: &Activity) -> bool {
    let combined = format!(
        "{} {} {}",
        activity.name,
        activity.window_title,
        activity.raw_window_title.as_deref().unwrap_or("")
    )
    .to_lowercase();

    contains_any(
        &combined,
        &[
            "网易云音乐",
            "netease music",
            "music",
            "spotify",
            "apple music",
            "qq 音乐",
            "qqmusic",
        ],
    )
}

fn activity_theme(activity: &Activity) -> String {
    let combined = format!(
        "{} {} {} {}",
        activity.name,
        activity.window_title,
        activity.raw_window_title.as_deref().unwrap_or(""),
        activity.description.as_deref().unwrap_or("")
    )
    .to_lowercase();

    if combined.contains("trace") {
        return "产品优化".to_string();
    }
    if combined.contains("product demo")
        || combined.contains("product demo")
        || combined.contains("product demo demo")
    {
        return "产品优化".to_string();
    }
    if combined.contains("prototype tool") {
        return "研究产品方案".to_string();
    }
    if combined.contains("应用构建") || combined.contains("应用构建") {
        return "研究开发方法".to_string();
    }
    if combined.contains("reminder") || combined.contains("提醒") {
        return "整理提醒事项".to_string();
    }
    if mentions_project_or_collaboration(&combined) {
        return "项目推进和沟通准备".to_string();
    }
    if contains_any(
        &combined,
        &["文档", "document", "doc", "brief", "case study"],
    ) {
        return "文档写作".to_string();
    }
    if contains_any(
        &combined,
        &[
            "项目推进",
            "项目",
            "项目",
            "计划",
            "知识库",
            "资料",
            "计划",
        ],
    ) {
        return "项目推进".to_string();
    }
    if contains_any(
        &combined,
        &["smart home", "harmony", "home assistant", "智能家居"],
    ) {
        return "研究智能家居".to_string();
    }
    if contains_any(
        &combined,
        &[
            "netflix",
            "爱奇艺",
            "腾讯视频",
            "优酷",
            "剧",
            "电影",
            "mp4",
            "mkv",
            "iina",
            "vlc",
            "rich.flu",
            "rich flu",
        ],
    ) {
        return "看剧".to_string();
    }

    activity
        .activity_type
        .clone()
        .or_else(|| activity.context_key.clone())
        .unwrap_or_else(|| {
            activity
                .category
                .clone()
                .unwrap_or_else(|| "其他活动".to_string())
        })
}

fn push_unique(items: &mut Vec<String>, value: String, limit: usize) {
    if value.trim().is_empty() || items.contains(&value) || items.len() >= limit {
        return;
    }
    items.push(value);
}

fn infer_context_key(activity: &Activity) -> String {
    if let Some(context_key) = activity.context_key.as_ref() {
        if !context_key.trim().is_empty() {
            return context_key.trim().to_string();
        }
    }

    let app = activity.name.to_lowercase();
    let title = activity.window_title.to_lowercase();
    let combined = format!("{app} {title}");

    if mentions_reminders(&combined) {
        return "处理提醒事项".to_string();
    }

    if mentions_product_work(activity) {
        return "产品优化".to_string();
    }

    if mentions_vibe_coding_research(&combined) {
        return "研究：如何构建高质量应用".to_string();
    }

    if mentions_project_or_collaboration(&combined) {
        return "项目推进和沟通准备".to_string();
    }

    if contains_any(
        &combined,
        &[
            "activitywatch",
            "active window",
            "window watcher",
            "自动追溯",
            "时间追踪",
            "calendar sync",
        ],
    ) {
        return "调研自动追溯和日历写入方案".to_string();
    }

    let rules = [
        (
            "开发 Trace",
            [
                    "desktop runtime",
                "main.rs",
                "calendar.rs",
                "vite.config",
                "tsx",
                "rust",
                "ai tool",
            ]
            .as_slice(),
        ),
        (
            "开发代码",
            [
                "code repository",
                "pull request",
                "commit",
                "editor",
                "editor",
                "ide",
                "terminal",
                "cargo",
                "npm",
            ]
            .as_slice(),
        ),
        (
            "搜索资料",
            ["google", "baidu", "搜索", "search", "perplexity", "ai assistant"].as_slice(),
        ),
        (
            "整理文件",
            ["finder", "访达", "downloads", "下载", "文件夹", ".dmg"].as_slice(),
        ),
        (
            "沟通协作",
            ["lark", "feishu", "slack", "wechat", "微信", "telegram"].as_slice(),
        ),
        (
            "文档写作",
            ["docs", "notion", "obsidian", "word", "pages", "文档"].as_slice(),
        ),
        (
            "视频学习",
            ["youtube", "bilibili", "课程", "tutorial"].as_slice(),
        ),
    ];

    for (key, keywords) in rules {
        if keywords.iter().any(|keyword| combined.contains(keyword)) {
            return key.to_string();
        }
    }

    let normalized_title = normalize_title(&activity.window_title);
    if normalized_title.is_empty() {
        activity.name.clone()
    } else {
        format!("{}::{}", activity.name, normalized_title)
    }
}

fn normalize_merge_text(value: &str) -> String {
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

fn semantic_tokens(values: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    for value in values {
        let normalized = normalize_merge_text(value);
        if normalized.is_empty() {
            continue;
        }
        for token in normalized.split_whitespace() {
            if token.chars().count() < 2 {
                continue;
            }
            if GENERIC_TASK_TOKENS.iter().any(|keyword| keyword == &token) {
                continue;
            }
            if !tokens.iter().any(|existing| existing == token) {
                tokens.push(token.to_string());
            }
        }
    }
    tokens.truncate(8);
    tokens
}

fn semantic_overlap(left: &[String], right: &[String]) -> usize {
    let left_tokens = semantic_tokens(left);
    let right_tokens = semantic_tokens(right);
    let right_set: std::collections::HashSet<&String> = right_tokens.iter().collect();
    left_tokens
        .iter()
        .filter(|token| right_set.contains(token))
        .count()
}

fn infer_block_semantic_key(block: &ActivityBlock) -> String {
    semantic_tokens(&[
        block.key.clone(),
        block.activity_type.clone(),
        block.details.join(" "),
        block.themes.join(" "),
    ])
    .into_iter()
    .take(3)
    .collect::<Vec<_>>()
    .join(" ")
}

fn infer_activity_semantic_key(activity: &Activity) -> String {
    semantic_tokens(&[
        activity.window_title.clone(),
        activity.raw_window_title.clone().unwrap_or_default(),
        activity.description.clone().unwrap_or_default(),
        activity.context_key.clone().unwrap_or_default(),
        activity.activity_type.clone().unwrap_or_default(),
    ])
    .into_iter()
    .take(3)
    .collect::<Vec<_>>()
    .join(" ")
}

fn is_productive_app(app: &str) -> bool {
    let lower = app.to_lowercase();
    PRODUCTIVE_APP_HINTS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

fn merge_overlap_score(source: &str, target: &str) -> i32 {
    let source_tokens: Vec<&str> = source
        .split_whitespace()
        .filter(|token| token.chars().count() >= 2)
        .collect();
    let target_tokens: Vec<&str> = target
        .split_whitespace()
        .filter(|token| token.chars().count() >= 2)
        .collect();
    if source_tokens.is_empty() || target_tokens.is_empty() {
        return 0;
    }

    let mut score = 0;
    for token in source_tokens {
        if target_tokens.iter().any(|candidate| candidate == &token) {
            score += 1;
        }
    }
    score
}

fn contains_any(value: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| value.contains(keyword))
}

fn mentions_reminders(combined: &str) -> bool {
    contains_any(
        combined,
        &["reminders", "reminder", "提醒事项", "提醒", "待办"],
    )
}

fn mentions_product_work(activity: &Activity) -> bool {
    let combined = format!(
        "{} {}",
        activity.name.to_lowercase(),
        activity.window_title.to_lowercase()
    );
    contains_any(&combined, &["trace"])
        && contains_any(
            &combined,
            &[
                "ai tool", "editor", "code", "editor", "优化", "产品", "calendar", "日历", "分析",
                "设置", "desktop runtime",
            ],
        )
}

fn mentions_vibe_coding_research(combined: &str) -> bool {
    contains_any(
        combined,
        &["应用构建", "应用构建", "vibe-coding", "氛围编程"],
    ) || (contains_any(combined, &["vibe"])
        && contains_any(combined, &["coding", "app", "submission"]))
        || contains_any(
            combined,
            &[
                "最好的app",
                "最好的 app",
                "高质量 app",
                "高质量app",
                "best app",
                "build better app",
            ],
        )
}

fn mentions_project_or_collaboration(combined: &str) -> bool {
    contains_any(
        combined,
        &[
            "项目推进",
            "项目",
            "项目",
            "计划",
            "文档",
            "document",
            "doc",
            "知识库",
            "资料",
            "计划",
            "meeting",
            "沟通",
            "沟通议题",
            "沟通材料",
            "final review",
            "final review",
            "meeting notes",
            "meeting copilot",
            "submitting to",
            "submission received",
            "submission",
        ],
    )
}

fn normalize_title(title: &str) -> String {
    let mut cleaned = title.trim().to_string();
    for suffix in [
        " - Google Chrome",
        " - Chrome",
        " - Safari",
        " — Safari",
        " - Microsoft Edge",
        " - Visual Studio Code",
        " - Editor",
    ] {
        if cleaned.ends_with(suffix) {
            cleaned.truncate(cleaned.len() - suffix.len());
        }
    }

    if ["Google Chrome", "Chrome", "Safari", "Finder", "访达"].contains(&cleaned.as_str()) {
        String::new()
    } else {
        cleaned
    }
}

fn build_activity_detail(activity: &Activity) -> String {
    if let Some(description) = activity.description.as_ref() {
        if !description.trim().is_empty() {
            return format!(
                "{}（{:.1} 分钟）",
                truncate(&strip_category_prefix(description.trim()), 96),
                activity.duration_minutes
            );
        }
    }

    let title = normalize_title(
        activity
            .raw_window_title
            .as_deref()
            .unwrap_or(&activity.window_title),
    );
    if title.is_empty() {
        format!("{}（{:.1} 分钟）", activity.name, activity.duration_minutes)
    } else {
        format!(
            "{} · {}（{:.1} 分钟）",
            activity.name,
            truncate(&title, 80),
            activity.duration_minutes
        )
    }
}

fn build_event_title(block: &ActivityBlock) -> String {
    if let Some(ai_title) = block.ai_title.as_ref() {
        if !ai_title.trim().is_empty() {
            return truncate(ai_title.trim(), 72);
        }
    }
    let headline = concise_calendar_title(block);
    truncate(&headline, 72)
}

fn concise_calendar_title(block: &ActivityBlock) -> String {
    let block_text = block_search_text(block);
    let evidence = best_evidence_title(block).unwrap_or_else(|| block_headline(block));
    let subject = truncate(&descriptive_subject_for_block(block, &evidence), 40);

    if block.key == "产品优化" {
        let lower = evidence.to_lowercase();
        let area = infer_trace_area(&evidence, &lower);
        return format!("产品优化 {}：{}", area, subject);
    }

    if block.key == "处理提醒事项" {
        let reminder = infer_reminder_subject(&evidence);
        return if reminder.is_empty() {
            "整理提醒事项".to_string()
        } else {
            format!("整理提醒事项：{}", reminder)
        };
    }

    if block.key.starts_with("研究：") {
        let topic = infer_research_subject(&evidence);
        return format!("研究：{}", truncate(&topic, 38));
    }

    if mentions_project_or_collaboration(&block_text) {
        return truncate(&infer_project_summary(block, &block_text), 52);
    }

    if block.activity_type == "AI 编程" {
        if subject.is_empty() || is_generic_block_subject(&subject) {
            return if block
                .apps
                .iter()
                .any(|app| app.eq_ignore_ascii_case("AI 工具"))
            {
                "用 AI 工具 进行 AI 编程".to_string()
            } else {
                "AI 编程与实现".to_string()
            };
        }
        return format!("AI 编程：{}", subject);
    }

    if block.activity_type == "搜索资料" {
        if subject.is_empty() || is_generic_block_subject(&subject) {
            return "搜索并理解资料".to_string();
        }
        return format!("搜索资料：{}", subject);
    }

    if block.activity_type.starts_with("用户修正") {
        let category_hint = if block.category.trim().is_empty() {
            "已修正活动"
        } else {
            block.category.as_str()
        };
        if subject.is_empty() || is_generic_block_subject(&subject) || subject == category_hint {
            return format!("手动修正：{}", category_hint);
        }
        return format!("手动修正：{}", subject);
    }

    if subject.is_empty() || subject == block.activity_type || subject == block.category {
        return truncate(&block.activity_type, 44);
    }

    format!("{}：{}", block.activity_type, subject)
}

fn descriptive_subject_for_block(block: &ActivityBlock, fallback: &str) -> String {
    let cleaned = strip_category_prefix(fallback).trim().to_string();
    if !is_generic_block_subject(&cleaned) {
        return cleaned;
    }

    if let Some(snapshot) = block_window_snapshots(block)
        .into_iter()
        .map(|item| strip_category_prefix(&item))
        .find(|item| !is_generic_block_subject(item))
    {
        return snapshot;
    }

    if let Some(detail_title) = block
        .details
        .iter()
        .filter_map(|detail| extract_detail_title(detail))
        .map(|item| strip_category_prefix(&item))
        .find(|item| !is_generic_block_subject(item))
    {
        return detail_title;
    }

    if block.key == "处理提醒事项" {
        return "整理提醒事项".to_string();
    }

    if block.activity_type == "搜索资料" {
        return "搜索并理解相关资料".to_string();
    }

    cleaned
}

fn is_generic_block_subject(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    if normalized == "使用 ai tool 进行 ai 编程"
        || normalized == "在 ai tool 中进行 ai 编程"
        || normalized == "在 ai tool 中进行 ai 编程和代码实现"
        || normalized == "使用 editor 进行 ai 编程"
        || normalized == "在 editor 中进行 ai 编程"
    {
        return true;
    }

    [
        "ai 编程",
        "搜索资料",
        "用户修正",
        "娱乐",
        "工作",
        "学习",
        "网页浏览",
        "文档整理",
        "处理提醒事项",
        "查看和整理提醒事项",
        "calendar",
        "reminders",
    ]
    .iter()
    .any(|item| normalized == *item)
}

fn block_headline(block: &ActivityBlock) -> String {
    let evidence = best_evidence_title(block);

    if block.key.contains("::") {
        return evidence.unwrap_or_else(|| {
            block
                .key
                .split("::")
                .last()
                .unwrap_or(&block.key)
                .to_string()
        });
    }

    if block.key == "处理提醒事项" {
        return evidence
            .map(|title| format!("处理提醒事项：{}", truncate(&title, 30)))
            .unwrap_or_else(|| "处理提醒事项".to_string());
    }

    if block.key == "产品优化" {
        return evidence
            .map(|title| format!("产品优化 · {}", truncate(&title, 30)))
            .unwrap_or_else(|| "产品优化".to_string());
    }

    if let Some(title) = evidence {
        if title != block.key && !title.is_empty() {
            return format!("{} · {}", block.key, truncate(&title, 28));
        }
    }

    block.key.clone()
}

fn best_evidence_title(block: &ActivityBlock) -> Option<String> {
    block
        .details
        .iter()
        .filter_map(|detail| extract_detail_title(detail))
        .filter(|title| title.chars().count() >= 4)
        .max_by_key(|title| title_specificity_score(title))
}

fn extract_detail_title(detail: &str) -> Option<String> {
    let without_duration = detail.split('（').next().unwrap_or(detail).trim();
    let title = without_duration
        .split_once(" · ")
        .map(|(_, value)| value.trim())
        .unwrap_or(without_duration);

    let title = strip_category_prefix(title);

    if title.is_empty()
        || ["Google Chrome", "Chrome", "Safari", "Finder", "访达"].contains(&title.as_str())
    {
        None
    } else {
        Some(title)
    }
}

fn title_specificity_score(title: &str) -> usize {
    let lower = title.to_lowercase();
    let keyword_bonus = [
        "trace", "ai tool", "vibe", "coding", "app", "提醒", "reminder", "产品", "研究", "优化",
        "calendar", "日历",
    ]
    .iter()
    .filter(|keyword| lower.contains(**keyword))
    .count()
        * 20;
    title.chars().count() + keyword_bonus
}

fn build_notes(block: &ActivityBlock) -> String {
    let focus_score = average_focus_score(&block.focus_scores);
    let generated_title = build_event_title(block);
    let window_snapshots = block_window_snapshots(block);
    format!(
        "{marker}\n{managed_marker}\n{title_prefix}{generated_title}\n\n推断事项：{headline}\n自然语言总结：{summary}\n主要主题：{themes}\n具体活动：{activity_type}\n时长：{minutes:.1} 分钟\n分类：{category}\n专注评分：{focus_score}%\n使用应用：{apps}\n\n打开的页面 / 窗口：\n- {windows}\n\n细节记录：\n- {details}\n\n说明：如果你手动修改这个日历事件的标题或详情，Trace 后续不会覆盖它。",
        marker = TRACE_MARKER,
        managed_marker = TRACE_AUTO_MANAGED_MARKER,
        title_prefix = TRACE_GENERATED_TITLE_PREFIX,
        generated_title = generated_title,
        headline = block_headline(block),
        summary = natural_summary(block),
        themes = if block.themes.is_empty() { "未识别".to_string() } else { block.themes.join(", ") },
        activity_type = block.activity_type,
        minutes = block.total_minutes,
        category = block.category,
        focus_score = focus_score,
        apps = block.apps.join(", "),
        windows = if window_snapshots.is_empty() { "未识别具体窗口".to_string() } else { window_snapshots.join("\n- ") },
        details = block.details.join("\n- ")
    )
}

fn natural_summary(block: &ActivityBlock) -> String {
    if let Some(ai_summary) = block.ai_summary.as_ref() {
        if !ai_summary.trim().is_empty() {
            return truncate(ai_summary.trim(), 140);
        }
    }

    let block_text = block_search_text(block);
    if mentions_project_or_collaboration(&block_text) {
        return infer_project_summary(block, &block_text);
    }

    let evidence = best_evidence_title(block).unwrap_or_else(|| block_headline(block));
    let lower = evidence.to_lowercase();
    let apps = block_apps_phrase(block);
    let brief_evidence = truncate(&evidence, 34);

    if block.key == "产品优化" {
        let area = infer_trace_area(&evidence, &lower);
        if block
            .apps
            .iter()
            .any(|app| app.eq_ignore_ascii_case("AI 工具"))
        {
            return format!(
                "在 {} 中围绕 Trace 的{}进行 AI 编程和调试，主要处理 {}。",
                apps, area, brief_evidence
            );
        }
        return format!(
            "在 {} 中围绕 Trace 的{}进行开发和调试，主要处理 {}。",
            apps, area, brief_evidence
        );
    }

    if block.key == "处理提醒事项" {
        let subject = infer_reminder_subject(&evidence);
        if subject.is_empty() {
            return format!("在 {} 中整理和处理提醒事项。", apps);
        }
        return format!("在 {} 中把 {} 加入或整理到提醒事项。", apps, subject);
    }

    if block.key.starts_with("研究：") {
        let subject = infer_research_subject(&evidence);
        if subject.is_empty() {
            return format!("在 {} 中研究如何用 应用构建 做出更好的 App。", apps);
        }
        return format!("在 {} 中研究 {}，目标是做出更好的 App。", apps, subject);
    }

    if !block.themes.is_empty() {
        let themed = natural_summary_from_themes(block);
        if !is_generic_theme_summary(&themed) {
            return themed;
        }
    }

    if block.activity_type == "AI 编程" && is_generic_block_subject(&evidence) {
        if block
            .apps
            .iter()
            .any(|app| app.eq_ignore_ascii_case("AI 工具"))
        {
            return "在 AI 工具 中进行 AI 编程和代码实现，这一段暂时没有捕获到更具体的窗口标题。"
                .to_string();
        }
        if block
            .apps
            .iter()
            .any(|app| app.eq_ignore_ascii_case("Editor"))
        {
            return "在 Editor 中进行 AI 编程和代码实现，这一段暂时没有捕获到更具体的窗口标题。"
                .to_string();
        }
        return "这一段主要是在进行 AI 编程和代码实现，但当前没有捕获到更具体的窗口标题。"
            .to_string();
    }

    if block.category == "开发" {
        return format!(
            "在 {} 中推进 {}，主要在处理 {}。",
            apps, block.activity_type, brief_evidence
        );
    }
    if block.category == "学习" || block.category == "浏览网页" {
        return format!(
            "在 {} 中围绕 {} 查资料、阅读并理解相关信息。",
            apps, brief_evidence
        );
    }
    if block.category == "整理文件" {
        return format!("在 {} 中整理与 {} 相关的文件和内容。", apps, brief_evidence);
    }
    if block.category == "沟通" {
        return format!(
            "在 {} 中围绕 {} 进行沟通协作和信息确认。",
            apps, brief_evidence
        );
    }
    if block.category == "会议" {
        return format!("在 {} 中围绕 {} 进行会议或日程处理。", apps, brief_evidence);
    }
    if block.category == "娱乐" {
        return format!("在 {} 中围绕 {} 进行娱乐或放松。", apps, brief_evidence);
    }

    format!("在 {} 中处理 {}。", apps, truncate(&evidence, 38))
}

fn natural_summary_from_themes(block: &ActivityBlock) -> String {
    let primary_themes: Vec<String> = block
        .themes
        .iter()
        .filter(|theme| !theme.trim().is_empty())
        .take(3)
        .cloned()
        .collect();

    if primary_themes.is_empty() {
        return block_headline(block);
    }

    if primary_themes.len() == 1 {
        return match primary_themes[0].as_str() {
            "产品优化" => "产品优化".to_string(),
            "研究产品方案" => "研究产品方案".to_string(),
            value => truncate(value, 42),
        };
    }

    if primary_themes
        .iter()
        .all(|theme| theme.starts_with("优化 "))
    {
        let targets: Vec<String> = primary_themes
            .iter()
            .map(|theme| theme.trim_start_matches("优化 ").to_string())
            .collect();
        return format!("优化 {}", truncate(&targets.join(" 和 "), 46));
    }

    truncate(&primary_themes.join(" / "), 56)
}

fn is_generic_theme_summary(value: &str) -> bool {
    matches!(
        value,
        "产品优化"
            | "研究产品方案"
            | "AI 编程"
            | "搜索资料"
            | "网页浏览"
            | "文档整理"
            | "工作"
            | "学习"
    )
}

fn block_apps_phrase(block: &ActivityBlock) -> String {
    let apps: Vec<String> = block
        .apps
        .iter()
        .filter(|app| !app.trim().is_empty())
        .take(3)
        .cloned()
        .collect();
    if apps.is_empty() {
        "当前应用".to_string()
    } else {
        apps.join("、")
    }
}

fn block_window_snapshots(block: &ActivityBlock) -> Vec<String> {
    let mut snapshots = Vec::new();
    for detail in &block.details {
        if let Some(title) = extract_detail_title(detail) {
            if !snapshots.contains(&title) {
                snapshots.push(title);
            }
        }
        if snapshots.len() >= 6 {
            break;
        }
    }
    snapshots
}

fn block_search_text(block: &ActivityBlock) -> String {
    format!(
        "{} {} {} {} {}",
        block.key,
        block.category,
        block.activity_type,
        block.themes.join(" "),
        block.details.join(" ")
    )
    .to_lowercase()
}

fn ai_block_summary_cache() -> &'static Mutex<HashMap<String, AiBlockNarrative>> {
    AI_BLOCK_SUMMARY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn enrich_blocks_with_ai(blocks: &mut [ActivityBlock], settings: &Settings) {
    if !settings.ai_summaries_enabled {
        return;
    }

    let mut uncached_budget = 3;
    for block in blocks.iter_mut() {
        if block.total_minutes < settings.min_activity_minutes.max(5.0) {
            continue;
        }
        if !should_use_ai_for_block(block) {
            continue;
        }

        let cache_key = block_ai_cache_key(block, &settings.ai_summary_model);
        if let Some(cached) = ai_block_summary_cache()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&cache_key)
            .cloned()
        {
            block.ai_title = Some(cached.title);
            block.ai_summary = Some(cached.summary);
            continue;
        }

        if uncached_budget <= 0 {
            continue;
        }

        if let Some(narrative) = generate_ai_block_narrative(block, &settings.ai_summary_model) {
            ai_block_summary_cache()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(cache_key, narrative.clone());
            block.ai_title = Some(narrative.title);
            block.ai_summary = Some(narrative.summary);
            uncached_budget -= 1;
        }
    }
}

fn should_use_ai_for_block(block: &ActivityBlock) -> bool {
    if block.total_minutes >= 20.0 {
        return true;
    }
    if block.category == "浏览网页" || block.category == "学习" {
        return true;
    }

    let heuristic_title = concise_calendar_title(block);
    !heuristic_title.contains('：') || heuristic_title.chars().count() <= 10
}

fn block_ai_cache_key(block: &ActivityBlock, model: &str) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        model,
        block.key,
        block.activity_type,
        block.category,
        block.apps.join("/"),
        block.details.join("|")
    )
}

fn generate_ai_block_narrative(block: &ActivityBlock, model: &str) -> Option<AiBlockNarrative> {
    let prompt = format!(
        "你是 Trace 的本地时间追踪理解器。请根据一个工作块信息，输出两行且只能两行：\n标题：一句简洁但具体的中文标题，12到28字，格式偏向“动作：对象”，不要泛词。\n总结：一句自然语言总结，20到60字，要明确用户在做什么、看了什么、处理了什么。\n\n分类：{}\n活动类型：{}\n应用：{}\n主题：{}\n细节：{}\n窗口：{}\n时长：{:.1} 分钟",
        block.category,
        block.activity_type,
        block.apps.join("、"),
        block.themes.join("、"),
        block.details.join("；"),
        block_window_snapshots(block).join("；"),
        block.total_minutes,
    );

    let timeout = if model == "qwen3:4b" {
        AI_BLOCK_SUMMARY_TIMEOUT_4B
    } else {
        AI_BLOCK_SUMMARY_TIMEOUT_1_7B
    };

    let raw = run_ollama_block_summary(model, &prompt, timeout).ok()?;
    parse_ai_block_narrative(&raw)
}

fn run_ollama_block_summary(
    model: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new("ollama")
        .arg("run")
        .arg(model)
        .arg(prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let started_at = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 AI 工作块摘要超时".to_string());
        }

        thread::sleep(Duration::from_millis(150));
    }
}

fn parse_ai_block_narrative(raw: &str) -> Option<AiBlockNarrative> {
    let mut title = String::new();
    let mut summary = String::new();

    for line in raw
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line.strip_prefix("标题：") {
            title = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("总结：") {
            summary = value.trim().to_string();
        }
    }

    if title.is_empty() || summary.is_empty() {
        return None;
    }

    Some(AiBlockNarrative {
        title: truncate(&title, 72),
        summary: truncate(&summary, 140),
    })
}

fn infer_project_summary(block: &ActivityBlock, block_text: &str) -> String {
    let company = infer_company_from_text(block_text);
    let has_document = contains_any(block_text, &["文档", "document", "doc", "case study", "作品集"]);
    let has_submission = contains_any(
        block_text,
        &[
            "submitting to",
            "submission received",
            "submission",
            "提交",
            "提交",
        ],
    );
    let has_meeting = contains_any(
        block_text,
        &[
            "meeting",
            "沟通",
            "沟通议题",
            "沟通材料",
            "final review",
            "final review",
            "meeting notes",
            "meeting copilot",
        ],
    );

    if has_submission && has_meeting {
        if let Some(company) = company {
            return format!("推进项目文档，准备 {} 沟通", company);
        }
        return "推进项目文档，准备沟通".to_string();
    }

    if has_document && has_meeting {
        if let Some(company) = company {
            return format!("文档写作，准备 {} 沟通", company);
        }
        return "文档写作，准备沟通".to_string();
    }

    if has_meeting {
        if let Some(company) = company {
            return format!("准备 {} 沟通", company);
        }
        return "准备沟通材料".to_string();
    }

    if has_document || has_submission {
        return "推进项目文档".to_string();
    }

    let evidence = best_evidence_title(block).unwrap_or_else(|| block_headline(block));
    format!("项目推进：{}", truncate(&evidence, 32))
}

fn infer_company_from_text(text: &str) -> Option<String> {
    for (needle, company) in [
        ("freyr", "Freyr"),
        ("xai", "xAI"),
        ("openai", "OpenAI"),
        ("anthropic", "Anthropic"),
        ("google", "Google"),
        ("meta", "Meta"),
        ("apple", "Apple"),
        ("tesla", "Tesla"),
        ("microsoft", "Microsoft"),
        ("amazon", "Amazon"),
    ] {
        if text.contains(needle) {
            return Some(company.to_string());
        }
    }
    None
}

fn strip_category_prefix(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('[') {
        if let Some(end_index) = trimmed.find(']') {
            return trimmed[end_index + 1..].trim().to_string();
        }
    }
    if trimmed.starts_with('【') {
        if let Some(end_index) = trimmed.find('】') {
            return trimmed[end_index + '】'.len_utf8()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn infer_trace_area(evidence: &str, lower: &str) -> String {
    if lower.contains("analytic") || evidence.contains("分析") {
        "分析页".to_string()
    } else if lower.contains("calendar") || evidence.contains("日历") {
        "日历同步".to_string()
    } else if lower.contains("setting") || evidence.contains("设置") {
        "设置页".to_string()
    } else if lower.contains("tray") || evidence.contains("菜单栏") {
        "菜单栏状态".to_string()
    } else if lower.contains("watcher") || lower.contains("tracking") || evidence.contains("追溯")
    {
        "自动追溯逻辑".to_string()
    } else {
        "产品细节".to_string()
    }
}

fn infer_reminder_subject(evidence: &str) -> String {
    let cleaned = evidence
        .replace("处理提醒事项：", "")
        .replace("提醒事项", "")
        .replace("Reminders", "")
        .trim()
        .to_string();
    if cleaned.is_empty() || cleaned == "Calendar" {
        String::new()
    } else {
        truncate(&cleaned, 28)
    }
}

fn infer_research_subject(evidence: &str) -> String {
    let cleaned = evidence
        .replace("研究：", "")
        .replace("搜索资料", "")
        .replace("Google Chrome", "")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "如何用 应用构建 做出更好的 App".to_string()
    } else if cleaned.to_lowercase().contains("vibe") {
        truncate(&cleaned, 32)
    } else {
        format!("{} 相关资料", truncate(&cleaned, 24))
    }
}

fn average_focus_score(scores: &[u8]) -> u8 {
    if scores.is_empty() {
        return 50;
    }
    let total: usize = scores.iter().map(|value| *value as usize).sum();
    (total / scores.len()) as u8
}

fn estimate_focus_score(category: &str) -> u8 {
    match category {
        "开发" => 88,
        "学习" => 80,
        "工作" => 74,
        "整理文件" => 62,
        "沟通" => 58,
        "提醒事项" => 70,
        "浏览网页" => 52,
        "娱乐" => 24,
        _ => 50,
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut result: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn ensure_calendar_exists(calendar_name: &str) -> Result<(), String> {
    let script = format!(
        r#"
tell submission "Calendar"
    if not (exists calendar "{calendar}") then
        make new calendar with properties {{name:"{calendar}"}}
    end if
end tell
"#,
        calendar = escape_applescript(calendar_name)
    );

    run_applescript(&script).map(|_| ())
}

pub fn read_manual_trace_edits_for_date(
    calendar_name: &str,
    date: NaiveDate,
) -> Result<Vec<CalendarManualEdit>, String> {
    let start_date_script =
        applescript_date_from_parts("startOfDay", date.year(), date.month(), date.day(), 0, 0, 0);
    let script = format!(
        r#"
tell submission "Calendar"
    set targetCalendar to first calendar whose name is "{calendar}"
{start_date_script}
    set endOfDay to startOfDay + 1 * days
    set output to ""
    set titlePrefix to "{title_prefix}"
    repeat with evt in (events of targetCalendar whose start date >= startOfDay and start date < endOfDay)
        set eventRef to contents of evt
        set eventDescription to ""
        set eventSummary to ""
        try
            set eventDescription to description of eventRef as string
            set eventSummary to summary of eventRef as string
        end try
        if eventDescription contains "{marker}" and eventDescription contains titlePrefix then
            set oldDelimiters to AppleScript's text item delimiters
            set AppleScript's text item delimiters to titlePrefix
            set generatedPart to text item 2 of eventDescription
            set AppleScript's text item delimiters to linefeed
            set generatedTitle to text item 1 of generatedPart
            set AppleScript's text item delimiters to oldDelimiters
            if eventSummary is not generatedTitle then
                set eventStartDate to start date of eventRef
                set eventEndDate to end date of eventRef
                set startSeconds to time of eventStartDate
                set endSeconds to time of eventEndDate
                set output to output & startSeconds & "||" & endSeconds & "||" & eventSummary & linefeed
            end if
        end if
    end repeat
    return output
end tell
"#,
        calendar = escape_applescript(calendar_name),
        start_date_script = start_date_script,
        title_prefix = TRACE_GENERATED_TITLE_PREFIX,
        marker = TRACE_MARKER
    );

    let output = run_applescript(&script)?;
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .and_then(|value| value.and_local_timezone(Local).single())
        .unwrap_or_else(Local::now)
        .timestamp_millis();
    let mut edits = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split("||").collect();
        if parts.len() != 3 {
            continue;
        }
        let start_seconds = parts[0].trim().parse::<i64>().unwrap_or(0);
        let end_seconds = parts[1].trim().parse::<i64>().unwrap_or(start_seconds + 60);
        let title = parts[2].trim();
        if title.is_empty() {
            continue;
        }
        edits.push(CalendarManualEdit {
            start_time_ms: midnight + start_seconds * 1000,
            end_time_ms: midnight + end_seconds.max(start_seconds + 60) * 1000,
            title: title.to_string(),
        });
    }
    Ok(edits)
}

fn delete_trace_events_for_date(
    calendar_name: &str,
    date: NaiveDate,
    since_time_ms: Option<i64>,
) -> Result<usize, String> {
    _delete_auto_managed_trace_events_for_date(calendar_name, date, since_time_ms)
}

fn delete_plan_events_for_date(calendar_name: &str, date: NaiveDate) -> Result<usize, String> {
    delete_managed_events_for_date(
        calendar_name,
        date,
        TRACE_PLAN_MARKER,
        TRACE_PLAN_MANAGED_MARKER,
        None,
    )
}

fn _delete_auto_managed_trace_events_for_date(
    calendar_name: &str,
    date: NaiveDate,
    since_time_ms: Option<i64>,
) -> Result<usize, String> {
    delete_managed_events_for_date(
        calendar_name,
        date,
        TRACE_MARKER,
        TRACE_AUTO_MANAGED_MARKER,
        since_time_ms,
    )
}

fn delete_managed_events_for_date(
    calendar_name: &str,
    date: NaiveDate,
    marker: &str,
    managed_marker: &str,
    since_time_ms: Option<i64>,
) -> Result<usize, String> {
    let start_date_script =
        applescript_date_from_parts("startOfDay", date.year(), date.month(), date.day(), 0, 0, 0);
    let since_date_script = since_time_ms
        .map(|value| applescript_date_from_timestamp("rewriteFromDate", value))
        .unwrap_or_default();
    let since_guard = if since_time_ms.is_some() {
        " and end date of eventRef >= rewriteFromDate"
    } else {
        ""
    };
    let generated_title_guard = if marker == TRACE_MARKER {
        r#"
            set generatedTitle to ""
            if eventDescription contains titlePrefix then
                try
                    set oldDelimiters to AppleScript's text item delimiters
                    set AppleScript's text item delimiters to titlePrefix
                    set generatedPart to text item 2 of eventDescription
                    set AppleScript's text item delimiters to linefeed
                    set generatedTitle to text item 1 of generatedPart
                    set AppleScript's text item delimiters to oldDelimiters
                end try
            end if
"#
    } else {
        ""
    };
    let generated_title_match_guard = if marker == TRACE_MARKER {
        " and eventSummary is generatedTitle"
    } else {
        ""
    };
    let script = format!(
        r#"
tell submission "Calendar"
    set targetCalendar to first calendar whose name is "{calendar}"
{start_date_script}
{since_date_script}
    set endOfDay to startOfDay + 1 * days
    set traceEventIds to {{}}
    set titlePrefix to "{title_prefix}"
    repeat with evt in (events of targetCalendar whose start date >= startOfDay and start date < endOfDay)
        set eventRef to contents of evt
        set eventDescription to ""
        set eventSummary to ""
        try
            set eventDescription to description of eventRef as string
            set eventSummary to summary of eventRef as string
        end try
{generated_title_guard}
        if eventDescription contains "{marker}" and eventDescription contains "{managed_marker}"{since_guard}{generated_title_match_guard} then
            try
                copy (uid of eventRef as string) to end of traceEventIds
            end try
        end if
    end repeat
    set deletedCount to 0
    repeat with traceEventId in traceEventIds
        try
            set evt to first event of targetCalendar whose uid is (contents of traceEventId)
            delete evt
            set deletedCount to deletedCount + 1
        end try
    end repeat
    return deletedCount as string
end tell
"#,
        calendar = escape_applescript(calendar_name),
        start_date_script = start_date_script,
        since_date_script = since_date_script,
        title_prefix = TRACE_GENERATED_TITLE_PREFIX,
        generated_title_guard = generated_title_guard,
        marker = marker,
        managed_marker = managed_marker,
        since_guard = since_guard,
        generated_title_match_guard = generated_title_match_guard,
    );

    let output = run_applescript(&script)?;
    Ok(output.trim().parse::<usize>().unwrap_or(0))
}

fn managed_trace_events_exist_for_date(
    calendar_name: &str,
    date: NaiveDate,
) -> Result<bool, String> {
    let start_date_script =
        applescript_date_from_parts("startOfDay", date.year(), date.month(), date.day(), 0, 0, 0);
    let script = format!(
        r#"
tell submission "Calendar"
    set targetCalendar to first calendar whose name is "{calendar}"
{start_date_script}
    set endOfDay to startOfDay + 1 * days
    repeat with evt in (events of targetCalendar whose start date >= startOfDay and start date < endOfDay)
        set eventDescription to ""
        try
            set eventDescription to description of evt as string
        end try
        if eventDescription contains "{marker}" then
            return "1"
        end if
    end repeat
    return "0"
end tell
"#,
        calendar = escape_applescript(calendar_name),
        start_date_script = start_date_script,
        marker = TRACE_MARKER,
    );

    Ok(run_applescript(&script)?.trim() == "1")
}

fn create_event(
    calendar_name: &str,
    title: &str,
    start_time_ms: i64,
    end_time_ms: i64,
    notes: &str,
    rewrite_from_ms: Option<i64>,
) -> Result<String, String> {
    create_event_with_marker(
        calendar_name,
        title,
        start_time_ms,
        end_time_ms,
        notes,
        TRACE_MARKER,
        TRACE_AUTO_MANAGED_MARKER,
        TRACE_GENERATED_TITLE_PREFIX,
        rewrite_from_ms,
    )
}

fn create_event_with_marker(
    calendar_name: &str,
    title: &str,
    start_time_ms: i64,
    end_time_ms: i64,
    notes: &str,
    marker: &str,
    managed_marker: &str,
    title_prefix: &str,
    rewrite_from_ms: Option<i64>,
) -> Result<String, String> {
    let start_date_script = applescript_date_from_timestamp("traceStartDate", start_time_ms);
    let end_date_script =
        applescript_date_from_timestamp("traceEndDate", end_time_ms.max(start_time_ms + 60_000));
    let rewrite_from_date_script = rewrite_from_ms
        .map(|value| applescript_date_from_timestamp("rewriteFromDate", value))
        .unwrap_or_default();
    let rewrite_guard = if rewrite_from_ms.is_some() {
        " and end date of evt >= rewriteFromDate"
    } else {
        ""
    };
    let script = format!(
        r#"
tell submission "Calendar"
    set targetCalendar to first calendar whose name is "{calendar}"
{start_date_script}
{end_date_script}
{rewrite_from_date_script}
    repeat with evt in (events of targetCalendar whose start date < traceEndDate and end date > traceStartDate)
        set eventDescription to ""
        set eventSummary to ""
        try
            set eventDescription to description of evt as string
            set eventSummary to summary of evt as string
        end try
        if eventDescription contains "{marker}" then
            if eventDescription contains "{managed_marker}"{rewrite_guard} then
                if eventDescription contains ("{title_prefix}" & eventSummary) then
                    set start date of evt to traceStartDate
                    set end date of evt to traceEndDate
                end if
                try
                    return uid of evt
                on error
                    return "existing"
                end try
            end if
        end if
    end repeat
    set newEvent to make new event at end of events of targetCalendar with properties {{summary:"{title}", start date:traceStartDate, end date:traceEndDate, description:"{notes}"}}
    return uid of newEvent
end tell
"#,
        calendar = escape_applescript(calendar_name),
        marker = marker,
        managed_marker = managed_marker,
        title_prefix = title_prefix,
        title = escape_applescript(title),
        start_date_script = start_date_script,
        end_date_script = end_date_script,
        rewrite_from_date_script = rewrite_from_date_script,
        rewrite_guard = rewrite_guard,
        notes = escape_applescript(notes)
    );

    run_applescript(&script)
}

fn run_applescript(script: &str) -> Result<String, String> {
    let calendar_ready_script = format!(
        r#"
tell submission "Calendar" to launch
{script}
"#
    );
    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(calendar_ready_script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行 AppleScript 失败: {error}"))?;

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started_at.elapsed() > Duration::from_secs(20) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Calendar 响应超时。Trace 会稍后自动重试；如果持续失败，再检查系统设置中的日历与自动化权限。".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("等待 AppleScript 失败: {error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取 AppleScript 输出失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn applescript_date_from_timestamp(variable_name: &str, timestamp_ms: i64) -> String {
    let datetime = DateTime::from_timestamp_millis(timestamp_ms)
        .unwrap_or_else(|| Local::now().into())
        .with_timezone(&Local);
    applescript_date_from_parts(
        variable_name,
        datetime.year(),
        datetime.month(),
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second(),
    )
}

fn applescript_date_from_parts(
    variable_name: &str,
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> String {
    format!(
        r#"    set {variable_name} to current date
    set year of {variable_name} to {year}
    set month of {variable_name} to {month}
    set day of {variable_name} to {day}
    set hours of {variable_name} to {hour}
    set minutes of {variable_name} to {minute}
    set seconds of {variable_name} to {second}"#
    )
}

fn escape_applescript(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_block() -> ActivityBlock {
        ActivityBlock {
            key: "开发代码".to_string(),
            category: "开发".to_string(),
            activity_type: "AI 编程".to_string(),
            start_time_ms: 0,
            end_time_ms: 10 * 60 * 1000,
            total_minutes: 10.0,
            focus_scores: vec![88],
            apps: vec!["AI 工具".to_string(), "Google Chrome".to_string()],
            themes: vec!["产品优化".to_string()],
            details: vec![
                "AI 编程（4.0 分钟）".to_string(),
                "AI 工具 · 修复 Trace 日历同步卡顿（6.0 分钟）".to_string(),
            ],
            ai_title: None,
            ai_summary: None,
        }
    }

    #[test]
    fn descriptive_subject_prefers_non_generic_detail() {
        let block = sample_block();
        let subject = descriptive_subject_for_block(&block, "AI 编程");
        assert_eq!(subject, "修复 Trace 日历同步卡顿");
    }

    #[test]
    fn concise_calendar_title_avoids_generic_ai_programming_label() {
        let block = sample_block();
        let title = concise_calendar_title(&block);
        assert!(title.contains("AI 编程："));
        assert!(title.contains("修复 Trace 日历同步卡顿"));
        assert_ne!(title, "AI 编程");
    }

    #[test]
    fn concise_calendar_title_falls_back_when_subject_is_generated_ai_tool_phrase() {
        let mut block = sample_block();
        block.details = vec!["AI 工具 · 使用 AI 工具 进行 AI 编程（6.0 分钟）".to_string()];
        let title = concise_calendar_title(&block);
        assert_eq!(title, "用 AI 工具 进行 AI 编程");
    }

    #[test]
    fn concise_calendar_title_falls_back_for_manual_correction() {
        let mut block = sample_block();
        block.activity_type = "用户修正：娱乐".to_string();
        block.category = "娱乐".to_string();
        block.details = vec!["用户修正（2.0 分钟）".to_string()];
        let title = concise_calendar_title(&block);
        assert_eq!(title, "手动修正：娱乐");
    }
}
