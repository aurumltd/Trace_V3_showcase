//! 事件合并模块。
//! 只保留 ActivityWatch 风格的实时 heartbeat 合并，避免旧版事后合并再次制造重复块。

pub mod heartbeat;

pub use heartbeat::{EventData, HeartbeatManager, HeartbeatResult, TrackEvent};
