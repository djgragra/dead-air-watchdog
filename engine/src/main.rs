//! Dead Air Watchdog audio engine: opens sound cards and live streams and reports their levels.
//! Reads JSON commands (one per line) on stdin, writes JSON events on stdout.
//! When stdin closes (the app is gone) the engine ends: it never outlives the app.

mod capture;
mod engine;
mod level;
mod protocol;
mod stream;
mod tone;

use engine::Engine;
use protocol::Command;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("dead-air-engine {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let allow_test = args.iter().any(|a| a == "--test-sources");

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let emit: engine::Emit = {
        let out = out.clone();
        Arc::new(move |v: Value| {
            let mut o = out.lock().unwrap();
            if writeln!(o, "{v}").is_err() || o.flush().is_err() {
                std::process::exit(0); // nobody reads any more
            }
        })
    };
    let engine = Arc::new(Engine::new(emit.clone(), allow_test));

    let ready = move || json!({"event":"ready","engine":"dead-air-engine","version":env!("CARGO_PKG_VERSION"),"protocol":protocol::PROTOCOL,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"test_sources":allow_test});
    emit(ready());

    {
        let engine = engine.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            engine.tick();
        });
    }

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(&line) {
            Ok(Command::Hello) => emit(ready()),
            Ok(Command::ListDevices) => emit(json!({"event":"devices","devices":capture::list_devices()})),
            Ok(Command::Sync { inputs }) => engine.sync(inputs),
            Ok(Command::Stop) => engine.stop(),
            Ok(Command::Shutdown) => break,
            Err(e) => emit(json!({"event":"error","message":format!("Bad command: {e}")})),
        }
    }
    engine.stop();
}
