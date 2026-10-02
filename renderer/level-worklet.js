// AudioWorklet: continuous RMS and peak per channel over 100 ms blocks, in dBFS.
// Every sample is counted (an AnalyserNode polled from a timer would skip most of them).
// The formula is the same as src/core/level.js; dev/level-worklet.test.js runs this very file
// against synthetic signals with known levels.
class LevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockFrames = Math.round(sampleRate * 0.1);
    this.channels = 2;
    this.reset();
  }

  reset() {
    this.frames = 0;
    this.sumSquares = new Float64Array(this.channels);
    this.peaks = new Float64Array(this.channels);
  }

  process(inputs) {
    const input = inputs[0];
    const quantum = input && input[0] ? input[0].length : 128;
    // No channels connected (e.g. stream not playing yet) is counted as digital silence.
    for (let c = 0; c < this.channels; c++) {
      const data = input && input[c];
      if (!data) continue;
      let sum = 0;
      let peak = this.peaks[c];
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      this.sumSquares[c] += sum;
      this.peaks[c] = peak;
    }
    this.frames += quantum;
    if (this.frames >= this.blockFrames) {
      const toDb = (x) => (x > 1e-12 ? Math.max(-120, 10 * Math.log10(x)) : -120);
      const rms = [];
      const peak = [];
      for (let c = 0; c < this.channels; c++) {
        rms.push(toDb(this.sumSquares[c] / this.frames));
        peak.push(toDb(this.peaks[c] * this.peaks[c]));
      }
      this.port.postMessage({ rms, peak });
      this.reset();
    }
    return true;
  }
}

registerProcessor('level-meter', LevelMeter);
