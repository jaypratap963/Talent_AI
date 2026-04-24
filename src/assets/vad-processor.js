/**
 * vad-processor.js — AudioWorkletProcessor
 *
 * Runs on the dedicated audio rendering thread (not main thread, not a worker).
 * Processes every 128-sample frame (~2.67ms at 16kHz, ~2.9ms at 44.1kHz).
 *
 * What it does:
 * - Computes RMS energy per frame
 * - Applies an envelope follower (attack fast, release slow)
 *   so brief silences inside a word don't drop the level
 * - Posts a message to main thread every N frames with:
 *   { rms, smoothedRms, isSpeech }
 *
 * Why this beats setInterval polling:
 * - Runs on audio thread — zero main thread jank or Angular CD interference
 * - Processes every single audio frame — no 80ms blind spots
 * - Envelope follower means a breath mid-sentence keeps level elevated
 */

class VADProcessor extends AudioWorkletProcessor {

  constructor() {
    super();

    // ── Envelope follower coefficients ────────────────────────
    // Attack: how fast level rises when voice starts (fast = responsive)
    // Release: how fast level falls when voice stops (SLOW = patience)
    // At 16kHz, 128 samples = 8ms per frame
    // attackCoeff  = 1 - e^(-1 / (attackMs  / 8)) ≈ fast rise
    // releaseCoeff = 1 - e^(-1 / (releaseMs / 8)) ≈ slow fall
    this._attackCoeff  = 0.40;   // ~20ms attack  — snappy voice detection
    this._releaseCoeff = 0.012;  // ~580ms release — holds level through breaths

    this._envelope = 0;          // Current smoothed envelope value (0–1)
    this._frameCount = 0;        // Total frames processed
    this._reportEvery = 4;       // Post to main thread every 4 frames (~32ms)

    // Speech/silence thresholds (normalised 0–1 RMS)
    // These are intentionally asymmetric (hysteresis):
    //   - Need higher level to START speaking detection
    //   - Need lower level to STOP (prevents rapid on/off toggling)
    this._onThreshold  = 0.018;  // RMS above this → speech
    this._offThreshold = 0.008;  // RMS below this → silence
    this._isSpeech = false;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array of 128 samples, range -1 to 1

    // ── Compute RMS of this frame ────────────────────────────
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length); // 0.0 → ~1.0

    // ── Envelope follower ────────────────────────────────────
    // Attack when signal rises, release when it falls
    // This means: if you take a breath mid-sentence, the envelope
    // stays elevated for ~580ms before dropping to silence level
    if (rms > this._envelope) {
      this._envelope += this._attackCoeff  * (rms - this._envelope);
    } else {
      this._envelope += this._releaseCoeff * (rms - this._envelope);
    }

    // ── Hysteresis state machine ─────────────────────────────
    // Use two thresholds to prevent rapid toggling at boundary
    if (!this._isSpeech && this._envelope > this._onThreshold) {
      this._isSpeech = true;
    } else if (this._isSpeech && this._envelope < this._offThreshold) {
      this._isSpeech = false;
    }

    // ── Report to main thread every _reportEvery frames ──────
    this._frameCount++;
    if (this._frameCount % this._reportEvery === 0) {
      this.port.postMessage({
        rms:         rms,
        envelope:    this._envelope,
        isSpeech:    this._isSpeech,
      });
    }

    return true; // Keep processor alive
  }
}

registerProcessor('vad-processor', VADProcessor);