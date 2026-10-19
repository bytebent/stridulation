// Renders every test preset to a stereo WAV for listening. Run: node tools/render-presets.js [outDir]
// Each file is normalised to a −6 dBFS peak; the printed level is the engine's own, before that.
'use strict';
const fs = require('fs'), path = require('path');
const { StridulationEngine } = require(path.join(__dirname, '..', 'reference', 'stridulation-engine.js'));
const { PRESETS } = require(path.join(__dirname, '..', 'reference', 'presets.js'));
const out = process.argv[2] || path.join(__dirname, '..', 'renders');
fs.mkdirSync(out, { recursive: true });
const sr = 48000, hold = 3.0, tail = 0.5;
for (const pr of PRESETS) {
  const e = new StridulationEngine(sr, 1);
  for (const k in pr.p) e.setParam(k, pr.p[k]);
  const n = Math.round(sr * (hold + tail)), L = new Float32Array(n), R = new Float32Array(n);
  const bl = 128, tl = new Float32Array(bl), tr = new Float32Array(bl);
  e.noteOn(pr.note, 100);
  for (let i = 0; i < n; i += bl) {
    if (i <= hold * sr && i + bl > hold * sr) e.noteOff(pr.note);
    const m = Math.min(bl, n - i); e.process(tl, tr, m);
    L.set(tl.subarray(0, m), i); R.set(tr.subarray(0, m), i);
  }
  let pk = 0; for (const x of L) pk = Math.max(pk, Math.abs(x));
  const g = pk > 0 ? 0.5 / pk : 1;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
  }
  const name = pr.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.wav';
  fs.writeFileSync(path.join(out, name), buf);
  console.log(name.padEnd(42) + 'engine peak ' + (20 * Math.log10(pk)).toFixed(1) + ' dBFS');
}
