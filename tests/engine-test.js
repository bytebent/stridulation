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

const SR = 48000, TWO_PI = 2 * Math.PI;
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
const ONE = f0 => ({ keytrack: 1, tune: tuneFor(f0), _note: noteFor(f0), chirp: 0, rate: 1, jitter: 0, spacing: 0.4, teeth: 120, arc: 0.8,
  wings: 0, glide: 0, nonlinear: 0, secondlevel: -48, loudness: 0 });   // the contact alone (batch 02)

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

// ---- batch 04: the full radiator, pitch lock, loudness ----
const relStrokes = e => {                       // release events grouped by stroke (gaps over 4 ms)
  const r = e.rec.filter(x => x.type === 'release'), out = []; let cur = [];
  for (let i = 0; i < r.length; i++) { if (i && r[i].t - r[i - 1].t > 0.004) { out.push(cur); cur = []; } cur.push(r[i]); }
  if (cur.length) out.push(cur); return out;
};
const rateOf = (s, a, b, f0) => { const n = s.length, m = s.slice(Math.floor(n * a), Math.floor(n * b)); return (m.length - 1) / (m[m.length - 1].t - m[0].t) / f0; };

// Glide: the wing is tuned by the plectrum's place on the file (Bennet-Clark 2003), so a locked
// clockwork's pitch falls through the second half of the stroke by about Glide
{
  const f0 = 4700, base = Object.assign(ONE(f0), { escapement: 1, speed: 2, wings: 8, nonlinear: 0.2 });
  for (const glide of [-10, -20]) {
    const s = relStrokes(render(Object.assign({}, base, { glide }), 0.2).e)[0];
    const start = rateOf(s, 0.05, 0.35, f0), end = rateOf(s, 0.85, 0.97, f0), fall = end / start - 1;
    check(`glide ${glide}%: locked pitch falls by about that through the stroke`, Math.abs(fall * 100 - glide) < 0.35 * Math.abs(glide), 'fall ' + pct(fall));
  }
}

// Two wings: one per side with Spread; detuned, they beat in the free tail
{
  const f0 = 4700, p = Object.assign(ONE(f0), { escapement: 1, speed: 2, tick: 0 });
  const a = render(Object.assign({}, p, { wings: 8, spread: 1 }), 0.12, { record: false });
  const b = render(Object.assign({}, p, { wings: 8, spread: 0 }), 0.12, { record: false });
  let dLR = 0, dB = 0; for (let i = 0; i < a.L.length; i++) { dLR = Math.max(dLR, Math.abs(a.L[i] - a.R[i])); dB = Math.max(dB, Math.abs(b.L[i] - b.R[i])); }
  check('wings: Spread 1 puts the two wings on different sides, Spread 0 is mono', dLR > 1e-3 && dB === 0);
  // tail envelope: per-cycle peaks after the stroke; beating shows as a non-monotonic envelope
  const tailBumps = r => {
    const L = r.L, per = Math.round(SR / f0); let last = 0; for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-3) last = i;
    const pk = []; for (let i = Math.floor(0.025 * SR); i + per < L.length; i += per) { let m = 0; for (let j = i; j < i + per; j++) m = Math.max(m, Math.abs(L[j])); pk.push(m); }
    let bumps = 0; for (let k = 2; k < pk.length - 2; k++) if (pk[k] > 1e-4 && pk[k] > pk[k - 1] * 1.05 && pk[k] > pk[k + 1]) bumps++;
    return bumps;
  };
  const beat = tailBumps(render(Object.assign({}, p, { wings: 20, spread: 0.5 }), 0.12, { record: false }));
  const flat = tailBumps(render(Object.assign({}, p, { wings: 0, spread: 0.5 }), 0.12, { record: false }));
  check('wings: detuned wings beat in the free tail, matched wings do not', beat >= 2 && flat === 0, beat + ' envelope bumps at 20% detune, ' + flat + ' at 0%');
}

// Second mode and body add energy where they should
{
  const f0 = 4700, p = Object.assign(ONE(f0), { escapement: 1, speed: 2, tick: 0, volume: -24 });
  const bandDb = (L, f) => { let re = 0, im = 0; const n = L.length; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(TWO_PI * i / n); re += L[i] * w * Math.cos(TWO_PI * f * i / SR); im += L[i] * w * Math.sin(TWO_PI * f * i / SR); } return 10 * Math.log10((re * re + im * im) / n / n + 1e-30); };
  const off = render(Object.assign({}, p, { secondlevel: -48, second: 2.7 }), 0.06, { record: false }).L;
  const on = render(Object.assign({}, p, { secondlevel: 0, second: 2.7 }), 0.06, { record: false }).L;
  const gain = bandDb(on, 2.7 * f0) - bandDb(off, 2.7 * f0);
  check('second mode: energy appears at Second × the carrier', gain > 10, '+' + gain.toFixed(1) + ' dB at 2.7× carrier');
  const ant = { escapement: 0, speed: 1, ring: 0.7, bodytone: 1000, tick: 0, volume: -24 };
  const nb = render(Object.assign(ONE(f0), ant, { body: 0 }), 0.06, { record: false }).L;
  const wb = render(Object.assign(ONE(f0), ant, { body: 1 }), 0.06, { record: false }).L;
  const g1 = bandDb(wb, 1000) - bandDb(nb, 1000), g10 = bandDb(wb, 10000) - bandDb(nb, 10000);
  check('body: rings near Body tone and about 10× it (Masters et al. 1983)', g1 > 10 && g10 > 3, '+' + g1.toFixed(1) + ' dB at 1 kHz, +' + g10.toFixed(1) + ' dB at 10 kHz');
}

// Frame Close (experimental, off by default): with Nonlinear, an off-tune cog rattle doubles its
// period — partials appear halfway between the tooth-rate harmonics (a sub-octave)
{
  check('frame is Normal by default', PARAMS.find(d => d.id === 'frame').def === 0);
  const f0 = 4700, half = frame => {
    const r = render(Object.assign(ONE(f0), { escapement: 0, speed: 0.8, chirp: 0, rate: 0.5, spacing: 0, teeth: 400, arc: 1, curve: 0, tick: 0, nonlinear: 1, ring: 30, height: 1, volume: -30, frame }), 0.3);
    const c = r.e.rec.filter(x => x.type === 'catch'), t0 = c[30].t, t1 = c[c.length - 30].t, tsr = (c.length - 61) / (t1 - t0);
    const L = r.L.subarray(Math.floor(t0 * SR), Math.floor(t1 * SR));
    const band = f => { let re = 0, im = 0; const n = L.length; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(TWO_PI * i / n); re += L[i] * w * Math.cos(TWO_PI * f * i / SR); im += L[i] * w * Math.sin(TWO_PI * f * i / SR); } return Math.sqrt(re * re + im * im); };
    return 20 * Math.log10((band(1.5 * tsr) + band(2.5 * tsr)) / (band(tsr) + band(2 * tsr)));
  };
  const normal = half(0), close = half(1);
  check('frame Close: period doubling, half-rate partials within 10 dB of the tooth-rate ones', close > -10 && normal < -20, 'Close ' + close.toFixed(1) + ' dB, Normal ' + normal.toFixed(1) + ' dB');
}

// Pitch lock (off by default) holds the note where the escapement pulls it sharp
{
  const f0 = 4700;
  check('pitch lock is off by default', PARAMS.find(d => d.id === 'pitchlock').def === 0);
  const cents = (p) => { const st = relStrokes(render(Object.assign(ONE(f0), { chirp: 0, rate: 8 }, p), 0.6).e); return 1200 * Math.log2(rateOf(st[Math.min(3, st.length - 1)], 0.2, 0.9, f0)); };
  for (const speed of [2.5, 2.8]) {
    const off = cents({ escapement: 1, speed, pitchlock: 0 }), on = cents({ escapement: 1, speed, pitchlock: 1 });
    check(`pitch lock, clockwork at Speed ${speed}: within 5 cents`, Math.abs(on) < 5, off.toFixed(1) + ' cents off without, ' + on.toFixed(1) + ' with');
  }
  const off = cents({ escapement: 0, speed: 1.3, pitchlock: 0 }), on = cents({ escapement: 0, speed: 1.3, pitchlock: 1 });
  check('pitch lock, cog rattle at Speed 1.3: within 25 cents', Math.abs(on) < 25, off.toFixed(1) + ' cents off without, ' + on.toFixed(1) + ' with');
}

// Loudness compensation evens out the level across regimes, without clipping
{
  const f0 = 4700, cases = [{ escapement: 1, speed: 2 }, { escapement: 0, speed: 1 }, { escapement: 0, speed: 2 }, { escapement: 1, speed: 6 },
    { escapement: 1, ring: 0.7 }, { escapement: 0, speed: 1, ring: 0.7, body: 1 }];
  const level = (p, amt) => {
    const L = render(Object.assign({ keytrack: 1, tune: tuneFor(f0), _note: noteFor(f0), chirp: 4, rate: 30, chirprate: 2.5, loudness: amt }, p), 2.5, { record: false }).L;
    let mx = 0; for (const x of L) mx = Math.max(mx, Math.abs(x));
    let s2 = 0, n = 0; for (let i = Math.floor(L.length * 0.3); i < L.length; i++) if (Math.abs(L[i]) > mx * 1e-3) { s2 += L[i] * L[i]; n++; }
    return { db: 10 * Math.log10(s2 / n), pk: mx };
  };
  const off = cases.map(p => level(p, 0)), on = cases.map(p => level(p, 1));
  const spread = a => Math.max(...a.map(x => x.db)) - Math.min(...a.map(x => x.db));
  const peak = Math.max(...on.map(x => x.pk));
  check('loudness: levels within 8 dB across six regimes (were spread over 20 dB)', spread(on) < 8 && spread(off) > 20, 'spread ' + spread(off).toFixed(1) + ' dB off, ' + spread(on).toFixed(1) + ' dB on');
  check('loudness: no clipping', peak < 0.9, 'peak ' + (20 * Math.log10(peak)).toFixed(1) + ' dBFS');
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
  for (const id of ['teeth', 'spacing', 'jitter', 'gaps', 'height', 'escapement', 'toothtime', 'ring', 'speed', 'curve', 'arc', 'rate', 'chirp', 'chirprate', 'tune',
      'wings', 'glide', 'nonlinear', 'frame', 'second', 'secondlevel', 'body', 'bodytone', 'spread', 'pitchlock', 'loudness']) {
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
