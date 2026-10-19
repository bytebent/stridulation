# stridulation · tests

Quick results per batch: tests, experiments and pictures. Pictures live in `docs/tests/`. Run the
tests with `node tests/engine-test.js`. Test numbers refer to `design.md` §11.

**Now: 44 engine tests passing** (about 25 s). Benchmark: `node tools/perf.js`.

## Batch 04 · full radiator, loudness, pitch lock

Built: two wings (Sismondo's frame and membrane each, one per side with Spread), Wings detune,
a stiffening frame (Nonlinear), Glide by plectrum position, a Second mode per wing, the Body,
loudness compensation and Pitch lock.

Findings while building:

- **Two detuned wings cancel unless joined.** At ±4% either side of the note, one wing answers in
  phase and the other nearly against it. Joining the membranes through the plectrum (strong
  while engaged, 0.6 × w²; light when free, 0.02 × w²) gives them one shared mode, as Bennet-Clark
  (2003) found. The detune then shows as beating in the free tail. With that coupling the lock
  range is back to Speed 1.5–2.9, and double speed is clean at 6.
- **Stiffening.** Sismondo's X⁵ blew up at the frame's real amplitude (|X| 1.8 locked, 5.4
  overdriven). He notes a cubic works as well, so the frame now has a cubic spring that saturates
  at +300% stiffness. Stable at every setting.
- **Test 5 (n:m locks) is not reproduced yet.** Driving a cog rattle at 3/4 or 4/5 of the wing,
  this frame (2.5 × carrier, Q 3) gives only tooth-rate harmonics. With the frame moved to
  1.25 × carrier, Q 8, stiffening does bring strong period doubling (peaks at 1.5× and 2.5× the
  tooth rate), one of Sismondo's behaviours. But that frame broke double speed and the gap
  behaviour, so it was reverted. Nonlinear stays a subtle stiffening for now. [Open]
- **Second mode and Body** are two-pole resonators normalised to unit peak gain and fed like the
  wing, so their level holds across pitch. The Body's input is scaled by (carrier / 4.7 kHz)^0.6,
  since the tooth impulses grow as the carrier falls.
- **Pitch lock:** a keeper measures each release-to-release interval against the note (glided),
  then nudges the wing's tuning and the muscle's push together (±1200 cents, 0.08 per release).
- **Loudness compensation:** each voice learns its level while stroking (mean square, 40 ms of
  stroking time) and aims for 0.2 RMS. It is also capped so a voice's recent peak stays under 0.6,
  and any sample over 0.8 is pulled down at once, which matters for clicky sounds and a voice's
  first moments. A new voice starts from the last voice's gain. Velocity then sets the level
  explicitly.

![loudness](docs/tests/04-loudness.png)

Tests:

- Glide −10% and −20%: locked pitch falls 9.1% and 15.6% through the stroke. ✓
- Spread 1 puts the wings on different sides, Spread 0 is mono. ✓
- 20% detune: 7 bumps in the free-tail envelope; matched wings: none. ✓
- Second mode at 0 dB: +31 dB at 2.7 × carrier. ✓
- Body: +47 dB at 1 kHz and +29 dB at 10 kHz (Ring 0.7, Body tone 1 kHz). ✓
- Pitch lock off by default. Clockwork at Speed 2.5: 44.6 → −1.7 cents; at 2.8: 80.3 → −3.0. Cog
  rattle at Speed 1.3: 331 → −18.5 cents (the rest is Curve's swell within the stroke). ✓
- Loudness: six regimes spread 23.1 dB off, 5.7 dB on; peak −5.6 dBFS. ✓
- Batch 02's contact tests run with Wings, Glide, Nonlinear and Second off, to test the contact
  alone; the defaults still lock (0.995 of the carrier at Speed 2).

Cost now (`tools/perf.js`): 1 voice 3–6%, 8 voices trilling at high notes 26.7%. That matches the
batch 03 projection before the second limb.

New presets: 11 leafcutter ant (body only), 12 field cricket with wide wings and glide, 13 a
clockwork pushed sharp with Pitch lock on.

**You:** listen to 01–13; decide whether Nonlinear's period doubling is worth a different frame.

## Batch 03 · cost

- `tools/perf.js` (one 2.1 GHz Xeon core, 48 kHz):

  | Scenario | CPU |
  |---|---|
  | Silent | 0.3% |
  | 1 voice, defaults (chirps) | 2–3% |
  | 1 voice, clockwork trill, 5 kHz | 2.6% |
  | 1 voice, clockwork trill, 15 kHz | 2.5% |
  | 1 voice, cog rattle, Speed 8, 15 kHz | 3.0% |
  | 4 voices, clockwork trill | 6.3% |
  | 8 voices, defaults | 11.1% |
  | 8 voices, clockwork trill, high notes | 12.5% |

- Where it goes: the wing integration is about a quarter of a voice (8 voices: 13.1% with it,
  9.5% without). The rest is the contact, the song clock and the 4× decimation.
- Projection for the full voice: three times the wing work (two nonlinear wings and a body) puts
  8 voices at 21%; a second limb adds roughly another contact, so about 27% at the worst case.
  Syrinx needs 40% for 4 voices.
- RK4 step rule: one sub-step per 0.5 rad of the frame's frequency per internal sample. Free-ring
  pitch error under 0.1 cent from 2 to 30 kHz at this rule, the same as at 0.25. Kept.
- The stroke uses implicit Euler, stable at any step: no sub-steps. The soft plectrum of Spring
  (batch 05) gets its own step rule there.
- Decided: Poly has 8 voices.

## Batch 02 · contact and one wing

Experiments before building (a scratch prototype of stroke, plectrum and wing):

- A release law based on force alone (hold more while the file is low) never locked: the plectrum
  met the next tooth while the file was still high and let go again, so the rate ran free.
- What locks is Bennet-Clark & Bailey's phase picture. Release near the top of the file's swing,
  only after the file has swung back down since the last release (re-arming). A plectrum that
  meets a tooth within half a cycle of a release, while the file is still high, slides over it.
  That slide is what gives Koch's double speed.
- The wing must be light (inertia about 0.1 carrier cycle), or it overshoots into a tooth and
  forces releases at any phase.
- The escapement reads the file's vibration, not its steady deflection under load (high-passed at
  carrier / 4). Without that, a heavily damped wing deadlocked against one tooth.
- Its authority scales with the wing's Q (half at Q 5): a wing that doesn't ring can't regulate,
  so Ring near 0.7 behaves like Koch's crickets with the harps removed.
- The phase it reads is advanced by one internal sample. Without that, the lock pitch drifted
  with the carrier, from 1.5% sharp at 300 Hz to 1.3% flat at 15 kHz.

![lock](docs/tests/02-lock.png)

The sweep (4.7 kHz carrier, one 96-tooth stroke):

- **Escapement 1:** one tooth per cycle from Speed 1.2 to 2.9, pitch −4% to +7.5%. Below that it
  locks at one tooth every two cycles, still on the carrier. Between 3.2 and 5.5 it slips: the
  tooth rate climbs and the pitch follows it. Near 6 it locks again at two teeth per cycle.
- **Escapement 0:** the tooth rate follows Speed.
- Koch et al. saw only normal and exactly double speed, never in between. The slipping band
  between them is the model's; worth hearing in the listening round.

![pulses](docs/tests/02-pulses.png)

Tests:

- 1 Clockwork, one tooth per cycle, at 300 Hz, 1, 4.7, 10 and 15 kHz: 1.004–1.041. ✓
- 1 Tooth rate = carrier within 2%: worst +1.7% at 300 Hz, +0.7% at 4.7 kHz, −0.2% at 15 kHz. ✓
- 1 Speed ∝ spacing through the origin with slope = carrier (Koch et al., Fig. 5): r² 0.993–0.999,
  slope within 2.6%. ✓
- 2 Speed 6: 1.98 teeth per cycle, stroke 1.95× faster, pitch +9% (Speed 2: 1.02). ✓
- 2 Cog rattle: tooth rate 0.97× carrier at Speed 1, 1.45× at Speed 1.5. ✓
- 3 Gaps: the wing crosses a missing tooth faster than its normal speed (slowest 1.23×), takes one
  half-cycle catch to find the phase, then runs one tooth per cycle again (7 of 7). ✓
- 3 Harps removed (Ring 0.7): stroke 1.78× faster. The factor is the free speed (Speed 2 here);
  Koch's "up to 3×" corresponds to a cricket pushing at Speed 3. ✓
- 6 Free decay Q: 10.1, 25.1, 40.1 for Ring 10, 25, 40. ✓
- 8 Same output at buffer sizes 1, 64, 1000; same seed same output; another seed another file. ✓
- Presets finite and not silent; parameter extremes finite at notes 0 and 127; chirp timing. ✓

Notes for the listening round:

- **Pitch rises with drive** when locked: +0.6% at Speed 2, +2.7% at 2.5, +7.5% at 2.9.
  Physically right: an escapement pulls its regulator, and Sismondo puts the limit near 15%.
  Decided: a pitch-locked mode, off by default (batch 04).
- **Levels follow the physics.** A locked clockwork is about 18 dB louder than a cog rattle at the
  same carrier, and a slow scrape (Speed 0.03) sits near −52 dBFS. Decided: loudness compensation
  (batch 04).
- Speed now runs 0.01–8 (was 0.25–4 in the design) and defaults to 2, the middle of the lock.

Renders: `node tools/render-presets.js` writes the ten presets to `renders/`, each normalised to
−6 dBFS. It prints each engine's own level.

**You:** listen to 01–03 (Escapement 1, 0.6, 0.3), 04–05 (cog rattle), 06 (double speed),
07 (damaged file), 08 (harps removed), 09 (separate ticks), 10 (*Teleogryllus*).
