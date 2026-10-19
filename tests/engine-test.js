// Reference engine tests. Run: node tests/engine-test.js
// Test numbers follow design.md §11.
'use strict';
const path = require('path');
const { StridulationEngine, PARAMS } = require(path.join(__dirname, '..', 'reference', 'stridulation-engine.js'));
const { PRESETS } = require(path.join(__dirname, '..', 'reference', 'presets.js'));

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (ok) passed++; else failed++;
}

const SR = 48000;
function render(p, seconds, opts = {}) {
  const e = new StridulationEngine(SR, opts.seed || 1);
  if (opts.record !== false) e.rec = [];
  for (const k in p) e.setParam(k, p[k]);
  const n = Math.round(SR * seconds), L = new Float32Array(n), R = new Float32Array(n);
  const bl = opts.block || 128, tl = new Float32Array(bl), tr = new Float32Array(bl);
  const note = opts.note || p._note || 69;
  e.noteOn(note, opts.vel || 127);
  for (let i = 0; i < n; i += bl) {
    if (opts.offAt !== undefined && i <= opts.offAt * SR && i + bl > opts.offAt * SR) e.noteOff(note);
    const m = Math.min(bl, n - i); e.process(tl, tr, m);
    L.set(tl.subarray(0, m), i); R.set(tr.subarray(0, m), i);
  }
  return { e, L, R };
}
// a carrier as the nearest MIDI note (Keytrack on) plus Tune for the remainder; _note is read by render()
const noteFor = hz => Math.round(69 + 12 * Math.log2(hz / 440));
const tuneFor = hz => 69 + 12 * Math.log2(hz / 440) - noteFor(hz);
// one long stroke, no song: chirp 0 at a slow rate
const ONE = f0 => ({ keytrack: 1, tune: tuneFor(f0), _note: noteFor(f0), chirp: 0, rate: 1, jitter: 0, spacing: 0.4, teeth: 120, arc: 0.8 });

// the first stroke's catches and skips, and the output's frequency over its middle 40%
function firstStroke(r, f0) {
  const ev = r.e.rec, fs = SR;
  const c = ev.filter(x => x.type === 'catch');
  let last = c.findIndex((x, i) => i > 0 && x.t - c[i - 1].t > 0.004); if (last < 0) last = c.length;
  const cs = c.slice(0, last), t0 = cs[0].t, t1 = cs[cs.length - 1].t, dur = t1 - t0;
  const skips = ev.filter(x => x.type === 'skip' && x.t >= t0 && x.t <= t1).length;
  const a = t0 + dur * 0.3, b = t0 + dur * 0.7;
  const mid = cs.filter(x => x.t >= a && x.t <= b);
  const rate = (mid.length - 1) / (mid[mid.length - 1].t - mid[0].t);
  const L = r.L, zc = [];
  for (let i = Math.floor(a * fs) + 1; i < b * fs; i++) if (L[i - 1] < 0 && L[i] >= 0) zc.push(i - L[i] / (L[i] - L[i - 1]));
  const fOut = (zc.length - 1) * fs / (zc[zc.length - 1] - zc[0]);
  return { cs, skips, dur, perCycle: (cs.length + skips) / (dur * f0), rate, fOut, mid };
}
const pct = x => (x * 100).toFixed(1) + '%';

// 1. Clockwork: one tooth per cycle, output on the carrier, wing speed proportional to spacing
for (const f0 of [300, 1000, 4700, 10000, 15000]) {
  const r = render(Object.assign(ONE(f0), { escapement: 1, speed: 2 }), Math.max(0.2, 60 / f0));
  const s = firstStroke(r, f0);
  check(`1 clockwork at ${f0} Hz: one tooth per cycle`, Math.abs(s.perCycle - 1) < 0.05, s.perCycle.toFixed(3) + ' teeth per cycle');
  check(`1 clockwork at ${f0} Hz: tooth rate = carrier within 2%`, Math.abs(s.rate / f0 - 1) < 0.02, 'rate ' + pct(s.rate / f0 - 1) + ', output ' + pct(s.fOut / f0 - 1));
  // Koch et al. 1988, Fig. 5: speed ∝ spacing through the origin, slope = carrier
  const m = s.cs; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 1; i < m.length; i++) {
    const sp = m[i].pos - m[i - 1].pos, vel = sp / (m[i].t - m[i - 1].t);
    sxy += sp * vel; sxx += sp * sp; syy += vel * vel;
  }
  const slope = sxy / sxx, r2 = sxy * sxy / (sxx * syy);
  check(`1 clockwork at ${f0} Hz: speed ∝ spacing, slope = carrier`, Math.abs(slope / f0 - 1) < 0.03 && r2 > 0.99, 'slope ' + pct(slope / f0 - 1) + ' off, r² ' + r2.toFixed(4));
}

// 2. Overdriven clockwork jumps to double speed, pitch held; a cog rattle follows speed instead
{
  const f0 = 4700;
  const s2 = firstStroke(render(Object.assign(ONE(f0), { escapement: 1, speed: 2 }), 0.2), f0);
  const s6 = firstStroke(render(Object.assign(ONE(f0), { escapement: 1, speed: 6 }), 0.2), f0);
  check('2 overdriven clockwork: about two teeth per cycle', s6.perCycle > 1.8 && s6.perCycle < 2.2, s6.perCycle.toFixed(2) + ' (Speed 2: ' + s2.perCycle.toFixed(2) + ')');
  check('2 overdriven clockwork: pitch held within 10% while the tooth rate doubles', Math.abs(s6.fOut / f0 - 1) < 0.1, 'output ' + pct(s6.fOut / f0 - 1));
  check('2 overdriven clockwork: stroke about twice as fast', s2.dur / s6.dur > 1.7, (s2.dur / s6.dur).toFixed(2) + '×');
  for (const speed of [1, 1.5]) {
    const s = firstStroke(render(Object.assign(ONE(f0), { escapement: 0, speed }), 0.2), f0);
    check(`2 cog rattle at Speed ${speed}: tooth rate follows speed`, Math.abs(s.rate / (speed * f0) - 1) < 0.05, 'rate ' + (s.rate / f0).toFixed(3) + ' × carrier');
  }
}

// 3. Missing teeth: the wing jumps the gap and resumes; harps removed: a much faster stroke
{
  const f0 = 4700;
  const r = render(Object.assign(ONE(f0), { escapement: 1, speed: 2, gaps: 0.15 }), 0.2);
  const s = firstStroke(r, f0), m = s.cs;
  // Koch et al. 1988: the wing accelerates across a gap, then resumes the original rate
  let gapsSeen = 0, slowest = Infinity, resumed = 0, resumable = 0;
  const gapAt = i => m[i].pos - m[i - 1].pos > 1.6;
  for (let i = 2; i < m.length - 3; i++) {
    if (!gapAt(i)) continue;
    gapsSeen++;
    const sp = m[i].pos - m[i - 1].pos, cyc = (m[i].t - m[i - 1].t) * f0;
    const normal = (m[i - 1].pos - m[i - 2].pos) / ((m[i - 1].t - m[i - 2].t) * f0);
    slowest = Math.min(slowest, (sp / cyc) / normal);   // speed across the gap ÷ speed just before
    if (gapAt(i + 1) || gapAt(i + 2)) continue;          // another gap follows: no clean resume to judge
    resumable++;
    if (Math.abs((m[i + 2].t - m[i + 1].t) * f0 - 1) < 0.1) resumed++;
  }
  check('3 gaps: the wing crosses a missing tooth faster than its normal speed', gapsSeen > 3 && slowest > 1, gapsSeen + ' gaps, slowest crossing ' + slowest.toFixed(2) + '× normal speed');
  check('3 gaps: one tooth per cycle again by the second tooth after a gap', resumed >= resumable - 1, resumed + ' of ' + resumable);
  const intact = firstStroke(render(Object.assign(ONE(f0), { escapement: 1, speed: 2 }), 0.2), f0);
  const removed = firstStroke(render(Object.assign(ONE(f0), { escapement: 1, speed: 2, ring: 0.7 }), 0.2), f0);
  check('3 harps removed (Ring 0.7): stroke at least 1.6× faster', intact.dur / removed.dur > 1.6, (intact.dur / removed.dur).toFixed(2) + '×');
}

// 6. Free decay after the last tooth has Q within 10% of Ring
for (const ring of [10, 25, 40]) {
  const f0 = 4700;
  const r = render(Object.assign(ONE(f0), { escapement: 1, speed: 2, ring, tick: 0 }), 0.12);
  const s = firstStroke(r, f0);
  const L = r.L, start = Math.ceil((s.cs[s.cs.length - 1].t + 0.002) * SR);
  // peak per carrier cycle, then a log-linear fit over 30 dB below the first
  const per = SR / f0, pk = [];
  for (let k = 0; ; k++) {
    const i0 = Math.floor(start + k * per), i1 = Math.floor(start + (k + 1) * per);
    if (i1 >= L.length) break;
    let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(L[i]));
    if (k > 0 && m < pk[0] * 0.03) break;
    pk.push(m);
  }
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = pk.length;
  for (let k = 0; k < n; k++) { const y = Math.log(pk[k]); sx += k; sy += y; sxx += k * k; sxy += k * y; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);     // log amplitude per cycle = −π / Q
  const Q = -Math.PI / slope;
  check(`6 free decay at Ring ${ring}: Q within 10%`, Math.abs(Q / ring - 1) < 0.1, 'Q ' + Q.toFixed(1) + ' over ' + n + ' cycles');
}

// 8. Same output at any buffer size; same seed, same output; another seed, another file
{
  const p = Object.assign({}, PRESETS[6].p);       // damaged file: jitter and gaps use the seed
  const a = render(p, 0.6, { block: 1, record: false }).L;
  const b = render(p, 0.6, { block: 64, record: false }).L;
  const c = render(p, 0.6, { block: 1000, record: false }).L;
  let dab = 0, dac = 0; for (let i = 0; i < a.length; i++) { dab = Math.max(dab, Math.abs(a[i] - b[i])); dac = Math.max(dac, Math.abs(a[i] - c[i])); }
  check('8 same output at buffer sizes 1, 64, 1000', dab === 0 && dac === 0, 'max diff ' + Math.max(dab, dac));
  const d = render(p, 0.6, { record: false }).L, e = render(p, 0.6, { record: false }).L;
  let dde = 0; for (let i = 0; i < d.length; i++) dde = Math.max(dde, Math.abs(d[i] - e[i]));
  check('8 same seed, same output', dde === 0);
  const f = render(Object.assign({}, p, { seed: 2 }), 0.6, { record: false }).L;
  let ddf = 0; for (let i = 0; i < d.length; i++) ddf = Math.max(ddf, Math.abs(d[i] - f[i]));
  check('8 another seed, another file', ddf > 1e-3);
}

// Sanity: every preset and the parameter extremes stay finite, and the song keeps time
{
  let bad = [];
  for (const pr of PRESETS) {
    const r = render(pr.p, 1.0, { record: false, note: pr.note });
    let pk = 0, nan = false; for (const x of r.L) { if (!Number.isFinite(x)) nan = true; pk = Math.max(pk, Math.abs(x)); }
    if (nan || pk === 0) bad.push(pr.name + (nan ? ' (NaN)' : ' (silent)'));
  }
  check('presets render, finite and not silent', bad.length === 0, bad.join(', '));
  bad = [];
  for (const id of ['teeth', 'spacing', 'jitter', 'gaps', 'height', 'escapement', 'toothtime', 'ring', 'speed', 'curve', 'arc', 'rate', 'chirp', 'chirprate', 'tune']) {
    const d = PARAMS.find(q => q.id === id);
    for (const v of [d.min, d.max]) for (const note of [0, 127]) {
      const r = render({ [id]: v, keytrack: 1 }, 0.4, { record: false, note });
      for (const x of r.L) if (!Number.isFinite(x)) { bad.push(id + '=' + v + ' note ' + note); break; }
    }
  }
  check('parameter extremes stay finite', bad.length === 0, bad.join(', '));
  // chirps: 4 strokes per chirp, 2.5 chirps per second → 10 strokes over 1 s from the note
  const r = render({ keytrack: 0, chirp: 4, chirprate: 2.5, rate: 30 }, 1.0);
  check('song: 4-stroke chirps at 2.5 per second', r.e.strokes === 12, r.e.strokes + ' strokes in 1 s (3 chirps started)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
