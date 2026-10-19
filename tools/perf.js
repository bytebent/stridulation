// Performance benchmark for the reference engine. Run: node tools/perf.js [seconds]
// Prints how much of one CPU core each scenario needs to run in real time at 48 kHz.
// This is the JS reference; the C++ port will be faster, but the ratios between scenarios carry over.
'use strict';
const path = require('path');
const { StridulationEngine } = require(path.join(__dirname, '..', 'reference', 'stridulation-engine.js'));

const SR = 48000, SECS = +process.argv[2] || 3, BL = 128;
const chord8 = [60, 64, 67, 71, 72, 76, 79, 83];
const TRILL = { chirp: 0, rate: 60, arc: 1, teeth: 400 };       // strokes back to back: always sounding
const SCENARIOS = [
  ['Silent (no notes)', {}, []],
  ['1 voice, defaults (chirps)', {}, [88]],
  ['1 voice, clockwork trill, 5 kHz', Object.assign({ escapement: 1 }, TRILL), [88]],
  ['1 voice, clockwork trill, 15 kHz', Object.assign({ escapement: 1 }, TRILL), [107]],
  ['1 voice, cog rattle trill, Speed 8, 15 kHz', Object.assign({ escapement: 0, speed: 8 }, TRILL), [107]],
  ['1 voice, slow scrape, long pulses', { escapement: 0, speed: 0.03, chirp: 0, rate: 0.5, toothtime: 1000 }, [88]],
  ['4 voices, clockwork trill', Object.assign({ escapement: 1, poly: 1 }, TRILL), chord8.slice(0, 4)],
  ['8 voices, defaults (chirps)', { poly: 1 }, chord8],
  ['8 voices, clockwork trill, high notes', Object.assign({ escapement: 1, poly: 1 }, TRILL), chord8.map(n => n + 24)],
];

function run(params, notes) {
  const e = new StridulationEngine(SR, 1);
  if (params.poly !== undefined) e.setParam('poly', params.poly);
  for (const k in params) e.setParam(k, params[k]);
  for (const n of notes) e.noteOn(n, 100);
  const L = new Float32Array(BL), R = new Float32Array(BL);
  for (let i = 0; i < SR * 0.25; i += BL) e.process(L, R, BL);          // warm up the JIT
  const total = Math.round(SR * SECS / BL) * BL;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < total; i += BL) e.process(L, R, BL);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return ms / (total / SR * 1000);                                        // share of real time
}

const rows = [];
for (const [name, p, notes] of SCENARIOS) {
  const best = Math.min(run(p, notes), run(p, notes));                   // best of two, less noise
  rows.push([name, best]);
}
const w = Math.max(...rows.map(r => r[0].length));
console.log('stridulation reference engine · ' + SR / 1000 + ' kHz · ' + SECS + ' s per run · Node ' + process.version);
console.log('Scenario'.padEnd(w) + '  CPU   x real time');
for (const [name, f] of rows) console.log(name.padEnd(w) + '  ' + (f * 100).toFixed(1).padStart(4) + '%  ' + (1 / f).toFixed(0).padStart(5) + 'x');
