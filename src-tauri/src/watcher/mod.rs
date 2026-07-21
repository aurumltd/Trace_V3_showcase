//! 窗口活动追踪模块
//! 负责监控当前活动窗口，提取应用名称和窗口标题

use anyhow::Result;
use serde::{Deserialize, Serialize};
use x_win::get_active_window;

/// 窗口信息
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowInfo {
    /// 应用名称
    pub app_name: String,
    /// 窗口标题（原始）
    pub raw_title: String,
    /// 窗口标题（已清理）
    pub clean_title: String,
}

/// 窗口追踪器
pub struct WindowWatcher {
    /// 忽略的应用列表
    ignored_apps: Vec<String>,
}

impl WindowWatcher {
    /// 创建新的窗口追踪器
    pub fn new() -> Self {
        Self {
            ignored_apps: Vec::new(),
        }
    }

    /// 设置忽略的应用列表
    pub fn set_ignored_apps(&mut self, apps: Vec<String>) {
        self.ignored_apps = apps;
    }

    /// 获取当前活动窗口
    pub fn get_active_window(&self) -> Result<Option<WindowInfo>> {
        let Some(window_info) = self.get_active_window_unfiltered()? else {
            return Ok(None);
        };

        let normalized_app_name = window_info.app_name.to_lowercase();
        for ignored in &self.ignored_apps {
            if normalized_app_name.contains(&ignored.to_lowercase()) {
                return Ok(None);
            }
        }

        Ok(Some(window_info))
    }

    pub fn get_active_window_unfiltered(&self) -> Result<Option<WindowInfo>> {
        let window_info = match get_active_window() {
            Ok(info) => info,
            Err(_) => return Ok(None),
        };

        let raw_app_name = window_info.info.name;
        let raw_title = window_info.title;
        let app_name = normalize_app_name(&raw_app_name, &raw_title);

        if app_name.trim().is_empty() && raw_title.trim().is_empty() {
            return Ok(None);
        }

        let clean_title = clean_window_title(&raw_title, &app_name);

        Ok(Some(WindowInfo {
            app_name,
            raw_title,
            clean_title,
        }))
    }
}

impl Default for WindowWatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// 窗口标题格式化 - 清理冗余信息，提升统计准确性
/// 处理浏览器标签页、IDE 项目名、通用后缀等冗余信息
pub fn clean_window_title(window_title: &str, app_name: &str) -> String {
    let mut title = window_title.trim();
    if title.is_empty() {
        return app_name.to_string();
    }

    // 1. 移除浏览器常见后缀
    let browser_suffixes = [
        " - Google Chrome",
        " - Chrome",
        " - Microsoft Edge",
        " - Edge",
        " - Firefox",
        " - Mozilla Firefox",
        " - Safari",
        " — Safari", // macOS em-dash
        " - Brave",
        " - Opera",
        " - Vivaldi",
    ];
    for suffix in browser_suffixes {
        if title.ends_with(suffix) {
            title = &title[..title.len() - suffix.len()];
            break;
        }
    }

    // 2. 移除 IDE 常见前缀/后缀
    let ide_patterns = [
        (" - Visual Studio Code", ""),
        (" - VS Code", ""),
        (" - JetBrains Rider", ""),
        (" - IntelliJ IDEA", ""),
        (" - WebStorm", ""),
        (" - PyCharm", ""),
        (" - CLion", ""),
        (" - GoLand", ""),
        (" - PhpStorm", ""),
        (" - RubyMine", ""),
        (" - Android Studio", ""),
        (" - Xcode", ""),
        (" - Sublime Text", ""),
        (" - Atom", ""),
    ];
    for (suffix, _replace) in ide_patterns {
        if title.ends_with(suffix) {
            title = &title[..title.len() - suffix.len()];
            break;
        }
    }

    // 3. 移除常见终端后缀
    let terminal_suffixes = [
        " — Terminal",
        " - Terminal",
        " - iTerm2",
        " - iTerm",
        " - Warp",
    ];
    for suffix in terminal_suffixes {
        if title.ends_with(suffix) {
            title = &title[..title.len() - suffix.len()];
            break;
        }
    }

    // 4. 如果清理后为空，返回应用名
    let title = title.trim();
    if title.is_empty() {
        app_name.to_string()
    } else {
        title.to_string()
    }
}

fn normalize_app_name(app_name: &str, window_title: &str) -> String {
    let combined = format!(
        "{} {}",
        app_name.to_lowercase(),
        window_title.to_lowercase()
    );
    if combined.contains("codex") {
        return "Codex".to_string();
    }
    if combined.contains("chatgpt") {
        return "ChatGPT".to_string();
    }
    if app_name == "Electron" && combined.contains("cursor") {
        return "Cursor".to_string();
    }
    app_name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_chrome_title() {
        let title = "Google - Google Chrome";
        let cleaned = clean_window_title(title, "Chrome");
        assert_eq!(cleaned, "Google");
    }

    #[test]
    fn test_clean_vscode_title() {
        let title = "main.rs - Visual Studio Code";
        let cleaned = clean_window_title(title, "Code");
        assert_eq!(cleaned, "main.rs");
    }

    #[test]
    fn test_empty_title() {
        let cleaned = clean_window_title("", "SomeApp");
        assert_eq!(cleaned, "SomeApp");
    }
}
