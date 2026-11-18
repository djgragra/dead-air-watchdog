//! Synthetic source for tests (`--test-sources`): plays a script of (ms, level) steps in real time, then keeps the last level.

use crate::engine::Reporter;
use crate::level::Acc;
use crate::protocol::ToneStep;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub fn spawn(script: Vec<ToneStep>, acc: Arc<Mutex<Acc>>, stop: Arc<AtomicBool>, _rep: Reporter) {
    std::thread::spawn(move || {
        let begin = Instant::now();
        let mut last_tick = begin;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
            let elapsed = begin.elapsed().as_millis() as u64;
            let mut at = 0u64;
            let mut db = script.last().map_or(-120.0, |s| s.db);
            for s in &script {
                if elapsed < at + s.ms {
                    db = s.db;
                    break;
                }
                at += s.ms;
            }
            let n = (last_tick.elapsed().as_secs_f64() * 48_000.0) as u64;
            last_tick = Instant::now();
            if let Ok(mut a) = acc.lock() {
                // the mean square of a sine of this RMS level, n frames at a time
                a.add_mean_square(10f64.powf(db / 10.0), n);
                a.last_data = Some(Instant::now());
            }
        }
    });
}
