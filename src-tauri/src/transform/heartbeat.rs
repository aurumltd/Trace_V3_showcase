//! Heartbeat 事件合并算法
//! 参考 ActivityWatch 的设计思想，相同数据在 pulsetime 内自动合并
//! 极大减少数据库写入量，提高查询性能

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// 可合并的事件数据结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventData {
    /// 应用名称
    pub app_name: String,
    /// 窗口标题（已清理）
    pub window_title: String,
    /// 可选的扩展数据（将来使用）
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// 追踪事件
#[derive(Debug, Clone)]
pub struct TrackEvent {
    /// 事件 ID（插入数据库后才分配）
    pub id: Option<String>,
    /// 开始时间（UTC 毫秒时间戳）
    pub timestamp_ms: i64,
    /// 持续时间（毫秒）
    pub duration_ms: i64,
    /// 事件数据（合并比较的依据）
    pub data: EventData,
}

impl TrackEvent {
    /// 计算结束时间戳（毫秒）
    pub fn end_time_ms(&self) -> i64 {
        self.timestamp_ms + self.duration_ms
    }

    /// 检查两个事件数据是否相同（可以合并）
    pub fn data_eq(&self, other: &TrackEvent) -> bool {
        self.data == other.data
    }
}

/// Heartbeat 合并结果
pub enum HeartbeatResult {
    /// 合并成功，返回合并后的事件
    Merged(TrackEvent),
    /// 无法合并，需要创建新事件
    NewEvent(TrackEvent),
}

/// 尝试合并两个事件
/// - `last_event`: 上一个已存在的事件
/// - `heartbeat`: 新的心跳事件
/// - `pulsetime_ms`: 允许的最大间隔时间（毫秒），通常是轮询间隔 + 1秒容错
///
/// 返回合并后的事件，如果无法合并且需要创建新事件返回 None
pub fn heartbeat(
    last_event: &TrackEvent,
    heartbeat: &TrackEvent,
    pulsetime_ms: i64,
) -> Option<TrackEvent> {
    // 1. 如果数据不同，不合并
    if !last_event.data_eq(heartbeat) {
        return None;
    }

    // 2. 时间有效性检查
    if heartbeat.timestamp_ms < last_event.timestamp_ms {
        // 心跳时间早于上一个事件，不正常的情况
        return None;
    }

    // 3. 检查是否在 pulsetime 范围内
    // 上一个事件的结束时间 + pulsetime
    let allowed_end_time = last_event.end_time_ms() + pulsetime_ms;

    if heartbeat.timestamp_ms > allowed_end_time {
        // 超过 pulsetime，无法合并
        return None;
    }

    // 4. 合并成功！
    // - 开始时间：取更早的那个（应该是 last_event 的时间）
    // - 结束时间：取更晚的那个
    let start_time = std::cmp::min(last_event.timestamp_ms, heartbeat.timestamp_ms);
    let end_time = std::cmp::max(last_event.end_time_ms(), heartbeat.end_time_ms());
    let duration_ms = end_time - start_time;

    if duration_ms < 0 {
        return None;
    }

    Some(TrackEvent {
        id: last_event.id.clone(), // 保留原 ID，方便数据库更新
        timestamp_ms: start_time,
        duration_ms,
        data: last_event.data.clone(),
    })
}

/// Heartbeat 管理器 - 跟踪最后一个事件，用于合并
#[derive(Default)]
pub struct HeartbeatManager {
    /// 每个 bucket 的最后一个事件
    /// bucket 概念：不同类型的数据在不同 bucket（如 "window"、"afk"）
    last_events: HashMap<String, TrackEvent>,
}

impl HeartbeatManager {
    /// 创建新的管理器
    pub fn new() -> Self {
        Self {
            last_events: HashMap::new(),
        }
    }

    /// 获取最后一个事件的可变引用（内部使用）
    pub(crate) fn get_last_event_mut(&mut self, bucket: &str) -> Option<&mut TrackEvent> {
        self.last_events.get_mut(bucket)
    }

    /// 处理一个心跳事件
    /// 返回 HeartbeatResult: Merged(合并后的事件) 或 NewEvent(新事件)
    pub fn process_heartbeat(
        &mut self,
        bucket: &str,
        event: TrackEvent,
        pulsetime_ms: i64,
    ) -> HeartbeatResult {
        if let Some(last_event) = self.last_events.get(bucket) {
            // 尝试合并
            if let Some(merged) = heartbeat(last_event, &event, pulsetime_ms) {
                // 合并成功，更新缓存
                self.last_events.insert(bucket.to_string(), merged.clone());
                return HeartbeatResult::Merged(merged);
            }
        }

        // 无法合并或没有上一个事件，作为新事件
        self.last_events.insert(bucket.to_string(), event.clone());
        HeartbeatResult::NewEvent(event)
    }

    /// 清除某个 bucket 的缓存（比如跨天时）
    pub fn clear_bucket(&mut self, bucket: &str) {
        self.last_events.remove(bucket);
    }

    /// 清除所有缓存
    pub fn clear_all(&mut self) {
        self.last_events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_event(
        app: &str,
        title: &str,
        timestamp_ms: i64,
        duration_ms: i64,
    ) -> TrackEvent {
        TrackEvent {
            id: None,
            timestamp_ms,
            duration_ms,
            data: EventData {
                app_name: app.to_string(),
                window_title: title.to_string(),
                extra: HashMap::new(),
            },
        }
    }

    #[test]
    fn test_heartbeat_merge_same_data() {
        let base_time = 1000000000000; // 某个时间点
        let event1 = create_test_event("Chrome", "Google", base_time, 1000);
        let event2 = create_test_event("Chrome", "Google", base_time + 1500, 1000);

        // pulsetime_ms = 2000ms，间隔 500ms 在范围内
        let result = heartbeat(&event1, &event2, 2000);
        assert!(result.is_some());

        let merged = result.unwrap();
        assert_eq!(merged.timestamp_ms, base_time);
        assert_eq!(merged.duration_ms, 2500); // base_time to base_time+2500
    }

    #[test]
    fn test_heartbeat_no_merge_different_data() {
        let base_time = 1000000000000;
        let event1 = create_test_event("Chrome", "Google", base_time, 1000);
        let event2 = create_test_event("VS Code", "main.rs", base_time + 500, 1000);

        let result = heartbeat(&event1, &event2, 2000);
        assert!(result.is_none());
    }

    #[test]
    fn test_heartbeat_no_merge_out_of_pulsetime() {
        let base_time = 1000000000000;
        let event1 = create_test_event("Chrome", "Google", base_time, 1000);
        let event2 = create_test_event("Chrome", "Google", base_time + 5000, 1000);

        // pulsetime_ms = 2000ms，但间隔 4000ms，超出范围
        let result = heartbeat(&event1, &event2, 2000);
        assert!(result.is_none());
    }

    #[test]
    fn test_heartbeat_manager() {
        let mut manager = HeartbeatManager::new();
        let base_time = 1000000000000;

        // 第一个事件 - 作为新事件
        let event1 = create_test_event("Chrome", "Google", base_time, 1000);
        match manager.process_heartbeat("window", event1, 2000) {
            HeartbeatResult::NewEvent(_) => (),
            _ => panic!("应该是新事件"),
        }

        // 第二个相同事件 - 应该合并
        let event2 = create_test_event("Chrome", "Google", base_time + 1500, 1000);
        match manager.process_heartbeat("window", event2, 2000) {
            HeartbeatResult::Merged(merged) => {
                assert_eq!(merged.duration_ms, 2500);
            }
            _ => panic!("应该合并"),
        }

        // 第三个不同事件 - 新事件
        let event3 = create_test_event("VS Code", "main.rs", base_time + 3000, 1000);
        match manager.process_heartbeat("window", event3, 2000) {
            HeartbeatResult::NewEvent(_) => (),
            _ => panic!("应该是新事件"),
        }
    }
}
