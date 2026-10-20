/*
 * stridulation test presets · bytebent
 *
 * Starting points for listening checks and tests. Used by tests/engine-test.js and
 * tools/render-presets.js (and the bench, once it exists); left out of the plugin build.
 * Each preset lists only what differs from the defaults. Carriers use Keytrack off (4.7 kHz)
 * plus Tune, so they land exactly on the measured value.
 *
 * Batch 02 set: the field cricket at several Escapement settings, plus the behaviours the
 * contact model should show (Koch et al. 1988; Bennet-Clark & Bailey 2002; Bennet-Clark 2003).
 */
(function (root) {
  'use strict';
  const st = hz => 12 * Math.log2(hz / 4700);
  // Gryllus campestris: 5 kHz, 3–4 pulse chirps, Q 25 (Bennet-Clark & Bailey 2002, Table 1)
  const FIELD = { keytrack: 0, tune: st(5000), teeth: 120, arc: 0.8, ring: 25, rate: 30, chirp: 4, chirprate: 2.5, speed: 2 };
  const PRESETS = [
    { name: '01 Field cricket, clockwork', note: 60, p: Object.assign({}, FIELD, { escapement: 1 }) },
    { name: '02 Field cricket, escapement 0.6', note: 60, p: Object.assign({}, FIELD, { escapement: 0.6 }) },
    { name: '03 Field cricket, escapement 0.3', note: 60, p: Object.assign({}, FIELD, { escapement: 0.3 }) },
    { name: '04 Field cricket, cog rattle', note: 60, p: Object.assign({}, FIELD, { escapement: 0, speed: 1 }) },
    { name: '05 Cog rattle, overdriven', note: 60, p: Object.assign({}, FIELD, { escapement: 0, speed: 2 }) },
    { name: '06 Clockwork, double speed', note: 60, p: Object.assign({}, FIELD, { escapement: 1, speed: 6 }) },
    { name: '07 Clockwork, damaged file', note: 60, p: Object.assign({}, FIELD, { escapement: 1, gaps: 0.12, jitter: 0.2 }) },
    { name: '08 Clockwork, harps removed', note: 60, p: Object.assign({}, FIELD, { escapement: 1, ring: 0.7 }) },
    { name: '09 Slow scrape, separate ticks', note: 60, p: Object.assign({}, FIELD, { escapement: 0, speed: 0.03, chirp: 0, rate: 0.3, ring: 8, tick: 0.6 }) },
    // Teleogryllus oceanicus: 252 teeth, closer at the start, song 4.8 kHz (Bennet-Clark 2003)
    { name: '10 Teleogryllus, long file', note: 60, p: Object.assign({}, FIELD, { tune: st(4800), teeth: 252, spacing: 0.5, arc: 0.45, escapement: 1, chirp: 4, rate: 25, chirprate: 1.5 }) },
    // batch 04
    // Atta sexdens: no radiating wing; each strike rings the gaster near 1 and 10 kHz, Q 1–3,
    // strikes about 1.7 ms apart, ~50 ms strokes about five per second (Masters et al. 1983)
    { name: '11 Leafcutter ant, body only', note: 60, p: { keytrack: 0, tune: st(590), escapement: 0, speed: 1, ring: 0.7, body: 1, bodytone: 1050, teeth: 30, arc: 1, spacing: 0, chirp: 0, rate: 5, wings: 0, glide: 0, secondlevel: -48, tick: 0.3 } },
    { name: '12 Field cricket, wide wings and glide', note: 60, p: Object.assign({}, FIELD, { escapement: 1, wings: 20, glide: -20, nonlinear: 0.6, spread: 1, secondlevel: -18 }) },
    { name: '13 Clockwork pushed sharp, pitch lock', note: 60, p: Object.assign({}, FIELD, { escapement: 1, speed: 2.8, pitchlock: 1, chirp: 0, rate: 8 }) },
    // experimental: Frame Close with Nonlinear, driven off tune, doubles its period (a sub-octave)
    { name: '14 Frame Close, sub-octave (experimental)', note: 60, p: Object.assign({}, FIELD, { escapement: 0, speed: 0.8, frame: 1, nonlinear: 1, height: 1, ring: 30, spacing: 0, teeth: 300, chirp: 0, rate: 4, wings: 0, glide: 0 }) },
    // batch 05: archetypes (grasshoppers wait for two limbs in batch 06)
    // Gryllotalpa gryllotalpa: 1.7 kHz long trill, glide under 6% (Bennet-Clark & Bailey 2002)
    { name: '15 Mole cricket', note: 60, p: { keytrack: 0, tune: st(1700), escapement: 1, teeth: 60, arc: 0.3, chirp: 0, rate: 40, glide: -5, wings: 4 } },
    // Oecanthus nigricornis: no escapement, 43 teeth, carrier 3.0 kHz at 15 °C to 4.6 kHz at 32 °C,
    // 25–65 pulses per second (Sismondo 1993). The tree-cricket wing is a broad plate (Mhatre et al.
    // 2012), so the wing is set broad here (Ring 6) to follow the tooth rate, not Sismondo's Q 25–35
    { name: '16 Tree cricket at 15 °C', note: 60, p: { keytrack: 0, tune: st(4000), escapement: 0, speed: 1.1, curve: 0.3, teeth: 43, spacing: 0, arc: 0.9, ring: 6, nonlinear: 0.6, chirp: 0, rate: 50, temperature: 15, glide: 0, wings: 3 } },
    { name: '17 Tree cricket at 32 °C', note: 60, p: { keytrack: 0, tune: st(4000), escapement: 0, speed: 1.1, curve: 0.3, teeth: 43, spacing: 0, arc: 0.9, ring: 6, nonlinear: 0.6, chirp: 0, rate: 50, temperature: 32, glide: 0, wings: 3 } },
    // Tympanophora similis: a bush cricket with a nearly pure 6.5 kHz song, glide 7.7% (Bennet-Clark & Bailey 2002)
    { name: '18 Pure-tone katydid', note: 60, p: { keytrack: 0, tune: st(6500), escapement: 0.7, teeth: 90, arc: 0.6, chirp: 3, rate: 25, chirprate: 1.5, glide: -8, wings: 0, rubato: 0.3 } },
    // Dendroctonus valens: spring stridulation, ~63 teeth, ~695 pulses/s, peaks near 7 and 30 kHz;
    // simple chirps of ~9 pulses, interrupted chirps from several catches (Lindeman & Yack 2019)
    { name: '19 Bark beetle, simple chirps', note: 60, p: { keytrack: 0, tune: st(7000), escapement: 0, spring: 0.8, speed: 0.12, curve: 0, teeth: 63, spacing: 0, jitter: 0.1, arc: 0.16, chirp: 0, rate: 3, ring: 2, body: 1, bodytone: 3000, glide: 0, wings: 0 } },
    { name: '20 Bark beetle, interrupted chirps', note: 60, p: { keytrack: 0, tune: st(7000), escapement: 0, spring: 0.8, speed: 0.12, curve: 0, teeth: 63, spacing: 0, jitter: 0.1, arc: 0.5, chirp: 0, rate: 2, ring: 2, body: 1, bodytone: 3000, glide: 0, wings: 0 } },
    // Arachnoscelis: 128 kHz, 62–64 teeth, elastic scraper slipping ~8 teeth at a time, trains of
    // 5–13 short pulses ~2.2 ms apart (Montealegre-Z et al. 2006, via the brief); heard through Ultra ÷10,
    // fully time-expanded (Time 1) like a bat detector
    { name: '21 Ultrasonic katydid (Ultra ÷10)', note: 127, p: { keytrack: 1, tune: 12 * Math.log2(128000 / 12543.85), ultra: 10, ultratime: 1, escapement: 0, spring: 0.999, speed: 1, curve: 0, teeth: 64, spacing: 0, arc: 1, chirp: 0, rate: 30, ring: 20, glide: 0, wings: 0 } },
    // Archaboilus musicus (Jurassic): symmetric wings, pure tone at 6.4 kHz, ~16 ms pulses (Gu et al. 2012, via the brief)
    { name: '22 Jurassic katydid', note: 60, p: { keytrack: 0, tune: st(6400), escapement: 1, teeth: 107, arc: 0.95, chirp: 0, rate: 3, wings: 0, glide: -5 } },
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = { PRESETS };
  else root.STRIDULATION_PRESETS = PRESETS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
