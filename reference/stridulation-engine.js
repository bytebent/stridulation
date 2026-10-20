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
  // spring: burst slows to SPRING_R of its start before it lodges; the hold is SPRING_S × the
  // teeth per burst of driver stretch (sets the first catch: about 10 ms for D. valens)
  const SPRING_R = 0.75, SPRING_S = 0.4;
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
    { id: 'spring', def: 0, min: 0, max: 1, notches: [0, 0.8] },
    { id: 'toothtime', def: 25, min: 10, max: 1000, log: true },        // µs, force pulse width
    { id: 'tick', def: 0.15, min: 0, max: 1 },
    // Wing
    { id: 'tune', def: 0, min: -48, max: 48 },             // semitones
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
    { id: 'arcgrow', def: 0.3, min: 0, max: 1 },
    { id: 'open', def: 0, min: 0, max: 1 },
    { id: 'shape', def: 0, min: 0, max: 2, step: 1 },  // Smooth, Steps, Vibrate
    { id: 'limbs', def: 0, min: 0, max: 1, step: 1 },  // One, Two
    { id: 'lag', def: 0.1, min: 0, max: 0.5 },
    { id: 'swap', def: 0.2, min: 0, max: 1 },             // chance per chirp that the legs trade patterns
    { id: 'legb', def: 0.5, min: 0, max: 1 },             // how different Leg B's pattern is (force, a pause)
    // Song
    { id: 'play', def: 0, min: 0, max: 1, step: 1 },   // Song, Scrape
    { id: 'rate', def: 30, min: 0.5, max: 150, log: true },          // strokes per second within a chirp
    { id: 'chirp', def: 4, min: 0, max: 64, step: 1 },               // strokes per chirp, 0 = trill
    { id: 'chirprate', def: 2.5, min: 0.2, max: 10, log: true },
    { id: 'phrase', def: 0, min: 0, max: 60 },            // s of song, 0 = endless
    { id: 'pause', def: 0, min: 0, max: 60 },             // s of silence between phrases
    { id: 'sync', def: 0, min: 0, max: 1, step: 1 },
    { id: 'rubato', def: 0.1, min: 0, max: 1 },
    // World
    { id: 'temperature', def: 25, min: 5, max: 40 },
    { id: 'size', def: 1, min: 0.25, max: 4, log: true },
    { id: 'ultra', def: 1, min: 1, max: 16, log: true },
    { id: 'ultratime', def: 0.5, min: 0, max: 1 },
    { id: 'keytrack', def: 1, min: 0, max: 1, step: 1 },
    // Voice
    { id: 'poly', def: 0, min: 0, max: 1, step: 1 },                 // Mono, Poly (8 voices)
    { id: 'pitchlock', def: 0, min: 0, max: 1, step: 1 },            // hold the pitch on the note
    { id: 'glidetime', def: 0, min: 0, max: 2 },
    { id: 'attack', def: 0.001, min: 0.001, max: 4, log: true },
    { id: 'release', def: 0.001, min: 0.001, max: 4, log: true },
    // Out
    { id: 'spread', def: 0.5, min: 0, max: 1 },
    { id: 'loudness', def: 1, min: 0, max: 1 },            // loudness compensation amount
    { id: 'volume', def: 0, min: -48, max: 6 },            // dB
    { id: 'seed', def: 1, min: 1, max: 65535, step: 1 },
  ];
  // what an LFO may move: every continuous knob that doesn't rebuild the file
  const MOD_TARGETS = ['escapement', 'spring', 'toothtime', 'tick', 'tune', 'ring', 'wings', 'glide', 'nonlinear', 'second', 'secondlevel',
    'body', 'bodytone', 'speed', 'curve', 'arc', 'arcgrow', 'open', 'lag', 'legb', 'rate', 'chirprate', 'rubato', 'temperature',
    'ultratime', 'attack', 'release', 'glidetime', 'spread', 'loudness', 'volume'];
  const NUM_LFOS = 4;
  const LFO_SHAPES = ['Sine', 'Triangle', 'Ramp up', 'Ramp down', 'Square', 'Random step', 'Random smooth'];
  // synced lengths in beats: 8 bars … 1/32, with triplets (LFOs and chirps)
  const LFO_DIVS = [32, 16, 8, 4, 2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
  const SYNC_DIVS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];   // strokes per beat
  for (let n = 1; n <= NUM_LFOS; n++) {
    PARAMS.push(
      { id: 'lfo' + n + 'target', def: 0, min: 0, max: MOD_TARGETS.length, step: 1 },   // 0 = none (dormant)
      { id: 'lfo' + n + 'shape', def: 0, min: 0, max: LFO_SHAPES.length - 1, step: 1 },
      { id: 'lfo' + n + 'rate', def: 0.5, min: 0.02, max: 40, log: true },              // Hz (free)
      { id: 'lfo' + n + 'sync', def: 0, min: 0, max: 1, step: 1 },
      { id: 'lfo' + n + 'from', def: 0, min: 0, max: 1 },                               // share of the target's range
      { id: 'lfo' + n + 'to', def: 1, min: 0, max: 1 },
      { id: 'lfo' + n + 'retrig', def: 0, min: 0, max: 1, step: 1 });                   // 0 free, 1 restart on note
  }
  const PINDEX = {};
  PARAMS.forEach((d, i) => { PINDEX[d.id] = i; });
  const TARGET_INDEX = MOD_TARGETS.map(id => PINDEX[id]);
  function nearestDiv(list, want) {
    let best = list[0], bd = Infinity;
    for (const b of list) { const dd = Math.abs(Math.log(b / want)); if (dd < bd) { bd = dd; best = b; } }
    return best;
  }
  const FILE_PARAMS = ['teeth', 'spacing', 'jitter', 'gaps', 'height', 'seed', 'size', 'keytrack'].map(id => PINDEX[id]);

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
      this.posR = new Float64Array(MAX_TEETH); this.hR = new Float64Array(MAX_TEETH);   // the same file, back to front (opening strokes)
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
      for (let i = 0; i < N; i++) { this.posR[i] = this.length - this.pos[N - 1 - i]; this.hR[i] = this.h[N - 1 - i]; }
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
  const OPEN_FORCE = 0.4;       // the opening stroke is pulled more gently (O. viridulus: upstroke ~3× slower, Elsner 1974)
  const SWELL_END = 0.02;       // after note-off the song stops once the swell is this low
  const FOLLOW_RATE = 300;      // Scrape follow: the plectrum chases the wheel with this rate (1/s)
  const LEGB_FORCE = 0.35, LEGB_PAUSE = 0.4;   // Leg B at 1: force −35%, and a pause of 40% of the stroke early on

  /* ---------- one limb: a plectrum drawn over the file ---------- */
  // One limb drives both wings. With two limbs (grasshoppers), limb A drives the left wing and
  // limb B the right, each read by its own escapement.
  class Limb {
    constructor(voice, idx) {
      this.voice = voice; this.idx = idx;
      this.pulse = new Float64Array(RING);
      this.reset();
    }
    reset() {
      this.file = null; this.stroking = false; this.dir = 1;
      this.u = 0; this.v = 0; this.uEnd = 0; this.uStart = 0; this.d = 0; this.v0 = 0; this.bRate = 0;
      this.n = 0; this.engaged = false; this.armed = true; this.justSkipped = false; this.load = 0; this.sinceRel = 1e9;
      this.relLast = -1; this.relCount = 0;
      this.Ylp = 0; this.env = 0; this.Yac = 0; this.Yvm = 0;    // what its escapement reads of its wing
      this.pulse.fill(0); this.pw = 0;
      // the stroke now and the next one queued: arc share, force share, pattern (0 A, 1 B), opening first?
      this.arcF = 1; this.forceF = 1; this.pat = 0; this.swellStart = 1; this.tStroke = 0; this.tNom = 1;
      this.pend = false; this.pArcF = 1; this.pForceF = 1; this.pPat = 0; this.closeNext = false;
      this.delay = -1; this.dArcF = 1; this.dForceF = 1; this.dPat = 0;   // a trigger waiting for Lag
      this.follow = false; this.fTarget = 0;                              // Scrape: chasing the wheel
    }
    // ask for a stroke (opening first when Open > 0); queued if one is running
    trigger(arcF, forceF, pat) {
      if (this.stroking) { this.pend = true; this.pArcF = arcF; this.pForceF = forceF; this.pPat = pat; return; }
      this.begin(arcF, forceF, pat);
    }
    begin(arcF, forceF, pat) {
      const v = this.voice, e = v.e;
      this.arcF = arcF; this.forceF = forceF; this.pat = pat;
      if (e.c.open > 0) { this.closeNext = true; this.startStroke(-1); }
      else { this.closeNext = false; this.startStroke(1); }
    }
    startStroke(dir) {
      const v = this.voice, e = v.e, f = e.file, c = e.c;
      if (this.file) this.file.users--;
      this.file = f; f.users++;
      const arcMax = clamp(c.arc * c.arcScale, Math.min(1, 2.5 / f.length), 1), L = f.length;
      const arc = Math.max(Math.min(1, 2.5 / f.length), arcMax * this.arcF);
      // later pulses of a chirp use more of the file, from the start side (Bennet-Clark & Bailey 2002)
      const end = L * (1 + arcMax) * 0.5, start = end - arc * L;
      this.dir = dir;
      if (dir > 0) { this.uStart = start; this.uEnd = end; }
      else { this.uStart = L - end; this.uEnd = L - start; }   // reversed coordinates: back along the file
      const pos = dir > 0 ? f.pos : f.posR;
      this.u = this.uStart; this.v = 0; this.d = this.uStart; this.v0 = 0;
      let n = 0; while (n < f.n && pos[n] < this.uStart) n++;
      this.n = n; this.engaged = false; this.justSkipped = false; this.armed = true;
      this.stroking = true; this.load = 0; this.tStroke = 0;
      this.relLast = -1; this.relCount = 0;
      this.swellStart = v.swell;
      this.tNom = Math.max(1, (this.uEnd - this.uStart) / Math.max(1e-9, c.speed * v.f0) * e.srOS);   // nominal stroke length (samples)
      if (dir > 0) e.strokes++;
    }
    endStroke() {
      this.stroking = false; this.engaged = false; this.v = 0; this.load = 0;
      if (this.file) { this.file.users--; this.file = null; }
      if (this.closeNext) { this.closeNext = false; this.startStroke(1); return; }
      if (this.pend && (this.voice.held || this.voice.swell > SWELL_END)) { this.pend = false; this.begin(this.pArcF, this.pForceF, this.pPat); }
      else this.pend = false;
    }
    // a raised-cosine force pulse of the given area, starting t0 internal samples after sample i
    writePulse(i, frac, area) {
      const e = this.voice.e, w = e.c.pulseLen, pulse = this.pulse;
      const t0 = i - 1 + frac, kEnd = Math.ceil(t0 + w), a = area * e.srOS / w;
      for (let k = i; k <= kEnd; k++) {
        const x = (k - t0) / w;
        if (x <= 0 || x >= 1) continue;
        pulse[(this.pw + k - i) & (RING - 1)] += a * (1 - Math.cos(TWO_PI * x));
      }
    }
    rec(i, frac, type) {
      const e = this.voice.e;
      if (e.rec) e.rec.push({ t: (e.osTime + i - 1 + frac) / e.srOS, type, pos: this.dir > 0 ? this.file.pos[this.n] : this.file.length - this.file.posR[this.n], v: this.v, limb: this.idx, dir: this.dir });
    }

    // one internal sample of the stroke; returns the static force the caught plectrum puts on the file
    step(i, k) {
      if (this.delay >= 0 && --this.delay < 0) this.trigger(this.dArcF, this.dForceF, this.dPat);
      if (this.follow) return this.stepFollow(i, k);
      if (!this.stroking) return 0;
      const v = this.voice, e = v.e, c = e.c, file = this.file, dir = this.dir;
      const pos = dir > 0 ? file.pos : file.posR, ht = dir > 0 ? file.h : file.hR;
      const f0 = k.f0, F0 = f0, dt = k.dt;
      let { u, n, engaged } = this, vel = this.v;
      const phi = clamp((u - this.uStart) / (this.uEnd - this.uStart), 0, 1);
      this.tStroke++;
      // glide: the wing is tuned by where the plectrum is on the file (Bennet-Clark 2003); the lead limb sets it
      const uReal = dir > 0 ? u : file.length - u;
      if (this.idx === 0 || !v.limbs[0].stroking) { v.glide = 1 + k.glideAmt * smooth01((uReal / file.length - 0.5) * 2); v.wf = k.w0 * v.glide * Math.exp(v.keep); }
      // muscle force: speed, velocity, temperature, wheel and pressure, twitch, Shape, swell, arc growth, pattern
      let Fm = k.Fm0 * Math.exp(v.keep) * v.glide * (1 + k.curve * 0.5 * (Math.sin(Math.PI * phi) - 1));
      if (k.shape === 1) Fm *= 0.1 + 1.8 * Math.pow(Math.sin(3 * Math.PI * phi), 2);          // Steps: three jerks per stroke
      else if (k.shape === 2) Fm *= 1 + 0.85 * Math.sin(TWO_PI * 12 * phi);                   // Vibrate: a shiver along the stroke
      Fm *= (v.held ? v.swell : this.swellStart) * this.forceF;
      if (this.pat === 1) {
        Fm *= 1 - LEGB_FORCE * c.legb;
        const t = this.tStroke / this.tNom;
        if (t > 0.15 && t < 0.15 + LEGB_PAUSE * c.legb) Fm *= 0.02;                           // Leg B's pause (Elsner 1974, pattern II)
      }
      if (dir < 0) Fm *= OPEN_FORCE;
      let fFile = 0, catchFrac = -1;
      const level = dir > 0 ? 1 : c.open;                       // the opening stroke sounds at Open
      const E = dir > 0 ? k.E : 0, springOn = dir > 0 && k.springOn;
      if (!springOn) {
        const a = k.a, K = k.K, uPrev = u, loadPrev = this.load;
        if (engaged) vel = (vel + a * (Fm - K * (u - pos[n]))) / (1 + a + a * dt * K);
        else vel = (vel + a * Fm) / (1 + a);
        u += vel * dt;
        const ec = E * this.env / (this.env + CONF_A0), wf = v.wf;
        // phase of the file's swing, advanced by one sample: Y is from the end of the previous step
        let th = Math.atan2(this.Yac, this.Yvm / wf) + wf * dt; if (th < 0) th += TWO_PI; if (th >= TWO_PI) th -= TWO_PI;
        if (!engaged) {
          while (n < file.n && ht[n] === 0 && pos[n] <= u) n++;      // missing teeth pass silently
          if (n < file.n && u >= pos[n]) {
            const frac = clamp((pos[n] - uPrev) / (u - uPrev), 0, 1);
            const skip = !this.justSkipped && this.sinceRel < k.soon && ec > 0 && th > REL_PHASE && th < REL_PHASE + SKIP_WIDTH * ec;
            if (skip) {
              this.justSkipped = true; this.n = n; this.v = vel; this.rec(i, frac, 'skip'); n++;
            } else {
              this.justSkipped = false; engaged = true; catchFrac = frac;
              this.writePulse(i, frac, level * IMPACT_K * ht[n] * vel / f0);
              this.n = n; this.v = vel; this.rec(i, frac, 'catch'); e.catches++;
            }
          }
        }
        if (engaged) {
          const load = K * (u - pos[n]);
          const inWin = th > REL_PHASE - REL_EARLY && th < REL_PHASE + REL_LATE;
          const hold = k.hs * ht[n] * (HOLD_MIN * Fm + ((ec > 0.05 && inWin && this.armed) ? 0 : HOLD_ESC * ec * F0));
          if (load > hold) {
            const lp = loadPrev > 0 ? loadPrev : 0;
            const frac = Math.max(catchFrac, load > lp ? clamp((hold - lp) / (load - lp), 0, 1) : 1);
            this.writePulse(i, frac, level * RELEASE_K * load / f0);
            this.n = n; this.v = vel; this.rec(i, frac, 'release');
            // pitch keeper (lead limb, closing strokes): one release per sounding cycle; nudge the tuning toward the note
            if (this.idx === 0 && dir > 0) {
              const tRel = v.age2 + i - 1 + frac;
              if (k.lock && this.relLast >= 0 && ++this.relCount > 3) {
                const per = (tRel - this.relLast) * k.w0 * v.glide / (TWO_PI * e.srOS);
                if (per > 0.5 && per < 2) v.keep = clamp(v.keep + KEEP_GAIN * Math.log(per), -KEEP_RANGE, KEEP_RANGE);
              }
              this.relLast = tRel;
            }
            engaged = false; this.armed = false; n++; this.sinceRel = 0;
            this.load = 0;
          } else { this.load = load; fFile = load; }
        } else this.load = 0;
      } else {
        // ---- spring (Lindeman & Yack 2019): the driver moves on at a slow speed; the plectrum
        // lodges on a tooth until the stretch reaches its hold, then slips over several teeth at
        // speed (starting at Fm, slowing as the spring unloads) and lodges again ----
        const vd = k.springSlow * Fm, nb = k.springNb;
        const dPrev = this.d; this.d += vd * dt;
        if (engaged) {
          const thr = SPRING_S * nb * k.hs * ht[n], st = this.d - u;
          if (st >= thr) {
            const frac = clamp((thr - (dPrev - u)) / (vd * dt), 0, 1);
            this.writePulse(i, frac, RELEASE_K * Fm / f0);
            this.n = n; this.v = Fm; this.rec(i, frac, 'release');
            engaged = false; n++; vel = Fm; this.v0 = Fm; this.sinceRel = 0;
            // burst decay rate so the plectrum covers about nb teeth before it slows to SPRING_R
            const x = (SPRING_R * Fm - vd) / (Fm - vd);
            this.bRate = x > 0 ? (vd * Math.log(1 / x) + (Fm - vd) * (1 - x)) / nb : (Fm - vd) / nb;
          }
        }
        if (!engaged) {
          const uPrev = u;
          if (vel < vd) vel = vd;                               // the plectrum moves with the driver at least
          if (this.v0 === 0) { this.v0 = Fm; this.bRate = 0; }   // stroke start: it lodges on the first tooth
          vel = vd + (vel - vd) * (1 - dt * this.bRate);
          const rF = SPRING_R * this.v0;                        // lodges once slowed to SPRING_R of its start
          u += vel * dt;
          while (n < file.n && u >= pos[n]) {
            if (ht[n] === 0) { n++; continue; }
            const frac = clamp((pos[n] - uPrev) / (u - uPrev), 0, 1);
            this.writePulse(i, frac, IMPACT_K * ht[n] * vel / f0);
            e.catches++; this.n = n; this.v = vel;
            if (vel < rF) { u = pos[n]; engaged = true; this.rec(i, frac, 'catch'); break; }   // slow enough: it lodges here
            this.rec(i, frac, 'strike');
            n++;
          }
        }
        this.load = 0;
      }
      this.u = u; this.v = vel; this.n = n; this.engaged = engaged;
      this.sinceRel++;
      // the stroke ends at the end of its arc, at the end of the file, or when the muscle has let go
      if (u >= this.uEnd || n >= file.n || (!v.held && this.swellStart * k.swellNow < SWELL_END * 0.5 && Fm < 1e-3 * F0)) this.endStroke();
      return fFile;
    }

    // Scrape with the wheel: the plectrum follows the wheel along the file, both ways; every tooth
    // it crosses strikes, forward at full level and backward at Open (a guiro)
    stepFollow(i, k) {
      const v = this.voice, e = v.e, file = this.file || e.file, dt = k.dt;
      if (!this.file) { this.file = file; file.users++; this.u = file.length * 0.5; this.n = 0; while (this.n < file.n && file.pos[this.n] < this.u) this.n++; }
      const pos = file.pos, ht = file.h, f0 = k.f0;
      const L = file.length, arcMax = clamp(e.c.arc * e.c.arcScale, Math.min(1, 2.5 / L), 1);
      const target = L * (1 - arcMax) * 0.5 + this.fTarget * arcMax * L;
      const uPrev = this.u;
      let vel = FOLLOW_RATE * (target - uPrev);
      const vmax = 4 * k.Fm0 + 10 * f0; if (vel > vmax) vel = vmax; if (vel < -vmax) vel = -vmax;
      const u = uPrev + vel * dt;
      let n = this.n;
      while (n < file.n && u >= pos[n] && uPrev < pos[n]) {
        if (ht[n] > 0) { const frac = clamp((pos[n] - uPrev) / (u - uPrev), 0, 1); this.writePulse(i, frac, IMPACT_K * ht[n] * vel / f0); this.n = n; this.v = vel; this.dir = 1; this.rec(i, frac, 'strike'); e.catches++; }
        n++;
      }
      while (n > 0 && u < pos[n - 1] && uPrev >= pos[n - 1]) {
        n--;
        if (ht[n] > 0 && e.c.open > 0) { const frac = clamp((uPrev - pos[n]) / (uPrev - u), 0, 1); this.writePulse(i, frac, e.c.open * IMPACT_K * ht[n] * (-vel) / f0); this.v = vel; e.catches++; }
      }
      this.u = u; this.v = vel; this.n = n;
      const uReal = u;
      v.glide = 1 + k.glideAmt * smooth01((uReal / L - 0.5) * 2); v.wf = k.w0 * v.glide;
      return 0;
    }
    stopFollow() { this.follow = false; if (this.file && !this.stroking) { this.file.users--; this.file = null; } }
  }

  class Voice {
    constructor(e, seed) {
      this.e = e;
      this.seed = (seed >>> 0) || 1;
      this.limbs = [new Limb(this, 0), new Limb(this, 1)];
      this.sec = { a1: 0, a2: 0, norm: 1 };
      this.reset();
    }
    reset() {
      this.rng = this.seed;
      this.stage = 0; this.held = false; this.note = -1; this.vel = 1; this.age = 0;
      this.f0 = 440; this.w0 = TWO_PI * 440; this.logF = Math.log2(440); this.logT = this.logF;
      for (const l of this.limbs) l.reset();
      // song clock (internal samples)
      this.strokeTimer = 0; this.chirpTimer = 0; this.inChirp = 0; this.phraseT = 0; this.chirpIdx = 0;
      this.swapNow = 0; this.gridChirp = -1; this.gridStroke = -1; this.swell = 0;
      // wings (left, right), second modes, body
      this.XL = 0; this.XvL = 0; this.YL = 0; this.YvL = 0;
      this.XR = 0; this.XvR = 0; this.YR = 0; this.YvR = 0;
      this.s1L = 0; this.s2L = 0; this.s1R = 0; this.s2R = 0;
      this.b1 = 0; this.b2 = 0; this.h1 = 0; this.h2 = 0;
      this.quiet = 0;
      this.glide = 1; this.wf = this.w0;     // wing tuning from the plectrum's place on the file
      // pitch keeper (log of the tuning correction) and loudness compensation (mean square, log gain)
      this.keep = 0;
      this.lgain = this.e.lastLoudGain; this.gainNow = 1; this.pkS = 0;
      this.ms = LOUD_TARGET * LOUD_TARGET * Math.exp(-2 * this.lgain);   // start from the last level heard: no jump
      this.age2 = 0; this.wheel0 = 0;
    }
    rand() { this.rng = nextRand(this.rng); return this.rng / 4294967296; }
    get stroking() { return this.limbs[0].stroking || this.limbs[1].stroking || this.limbs[0].follow; }

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

    noteOn(note, vel, f0, legato) {
      const e = this.e;
      if (this.stage === 0) this.reset();
      this.note = note; this.vel = vel; this.logT = Math.log2(f0);
      if (legato && this.stage !== 0 && this.held) return;          // Mono legato: glide to the new note, the song goes on
      if (this.stage === 0) { this.logF = this.logT; this.setPitch(f0); }
      else if (e.c.glidetime <= 0) { this.logF = this.logT; this.setPitch(f0); }
      this.stage = 1; this.held = true;
      this.age = e.ageCounter++;
      this.strokeTimer = 0; this.chirpTimer = 0; this.inChirp = 0; this.phraseT = 0; this.gridChirp = -1; this.gridStroke = -1;
      this.wheel0 = e.wheel; this.limbs[0].stopFollow();
      if (Math.round(e.m[PINDEX.play]) === 1) { e.c.play = 1; e.c.open = e.m[PINDEX.open]; this.triggerStroke(0, 0); }   // Scrape: one stroke per note
    }
    noteOff() { this.held = false; this.limbs[0].stopFollow(); }

    // a stroke for each limb: index k of N in its chirp (N 0 = a trill), with Arc growth and the patterns
    triggerStroke(k, N, strokeSamples) {
      const c = this.e.c;
      const g = N > 1 ? 1 - c.arcgrow * (1 - k / (N - 1)) : 1;
      const arcF = 1 - 0.6 * (1 - g), forceF = 1 - 0.3 * (1 - g);
      const swap = this.swapNow;
      this.limbs[0].trigger(arcF, forceF, swap ? 1 : 0);
      if (c.limbs === 1) {
        const lb = this.limbs[1], lag = Math.round(c.lag * (strokeSamples || this.e.srOS / c.rate));
        if (lag <= 0) lb.trigger(arcF, forceF, swap ? 0 : 1);
        else { lb.delay = lag; lb.dArcF = arcF; lb.dForceF = forceF; lb.dPat = swap ? 0 : 1; }
      }
    }

    // the song: chirps of strokes, phrases, rubato, or the beat grid with Sync
    songClock(i, k) {
      const c = this.e.c;
      if (c.play === 1 || !(this.held || this.swell > SWELL_END)) return;
      const chirpN = c.chirp;
      let inPhrase = true;
      if (k.phraseLen > 0) { inPhrase = this.phraseT < k.phraseLen; if (++this.phraseT >= k.phraseLen + k.pauseLen) this.phraseT = 0; }
      if (k.sync) {
        const beat = k.beat0 + i * k.bps;
        if (chirpN > 0) {
          const gc = Math.floor(beat / k.chirpBeats + 1e-9);
          if (this.gridChirp < 0) this.gridChirp = gc;
          else if (gc !== this.gridChirp) { this.gridChirp = gc; this.inChirp = 0; this.strokeTimer = 0; if (inPhrase) this.newChirp(); else this.inChirp = chirpN; }
          if (this.inChirp < chirpN && --this.strokeTimer <= 0) { this.strokeTimer += k.strokePeriod; this.triggerStroke(this.inChirp, chirpN, k.strokePeriod); this.inChirp++; }
        } else {
          const gs = Math.floor(beat * k.strokesPerBeat + 1e-9);
          if (this.gridStroke < 0 || gs !== this.gridStroke) { this.gridStroke = gs; if (inPhrase) this.triggerStroke(0, 0, k.strokePeriod); }
        }
        return;
      }
      if (chirpN > 0) {
        if (--this.chirpTimer <= 0) {
          this.chirpTimer += k.chirpPeriod * (1 + k.rubC * (2 * this.rand() - 1));
          this.strokeTimer = 0;
          if (inPhrase) { this.inChirp = 0; this.newChirp(); } else this.inChirp = chirpN;
        }
        if (this.inChirp < chirpN && --this.strokeTimer <= 0) {
          this.strokeTimer += k.strokePeriod * (1 + k.rubS * (2 * this.rand() - 1));
          this.triggerStroke(this.inChirp, chirpN, k.strokePeriod); this.inChirp++;
        }
      } else if (--this.strokeTimer <= 0) {
        this.strokeTimer += k.strokePeriod * (1 + k.rubS * (2 * this.rand() - 1));
        if (inPhrase) { if (this.e.c.limbs === 1 && this.rand() < this.e.c.swap * 0.1) this.swapNow ^= 1; this.triggerStroke(0, 0, k.strokePeriod); }
      }
    }
    newChirp() {
      this.chirpIdx++;
      if (this.e.c.limbs === 1 && this.rand() < this.e.c.swap) this.swapNow ^= 1;   // the legs trade patterns (Elsner 1974)
    }

    render(nOS, oL, oR) {
      const e = this.e, c = e.c, f0 = this.f0, F0 = f0;      // F0: free speed at Speed 1 (spacings/s)
      const dt = 1 / e.srOS, blockT = nOS * dt;
      // swell: attack and release act on the muscle force
      // (at their 1 ms minimum they act at once: the force is full from the first sample, and gone at note-off)
      if (this.held) this.swell = c.attack <= 0.0011 ? 1 : this.swell + (1 - this.swell) * (1 - Math.exp(-blockT / c.attack));
      else this.swell = c.release <= 0.0011 ? 0 : this.swell * Math.exp(-blockT / c.release);
      const k = this.k || (this.k = {});
      k.dt = dt; k.f0 = f0; k.w0 = this.w0; k.a = dt * f0 / WING_TAU; k.K = this.K;
      k.E = c.escapement * (c.ring * c.ring / (c.ring * c.ring + REG_Q0 * REG_Q0)); k.hs = 2 * c.height;
      k.glideAmt = c.glide; k.lock = c.pitchlock; k.springOn = c.springOn; k.springSlow = c.springSlow; k.springNb = c.springNb;
      k.curve = c.curve; k.shape = c.shape; k.soon = SKIP_SOON * e.srOS / f0; k.swellNow = this.swell;
      k.Fm0 = c.speed * c.wheelSpeed * F0 * (0.7 + 0.3 * this.vel) * c.tempForce * (1 + c.pressure);
      k.strokePeriod = e.srOS / (c.rate * c.patternScale); k.chirpPeriod = e.srOS / (c.chirprate * c.patternScale);
      k.rubS = 0.1 * c.rubato; k.rubC = 0.25 * c.rubato;
      k.phraseLen = c.phrase * e.srOS; k.pauseLen = c.pause * e.srOS;
      k.sync = c.sync; k.beat0 = e.beat; k.bps = e.tempo / 60 / e.srOS;
      if (c.sync) { k.chirpBeats = c.chirpBeats; k.strokesPerBeat = c.strokesPerBeat; k.strokePeriod = e.srOS * 60 / e.tempo / c.strokesPerBeat; }
      // Scrape: once the wheel moves under a held note, the plectrum follows it
      const lead = this.limbs[0];
      if (c.play === 1 && this.held && !lead.follow && Math.abs(e.wheel - this.wheel0) > 0.01) { lead.follow = true; lead.stroking = false; lead.pend = false; lead.closeNext = false; if (!lead.file) { lead.file = e.file; e.file.users++; lead.u = lead.file.length * (0.5 - 0.5 * clamp(c.arc * c.arcScale, 0, 1)) + this.wheel0 * clamp(c.arc * c.arcScale, 0, 1) * lead.file.length; lead.n = 0; while (lead.n < lead.file.n && lead.file.pos[lead.n] < lead.u) lead.n++; } }
      if (lead.follow) lead.fTarget = e.wheel;
      const two = c.limbs === 1, lb = this.limbs[1];
      const gain = this.gain, sub = this.sub, h = dt / sub, envDec = this.envDec;
      const fr = FRAMES[c.frame], KF = fr.KF, K2 = fr.K2, GF = fr.GF;
      const g2 = membraneDamping(fr, c.ring), nl = c.nonlinear * NL_A;
      const dL = 1 + 0.5 * c.wings, dR = 1 - 0.5 * c.wings;
      const tickGain = c.tick * 0.25 * c.toothSec, outGain = OUT_GAIN / this.w0;
      // second mode per wing and the body: two-pole resonators, retuned per block
      const sOn = c.secondGain > 0, bOn = c.body > 0;
      const panL = 0.5 * (1 + c.spread), panR = 0.5 * (1 - c.spread);
      let { XL, XvL, YL, YvL, XR, XvR, YR, YvR } = this;
      let { s1L, s2L, s1R, s2R, b1, b2, h1, h2 } = this;
      const lpA = this.lpA;
      const sec = this.sec; if (sOn) setRes(sec, c.second * this.wf / TWO_PI, Math.max(4, c.ring), e.srOS);
      const bodyLo = c.bodyLo, bodyHi = c.bodyHi;
      const secIn = SECOND_IN * OUT_GAIN * Math.max(4, c.ring) / f0 * sec.norm, bodyIn = BODY_IN * OUT_GAIN / f0 * Math.pow(f0 / 4700, 0.6);   // body level about the same at any carrier
      const pA = lead.pulse, pB = lb.pulse;
      let peak = 0, sumsq = 0, nStroke = 0, peakStroke = 0;
      const guard = c.loudness > 0;
      for (let i = 0; i < nOS; i++) {
        this.songClock(i, k);
        // ---- strokes ----
        const fA = lead.step(i, k), fB = two ? lb.step(i, k) : 0;
        const iA = lead.pw & (RING - 1), pfA = pA[iA]; pA[iA] = 0; lead.pw++;
        let pfB = 0; if (two) { const iB = lb.pw & (RING - 1); pfB = pB[iB]; pB[iB] = 0; lb.pw++; }
        // one limb drives both wings; two limbs drive one wing each
        const FL = gain * (fA + pfA), FR = two ? gain * (fB + pfB) : FL;
        const wf = this.wf;
        {
          const wl = wf * dL, wr = wf * dR, wl2 = wl * wl, wr2 = wr * wr;
          const k1l = KF * wl2, kcl = KC * wl2, k2l = K2 * wl2, c1l = GF * wl, c2l = g2 * wl, nll = nl * k1l;
          const k1r = KF * wr2, kcr = KC * wr2, k2r = K2 * wr2, c1r = GF * wr, c2r = g2 * wr, nlr = nl * k1r;
          // the two membranes are joined through the plectrum and file: strongly while engaged
          const kw = ((lead.engaged || lb.engaged) ? WING_LINK_ENGAGED : WING_LINK_FREE) * wf * wf, ixs2 = fr.ixs2;
          for (let s = 0; s < sub; s++) {
            let x2, p2;
            // stage 1
            x2 = XL * XL * ixs2; p2 = XR * XR * ixs2;
            const ax1 = FL - c1l * XvL - k1l * XL - nll * x2 * XL / (1 + NL_B * x2) - kcl * (XL - YL), ay1 = -c2l * YvL - k2l * YL - kcl * (YL - XL) - kw * (YL - YR);
            const bx1 = FR - c1r * XvR - k1r * XR - nlr * p2 * XR / (1 + NL_B * p2) - kcr * (XR - YR), by1 = -c2r * YvR - k2r * YR - kcr * (YR - XR) - kw * (YR - YL);
            // stage 2
            const X2 = XL + 0.5 * h * XvL, Xv2 = XvL + 0.5 * h * ax1, Y2 = YL + 0.5 * h * YvL, Yv2 = YvL + 0.5 * h * ay1;
            const P2 = XR + 0.5 * h * XvR, Pv2 = XvR + 0.5 * h * bx1, Q2 = YR + 0.5 * h * YvR, Qv2 = YvR + 0.5 * h * by1;
            x2 = X2 * X2 * ixs2; p2 = P2 * P2 * ixs2;
            const ax2 = FL - c1l * Xv2 - k1l * X2 - nll * x2 * X2 / (1 + NL_B * x2) - kcl * (X2 - Y2), ay2 = -c2l * Yv2 - k2l * Y2 - kcl * (Y2 - X2) - kw * (Y2 - Q2);
            const bx2 = FR - c1r * Pv2 - k1r * P2 - nlr * p2 * P2 / (1 + NL_B * p2) - kcr * (P2 - Q2), by2 = -c2r * Qv2 - k2r * Q2 - kcr * (Q2 - P2) - kw * (Q2 - Y2);
            // stage 3
            const X3 = XL + 0.5 * h * Xv2, Xv3 = XvL + 0.5 * h * ax2, Y3 = YL + 0.5 * h * Yv2, Yv3 = YvL + 0.5 * h * ay2;
            const P3 = XR + 0.5 * h * Pv2, Pv3 = XvR + 0.5 * h * bx2, Q3 = YR + 0.5 * h * Qv2, Qv3 = YvR + 0.5 * h * by2;
            x2 = X3 * X3 * ixs2; p2 = P3 * P3 * ixs2;
            const ax3 = FL - c1l * Xv3 - k1l * X3 - nll * x2 * X3 / (1 + NL_B * x2) - kcl * (X3 - Y3), ay3 = -c2l * Yv3 - k2l * Y3 - kcl * (Y3 - X3) - kw * (Y3 - Q3);
            const bx3 = FR - c1r * Pv3 - k1r * P3 - nlr * p2 * P3 / (1 + NL_B * p2) - kcr * (P3 - Q3), by3 = -c2r * Qv3 - k2r * Q3 - kcr * (Q3 - P3) - kw * (Q3 - Y3);
            // stage 4
            const X4 = XL + h * Xv3, Xv4 = XvL + h * ax3, Y4 = YL + h * Yv3, Yv4 = YvL + h * ay3;
            const P4 = XR + h * Pv3, Pv4 = XvR + h * bx3, Q4 = YR + h * Qv3, Qv4 = YvR + h * by3;
            x2 = X4 * X4 * ixs2; p2 = P4 * P4 * ixs2;
            const ax4 = FL - c1l * Xv4 - k1l * X4 - nll * x2 * X4 / (1 + NL_B * x2) - kcl * (X4 - Y4), ay4 = -c2l * Yv4 - k2l * Y4 - kcl * (Y4 - X4) - kw * (Y4 - Q4);
            const bx4 = FR - c1r * Pv4 - k1r * P4 - nlr * p2 * P4 / (1 + NL_B * p2) - kcr * (P4 - Q4), by4 = -c2r * Qv4 - k2r * Q4 - kcr * (Q4 - P4) - kw * (Q4 - Y4);
            const h6 = h / 6;
            XL += h6 * (XvL + 2 * Xv2 + 2 * Xv3 + Xv4); YL += h6 * (YvL + 2 * Yv2 + 2 * Yv3 + Yv4);
            XvL += h6 * (ax1 + 2 * ax2 + 2 * ax3 + ax4); YvL += h6 * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
            XR += h6 * (XvR + 2 * Pv2 + 2 * Pv3 + Pv4); YR += h6 * (YvR + 2 * Qv2 + 2 * Qv3 + Qv4);
            XvR += h6 * (bx1 + 2 * bx2 + 2 * bx3 + bx4); YvR += h6 * (by1 + 2 * by2 + 2 * by3 + by4);
          }
        }
        // each escapement reads its wing's vibration, not its steady deflection under load:
        // one limb reads both wings (their mean), two limbs read one wing each
        const E = k.E;
        {
          const Ym = two ? YL : 0.5 * (YL + YR), Yvm = two ? YvL : 0.5 * (YvL + YvR), l = lead;
          l.Ylp += lpA * (Ym - l.Ylp); l.Yac = Ym - l.Ylp; l.Yvm = Yvm;
          const ay = Math.abs(l.Yac); l.env = ay > l.env * envDec ? ay : l.env * envDec;
          if (!l.armed && l.Yac < ARM_AT * l.env) l.armed = true;
          if (E * l.env / (l.env + CONF_A0) < 0.05) l.armed = true;
        }
        if (two) {
          const l = lb; l.Ylp += lpA * (YR - l.Ylp); l.Yac = YR - l.Ylp; l.Yvm = YvR;
          const ay = Math.abs(l.Yac); l.env = ay > l.env * envDec ? ay : l.env * envDec;
          if (!l.armed && l.Yac < ARM_AT * l.env) l.armed = true;
          if (E * l.env / (l.env + CONF_A0) < 0.05) l.armed = true;
        }
        let outL = outGain * YvL, outR = outGain * YvR;
        // second mode on each wing, driven by the same force
        if (sOn) {
          // a resonator of unit peak gain fed like the wing: force × Q × OUT_GAIN / f0 matches the wing at resonance
          const xl = (FL / gain) * secIn, xr = (FR / gain) * secIn;
          const nl1 = sec.a1 * s1L - sec.a2 * s2L + xl; s2L = s1L; s1L = nl1;
          const nr1 = sec.a1 * s1R - sec.a2 * s2R + xr; s2R = s1R; s1R = nr1;
          outL += c.secondGain * (s1L - s2L); outR += c.secondGain * (s1R - s2R);
        }
        const pf = pfA + pfB;
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
        if (lead.stroking || lb.stroking || lead.follow) {
          sumsq += 0.5 * (oLs * oLs + oRs * oRs); nStroke++;
          const am = Math.max(oLs < 0 ? -oLs : oLs, oRs < 0 ? -oRs : oRs); if (am > peakStroke) peakStroke = am;
        }
        // compensation also guards peaks at once (a voice's first moments, before it has adapted)
        if (guard) { const am = Math.max(oLs < 0 ? -oLs : oLs, oRs < 0 ? -oRs : oRs) * this.gainNow; if (am > LOUD_GUARD) this.gainNow *= LOUD_GUARD / am; }
        oL[i] += oLs * this.gainNow; oR[i] += oRs * this.gainNow;
        const ao = oLs < 0 ? -oLs : oLs; if (ao > peak) peak = ao;
      }
      this.age2 += nOS;
      Object.assign(this, { XL, XvL, YL, YvL, XR, XvR, YR, YvR, s1L, s2L, s1R, s2R, b1, b2, h1, h2 });
      if (!c.pitchlock) this.keep = 0;
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
      // a voice ends once released, the song stopped, no stroke running, and quiet for a while
      const busy = this.stroking || lead.pend || lb.pend || lb.delay >= 0 || (this.swell > SWELL_END && c.play === 0);
      if (!this.held && !busy && peak < 1e-6) { if (++this.quiet > 8) { this.reset(); } } else this.quiet = 0;
    }
  }

  /* ---------- the engine ---------- */
  class StridulationEngine {
    constructor(sampleRate, seed) {
      this.sr = sampleRate; this.srOS = sampleRate * OS;
      this.p = new Float64Array(PARAMS.length);
      PARAMS.forEach((d, i) => { this.p[i] = d.def; });
      if (seed !== undefined) this.p[PINDEX.seed] = clamp(Math.round(seed) || 1, 1, 65535);
      this.m = Float64Array.from(this.p);                   // after the LFOs: what the sound uses
      // LFOs: dormant (no work at all) while their target is None
      this.lfoPhase = new Float64Array(NUM_LFOS); this.lfoPrev = new Float64Array(NUM_LFOS); this.lfoNext = new Float64Array(NUM_LFOS);
      this.lfoSm = new Float64Array(NUM_LFOS); this.lfoTarget = new Int32Array(NUM_LFOS); this.lfoFresh = new Uint8Array(NUM_LFOS).fill(1);
      this.lfoRng = new Uint32Array(NUM_LFOS);
      for (let i = 0; i < NUM_LFOS; i++) this.lfoRng[i] = ((this.p[PINDEX.seed] * 2654435761) ^ (0x51ed27 * (i + 1))) >>> 0 || 1;
      this.lfoSmooth = 1 - Math.exp(-BLOCK / (0.002 * sampleRate));
      this.wheel = 0; this.pressure = 0; this.tempo = 120; this.beat = 0; this.stack = [];
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
      // an LFO target may be given by parameter id ('speed') instead of its menu number
      if (typeof v === 'string' && /^lfo\dtarget$/.test(id)) v = v === 'none' ? 0 : MOD_TARGETS.indexOf(v) + 1;
      const i = PINDEX[id];
      if (i === undefined || !Number.isFinite(v)) return;
      const d = PARAMS[i];
      v = clamp(v, d.min, d.max);
      if (d.step) v = Math.round(v / d.step) * d.step;
      this.p[i] = v; this.m[i] = v;
      if (id === 'poly') this.allNotesOff();
          }
    getParam(id) { return this.p[PINDEX[id]]; }
    setBend(norm) { this.bendNorm = clamp(norm, -1, 1); }       // ±2 semitones
    setModWheel(x) { this.wheel = clamp(x, 0, 1); }             // Song: speed up to ×2.8; Scrape: plectrum position
    setPressure(x) { this.pressure = clamp(x, 0, 1); }          // aftertouch: muscle force up to ×2
    setTempo(bpm) { this.tempo = clamp(bpm, 20, 400); }
    setPosition(beats) { if (Number.isFinite(beats)) this.beat = beats; }   // host song position in beats, at the next block

    // move each active LFO on by dt seconds and compute its output (0–1)
    advanceLfos(dt) {
      for (let i = 0; i < NUM_LFOS; i++) {
        const b = PINDEX['lfo' + (i + 1) + 'target'];
        const t = Math.round(this.p[b]);
        this.lfoTarget[i] = t;
        if (t === 0) continue;                                   // dormant
        const shape = Math.round(this.p[b + 1]);
        let hz = this.p[b + 2];
        if (this.p[b + 3] >= 0.5) hz = (this.tempo / 60) / nearestDiv(LFO_DIVS, (this.tempo / 60) / hz);
        let ph = this.lfoPhase[i] + hz * dt, wrapped = false;
        if (ph >= 1) { ph -= Math.floor(ph); wrapped = true; }
        if (wrapped || this.lfoFresh[i]) {
          this.lfoPrev[i] = this.lfoFresh[i] ? this.lfoRand(i) : this.lfoNext[i];
          this.lfoNext[i] = this.lfoRand(i);
          this.lfoFresh[i] = 0;
        }
        this.lfoPhase[i] = ph;
        let y;
        switch (shape) {
          case 0: y = 0.5 - 0.5 * Math.cos(TWO_PI * ph); break;          // Sine, starts at From
          case 1: y = ph < 0.5 ? 2 * ph : 2 - 2 * ph; break;              // Triangle
          case 2: y = ph; break;                                           // Ramp up
          case 3: y = 1 - ph; break;                                       // Ramp down
          case 4: y = ph < 0.5 ? 0 : 1; break;                             // Square
          case 5: y = this.lfoPrev[i]; break;                              // Random step
          default: { const u = 0.5 - 0.5 * Math.cos(Math.PI * ph); y = this.lfoPrev[i] + (this.lfoNext[i] - this.lfoPrev[i]) * u; }  // Random smooth
        }
        // a 2 ms glide keeps square and step jumps from clicking
        this.lfoSm[i] = dt === 0 ? y : this.lfoSm[i] + (y - this.lfoSm[i]) * this.lfoSmooth;
      }
    }
    lfoRand(i) { this.lfoRng[i] = nextRand(this.lfoRng[i]); return this.lfoRng[i] / 4294967296; }
    // effective values: the set values, with each active LFO's target moved between From and To
    applyLfos() {
      this.m.set(this.p);
      for (let i = 0; i < NUM_LFOS; i++) {
        const t = this.lfoTarget[i];
        if (t === 0) continue;
        const b = PINDEX['lfo' + (i + 1) + 'target'];
        const idx = TARGET_INDEX[t - 1], d = PARAMS[idx];
        const from = this.p[b + 4], to = this.p[b + 5];
        this.m[idx] = fromNorm(d, from + (to - from) * this.lfoSm[i]);
      }
    }

    noteFreq(note) {
      const P = this.m;
      const st = P[PINDEX.tune] + 2 * this.bendNorm;
      // Keytrack off: Size sets the carrier from the katydid file-length fit, f ∝ L^−0.81 (4.7 kHz at 1×)
      const base = P[PINDEX.keytrack] >= 0.5 ? 440 * Math.pow(2, (note - 69) / 12) : 4700 * Math.pow(P[PINDEX.size], -0.81);
      return base * Math.pow(2, st / 12) / P[PINDEX.ultra];    // the insect's carrier, divided by Ultra
    }
    noteOn(note, vel) {
      if (vel <= 0) { this.noteOff(note); return; }
      const v01 = clamp(vel / 127, 0, 1), f0 = this.noteFreq(note);
      for (let i = 0; i < NUM_LFOS; i++) if (this.p[PINDEX['lfo' + (i + 1) + 'retrig']] >= 0.5) { this.lfoPhase[i] = 0; this.lfoFresh[i] = 1; }
      if (this.p[PINDEX.poly] < 0.5) {
        // Mono: last note wins; a note played while another is held glides to it and the song goes on
        const v = this.voices[0], legato = this.stack.length > 0 && v.held && Math.round(this.m[PINDEX.play]) === 0;
        this.stack = this.stack.filter(n => n !== note); if (this.stack.length < 16) this.stack.push(note);
        v.noteOn(note, v01, f0, legato);
        return;
      }
      let pick = this.voices.find(x => x.stage === 0);
      if (!pick) pick = this.voices.reduce((o, x) => (x.age < o.age ? x : o));
      pick.noteOn(note, v01, f0, false);
    }
    noteOff(note) {
      if (this.p[PINDEX.poly] < 0.5) {
        const v = this.voices[0];
        this.stack = this.stack.filter(n => n !== note);
        if (v.note === note) {
          if (this.stack.length > 0 && this.c.play === 0) { const back = this.stack[this.stack.length - 1]; v.note = back; v.logT = Math.log2(this.noteFreq(back)); }
          else v.noteOff();
        }
        return;
      }
      for (const v of this.voices) if (v.stage !== 0 && v.note === note) v.noteOff();
    }
    allNotesOff() { for (const v of this.voices) v.reset(); this.stack = []; }

    updateControls() {
      const P = this.m, c = this.c;
      c.escapement = P[PINDEX.escapement]; c.height = P[PINDEX.height];
      c.toothSec = P[PINDEX.toothtime] * 1e-6;
      c.pulseLen = Math.max(2.5, c.toothSec * this.srOS);    // internal samples
      c.tick = P[PINDEX.tick]; c.ring = P[PINDEX.ring];
      c.nonlinear = P[PINDEX.nonlinear]; c.wings = P[PINDEX.wings] / 100; c.glide = P[PINDEX.glide] / 100;
      c.second = P[PINDEX.second]; c.frame = P[PINDEX.frame] >= 0.5 ? 1 : 0;
      c.secondGain = P[PINDEX.secondlevel] <= -48 ? 0 : Math.pow(10, P[PINDEX.secondlevel] / 20);
      c.body = P[PINDEX.body]; c.spread = P[PINDEX.spread];
      if (!c.bodyLo) { c.bodyLo = { a1: 0, a2: 0, norm: 1 }; c.bodyHi = { a1: 0, a2: 0, norm: 1 }; }
      const ku = P[PINDEX.ultra];
      setRes(c.bodyLo, P[PINDEX.bodytone] / ku, 3, this.srOS); setRes(c.bodyHi, 10 * P[PINDEX.bodytone] / ku, 2, this.srOS);
      c.pitchlock = P[PINDEX.pitchlock] >= 0.5; c.loudness = P[PINDEX.loudness];
      // Spring: off below 0.02 (the stiff contact, unchanged); driver speed falls and bursts grow
      const sp = P[PINDEX.spring];
      c.springOn = sp > 0.02; c.springSlow = 0.02 + 0.98 * Math.pow(1 - sp, 0.45); c.springNb = 1 + 12.5 * sp * sp;
      // Temperature: pattern rates follow Walker's rule (zero near 4 °C), muscle force (T + 17) / 42
      const T = P[PINDEX.temperature];
      c.tempForce = (T + 17) / 42;
      // Ultra divides every frequency by k; Time keeps k^Time of the matching stretch
      const k = P[PINDEX.ultra], tt = P[PINDEX.ultratime];
      c.ultra = k; c.patternScale = Math.max(0.02, (T - 4) / 21) / Math.pow(k, tt); c.arcScale = Math.pow(k, tt - 1);
      c.speed = P[PINDEX.speed]; c.curve = P[PINDEX.curve]; c.arc = P[PINDEX.arc];
      c.rate = P[PINDEX.rate]; c.chirp = Math.round(P[PINDEX.chirp]); c.chirprate = P[PINDEX.chirprate];
      c.arcgrow = P[PINDEX.arcgrow]; c.open = P[PINDEX.open]; c.shape = Math.round(P[PINDEX.shape]);
      c.limbs = Math.round(P[PINDEX.limbs]); c.lag = P[PINDEX.lag]; c.swap = P[PINDEX.swap]; c.legb = P[PINDEX.legb];
      c.play = Math.round(P[PINDEX.play]); c.phrase = P[PINDEX.phrase]; c.pause = P[PINDEX.pause]; c.rubato = P[PINDEX.rubato];
      c.attack = P[PINDEX.attack]; c.release = P[PINDEX.release]; c.glidetime = P[PINDEX.glidetime];
      c.wheelSpeed = c.play === 0 ? Math.pow(2, 1.5 * this.wheel) : 1; c.pressure = this.pressure;
      // Sync: strokes per beat and chirp length in beats snap to the nearest note values (Temperature is then ignored)
      c.sync = P[PINDEX.sync] >= 0.5;
      if (c.sync) {
        const bps = this.tempo / 60;
        c.strokesPerBeat = nearestDiv(SYNC_DIVS, c.rate / bps); c.chirpBeats = nearestDiv(LFO_DIVS, bps / c.chirprate);
      }
      this.vol = Math.pow(10, P[PINDEX.volume] / 20);
      // file: rebuild into the spare table when its parameters change and no voice is using it
      let changed = false;
      for (let k = 0; k < FILE_PARAMS.length; k++) if (this.fileKey[k] !== P[FILE_PARAMS[k]]) changed = true;
      if (changed) this.fileDirty = true;
      if (this.fileDirty) {
        const spare = this.files[this.fileIdx ^ 1];
        if (spare.users === 0) {
          // Keytrack on: Size lengthens the file instead (more teeth at the same spacing), so pulses lengthen as
          // they would with the lower carrier of Keytrack off
          const teeth = P[PINDEX.keytrack] >= 0.5 ? P[PINDEX.teeth] * Math.pow(P[PINDEX.size], 0.81) : P[PINDEX.teeth];
          spare.build(teeth, P[PINDEX.spacing], P[PINDEX.jitter], P[PINDEX.gaps], P[PINDEX.seed]);
          this.fileIdx ^= 1; this.file = spare; this.fileDirty = false;
          for (let k = 0; k < FILE_PARAMS.length; k++) this.fileKey[k] = P[FILE_PARAMS[k]];
        }
      }
      // pitch follows live (tune, bend, LFOs), gliding in Mono when Glide time is set
      const gl = c.glidetime > 0 ? 1 - Math.exp(-BLOCK / this.sr / c.glidetime) : 1;
      for (const v of this.voices) if (v.stage !== 0) {
        v.logT = Math.log2(this.noteFreq(v.note) || v.f0);
        v.logF += (v.logT - v.logF) * gl;
        v.setPitch(Math.pow(2, v.logF));
      }
    }

    processBlock() {
      this.advanceLfos(BLOCK / this.sr);
      this.applyLfos();
      this.updateControls();
      const nOS = BLOCK * OS, oL = this.osL, oR = this.osR;
      oL.fill(0); oR.fill(0);
      let count = 0;
      for (const v of this.voices) if (v.stage !== 0) { v.render(nOS, oL, oR); count++; }
      this.osTime += nOS; this.beat += BLOCK / this.sr * this.tempo / 60;
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
  StridulationEngine.MOD_TARGETS = MOD_TARGETS; StridulationEngine.LFO_SHAPES = LFO_SHAPES; StridulationEngine.LFO_DIVS = LFO_DIVS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { StridulationEngine, PARAMS, MOD_TARGETS, LFO_SHAPES };
  else root.StridulationEngine = StridulationEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
