//! The open inputs and their sources. A tick every 100 ms collects what each input measured and reports it in one
//! batch, like the audio worklet of the previous engine did; a source that cannot deliver says so with a fault
//! (and says "ok" when it delivers again). Same reasons as before: `device-ended`, `NotFoundError`, `NotReadableError`,
//! `ChannelsUnavailable`, `stream-error`, `stream-ended`, `stream-stalled`, `stream-nostart`.

use crate::level::Acc;
use crate::protocol::{InputConfig, Source};
use crate::{capture, stream, tone};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Waits between two attempts to open a device or a stream again (same as the previous engine).
pub const RETRY_MS: [u64; 4] = [2000, 5000, 10_000, 30_000];

/// Sleeps `ms` in short steps, ending early when `stop` is set. Returns true when it was stopped.
pub fn sleep_unless_stopped(stop: &AtomicBool, ms: u64) -> bool {
    let mut left = ms;
    while left > 0 && !stop.load(Ordering::Relaxed) {
        let step = left.min(100);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
    stop.load(Ordering::Relaxed)
}

/// What a source uses to tell the app that its input has a problem, or that the problem is gone.
#[derive(Clone)]
pub struct Reporter {
    id: String,
    emit: Emit,
    fault: Arc<Mutex<Option<String>>>,
}

impl Reporter {
    pub fn new(id: &str, emit: Emit) -> Reporter {
        Reporter { id: id.to_string(), emit, fault: Arc::new(Mutex::new(None)) }
    }
    /// Reported once per reason: a source that keeps failing the same way does not repeat itself.
    pub fn fault(&self, reason: &str, detail: impl Into<String>) {
        let mut f = self.fault.lock().unwrap();
        if f.as_deref() == Some(reason) {
            return;
        }
        *f = Some(reason.to_string());
        drop(f);
        (self.emit)(json!({"event":"fault","id":self.id,"reason":reason,"detail":detail.into()}));
    }
    /// A note for the log of the app (nothing is shown on the tile).
    pub fn info(&self, detail: impl Into<String>) {
        (self.emit)(json!({"event":"info","id":self.id,"detail":detail.into()}));
    }
    /// Only says something when there was a fault.
    pub fn ok(&self) {
        let mut f = self.fault.lock().unwrap();
        if f.take().is_some() {
            drop(f);
            (self.emit)(json!({"event":"ok","id":self.id}));
        }
    }
}

struct Input {
    cfg: InputConfig,
    acc: Arc<Mutex<Acc>>,
    stop: Arc<AtomicBool>,
}

pub struct Engine {
    emit: Emit,
    allow_test: bool,
    inputs: Mutex<Vec<Input>>,
}

impl Engine {
    pub fn new(emit: Emit, allow_test: bool) -> Engine {
        Engine { emit, allow_test, inputs: Mutex::new(Vec::new()) }
    }

    /// Makes the open inputs match the list: new ones are opened, removed ones closed, edited ones opened again.
    pub fn sync(&self, configs: Vec<InputConfig>) {
        let mut g = self.inputs.lock().unwrap();
        let mut old: Vec<Input> = std::mem::take(&mut *g);
        for cfg in configs {
            if matches!(cfg.source, Source::Tone { .. }) && !self.allow_test {
                (self.emit)(json!({"event":"fault","id":cfg.id,"reason":"error","detail":"Test sources are not enabled"}));
                continue;
            }
            if g.iter().any(|i| i.cfg.id == cfg.id) {
                continue; // a repeated id: the first one wins
            }
            if let Some(pos) = old.iter().position(|i| i.cfg == cfg) {
                g.push(old.remove(pos));
            } else {
                g.push(self.open(cfg));
            }
        }
        for gone in old {
            gone.stop.store(true, Ordering::Relaxed);
        }
    }

    pub fn stop(&self) {
        for i in self.inputs.lock().unwrap().drain(..) {
            i.stop.store(true, Ordering::Relaxed);
        }
    }

    fn open(&self, cfg: InputConfig) -> Input {
        let acc = Arc::new(Mutex::new(Acc::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let rep = Reporter::new(&cfg.id, self.emit.clone());
        match cfg.source.clone() {
            Source::Device { device_id, channel_start, channel_count } => capture::spawn(device_id, channel_start, channel_count, acc.clone(), stop.clone(), rep),
            Source::Stream { url } => stream::spawn(url, acc.clone(), stop.clone(), rep),
            Source::Tone { script } => tone::spawn(script, acc.clone(), stop.clone(), rep),
        }
        Input { cfg, acc, stop }
    }

    /// One batch: `{ id: { rms: [L, R], peak: [L, R] } }` for the inputs that delivered audio since the last tick.
    pub fn tick(&self) {
        let mut batch = Map::new();
        for i in self.inputs.lock().unwrap().iter() {
            if let Some(l) = i.acc.lock().unwrap().take_levels() {
                batch.insert(i.cfg.id.clone(), json!({"rms": l.rms, "peak": l.peak}));
            }
        }
        if !batch.is_empty() {
            (self.emit)(json!({"event":"levels","inputs":batch}));
        }
    }
}
