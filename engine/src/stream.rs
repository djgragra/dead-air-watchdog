//! Icecast / Shoutcast / plain HTTP(S) audio streams: connect, decode (MP3, AAC in ADTS, Ogg Vorbis, FLAC) and
//! measure, with reconnection. No Chromium limits: every stream is a thread of the engine.
//! A connection that stops delivering without closing is abandoned after `STALL_SECS` and opened again.

use crate::engine::{sleep_unless_stopped, Reporter};
use crate::level::Acc;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use symphonia::core::audio::sample::Sample;
use std::sync::OnceLock;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::common::Tier;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;

/// Once it has played, a stream that delivers nothing for this long is reported as stalled; if it stays silent
/// for `GIVE_UP_SECS` the connection is dropped and opened again. A stream that has not delivered its first audio
/// yet gets `START_SECS` (some servers need 5-10 s).
const STALL_SECS: u64 = 4;
const GIVE_UP_SECS: u64 = 20;
const START_SECS: u64 = 20;

/// Waits before a stream is opened again (the first one is short: a stream that dropped should be back at once). Each wait
/// gets up to a quarter more, so that streams that fell together do not knock on the server all at the same moment.
const STREAM_RETRY_MS: [u64; 4] = [1000, 3000, 8000, 20_000];

/// Streams of one server that are all opened at the same moment can be refused (a 502 was seen from a shared Icecast
/// host when five were opened together): each one starts after its own small delay, from its address, 0 to 1.2 s.
fn start_delay_ms(url: &str) -> u64 {
    url.bytes().fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)) % 1200
}

/// A server delivers audio in bursts (an Ogg page holds a second, the start of an Icecast stream comes as a burst) and
/// something between the server and the PC can hand it over in lumps (128 KB every 5 s was seen on a radio PC). What is
/// measured is the audio of *now*, as a player would hear it: decoded frames wait in a queue and are measured at the speed
/// of real time, so a lump is played out whole and nothing is lost. Only if so much piles up that it can only be a server
/// that was stuck and catches up (`MAX_BACKLOG_SECS`), the oldest part is dropped and `KEEP_BACKLOG_SECS` are kept: the
/// monitor needs the present, not the past. (Until 0.6.1 the limit was 2 s: a lump of 5 s was cut to half a second, the
/// rest of the 5 s was taken for "no audio", and the stream went yellow and red every few seconds.)
const PREBUFFER_SECS: f64 = 0.25;
const MAX_BACKLOG_SECS: f64 = 20.0;
const KEEP_BACKLOG_SECS: f64 = 6.0;

#[derive(Default)]
struct Queue {
    frames: VecDeque<(f32, f32)>,
    rate: u32,
}

/// Feeds the queue into the level meter at the real-time rate until `cancel`.
fn pace(queue: Arc<Mutex<Queue>>, acc: Arc<Mutex<Acc>>, cancel: Arc<AtomicBool>) {
    let mut last = Instant::now();
    let mut credit = 0.0f64; // frames owed to the meter
    let mut primed = false;
    while !cancel.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64();
        last = now;
        let mut q = queue.lock().unwrap();
        let rate = q.rate.max(1) as f64;
        if !primed {
            if (q.frames.len() as f64) < PREBUFFER_SECS * rate {
                continue;
            }
            primed = true;
        }
        if q.frames.len() as f64 > MAX_BACKLOG_SECS * rate {
            let drop = q.frames.len() - (KEEP_BACKLOG_SECS * rate) as usize;
            q.frames.drain(..drop);
        }
        credit += dt * rate;
        let n = (credit as usize).min(q.frames.len());
        if n == 0 {
            if q.frames.is_empty() {
                credit = 0.0; // nothing to play: no catching up afterwards
            }
            continue;
        }
        credit -= n as f64;
        if q.frames.is_empty() {
            credit = 0.0;
        }
        let chunk: Vec<(f32, f32)> = q.frames.drain(..n).collect();
        drop(q);
        if let Ok(mut a) = acc.lock() {
            for (l, r) in chunk {
                a.add_frame(l, r);
            }
            a.last_data = Some(Instant::now());
        }
    }
}

/// The decoders: the ones symphonia has (MP3, AAC, Vorbis, FLAC) and Opus, from the pure-Rust `symphonia-opus`.
fn codecs() -> &'static CodecRegistry {
    static CODECS: OnceLock<CodecRegistry> = OnceLock::new();
    CODECS.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_audio_decoder_at_tier::<symphonia_opus::OpusDecoder>(Tier::Fallback);
        registry
    })
}

/// A network body as a symphonia media source (not seekable).
struct NetSource<R>(Mutex<R>, Arc<AtomicU64>); // the reader and the bytes it has read on this connection (for the faults)

impl<R: Read> Read for NetSource<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.get_mut().map_err(|_| std::io::Error::other("poisoned"))?.read(buf)?;
        self.1.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}
impl<R> Seek for NetSource<R> {
    fn seek(&mut self, _: SeekFrom) -> std::io::Result<u64> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "a live stream cannot seek"))
    }
}
impl<R: Read + Send> MediaSource for NetSource<R> {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

pub fn spawn(url: String, acc: Arc<Mutex<Acc>>, stop: Arc<AtomicBool>, rep: Reporter) {
    std::thread::spawn(move || {
        let mut attempts = 0usize;
        if sleep_unless_stopped(&stop, start_delay_ms(&url)) {
            return;
        }
        while !stop.load(Ordering::Relaxed) {
            let cancel = Arc::new(AtomicBool::new(false));
            let bytes = Arc::new(AtomicU64::new(0));
            let started = Arc::new(AtomicBool::new(false));
            let done: Arc<Mutex<Option<Result<(), (&'static str, String)>>>> = Arc::new(Mutex::new(None));
            if let Ok(mut a) = acc.lock() {
                a.last_data = None;
            }
            let began = Instant::now();
            {
                let (url, acc, cancel, started, done, bytes) = (url.clone(), acc.clone(), cancel.clone(), started.clone(), done.clone(), bytes.clone());
                std::thread::spawn(move || {
                    let r = run(&url, &acc, &cancel, &started, &bytes);
                    if let Ok(mut d) = done.lock() {
                        *d = Some(r);
                    }
                });
            }
            let (reason, detail) = loop {
                if stop.load(Ordering::Relaxed) {
                    cancel.store(true, Ordering::Relaxed);
                    return;
                }
                if let Some(r) = done.lock().ok().and_then(|d| d.clone()) {
                    break r.err().unwrap_or(("stream-ended", "The server closed the stream".into()));
                }
                let last = acc.lock().ok().and_then(|a| a.last_data);
                if started.load(Ordering::Relaxed) {
                    let quiet = last.map_or(Duration::ZERO, |l| l.elapsed());
                    if quiet > Duration::from_secs(GIVE_UP_SECS) {
                        cancel.store(true, Ordering::Relaxed); // the blocked thread is left behind; it ends when its read returns
                        break ("stream-stalled", format!("No audio for {} seconds; dropped after {} s on this connection, {} KB received", quiet.as_secs(), began.elapsed().as_secs(), bytes.load(Ordering::Relaxed) / 1024));
                    }
                    if quiet > Duration::from_secs(STALL_SECS) {
                        rep.fault("stream-stalled", format!("No audio for {} seconds ({} s on this connection, {} KB received)", quiet.as_secs(), began.elapsed().as_secs(), bytes.load(Ordering::Relaxed) / 1024));
                    } else if quiet < Duration::from_secs(1) {
                        rep.ok(); // audio is back
                    }
                } else if began.elapsed() > Duration::from_secs(START_SECS) {
                    cancel.store(true, Ordering::Relaxed);
                    break ("stream-nostart", format!("No audio after {START_SECS} seconds ({} KB received)", bytes.load(Ordering::Relaxed) / 1024));
                }
                std::thread::sleep(Duration::from_millis(250));
            };
            if began.elapsed() > Duration::from_secs(60) {
                attempts = 0;
            }
            rep.fault(reason, detail);
            let wait = STREAM_RETRY_MS[attempts.min(STREAM_RETRY_MS.len() - 1)];
            let wait = wait + wait / 4 * (began.elapsed().subsec_millis() as u64 % 100) / 100; // a little jitter
            attempts += 1;
            if sleep_unless_stopped(&stop, wait) {
                return;
            }
        }
    });
}

fn open(url: &str, family: ureq::config::IpFamily) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .ip_family(family)
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .user_agent("DeadAirWatchdog/0.2")
        .build()
        .into();
    agent.get(url).header("Icy-MetaData", "0").call()
}

fn run(url: &str, acc: &Arc<Mutex<Acc>>, cancel: &Arc<AtomicBool>, started: &Arc<AtomicBool>, bytes: &Arc<AtomicU64>) -> Result<(), (&'static str, String)> {
    let err = |m: String| ("stream-error", m);
    // IPv4 first: a PC that has an IPv6 address but no IPv6 route (usual in a studio network) would wait for the connection
    // to each IPv6 address of the server before trying IPv4. The family-free attempt follows only if IPv4 did not work.
    let t0 = Instant::now();
    let resp = match open(url, ureq::config::IpFamily::Ipv4Only) {
        Ok(r) => r,
        Err(first) => open(url, ureq::config::IpFamily::Any).map_err(|e| err(format!("Cannot connect: {e} (after {} ms; IPv4 only: {first})", t0.elapsed().as_millis())))?,
    };
    let mut hint = Hint::new();
    if let Some(ct) = resp.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        hint.mime_type(ct.split(';').next().unwrap_or(ct).trim());
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    if let Some(ext) = path.rsplit('.').next().filter(|e| e.len() <= 4 && !e.contains('/')) {
        hint.with_extension(ext);
    }
    let reader = resp.into_body().into_reader();
    let mss = MediaSourceStream::new(Box::new(NetSource(Mutex::new(reader), bytes.clone())), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| err(format!("Unknown or unsupported audio format ({e}). MP3, AAC (ADTS), Ogg Vorbis, Opus and FLAC are supported")))?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| err("The stream has no audio track".into()))?;
    let track_id = track.id;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or_else(|| err("The audio format is not supported".into()))?;
    let mut decoder = codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| err(format!("The audio codec is not supported: {e}")))?;

    let queue = Arc::new(Mutex::new(Queue::default()));
    {
        let (queue, acc, cancel) = (queue.clone(), acc.clone(), cancel.clone());
        std::thread::spawn(move || pace(queue, acc, cancel));
    }
    let mut samples: Vec<f32> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => return Err(("stream-ended", "The server closed the stream".into())),
            Err(e) => return Err(("stream-ended", format!("Read error: {e}"))),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let ch = buf.spec().channels().count().max(1);
                samples.resize(buf.samples_interleaved(), f32::MID);
                buf.copy_to_slice_interleaved(&mut samples);
                if cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                {
                    let mut q = queue.lock().unwrap();
                    q.rate = buf.spec().rate();
                    for frame in samples.chunks_exact(ch) {
                        q.frames.push_back((frame[0], if ch > 1 { frame[1] } else { frame[0] })); // mono is heard on both sides
                    }
                }
                started.store(true, Ordering::Relaxed);
            }
            Err(SymError::DecodeError(_)) => {} // a damaged frame: skip it
            Err(e) => return Err(err(format!("Decode error: {e}"))),
        }
    }
}
