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
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = { PRESETS };
  else root.STRIDULATION_PRESETS = PRESETS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
