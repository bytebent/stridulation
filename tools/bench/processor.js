/* AudioWorklet wrapper: stridulation engine → stereo output. Runs after stridulation-engine.js. */
class StridulationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.eng = new StridulationEngine(sampleRate, 1);
    this.vizEvery = Math.round(sampleRate / 30);
    this.vizCount = 0; this.vizRead = 0; this.strokeT = 0; this.lastCatches = 0; this.fileSent = -1;
    // DSP load: time spent in the engine / length of audio produced. performance.now() where the
    // worklet has it; otherwise Date.now(), whose 1 ms steps average out over half a second
    this.hiRes = typeof performance !== 'undefined' && typeof performance.now === 'function';
    this.clock = this.hiRes ? () => performance.now() : () => Date.now();
    this.busyMs = 0; this.audioMs = 0; this.load = 0; this.peak = 0; this.winPeak = 0; this.peakAge = 0;
    this.port.onmessage = (e) => {
      const m = e.data, eng = this.eng;
      if (m.t === 'p') eng.setParam(m.id, m.v);
      else if (m.t === 'many') { for (const k in m.p) eng.setParam(k, m.p[k]); }
      else if (m.t === 'on') eng.noteOn(m.n, m.v);
      else if (m.t === 'off') eng.noteOff(m.n);
      else if (m.t === 'bend') eng.setBend(m.v);
      else if (m.t === 'wheel') eng.setModWheel(m.v);
      else if (m.t === 'press') eng.setPressure(m.v);
      else if (m.t === 'tempo') eng.setTempo(m.v);
      else if (m.t === 'panic') eng.allNotesOff();
    };
    this.port.postMessage({ t: 'ready', sr: sampleRate, latency: StridulationEngine.LATENCY });
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] || null, n = l.length;
    const t0 = this.clock();
    this.eng.process(l, r, n);
    const spent = this.clock() - t0, len = n / sampleRate * 1000;
    this.busyMs += spent; this.audioMs += len;
    if (this.hiRes && spent / len > this.winPeak) this.winPeak = spent / len;
    if (this.audioMs >= 500) {
      this.load = this.busyMs / this.audioMs; this.busyMs = 0; this.audioMs = 0;
      // peak: the slowest single callback, held for 2 s
      if (this.winPeak >= this.peak || ++this.peakAge >= 4) { this.peak = this.winPeak; this.peakAge = 0; }
      this.winPeak = 0;
    }
    // time the shown voice spends stroking, so the tooth rate is the rate within a stroke
    let stroking = false; for (const x of this.eng.voices) if (x.stage !== 0) for (const lb of x.limbs) if (lb.stroking || lb.follow) stroking = true;
    if (stroking) this.strokeT += n / sampleRate;
    this.vizCount += n;
    if (this.vizCount >= this.vizEvery) {
      const e = this.eng, dt = this.vizCount / sampleRate;
      this.vizCount = 0;
      // the newest sounding voice is the one shown
      let v = null; for (const x of e.voices) if (x.stage !== 0 && (!v || x.age > v.age)) v = x;
      const msg = { t: 'stat', voices: e.info.voices, load: this.load, peak: this.hiRes ? this.peak : -1,
        toothRate: this.strokeT > 0 ? (e.catches - this.lastCatches) / this.strokeT : 0, strokeShare: this.strokeT / dt, f0: v ? v.f0 : 0, wf: v ? v.wf / (2 * Math.PI) : 0,
        voice: v ? v.index : -1, limbs: [], ev: [],
        lfo: { t: Array.from(e.lfoTarget), ph: Array.from(e.lfoPhase), y: Array.from(e.lfoSm) } };
      this.lastCatches = e.catches; this.strokeT = 0;
      if (v) for (const lb of v.limbs) {
        const f = lb.file;
        if ((lb.stroking || lb.follow) && f) msg.limbs.push({ x: (lb.dir > 0 ? lb.u : f.length - lb.u) / f.length, dir: lb.dir, i: lb.idx });
      }
      // tooth events since the last frame (only the shown voice)
      const z = e.viz; let from = this.vizRead; if (z.w - from > 1023) from = z.w - 1023;
      for (let k = from; k < z.w; k++) { const j = k & 1023; if (v && z.voice[j] === v.index) msg.ev.push(z.tooth[j], z.kind[j], z.limb[j]); }
      this.vizRead = z.w;
      // the file itself, when it changes
      if (e.fileVersion !== this.fileSent && e.file && e.file.n > 0) {
        const f = e.file, pos = new Float32Array(f.n), h = new Float32Array(f.n);
        for (let k = 0; k < f.n; k++) { pos[k] = f.pos[k] / f.length; h[k] = f.h[k]; }
        msg.file = { pos, h }; this.fileSent = e.fileVersion;
      }
      this.port.postMessage(msg);
    }
    return true;
  }
}
registerProcessor('stridulation-processor', StridulationProcessor);
