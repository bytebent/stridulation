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
  const FRAME_RATIO = 2.5, FRAME_Q = 3, COUPLING = 0.3;   // wing frame mode, its Q, frame–membrane coupling
  const OUT_GAIN = 0.17;

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
    { id: 'wings', def: 8, min: 0, max: 30, built: false },          // % left–right free detune
    { id: 'glide', def: -10, min: -30, max: 30, built: false },      // % bend by file position
    { id: 'nonlinear', def: 0.2, min: 0, max: 1, built: false },
    { id: 'second', def: 2, min: 1, max: 4, built: false },
    { id: 'secondlevel', def: -24, min: -48, max: 0, built: false },
    { id: 'body', def: 0, min: 0, max: 1, built: false },
    { id: 'bodytone', def: 1000, min: 300, max: 3000, log: true, built: false },
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
    { id: 'poly', def: 0, min: 0, max: 1, step: 1 },                 // Mono, Poly
    { id: 'glidetime', def: 0, min: 0, max: 2, built: false },
    { id: 'attack', def: 0.005, min: 0.001, max: 4, log: true, built: false },
    { id: 'release', def: 0.05, min: 0.001, max: 4, log: true, built: false },
    // Out
    { id: 'spread', def: 0.5, min: 0, max: 1, built: false },
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
  class Voice {
    constructor(e, seed) {
      this.e = e;
      this.seed = (seed >>> 0) || 1;
      this.pulse = new Float64Array(RING);
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
      // wing
      this.X = 0; this.Xv = 0; this.Y = 0; this.Yv = 0; this.Ylp = 0; this.env = 0; this.quiet = 0;
      this.pulse.fill(0); this.pw = 0;
    }
    rand() { this.rng = nextRand(this.rng); return this.rng / 4294967296; }

    setPitch(f0) {
      const e = this.e;
      this.f0 = clamp(f0, 20, 0.2 * e.srOS);
      const w0 = this.w0 = TWO_PI * this.f0, Q = e.c.ring;
      const w1 = FRAME_RATIO * w0, k1 = w1 * w1, kc = COUPLING * w0 * w0;
      this.k1 = k1; this.kc = kc; this.c1 = w1 / FRAME_Q;
      // place the lower (membrane) mode exactly on the carrier: (k1 + kc − w0²)(k2 + kc − w0²) = kc²
      this.k2 = kc * kc / (k1 + kc - w0 * w0) + w0 * w0 - kc;
      // membrane damping so the coupled mode itself has Q = Ring: modal damping
      // (c1·φX² + c2·φY²) / (φX² + φY²) = w0 / Q, with the mode shape φX/φY = kc / (k1 + kc − w0²)
      const r = kc / (k1 + kc - w0 * w0), rr = r * r;
      this.c2 = Math.max(1e-4 * w0, (w0 * (1 + rr) / Q - this.c1 * rr));
      this.gain = w0 * w0 / this.f0;                       // force (velocity units) → frame acceleration
      this.K = SPRING_K * w0;
      this.envDec = Math.exp(-this.f0 / (1.5 * e.srOS));
      this.lpA = 1 - Math.exp(-TWO_PI * this.f0 * 0.25 / e.srOS);   // static deflection follower, carrier / 4
      this.sub = Math.max(1, Math.ceil(w1 / e.srOS / 0.5));
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
      const k1 = this.k1, k2 = this.k2, kc = this.kc, c1 = this.c1, c2 = this.c2, gain = this.gain;
      const sub = this.sub, h = dt / sub, envDec = this.envDec;
      const Fm0 = c.speed * F0 * (0.7 + 0.3 * this.vel);
      const strokePeriod = e.srOS / c.rate, chirpPeriod = e.srOS / c.chirprate, chirpN = c.chirp;
      const tickGain = c.tick * 0.25 * c.toothSec * f0 / F0, outGain = OUT_GAIN / w0;
      const pulse = this.pulse;
      let { u, v, n, engaged, armed, justSkipped, X, Xv, Y, Yv, Ylp, env, sinceRel } = this;
      const soon = SKIP_SOON * e.srOS / f0;
      const lpA = this.lpA;
      let Yac = Y - Ylp;
      let peak = 0;
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
          const Fm = Fm0 * (1 + c.curve * 0.5 * (Math.sin(Math.PI * clamp(phi, 0, 1)) - 1));   // twitch: full force at mid-file
          const uPrev = u, loadPrev = this.load;
          if (engaged) v = (v + a * (Fm - K * (u - pos[n]))) / (1 + a + a * dt * K);
          else v = (v + a * Fm) / (1 + a);
          u += v * dt;
          const conf = env / (env + CONF_A0), ec = E * conf;
          // phase of the file's swing, advanced by one sample: Y is from the end of the previous step
          let th = Math.atan2(Yac, Yv / w0) + w0 * dt; if (th < 0) th += TWO_PI; if (th >= TWO_PI) th -= TWO_PI;
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
        // ---- wing: frame struck by the teeth, membrane radiates (RK4, force held over the sample) ----
        const pIdx = this.pw & (RING - 1), pf = pulse[pIdx]; pulse[pIdx] = 0; this.pw++;
        const F = gain * (fFile + pf);
        for (let s = 0; s < sub; s++) {
          const ax1 = F - c1 * Xv - k1 * X - kc * (X - Y), ay1 = -c2 * Yv - k2 * Y - kc * (Y - X);
          const X2 = X + 0.5 * h * Xv, Xv2 = Xv + 0.5 * h * ax1, Y2 = Y + 0.5 * h * Yv, Yv2 = Yv + 0.5 * h * ay1;
          const ax2 = F - c1 * Xv2 - k1 * X2 - kc * (X2 - Y2), ay2 = -c2 * Yv2 - k2 * Y2 - kc * (Y2 - X2);
          const X3 = X + 0.5 * h * Xv2, Xv3 = Xv + 0.5 * h * ax2, Y3 = Y + 0.5 * h * Yv2, Yv3 = Yv + 0.5 * h * ay2;
          const ax3 = F - c1 * Xv3 - k1 * X3 - kc * (X3 - Y3), ay3 = -c2 * Yv3 - k2 * Y3 - kc * (Y3 - X3);
          const X4 = X + h * Xv3, Xv4 = Xv + h * ax3, Y4 = Y + h * Yv3, Yv4 = Yv + h * ay3;
          const ax4 = F - c1 * Xv4 - k1 * X4 - kc * (X4 - Y4), ay4 = -c2 * Yv4 - k2 * Y4 - kc * (Y4 - X4);
          X += h / 6 * (Xv + 2 * Xv2 + 2 * Xv3 + Xv4); Xv += h / 6 * (ax1 + 2 * ax2 + 2 * ax3 + ax4);
          Y += h / 6 * (Yv + 2 * Yv2 + 2 * Yv3 + Yv4); Yv += h / 6 * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
        }
        // the escapement reads the file's vibration, not its steady deflection under load
        Ylp += lpA * (Y - Ylp); Yac = Y - Ylp;
        const ay = Math.abs(Yac);
        env = ay > env * envDec ? ay : env * envDec;
        if (!armed && Yac < ARM_AT * env) armed = true;
        if (E * env / (env + CONF_A0) < 0.05) armed = true;
        const out = outGain * Yv + tickGain * pf;
        oL[i] += out; oR[i] += out;
        const ao = out < 0 ? -out : out; if (ao > peak) peak = ao;
      }
      Object.assign(this, { u, v, n, engaged, armed, justSkipped, X, Xv, Y, Yv, Ylp, env, sinceRel });
      // a voice ends once released, not stroking, and quiet for a while
      if (!this.held && !this.stroking && peak < 1e-5) { if (++this.quiet > 8) { this.reset(); } } else this.quiet = 0;
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
      this.bendNorm = 0;
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
