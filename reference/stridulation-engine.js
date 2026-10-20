/*
 * stridulation engine v0.1 · bytebent
 *
 * An insect voice: a plectrum on a stiff spring is dragged across a file of teeth by a
 * muscle-driven wing. Each tooth it is caught on rings a wing resonator; the wing's swing can
 * feed back and time each release (the cricket's escapement).
 *
 *   - File: a table of tooth positions (units: tooth spacings at mid-file) and heights, from
 *     Teeth, Spacing, Jitter, Gaps, Height and the seed. Rebuilt off the sound path and swapped
 *     in at a stroke boundary.
 *   - Stroke: the wing is a light mass with damping pulled by a muscle force. Free, it runs at
 *     Speed × (carrier × mid-file spacing). Caught on a tooth, it loads the plectrum spring.
 *   - Contact (Bennet-Clark & Bailey 2002): a caught plectrum is released near the top of the
 *     file's swing (90°) once the escapement has re-armed (the file has swung down since the last
 *     release); a free plectrum arriving just after a release, while the file is still high,
 *     slides over one tooth. A hard enough push releases it at any phase. Escapement scales how
 *     much of this the wing controls: 0 is a cog rattle (teeth set the rate), 1 a clockwork (the
 *     wing sets the rate).
 *   - Wing (Sismondo 1993): a frame oscillator struck by the teeth, coupled to a tuned membrane
 *     that radiates. Linear in this version; the membrane mode is placed exactly on the carrier.
 *
 * Events (catch, release) are found between samples and written as raised-cosine force pulses of
 * width Tooth time. Everything runs at 4x the host rate in fixed 32-sample blocks and is
 * decimated with a windowed-sinc FIR, as in Dolphin. process() never allocates. Same seed, same
 * notes: same output, at any host buffer size.
 *
 * Works in an AudioWorklet and in Node (module.exports) for offline tests.
 */
(function (root) {
  'use strict';

  const OS = 4;                 // internal oversampling
  const BLOCK = 32;             // fixed internal block (host samples) = latency
  const FIR_LEN = 128;          // decimation filter taps (at 4x rate)
  const MAX_VOICES = 8;
  const MAX_TEETH = 400;
  const RING = 4096;            // force-pulse ring buffer (internal samples), power of two
  const TWO_PI = 2 * Math.PI;

  // contact model constants (tuned in batch 02; see tests.md)
  const WING_TAU = 0.094;       // wing mass / damping, in carrier cycles: light, so it stalls on a tooth without overshoot
  const SPRING_K = 4;           // plectrum spring stiffness, × 2π·carrier (per second, velocity units)
  const HOLD_MIN = 0.05;        // force to pass a tooth with no escapement (× Height × the muscle's push)
  const HOLD_ESC = 10;          // extra hold the escapement adds while the file is not at its release phase
  const REL_PHASE = Math.PI / 2;       // release near the top of the file's swing
  const REL_EARLY = 0.25, REL_LATE = 0.9;   // release window around it (rad)
  const SKIP_WIDTH = 100 * Math.PI / 180;   // a tooth met while the file is this far past its top is slid over...
  const SKIP_SOON = 0.5;        // ...if it comes within this many carrier cycles of the last release
  const ARM_AT = -0.3;          // the escapement re-arms once the file has swung this far down (× envelope)
  const CONF_A0 = 0.03;         // membrane amplitude at which the escapement is half effective
  const REG_Q0 = 5;             // membrane Q at which the wing is half able to act as a regulator
  const IMPACT_K = 0.5;         // catch pulse size (× impact speed / free speed at Speed 1, × one carrier period)
  const RELEASE_K = 0.15;       // release pulse size (× load / free force at Speed 1)
  const FRAME_RATIO = 2.5, COUPLING = 0.3;   // highest wing frame ratio (sets the RK4 step rule), frame–membrane coupling
  const OUT_GAIN = 0.17;
  const WING_LINK_ENGAGED = 0.6, WING_LINK_FREE = 0.02;   // membrane-to-membrane coupling (plectrum and file engaged, or not), × w²
  // frame stiffening (Sismondo 1993 used X⁵; he notes a cubic works as well): a cubic spring that
  // saturates, k1·Nonlinear·NL_A·X³ / (1 + NL_B·X²), at most +NL_A/NL_B of k1. A locked clockwork
  // swings the frame to about |X| 1.8, where Nonlinear 1 adds about 75% stiffness.
  const NL_A = 0.25, NL_B = 0.083;
  const KEEP_GAIN = 0.08, KEEP_RANGE = 0.7;   // pitch keeper: step per release and range (log of the tuning, ±1200 cents)
  const SECOND_IN = 0.076, BODY_IN = 2;   // Second at 0 dB and Body at 1 about as loud as the wing at 4.7 kHz (batch 04)
  const LOUD_PEAK = 0.6, LOUD_GUARD = 0.8;   // compensation keeps a voice's recent peak under 0.6, and any sample under 0.8
  const LOUD_TARGET = 0.2, LOUD_TAU = 0.04, LOUD_RANGE = 48 / 8.686, LOUD_SLEW = 0.05;   // rms while stroking, s, ±dB (as log), per block

  // ids, defaults and ranges: the one table the C++ core and the UI copy.
  // log: the knob moves logarithmically; step: whole steps; notches: knob detents (UI only).
  // built: false marks parameters the design has but this version doesn't use yet (see plan.md).
  const PARAMS = [
    // File
    { id: 'teeth', def: 120, min: 8, max: MAX_TEETH, step: 1 },
    { id: 'spacing', def: 0.4, min: -1, max: 1 },          // + = closer together at the start of the stroke
    { id: 'jitter', def: 0.05, min: 0, max: 0.3 },
    { id: 'gaps', def: 0, min: 0, max: 0.5 },              // fraction of missing teeth
    { id: 'height', def: 0.5, min: 0, max: 1 },            // how hard a tooth holds
    // Contact
    { id: 'escapement', def: 0.9, min: 0, max: 1, notches: [0, 1] },     // Cog rattle ↔ Clockwork
    { id: 'spring', def: 0.1, min: 0, max: 1, notches: [0, 0.8], built: false },
    { id: 'toothtime', def: 25, min: 10, max: 1000, log: true },        // µs, force pulse width
    { id: 'tick', def: 0.15, min: 0, max: 1 },
    // Wing
    { id: 'tune', def: 0, min: -24, max: 24 },             // semitones
    { id: 'ring', def: 25, min: 0.7, max: 60, log: true }, // membrane Q
    { id: 'wings', def: 8, min: 0, max: 30 },          // % left–right free detune
    { id: 'glide', def: -10, min: -30, max: 30 },      // % bend by file position
    { id: 'nonlinear', def: 0.2, min: 0, max: 1 },
    { id: 'frame', def: 0, min: 0, max: 1, step: 1, experimental: true },   // Normal, Close (sub-octave; see tests.md)
    { id: 'second', def: 2, min: 1, max: 4 },
    { id: 'secondlevel', def: -24, min: -48, max: 0 },
    { id: 'body', def: 0, min: 0, max: 1 },
    { id: 'bodytone', def: 1000, min: 300, max: 3000, log: true },
    // Stroke
    { id: 'speed', def: 2, min: 0.01, max: 8, log: true }, // 1 = free speed matched to the carrier at mid-file
    { id: 'curve', def: 0.5, min: 0, max: 1 },             // muscle twitch through the stroke
    { id: 'arc', def: 0.8, min: 0.1, max: 1 },             // share of the file one stroke uses
    { id: 'arcgrow', def: 0.3, min: 0, max: 1, built: false },
    { id: 'open', def: 0, min: 0, max: 1, built: false },
    { id: 'shape', def: 0, min: 0, max: 2, step: 1, built: false },  // Smooth, Steps, Vibrate
    { id: 'limbs', def: 0, min: 0, max: 1, step: 1, built: false },  // One, Two
    { id: 'lag', def: 0.1, min: 0, max: 0.5, built: false },
    { id: 'swap', def: 0.2, min: 0, max: 1, built: false },
    // Song
    { id: 'play', def: 0, min: 0, max: 1, step: 1, built: false },   // Song, Scrape
    { id: 'rate', def: 30, min: 0.5, max: 150, log: true },          // strokes per second within a chirp
    { id: 'chirp', def: 4, min: 0, max: 64, step: 1 },               // strokes per chirp, 0 = trill
    { id: 'chirprate', def: 2.5, min: 0.2, max: 10, log: true },
    { id: 'phrase', def: 0, min: 0, max: 60, built: false },
    { id: 'sync', def: 0, min: 0, max: 1, step: 1, built: false },
    { id: 'rubato', def: 0.1, min: 0, max: 1, built: false },
    // World
    { id: 'temperature', def: 25, min: 5, max: 40, built: false },
    { id: 'size', def: 1, min: 0.25, max: 4, log: true, built: false },
    { id: 'ultra', def: 1, min: 1, max: 16, log: true, built: false },
    { id: 'ultratime', def: 0.5, min: 0, max: 1, built: false },
    { id: 'keytrack', def: 1, min: 0, max: 1, step: 1 },
    // Voice
    { id: 'poly', def: 0, min: 0, max: 1, step: 1 },                 // Mono, Poly (8 voices)
    { id: 'pitchlock', def: 0, min: 0, max: 1, step: 1 },            // hold the pitch on the note
    { id: 'glidetime', def: 0, min: 0, max: 2, built: false },
    { id: 'attack', def: 0.005, min: 0.001, max: 4, log: true, built: false },
    { id: 'release', def: 0.05, min: 0.001, max: 4, log: true, built: false },
    // Out
    { id: 'spread', def: 0.5, min: 0, max: 1 },
    { id: 'loudness', def: 1, min: 0, max: 1 },            // loudness compensation amount
    { id: 'volume', def: 0, min: -48, max: 6 },            // dB
    { id: 'seed', def: 1, min: 1, max: 65535, step: 1 },
  ];
  const PINDEX = {};
  PARAMS.forEach((d, i) => { PINDEX[d.id] = i; });
  const FILE_PARAMS = ['teeth', 'spacing', 'jitter', 'gaps', 'height', 'seed'].map(id => PINDEX[id]);

  // knob position (0–1) ↔ value, as the UI's knobs move
  function toNorm(d, v) {
    if (d.log) return Math.log(v / d.min) / Math.log(d.max / d.min);
    return (v - d.min) / (d.max - d.min);
  }
  function fromNorm(d, n) {
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    let v = d.log ? d.min * Math.pow(d.max / d.min, n) : d.min + (d.max - d.min) * n;
    if (d.step) v = Math.round(v / d.step) * d.step;
    return v;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function makeFir() {
    const h = new Float32Array(FIR_LEN);
    const fc = 0.5 / OS * 0.92, M = (FIR_LEN - 1) / 2;
    let sum = 0;
    for (let n = 0; n < FIR_LEN; n++) {
      const x = n - M;
      const s = x === 0 ? 2 * fc : Math.sin(TWO_PI * fc * x) / (Math.PI * x);
      const a = TWO_PI * n / (FIR_LEN - 1);
      const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
      h[n] = s * w; sum += h[n];
    }
    for (let n = 0; n < FIR_LEN; n++) h[n] /= sum;
    return h;
  }

  // two-pole resonator y[n] = a1·y[n−1] − a2·y[n−2] + x at frequency f with quality Q, set in place
  function setRes(o, f, Q, fs) {
    f = Math.min(f, 0.45 * fs);
    const r = Math.exp(-Math.PI * f / (Q * fs)), th = TWO_PI * f / fs;
    o.a1 = 2 * r * Math.cos(th); o.a2 = r * r;
    // unit peak gain for the difference output (y[n] − y[n−1]) at f
    const re = 1 - o.a1 * Math.cos(th) + o.a2 * Math.cos(2 * th), im = o.a1 * Math.sin(th) - o.a2 * Math.sin(2 * th);
    o.norm = Math.sqrt(re * re + im * im) / (2 * Math.sin(th / 2));
  }

  // xorshift32
  function nextRand(state) { let x = state; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; return x >>> 0; }

  /* ---------- the file: tooth positions and heights ---------- */
  class FileTable {
    constructor() {
      this.pos = new Float64Array(MAX_TEETH);
      this.h = new Float64Array(MAX_TEETH);    // 0 = missing tooth
      this.n = 0; this.length = 0; this.users = 0;
    }
    build(teeth, spacing, jitter, gaps, seed) {
      const N = Math.round(clamp(teeth, 2, MAX_TEETH));
      let r = ((seed >>> 0) * 2654435761 + 0x1234567) >>> 0 || 1;
      const rnd = () => { r = nextRand(r); return r / 4294967296; };
      let x = 0;
      for (let i = 0; i < N; i++) {
        const w = 1 - spacing * 0.5 * (1 - 2 * i / (N - 1));    // linear gradient, 1 at mid-file
        const jit = jitter * 0.5 * w * (2 * rnd() - 1);
        this.pos[i] = x + jit;
        if (i > 0 && this.pos[i] < this.pos[i - 1] + 0.1) this.pos[i] = this.pos[i - 1] + 0.1;
        this.h[i] = (1 + jitter * (2 * rnd() - 1));
        if (gaps > 0 && i > 0 && i < N - 1 && rnd() < gaps) this.h[i] = 0;
        x += w;
      }
      this.n = N; this.length = this.pos[N - 1];
    }
  }

  /* ---------- one voice ---------- */
  // Wing modes scale with the wing's angular frequency w: k1 = KF·w², kc = KC·w², k2 = K2·w²,
  // c1 = GF·w, c2 = g2·w (g2 depends on Ring). Two wings: left (+Wings/2) and right (−Wings/2).
  // Frame (experimental switch): Normal puts the frame at 2.5 × the carrier, Q 3. Close puts it at
  // 1.25 ×, Q 8, with the stiffening scaled to |X| 0.3: Nonlinear then gives period doubling (a
  // sub-octave), but double speed slips and gaps stall (tests.md, batch 04).
  const KC = COUPLING;
  const FRAMES = [[2.5, 3, 1], [1.25, 8, 0.3]].map(([ratio, q, xs]) => {
    const KF = ratio * ratio, GF = ratio / q;
    return {
      KF, GF, ixs2: 1 / (xs * xs),
      K2: KC * KC / (KF + KC - 1) + 1 - KC,             // puts the lower (membrane) mode at w
      MODE_R: KC / (KF + KC - 1),                       // frame/membrane amplitude in that mode
    };
  });
  function membraneDamping(fr, Q) {                     // so the coupled mode has Q = Ring
    const rr = fr.MODE_R * fr.MODE_R;
    return Math.max(1e-4, (1 + rr) / Q - fr.GF * rr);
  }
  const smooth01 = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  class Voice {
    constructor(e, seed) {
      this.e = e;
      this.seed = (seed >>> 0) || 1;
      this.pulse = new Float64Array(RING);
      this.sec = { a1: 0, a2: 0, norm: 1 };
      this.reset();
    }
    reset() {
      this.rng = this.seed;
      this.stage = 0; this.held = false; this.note = -1; this.vel = 1; this.age = 0;
      this.f0 = 440; this.w0 = TWO_PI * 440;
      // stroke and contact
      this.file = null; this.stroking = false; this.u = 0; this.v = 0; this.uEnd = 0; this.uStart = 0;
      this.n = 0; this.engaged = false; this.armed = true; this.justSkipped = false; this.load = 0; this.sinceRel = 1e9;
      // song clock (internal samples)
      this.strokeTimer = 0; this.chirpTimer = 0; this.inChirp = 0; this.strokePending = false;
      // wings (left, right), second modes, body
      this.XL = 0; this.XvL = 0; this.YL = 0; this.YvL = 0;
      this.XR = 0; this.XvR = 0; this.YR = 0; this.YvR = 0;
      this.s1L = 0; this.s2L = 0; this.s1R = 0; this.s2R = 0;
      this.b1 = 0; this.b2 = 0; this.h1 = 0; this.h2 = 0;
      this.Ylp = 0; this.env = 0; this.quiet = 0;
      this.glide = 1;                         // wing tuning factor from the plectrum's place on the file
      // pitch keeper (log of the tuning correction) and loudness compensation (mean square, log gain)
      this.keep = 0; this.relLast = -1; this.relCount = 0;
      this.lgain = this.e.lastLoudGain; this.gainNow = 1; this.pkS = 0;
      this.ms = LOUD_TARGET * LOUD_TARGET * Math.exp(-2 * this.lgain);   // start from the last level heard: no jump
      this.pulse.fill(0); this.pw = 0; this.age2 = 0;
    }
    rand() { this.rng = nextRand(this.rng); return this.rng / 4294967296; }

    setPitch(f0) {
      const e = this.e;
      this.f0 = clamp(f0, 20, 0.2 * e.srOS);
      const w0 = this.w0 = TWO_PI * this.f0;
      this.gain = w0 * w0 / this.f0;                       // force (velocity units) → frame acceleration
      this.K = SPRING_K * w0;
      this.envDec = Math.exp(-this.f0 / (1.5 * e.srOS));
      this.lpA = 1 - Math.exp(-TWO_PI * this.f0 * 0.25 / e.srOS);   // static deflection follower, carrier / 4
      // RK4 sub-steps: 0.5 rad of the highest frame frequency per step (Wings, Glide, the keeper and Nonlinear raise it)
      this.sub = Math.max(1, Math.ceil(FRAME_RATIO * w0 * 1.6 * 2 / e.srOS / 0.5));   // ×2: a fully stiffened frame
    }

    noteOn(note, vel, f0) {
      if (this.stage === 0) { this.reset(); }
      this.stage = 1; this.held = true; this.note = note; this.vel = vel;
      this.age = this.e.ageCounter++;
      this.setPitch(f0);
      this.strokeTimer = 0; this.chirpTimer = 0; this.inChirp = 0;
    }
    noteOff() { this.held = false; }

    startStroke() {
      const e = this.e, f = e.file;
      if (this.file) this.file.users--;
      this.file = f; f.users++;
      const arc = e.c.arc, L = f.length;
      this.uStart = L * (1 - arc) * 0.5; this.uEnd = L * (1 + arc) * 0.5;
      this.u = this.uStart; this.v = 0;
      let n = 0; while (n < f.n && f.pos[n] < this.uStart) n++;
      this.n = n; this.engaged = false; this.justSkipped = false; this.armed = true;
      this.stroking = true; this.strokePending = false; this.load = 0;
      this.relLast = -1; this.relCount = 0;
      e.strokes++;
    }
    endStroke() {
      this.stroking = false; this.engaged = false; this.v = 0;
      if (this.file) { this.file.users--; this.file = null; }
    }

    // a raised-cosine force pulse of the given area, starting t0 internal samples after sample i
    writePulse(i, frac, area) {
      const e = this.e, w = e.c.pulseLen, pulse = this.pulse;
      // sample k (k ≥ i) covers time k; pulse runs from t0 = i − 1 + frac over w samples
      const t0 = i - 1 + frac;
      const kEnd = Math.ceil(t0 + w);
      const a = area * e.srOS / w;     // force, so the pulse delivers `area` (force × seconds)
      for (let k = i; k <= kEnd; k++) {
        const x = (k - t0) / w;
        if (x <= 0 || x >= 1) continue;
        pulse[(this.pw + k - i) & (RING - 1)] += a * (1 - Math.cos(TWO_PI * x));
      }
    }

    render(nOS, oL, oR) {
      const e = this.e, c = e.c, f0 = this.f0, F0 = f0;      // F0: free speed at Speed 1 (spacings/s)
      const dt = 1 / e.srOS, a = dt * f0 / WING_TAU;
      const E = c.escapement * (c.ring * c.ring / (c.ring * c.ring + REG_Q0 * REG_Q0)), hs = 2 * c.height, K = this.K, w0 = this.w0;
      const gain = this.gain, sub = this.sub, h = dt / sub, envDec = this.envDec;
      const fr = FRAMES[c.frame], KF = fr.KF, K2 = fr.K2, GF = fr.GF;
      const g2 = membraneDamping(fr, c.ring), nl = c.nonlinear * NL_A;
      const dL = 1 + 0.5 * c.wings, dR = 1 - 0.5 * c.wings;
      const glideAmt = c.glide, lock = c.pitchlock;
      const Fm0 = c.speed * F0 * (0.7 + 0.3 * this.vel);
      const strokePeriod = e.srOS / c.rate, chirpPeriod = e.srOS / c.chirprate, chirpN = c.chirp;
      const tickGain = c.tick * 0.25 * c.toothSec, outGain = OUT_GAIN / w0;
      // second mode per wing and the body: two-pole resonators, retuned per block
      const sOn = c.secondGain > 0, bOn = c.body > 0;
      const panL = 0.5 * (1 + c.spread), panR = 0.5 * (1 - c.spread);
      const pulse = this.pulse;
      let { u, v, n, engaged, armed, justSkipped, XL, XvL, YL, YvL, XR, XvR, YR, YvR, Ylp, env, sinceRel } = this;
      let { s1L, s2L, s1R, s2R, b1, b2, h1, h2, glide, keep } = this;
      const soon = SKIP_SOON * e.srOS / f0;
      const lpA = this.lpA;
      // the wing's tuning this block (glide and keeper move slowly; retune the extras once per block)
      let wf = w0 * glide * Math.exp(keep);
      const sec = this.sec; if (sOn) setRes(sec, c.second * wf / TWO_PI, Math.max(4, c.ring), e.srOS);
      const bodyLo = c.bodyLo, bodyHi = c.bodyHi;
      const secIn = SECOND_IN * OUT_GAIN * Math.max(4, c.ring) / f0 * sec.norm, bodyIn = BODY_IN * OUT_GAIN / f0 * Math.pow(f0 / 4700, 0.6);   // body level about the same at any carrier
      let Ym = 0.5 * (YL + YR), Yvm = 0.5 * (YvL + YvR), Yac = Ym - Ylp;
      let peak = 0, sumsq = 0, nStroke = 0, peakStroke = 0;
      const guard = c.loudness > 0;
      for (let i = 0; i < nOS; i++) {
        // ---- song clock ----
        if (this.held) {
          if (chirpN > 0) {
            if (--this.chirpTimer <= 0) { this.chirpTimer += chirpPeriod; this.inChirp = 0; this.strokeTimer = 0; }
            if (this.inChirp < chirpN && --this.strokeTimer <= 0) {
              this.strokeTimer += strokePeriod; this.inChirp++;
              if (this.stroking) this.strokePending = true; else { this.startStroke(); u = this.u; v = 0; n = this.n; engaged = false; armed = true; justSkipped = false; }
            }
          } else if (--this.strokeTimer <= 0) {
            this.strokeTimer += strokePeriod;
            if (this.stroking) this.strokePending = true; else { this.startStroke(); u = this.u; v = 0; n = this.n; engaged = false; armed = true; justSkipped = false; }
          }
        }
        // ---- stroke: the wing, pulled by the muscle, held back by a caught plectrum ----
        let fFile = 0, catchFrac = -1;
        if (this.stroking) {
          const file = this.file, pos = file.pos, ht = file.h;
          const phi = (u - this.uStart) / (this.uEnd - this.uStart);
          // glide: the wing is tuned by where the plectrum is on the file (Bennet-Clark 2003)
          glide = 1 + glideAmt * smooth01((u / file.length - 0.5) * 2);
          wf = w0 * glide * Math.exp(keep);
          const Fm = Fm0 * Math.exp(keep) * glide * (1 + c.curve * 0.5 * (Math.sin(Math.PI * clamp(phi, 0, 1)) - 1));   // twitch: full force at mid-file
          const uPrev = u, loadPrev = this.load;
          if (engaged) v = (v + a * (Fm - K * (u - pos[n]))) / (1 + a + a * dt * K);
          else v = (v + a * Fm) / (1 + a);
          u += v * dt;
          const conf = env / (env + CONF_A0), ec = E * conf;
          // phase of the file's swing, advanced by one sample: Y is from the end of the previous step
          let th = Math.atan2(Yac, Yvm / wf) + wf * dt; if (th < 0) th += TWO_PI; if (th >= TWO_PI) th -= TWO_PI;
          if (!engaged) {
            while (n < file.n && ht[n] === 0 && pos[n] <= u) n++;      // missing teeth pass silently
            if (n < file.n && u >= pos[n]) {
              const frac = clamp((pos[n] - uPrev) / (u - uPrev), 0, 1);
              const skip = !justSkipped && sinceRel < soon && ec > 0 && th > REL_PHASE && th < REL_PHASE + SKIP_WIDTH * ec;
              if (skip) {
                justSkipped = true; n++;
                if (e.rec) e.rec.push({ t: (e.osTime + i - 1 + frac) / e.srOS, type: 'skip', pos: pos[n - 1], v });
              } else {
                justSkipped = false; engaged = true; catchFrac = frac;
                this.writePulse(i, frac, IMPACT_K * ht[n] * v / f0);
                if (e.rec) e.rec.push({ t: (e.osTime + i - 1 + frac) / e.srOS, type: 'catch', pos: pos[n], v });
                e.catches++;
              }
            }
          }
          if (engaged) {
            const load = K * (u - pos[n]);
            const inWin = th > REL_PHASE - REL_EARLY && th < REL_PHASE + REL_LATE;
            const hold = hs * ht[n] * (HOLD_MIN * Fm + ((ec > 0.05 && inWin && armed) ? 0 : HOLD_ESC * ec * F0));
            if (load > hold) {
              const lp = loadPrev > 0 ? loadPrev : 0;
              const frac = Math.max(catchFrac, load > lp ? clamp((hold - lp) / (load - lp), 0, 1) : 1);
              this.writePulse(i, frac, RELEASE_K * load / f0);
              if (e.rec) e.rec.push({ t: (e.osTime + i - 1 + frac) / e.srOS, type: 'release', pos: pos[n], v });
              // pitch keeper: one release per sounding cycle; nudge the tuning toward the note
              const tRel = this.age2 + i - 1 + frac;
              if (lock && this.relLast >= 0 && ++this.relCount > 3) {
                // the last release-to-release interval, in periods of the note (as glided)
                const per = (tRel - this.relLast) * w0 * glide / (TWO_PI * e.srOS);
                if (per > 0.5 && per < 2) keep = clamp(keep + KEEP_GAIN * Math.log(per), -KEEP_RANGE, KEEP_RANGE);
              }
              this.relLast = tRel;
              engaged = false; armed = false; n++; sinceRel = 0;
              this.load = 0;
            } else { this.load = load; fFile = load; }
          } else this.load = 0;
          if (u >= this.uEnd || n >= file.n) {
            this.u = u; this.endStroke(); engaged = false; this.load = 0;
            if (this.strokePending && this.held) { this.startStroke(); u = this.u; v = 0; n = this.n; armed = true; justSkipped = false; }
          }
        }
        sinceRel++;
        // ---- wings: frames struck by the teeth, membranes radiate (RK4, force held over the sample) ----
        const pIdx = this.pw & (RING - 1), pf = pulse[pIdx]; pulse[pIdx] = 0; this.pw++;
        const F = gain * (fFile + pf);
        {
          const wl = wf * dL, wr = wf * dR, wl2 = wl * wl, wr2 = wr * wr;
          const k1l = KF * wl2, kcl = KC * wl2, k2l = K2 * wl2, c1l = GF * wl, c2l = g2 * wl, nll = nl * k1l;
          const k1r = KF * wr2, kcr = KC * wr2, k2r = K2 * wr2, c1r = GF * wr, c2r = g2 * wr, nlr = nl * k1r;
          // the two membranes are joined through the plectrum and file: strongly while engaged
          const kw = (engaged ? WING_LINK_ENGAGED : WING_LINK_FREE) * wf * wf, ixs2 = fr.ixs2;
          for (let s = 0; s < sub; s++) {
            let x2, p2;
            // stage 1
            x2 = XL * XL * ixs2; p2 = XR * XR * ixs2;
            const ax1 = F - c1l * XvL - k1l * XL - nll * x2 * XL / (1 + NL_B * x2) - kcl * (XL - YL), ay1 = -c2l * YvL - k2l * YL - kcl * (YL - XL) - kw * (YL - YR);
            const bx1 = F - c1r * XvR - k1r * XR - nlr * p2 * XR / (1 + NL_B * p2) - kcr * (XR - YR), by1 = -c2r * YvR - k2r * YR - kcr * (YR - XR) - kw * (YR - YL);
            // stage 2
            const X2 = XL + 0.5 * h * XvL, Xv2 = XvL + 0.5 * h * ax1, Y2 = YL + 0.5 * h * YvL, Yv2 = YvL + 0.5 * h * ay1;
            const P2 = XR + 0.5 * h * XvR, Pv2 = XvR + 0.5 * h * bx1, Q2 = YR + 0.5 * h * YvR, Qv2 = YvR + 0.5 * h * by1;
            x2 = X2 * X2 * ixs2; p2 = P2 * P2 * ixs2;
            const ax2 = F - c1l * Xv2 - k1l * X2 - nll * x2 * X2 / (1 + NL_B * x2) - kcl * (X2 - Y2), ay2 = -c2l * Yv2 - k2l * Y2 - kcl * (Y2 - X2) - kw * (Y2 - Q2);
            const bx2 = F - c1r * Pv2 - k1r * P2 - nlr * p2 * P2 / (1 + NL_B * p2) - kcr * (P2 - Q2), by2 = -c2r * Qv2 - k2r * Q2 - kcr * (Q2 - P2) - kw * (Q2 - Y2);
            // stage 3
            const X3 = XL + 0.5 * h * Xv2, Xv3 = XvL + 0.5 * h * ax2, Y3 = YL + 0.5 * h * Yv2, Yv3 = YvL + 0.5 * h * ay2;
            const P3 = XR + 0.5 * h * Pv2, Pv3 = XvR + 0.5 * h * bx2, Q3 = YR + 0.5 * h * Qv2, Qv3 = YvR + 0.5 * h * by2;
            x2 = X3 * X3 * ixs2; p2 = P3 * P3 * ixs2;
            const ax3 = F - c1l * Xv3 - k1l * X3 - nll * x2 * X3 / (1 + NL_B * x2) - kcl * (X3 - Y3), ay3 = -c2l * Yv3 - k2l * Y3 - kcl * (Y3 - X3) - kw * (Y3 - Q3);
            const bx3 = F - c1r * Pv3 - k1r * P3 - nlr * p2 * P3 / (1 + NL_B * p2) - kcr * (P3 - Q3), by3 = -c2r * Qv3 - k2r * Q3 - kcr * (Q3 - P3) - kw * (Q3 - Y3);
            // stage 4
            const X4 = XL + h * Xv3, Xv4 = XvL + h * ax3, Y4 = YL + h * Yv3, Yv4 = YvL + h * ay3;
            const P4 = XR + h * Pv3, Pv4 = XvR + h * bx3, Q4 = YR + h * Qv3, Qv4 = YvR + h * by3;
            x2 = X4 * X4 * ixs2; p2 = P4 * P4 * ixs2;
            const ax4 = F - c1l * Xv4 - k1l * X4 - nll * x2 * X4 / (1 + NL_B * x2) - kcl * (X4 - Y4), ay4 = -c2l * Yv4 - k2l * Y4 - kcl * (Y4 - X4) - kw * (Y4 - Q4);
            const bx4 = F - c1r * Pv4 - k1r * P4 - nlr * p2 * P4 / (1 + NL_B * p2) - kcr * (P4 - Q4), by4 = -c2r * Qv4 - k2r * Q4 - kcr * (Q4 - P4) - kw * (Q4 - Y4);
            const h6 = h / 6;
            XL += h6 * (XvL + 2 * Xv2 + 2 * Xv3 + Xv4); YL += h6 * (YvL + 2 * Yv2 + 2 * Yv3 + Yv4);
            XvL += h6 * (ax1 + 2 * ax2 + 2 * ax3 + ax4); YvL += h6 * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
            XR += h6 * (XvR + 2 * Pv2 + 2 * Pv3 + Pv4); YR += h6 * (YvR + 2 * Qv2 + 2 * Qv3 + Qv4);
            XvR += h6 * (bx1 + 2 * bx2 + 2 * bx3 + bx4); YvR += h6 * (by1 + 2 * by2 + 2 * by3 + by4);
          }
        }
        // the escapement reads both wings' vibration (their mean), not their steady deflection under load
        Ym = 0.5 * (YL + YR); Yvm = 0.5 * (YvL + YvR);
        Ylp += lpA * (Ym - Ylp); Yac = Ym - Ylp;
        const ay = Math.abs(Yac);
        env = ay > env * envDec ? ay : env * envDec;
        if (!armed && Yac < ARM_AT * env) armed = true;
        if (E * env / (env + CONF_A0) < 0.05) armed = true;
        let outL = outGain * YvL, outR = outGain * YvR;
        // second mode on each wing, driven by the same force
        if (sOn) {
          // a resonator of unit peak gain fed like the wing: force × Q × OUT_GAIN / f0 matches the wing at resonance
          const xin = (F / gain) * secIn;
          const nl1 = sec.a1 * s1L - sec.a2 * s2L + xin; s2L = s1L; s1L = nl1;
          const nr1 = sec.a1 * s1R - sec.a2 * s2R + xin; s2R = s1R; s1R = nr1;
          outL += c.secondGain * (s1L - s2L); outR += c.secondGain * (s1R - s2R);
        }
        let mono = tickGain * pf;
        // body: low-Q ringing of the whole insect, struck by the teeth only (Masters et al. 1983)
        if (bOn) {
          const xin = pf * bodyIn;
          const lo = bodyLo.a1 * b1 - bodyLo.a2 * b2 + xin * bodyLo.norm; b2 = b1; b1 = lo;
          const hi = bodyHi.a1 * h1 - bodyHi.a2 * h2 + xin * bodyHi.norm; h2 = h1; h1 = hi;
          mono += c.body * ((b1 - b2) + 0.7 * (h1 - h2));
        }
        outL += mono; outR += mono;
        const oLs = panL * outL + panR * outR, oRs = panR * outL + panL * outR;
        if (this.stroking) {
          sumsq += 0.5 * (oLs * oLs + oRs * oRs); nStroke++;
          const am = Math.max(oLs < 0 ? -oLs : oLs, oRs < 0 ? -oRs : oRs); if (am > peakStroke) peakStroke = am;
        }
        // compensation also guards peaks at once (a voice's first moments, before it has adapted)
        if (guard) { const am = Math.max(oLs < 0 ? -oLs : oLs, oRs < 0 ? -oRs : oRs) * this.gainNow; if (am > LOUD_GUARD) this.gainNow *= LOUD_GUARD / am; }
        oL[i] += oLs * this.gainNow; oR[i] += oRs * this.gainNow;
        const ao = oLs < 0 ? -oLs : oLs; if (ao > peak) peak = ao;
      }
      this.age2 += nOS;
      Object.assign(this, { u, v, n, engaged, armed, justSkipped, XL, XvL, YL, YvL, XR, XvR, YR, YvR, Ylp, env, sinceRel });
      Object.assign(this, { s1L, s2L, s1R, s2R, b1, b2, h1, h2, glide, keep });
      if (!lock) this.keep = 0;
      // loudness compensation: mean square while stroking (time constant LOUD_TAU of stroking time),
      // gain toward LOUD_TARGET, ±LOUD_RANGE dB; velocity then sets the level explicitly
      if (nStroke > 0) {
        const aMs = 1 - Math.exp(-nStroke / (LOUD_TAU * e.srOS));
        this.ms += aMs * (sumsq / nStroke - this.ms);
        this.pkS = Math.max(peakStroke, this.pkS * 0.995);
        if (this.ms > 1e-14) {
          let want = clamp(0.5 * Math.log(LOUD_TARGET * LOUD_TARGET / this.ms), -LOUD_RANGE, LOUD_RANGE);
          if (this.pkS > 1e-12) want = Math.min(want, Math.log(LOUD_PEAK / this.pkS));   // spiky sounds: peaks first
          this.lgain = want; e.lastLoudGain = want;
        }
      }
      const amt = c.loudness, velAmp = 0.25 + 0.75 * this.vel;
      const target = Math.exp(amt * (this.lgain + Math.log(velAmp)));
      this.gainNow += (target - this.gainNow) * LOUD_SLEW;
      // a voice ends once released, not stroking, and quiet for a while
      if (!this.held && !this.stroking && peak < 1e-6) { if (++this.quiet > 8) { this.reset(); } } else this.quiet = 0;
    }
  }

  /* ---------- the engine ---------- */
  class StridulationEngine {
    constructor(sampleRate, seed) {
      this.sr = sampleRate; this.srOS = sampleRate * OS;
      this.p = new Float64Array(PARAMS.length);
      PARAMS.forEach((d, i) => { this.p[i] = d.def; });
      if (seed !== undefined) this.p[PINDEX.seed] = clamp(Math.round(seed) || 1, 1, 65535);
      this.c = {};                                          // derived controls, updated per block
      this.fir = makeFir();
      this.histL = new Float32Array(FIR_LEN * 2); this.histR = new Float32Array(FIR_LEN * 2); this.hw = 0;
      this.osL = new Float32Array(BLOCK * OS); this.osR = new Float32Array(BLOCK * OS);
      this.blkL = new Float32Array(BLOCK); this.blkR = new Float32Array(BLOCK); this.blkPos = BLOCK;
      this.dc = { xl: 0, yl: 0, xr: 0, yr: 0, R: 1 - TWO_PI * 10 / sampleRate };
      this.files = [new FileTable(), new FileTable()]; this.fileIdx = 0;
      this.fileKey = new Float64Array(FILE_PARAMS.length).fill(NaN); this.fileDirty = true;
      this.osTime = 0; this.ageCounter = 0; this.quietBlocks = 0;
      this.catches = 0; this.strokes = 0; this.rec = null;      // counters; set rec = [] to record events (tests)
      this.bendNorm = 0; this.lastLoudGain = 0;
      const base = (this.p[PINDEX.seed] * 0x9e3779b9) >>> 0 || 1;
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(this, (base + i * 0x6d2b79f5) >>> 0));
      this.updateControls();
      this.file = this.files[this.fileIdx];
      this.info = { voices: 0 };
    }

    static get LATENCY() { return BLOCK; }
    static get PARAMS() { return PARAMS; }

    setParam(id, v) {
      const i = PINDEX[id];
      if (i === undefined || !Number.isFinite(v)) return;
      const d = PARAMS[i];
      v = clamp(v, d.min, d.max);
      if (d.step) v = Math.round(v / d.step) * d.step;
      this.p[i] = v;
      if (id === 'poly') this.allNotesOff();
    }
    getParam(id) { return this.p[PINDEX[id]]; }
    setBend(norm) { this.bendNorm = clamp(norm, -1, 1); }       // ±2 semitones

    noteFreq(note) {
      const P = this.p;
      const st = P[PINDEX.tune] + 2 * this.bendNorm;
      const base = P[PINDEX.keytrack] >= 0.5 ? 440 * Math.pow(2, (note - 69) / 12) : 4700;
      return base * Math.pow(2, st / 12);
    }
    noteOn(note, vel) {
      if (vel <= 0) { this.noteOff(note); return; }
      const v01 = clamp(vel / 127, 0, 1), f0 = this.noteFreq(note);
      if (this.p[PINDEX.poly] < 0.5) { this.voices[0].noteOn(note, v01, f0); return; }
      let pick = this.voices.find(x => x.stage === 0);
      if (!pick) pick = this.voices.reduce((o, x) => (x.age < o.age ? x : o));
      pick.noteOn(note, v01, f0);
    }
    noteOff(note) {
      for (const v of this.voices) if (v.stage !== 0 && v.note === note) v.noteOff();
    }
    allNotesOff() { for (const v of this.voices) v.reset(); }

    updateControls() {
      const P = this.p, c = this.c;
      c.escapement = P[PINDEX.escapement]; c.height = P[PINDEX.height];
      c.toothSec = P[PINDEX.toothtime] * 1e-6;
      c.pulseLen = Math.max(2.5, c.toothSec * this.srOS);    // internal samples
      c.tick = P[PINDEX.tick]; c.ring = P[PINDEX.ring];
      c.nonlinear = P[PINDEX.nonlinear]; c.wings = P[PINDEX.wings] / 100; c.glide = P[PINDEX.glide] / 100;
      c.second = P[PINDEX.second]; c.frame = P[PINDEX.frame] >= 0.5 ? 1 : 0;
      c.secondGain = P[PINDEX.secondlevel] <= -48 ? 0 : Math.pow(10, P[PINDEX.secondlevel] / 20);
      c.body = P[PINDEX.body]; c.spread = P[PINDEX.spread];
      if (!c.bodyLo) { c.bodyLo = { a1: 0, a2: 0, norm: 1 }; c.bodyHi = { a1: 0, a2: 0, norm: 1 }; }
      setRes(c.bodyLo, P[PINDEX.bodytone], 3, this.srOS); setRes(c.bodyHi, 10 * P[PINDEX.bodytone], 2, this.srOS);
      c.pitchlock = P[PINDEX.pitchlock] >= 0.5; c.loudness = P[PINDEX.loudness];
      c.speed = P[PINDEX.speed]; c.curve = P[PINDEX.curve]; c.arc = P[PINDEX.arc];
      c.rate = P[PINDEX.rate]; c.chirp = Math.round(P[PINDEX.chirp]); c.chirprate = P[PINDEX.chirprate];
      this.vol = Math.pow(10, P[PINDEX.volume] / 20);
      // file: rebuild into the spare table when its parameters change and no voice is using it
      let changed = false;
      for (let k = 0; k < FILE_PARAMS.length; k++) if (this.fileKey[k] !== P[FILE_PARAMS[k]]) changed = true;
      if (changed) this.fileDirty = true;
      if (this.fileDirty) {
        const spare = this.files[this.fileIdx ^ 1];
        if (spare.users === 0) {
          spare.build(P[PINDEX.teeth], P[PINDEX.spacing], P[PINDEX.jitter], P[PINDEX.gaps], P[PINDEX.seed]);
          this.fileIdx ^= 1; this.file = spare; this.fileDirty = false;
          for (let k = 0; k < FILE_PARAMS.length; k++) this.fileKey[k] = P[FILE_PARAMS[k]];
        }
      }
      // pitch and Q follow live (tune, ring, bend)
      for (const v of this.voices) if (v.stage !== 0) v.setPitch(this.noteFreq(v.note) || v.f0);
    }

    processBlock() {
      this.updateControls();
      const nOS = BLOCK * OS, oL = this.osL, oR = this.osR;
      oL.fill(0); oR.fill(0);
      let count = 0;
      for (const v of this.voices) if (v.stage !== 0) { v.render(nOS, oL, oR); count++; }
      this.osTime += nOS;
      this.info.voices = count;
      const d = this.dc;
      if (count === 0 && this.quietBlocks > 0 && Math.abs(d.yl) < 1e-12 && Math.abs(d.yr) < 1e-12 && Math.abs(d.xl) < 1e-12 && Math.abs(d.xr) < 1e-12) {
        this.blkL.fill(0); this.blkR.fill(0); d.xl = d.yl = d.xr = d.yr = 0;
        return;
      }
      this.quietBlocks = count === 0 ? this.quietBlocks + 1 : 0;
      // decimate (FIR, symmetric: half the multiplies) both channels, DC block, volume, clip
      const L = FIR_LEN, H = FIR_LEN / 2, h = this.fir, hl = this.histL, hr = this.histR, vol = this.vol;
      let hw = this.hw;
      for (let j = 0, o = 0; j < BLOCK; j++) {
        for (let q = 0; q < OS; q++, o++) {
          hl[hw] = hl[hw + L] = oL[o];
          hr[hw] = hr[hw + L] = oR[o];
          hw = hw + 1 === L ? 0 : hw + 1;
        }
        let al = 0, ar = 0;
        for (let t = 0, u = hw + L - 1; t < H; t++, u--) { const cc = h[t], aa = hw + t; al += cc * (hl[aa] + hl[u]); ar += cc * (hr[aa] + hr[u]); }
        const yl = al - d.xl + d.R * d.yl; d.xl = al; d.yl = yl;
        const yr = ar - d.xr + d.R * d.yr; d.xr = ar; d.yr = yr;
        const sl = yl * vol, sr = yr * vol;
        this.blkL[j] = sl > 1 ? 1 : sl < -1 ? -1 : sl;
        this.blkR[j] = sr > 1 ? 1 : sr < -1 ? -1 : sr;
      }
      this.hw = hw;
      if (Math.abs(d.yl) < 1e-20) d.yl = 0;
      if (Math.abs(d.yr) < 1e-20) d.yr = 0;
    }

    // host calls with any n; work happens in fixed BLOCK chunks
    process(outL, outR, n) {
      let pos = this.blkPos;
      for (let j = 0; j < n; j++) {
        if (pos === BLOCK) { this.processBlock(); pos = 0; }
        outL[j] = this.blkL[pos];
        if (outR) outR[j] = this.blkR[pos];
        pos++;
      }
      this.blkPos = pos;
    }
  }

  StridulationEngine.BLOCK = BLOCK; StridulationEngine.OS = OS;
  StridulationEngine.toNorm = toNorm; StridulationEngine.fromNorm = fromNorm;
  if (typeof module !== 'undefined' && module.exports) module.exports = { StridulationEngine, PARAMS };
  else root.StridulationEngine = StridulationEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
