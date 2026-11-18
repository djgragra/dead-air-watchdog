//! Messages between the interface and the engine: one JSON object per line on stdin (commands) and stdout (events).
//! Protocol version 2. The engine only measures: it opens the inputs and reports levels and faults. What a level
//! means (threshold, alarm time, monitoring hours, frozen audio) is decided by the app.

use serde::Deserialize;

pub const PROTOCOL: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Hello,
    ListDevices,
    /// The whole list of inputs to keep open: new ones are opened, missing ones closed, changed ones opened again.
    Sync { inputs: Vec<InputConfig> },
    /// Close every input (levels stop).
    Stop,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct InputConfig {
    pub id: String,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// A sound card: `channel_count` is 1 (one channel, heard on both sides) or 2 (a pair), from `channel_start`
    /// (0-based). An empty `device_id` is the default input of the system.
    Device {
        #[serde(default)]
        device_id: String,
        #[serde(default)]
        channel_start: usize,
        #[serde(default = "two")]
        channel_count: usize,
    },
    /// An Icecast / Shoutcast / plain HTTP(S) audio stream (MP3, AAC in ADTS, Ogg Vorbis, FLAC).
    Stream { url: String },
    /// Synthetic source for tests (only with `--test-sources`): a script of (ms, level) steps, then the last level.
    Tone { script: Vec<ToneStep> },
}

fn two() -> usize {
    2
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToneStep {
    pub ms: u64,
    pub db: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_and_defaults_apply() {
        let c: Command = serde_json::from_str(r#"{"cmd":"sync","inputs":[{"id":"a","source":{"kind":"stream","url":"http://x/y"}}]}"#).unwrap();
        match c {
            Command::Sync { inputs } => assert_eq!(inputs[0].source, Source::Stream { url: "http://x/y".into() }),
            _ => panic!(),
        }
        let c: Command = serde_json::from_str(r#"{"cmd":"sync","inputs":[{"id":"d","source":{"kind":"device"}}]}"#).unwrap();
        match c {
            Command::Sync { inputs } => assert_eq!(inputs[0].source, Source::Device { device_id: String::new(), channel_start: 0, channel_count: 2 }),
            _ => panic!(),
        }
        assert!(serde_json::from_str::<Command>(r#"{"cmd":"nope"}"#).is_err());
    }
}
