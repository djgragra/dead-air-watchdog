//! Sound cards: list the devices that can record, and capture the level of one channel or one pair of channels.
//! The cpal stream lives on a thread of its own (it is not `Send` on every system). If the device cannot be opened,
//! or disappears, the input reports a fault and tries again by itself (2, 5, 10, 30 s).

use crate::engine::{sleep_unless_stopped, Reporter, RETRY_MS};
use crate::level::Acc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, SupportedStreamConfig};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A device that opens but sends no frame at all for this long is reported as a fault (it would read as plain silence).
const NODATA_MS: u64 = 3000;

/// On Linux the ALSA host lists every plugin of every card (front, surround, hdmi, dmix, ...). Only the ones that
/// make sense as an input for a person are shown: the system default, PulseAudio / PipeWire, and each card through its
/// "sysdefault" entry (which shares the card with the sound server instead of taking it).
fn worth_listing(id: &str) -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    let name = id.split_once(':').map_or(id, |(_, rest)| rest);
    name == "default" || name == "pulse" || name == "pipewire" || name.starts_with("sysdefault:")
}

pub fn list_devices() -> Vec<Value> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| d.id().ok()).map(|i| i.to_string());
    let mut out = Vec::new();
    let Ok(devices) = host.input_devices() else { return out };
    for d in devices {
        let Ok(id) = d.id() else { continue };
        let id = id.to_string();
        if !worth_listing(&id) {
            continue;
        }
        let Ok(default_cfg) = d.default_input_config() else { continue };
        let mut channels = default_cfg.channels() as usize;
        if let Ok(cfgs) = d.supported_input_configs() {
            for c in cfgs {
                channels = channels.max(c.channels() as usize);
            }
        }
        let name = d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| id.clone());
        out.push(json!({ "id": id, "name": name, "channels": channels, "default": Some(&id) == default_id.as_ref() }));
    }
    out
}

/// What the system says about a stream that is running. Some of it is only a remark and the stream goes on (a buffer
/// underrun or overrun that made a glitch, the route of the default device changing, a refused real-time priority); the rest
/// means that the stream is over and must be opened again. Until 0.6.2 every message ended the stream: on a Dante Virtual
/// Soundcard (log of the radio PC, 16 Nov) the system reported a glitch right after each start, the four inputs were closed and
/// opened again every two seconds, and the alarm went off.
pub fn is_fatal(kind: cpal::ErrorKind) -> bool {
    !matches!(kind, cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied)
}

/// A fault: the reason code the app knows, and a detail for the log.
type Fail = (&'static str, String);

fn find_device(host: &cpal::Host, device_id: &str) -> Result<cpal::Device, Fail> {
    if device_id.is_empty() {
        return host.default_input_device().ok_or(("NotFoundError", "There is no default audio input".into()));
    }
    let id: cpal::DeviceId = device_id.parse().map_err(|_| ("NotFoundError", format!("Not a device of this system: {device_id}")))?;
    host.device_by_id(&id).ok_or(("NotFoundError", "The audio device was not found".into()))
}

/// The format to open: the default of the device if it has enough channels, otherwise the smallest one that has them.
fn choose_config(device: &cpal::Device, needed: usize) -> Result<SupportedStreamConfig, Fail> {
    let default = device.default_input_config().map_err(|e| ("NotReadableError", format!("Cannot read the device format: {e}")))?;
    if default.channels() as usize >= needed {
        return Ok(default);
    }
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    if let Ok(cfgs) = device.supported_input_configs() {
        for c in cfgs {
            if (c.channels() as usize) < needed {
                continue;
            }
            if best.as_ref().map_or(true, |b| c.channels() < b.channels()) {
                best = Some(c);
            }
        }
    }
    match best {
        Some(r) => Ok(r.clone().try_with_sample_rate(default.sample_rate()).unwrap_or_else(|| r.with_max_sample_rate())),
        None => Err(("ChannelsUnavailable", format!("The device has {} channel(s), {needed} needed", default.channels()))),
    }
}

/// Opens the stream. The caller keeps it alive; `broken` turns true when the system reports an error on it.
fn open(device_id: &str, start: usize, count: usize, acc: &Arc<Mutex<Acc>>, broken: &Arc<AtomicBool>, why: &Arc<Mutex<String>>) -> Result<(cpal::Stream, String), Fail> {
    let host = cpal::default_host();
    let device = find_device(&host, device_id)?;
    let count = count.clamp(1, 2);
    let cfg = choose_config(&device, start + count)?;
    let channels = cfg.channels() as usize;
    let stream_cfg: cpal::StreamConfig = cfg.clone().into();
    let err_flag = broken.clone();
    let err_why = why.clone();
    let err_fn = move |e: cpal::Error| {
        if is_fatal(e.kind()) {
            if let Ok(mut w) = err_why.lock() {
                *w = format!("{:?}: {}", e.kind(), e.message().map_or_else(|| e.kind().to_string(), |m| m.to_string()));
            }
            err_flag.store(true, Ordering::Relaxed);
        }
    };
    macro_rules! build {
        ($t:ty) => {{
            let acc = acc.clone();
            device.build_input_stream(stream_cfg, move |data: &[$t], _: &_| feed(data, channels, start, count, &acc), err_fn, None)
        }};
    }
    let stream = match cfg.sample_format() {
        SampleFormat::F32 => build!(f32),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I8 => build!(i8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::F64 => build!(f64),
        other => return Err(("NotReadableError", format!("Sample format not supported: {other}"))),
    }
    .map_err(|e| ("NotReadableError", format!("Cannot open the device (in use by another program?): {e}")))?;
    stream.play().map_err(|e| ("NotReadableError", format!("Cannot start the device: {e}")))?;
    let name = device.description().map(|x| x.name().to_string()).unwrap_or_else(|_| device_id.to_string());
    let info = format!("{name}: {} Hz, {} channel(s), {:?}", cfg.sample_rate(), channels, cfg.sample_format());
    Ok((stream, info))
}

pub fn spawn(device_id: String, channel_start: usize, channel_count: usize, acc: Arc<Mutex<Acc>>, stop: Arc<AtomicBool>, rep: Reporter) {
    std::thread::spawn(move || {
        let mut attempts = 0usize;
        while !stop.load(Ordering::Relaxed) {
            let broken = Arc::new(AtomicBool::new(false));
            let why = Arc::new(Mutex::new(String::new()));
            if let Ok(mut a) = acc.lock() {
                a.last_data = None;
            }
            match open(&device_id, channel_start, channel_count, &acc, &broken, &why) {
                Ok((stream, info)) => {
                    rep.info(format!("device opened ({info})"));
                    attempts = 0;
                    let opened = Instant::now();
                    let mut silent_fault = false;
                    while !stop.load(Ordering::Relaxed) && !broken.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        // The device opened without error but the system delivers no audio at all (not even silence)
                        let delivering = acc.lock().map(|a| a.last_data.is_some()).unwrap_or(true);
                        if delivering {
                            rep.ok(); // says something only if there was a fault
                            silent_fault = false;
                        } else if !silent_fault && opened.elapsed() > Duration::from_millis(NODATA_MS) {
                            silent_fault = true;
                            rep.fault("device-nodata", format!("The device opened but delivers no audio after {} s ({info})", NODATA_MS / 1000));
                        }
                    }
                    drop(stream);
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let why = why.lock().map(|w| w.clone()).unwrap_or_default();
                    rep.fault("device-ended", format!("The audio device stopped delivering audio ({why})"));
                }
                Err((reason, detail)) => rep.fault(reason, detail),
            }
            let wait = RETRY_MS[attempts.min(RETRY_MS.len() - 1)];
            attempts += 1;
            if sleep_unless_stopped(&stop, wait) {
                return;
            }
        }
    });
}

fn feed<T>(data: &[T], channels: usize, start: usize, count: usize, acc: &Arc<Mutex<Acc>>)
where
    T: Sample,
    f32: cpal::FromSample<T>,
{
    let Ok(mut a) = acc.lock() else { return };
    for frame in data.chunks_exact(channels) {
        let l: f32 = frame[start].to_sample();
        let r: f32 = if count == 2 { frame[start + 1].to_sample() } else { l }; // one channel is heard on both sides
        a.add_frame(l, r);
    }
    a.last_data = Some(Instant::now());
}

#[cfg(test)]
mod tests {
    use super::is_fatal;
    use cpal::ErrorKind::*;

    #[test]
    fn a_glitch_or_a_route_change_does_not_end_the_stream_but_a_lost_device_does() {
        for k in [Xrun, DeviceChanged, RealtimeDenied] {
            assert!(!is_fatal(k), "{k:?} is only a remark");
        }
        for k in [DeviceNotAvailable, StreamInvalidated, HostUnavailable, BackendError, PermissionDenied, DeviceBusy, Other] {
            assert!(is_fatal(k), "{k:?} ends the stream");
        }
    }
}
