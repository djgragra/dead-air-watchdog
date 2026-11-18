//! Level conversions. Convention: dBFS (samples in -1..+1), plain RMS and sample peak, NOT a loudness measurement
//! (no K-weighting, no gating). A full-scale sine reads -3.01 dBFS RMS, a full-scale square wave 0 dBFS.
//! Same formula and same floor as the worklet of the previous engine (`10·log10(mean(x²))`, floor -120 dBFS).

pub const FLOOR_DB: f64 = -120.0;

pub fn mean_square_to_db(mean_square: f64) -> f64 {
    if !(mean_square > 1e-12) {
        return FLOOR_DB;
    }
    (10.0 * mean_square.log10()).max(FLOOR_DB)
}

/// Sums of squares and peaks of the two channels of an input over a measuring window. An input that is one single
/// channel (or mono audio) feeds the same sample to both sides, so both read the level of that channel.
#[derive(Debug, Default, Clone)]
pub struct Acc {
    pub sum_sq: [f64; 2],
    pub peak: [f32; 2],
    pub frames: u64,
    pub last_data: Option<std::time::Instant>,
}

/// What one window reports: RMS and peak of each of the two channels, in dBFS.
#[derive(Debug, Clone, PartialEq)]
pub struct Levels {
    pub rms: [f64; 2],
    pub peak: [f64; 2],
}

impl Acc {
    pub fn add_frame(&mut self, a: f32, b: f32) {
        self.sum_sq[0] += (a as f64) * (a as f64);
        self.sum_sq[1] += (b as f64) * (b as f64);
        self.peak[0] = self.peak[0].max(a.abs());
        self.peak[1] = self.peak[1].max(b.abs());
        self.frames += 1;
    }

    /// Adds `frames` frames of a signal whose mean square is `mean_square` (test sources).
    pub fn add_mean_square(&mut self, mean_square: f64, frames: u64) {
        self.sum_sq[0] += mean_square * frames as f64;
        self.sum_sq[1] += mean_square * frames as f64;
        let p = mean_square.sqrt() as f32;
        self.peak[0] = self.peak[0].max(p);
        self.peak[1] = self.peak[1].max(p);
        self.frames += frames;
    }

    /// Levels of the window and a fresh window, or `None` when no frame arrived.
    pub fn take_levels(&mut self) -> Option<Levels> {
        if self.frames == 0 {
            return None;
        }
        let n = self.frames as f64;
        let to_db = |p: f32| mean_square_to_db((p as f64) * (p as f64));
        let out = Levels {
            rms: [mean_square_to_db(self.sum_sq[0] / n), mean_square_to_db(self.sum_sq[1] / n)],
            peak: [to_db(self.peak[0]), to_db(self.peak[1])],
        };
        self.sum_sq = [0.0; 2];
        self.peak = [0.0; 2];
        self.frames = 0;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(peak_db: f64) -> Levels {
        let peak = 10f64.powf(peak_db / 20.0);
        let mut acc = Acc::default();
        for i in 0..48_000 {
            let x = (peak * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48_000.0).sin()) as f32;
            acc.add_frame(x, x);
        }
        acc.take_levels().unwrap()
    }

    // Same reference points as dev/level-worklet.test.js of the previous engine: theory is `peak - 3.0103`.
    #[test]
    fn sine_levels_match_theory() {
        for peak_db in [-6.0, -20.0, -40.0, -60.0] {
            let l = sine(peak_db);
            assert!((l.rms[0] - (peak_db - 3.0103)).abs() < 0.05, "{peak_db}: {}", l.rms[0]);
            assert!((l.peak[0] - peak_db).abs() < 0.05, "peak {peak_db}: {}", l.peak[0]);
            assert_eq!(l.rms[0], l.rms[1]);
        }
    }

    #[test]
    fn full_scale_square_is_zero_dbfs() {
        let mut acc = Acc::default();
        for i in 0..1000 {
            let v = if i % 2 == 0 { 1.0 } else { -1.0 };
            acc.add_frame(v, v);
        }
        let l = acc.take_levels().unwrap();
        assert!(l.rms[0].abs() < 1e-9 && l.peak[0].abs() < 1e-9);
    }

    #[test]
    fn digital_silence_is_the_floor_and_empty_window_is_none() {
        let mut acc = Acc::default();
        assert!(acc.take_levels().is_none());
        acc.add_frame(0.0, 0.0);
        let l = acc.take_levels().unwrap();
        assert_eq!((l.rms, l.peak), ([FLOOR_DB; 2], [FLOOR_DB; 2]));
        assert!(acc.take_levels().is_none(), "the window starts again");
    }

    #[test]
    fn the_two_channels_are_measured_apart() {
        let mut acc = Acc::default();
        for _ in 0..100 {
            acc.add_frame(0.5, 0.0);
        }
        let l = acc.take_levels().unwrap();
        assert!((l.rms[0] - (-6.0206)).abs() < 0.001);
        assert_eq!(l.rms[1], FLOOR_DB);
    }
}
