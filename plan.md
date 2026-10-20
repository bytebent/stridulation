# stridulation · build plan

Reference engine and bench first, then the C++ port and the plugin. Design: `design.md`.

Each batch ends with passing tests and a commit authored as
`bytebent <bytebent@users.noreply.github.com>`. Nothing moves to the next batch until you've
checked the one before where it says **You**.

## Layout

```
reference/
  stridulation-engine.js   the reference engine; defines the sound
  presets.js               test presets (bench and tests only)
source/
  StridulationDSP.h        C++ port, no JUCE
  PluginProcessor.*        JUCE instrument: MIDI in, stereo out
  PluginEditor.*           web-view host
  PresetManager.h          saving and loading presets
ui/index.html              interface (also opens in a browser)
tests/                     engine-test.js, compare.js + dsp_cli.cpp, plugin_test.cpp
tools/
  bench/                   bench template, AudioWorklet wrapper, build script → stridulation.html
  perf.js                  CPU per scenario
  render-presets.js        every test preset to a WAV
packaging/                 Mac installer
.github/workflows/         CI: tests, universal binary, auval, pluginval strictness 7
```

## Batches

Test numbers refer to `design.md` §11.

| # | Batch | Contents | Check | State |
|---|---|---|---|---|
| 01 | **Setup** | `README.md`, `design.md`, `plan.md`, `research.md`, `tests.md`, `.gitignore`. | | Done |
| 02 | **Contact and one wing** | Tooth table, force-driven stroke, plectrum tip and the release law, one linear wing (frame + membrane), sub-sample event writer, Tick. Test runner. A basic song clock (Rate, Chirp, Chirp rate) so the cricket can be heard. | Tests 1, 2, 3, 6, 8 · **You:** listen to the field cricket at several Escapement settings | Done: 32 tests; locks one tooth per cycle at Speed 1.2–2.9, double speed near 6 · **You:** listen to presets 01–10 |
| 03 | **Cost** | `perf.js` at the worst case (Clockwork and Spring, high carrier, two wings, body, two limbs). Decides the step rule for stroke and tip and the Poly voice count. | Numbers in the README | Done: about 1.6% of a core per voice now, ~3.3% projected for the full voice; RK4 rule kept; Poly 8 voices |
| 04 | **Full radiator** | Nonlinear frame, two wings with Wings detune, Glide by file position, Second mode, Body. Loudness compensation. Pitch lock (off by default). | Tests 4 (escapement half), 5; level within a few dB across Escapement and Speed with compensation on; locked pitch within 5 cents with Pitch lock on · **You:** listen | Done: 44 tests; wings joined through the plectrum; loudness spread 23 → 6 dB; Pitch lock within 3 cents locked; test 5 (n:m locks) not reproduced; period doubling behind the experimental Frame switch · **You:** listen to presets 01–14 |
| 05 | **Spring and macros** | Spring contact, Temperature, Size, Ultra and Time. | Tests 4, 7 · **You:** listen to the ten archetypes | Done: 58 tests; spring fitted to *D. valens* (9.9 ms load, 9 pulses at 657/s); temperature ×1.53 like *Oecanthus*; eight archetype presets (grasshoppers in 06) · **You:** listen to presets 15–22 |
| 06 | **Song, limbs, Scrape** | Pattern engine (Rate, Chirp, Chirp rate, Phrase, Rubato, Sync), Arc and Arc growth, Open, Shape, two limbs with Lag and Swap, Scrape mode, Swell, Glide, four LFOs. | Tests: stroke timing exact at any buffer size; note-off finishes the stroke · **You:** listen | Done: 79 tests; voice rebuilt around limbs; new knobs Leg B and Pause; attack and release default to instant · **You:** listen to presets 23–25 |
| 07 | **Bench** | `stridulation.html`: keyboard as on the other benches, notched Escapement and Spring knobs, live file view, test presets, DSP meter. | **You:** first listening round | Done: `tools/stridulation.html`; live file view lights each tooth by how it was struck · **You:** first listening round |
| 08 | **C++ port** | `StridulationDSP.h`, `dsp_cli.cpp`, `compare.js`. | Tests: C++ matches the reference | |
| 09 | **Plugin** | JUCE wrapper, web-view UI with the live view, presets, installer, CI. | CI green · **You:** play it in a host | |
| 10 | **Listening round** | Tuning defaults and ranges from what you hear, against the reference recordings. | **You** | |

## Later: Frame Close (experimental)

Frame Close gives period doubling with Nonlinear but breaks double speed and the gap behaviour
(`tests.md`, batch 04). It ships as it is, behind the switch, off by default. Two fixes to try
later, not scheduled:

1. **Let Nonlinear move the frame.** At Nonlinear 0 the frame sits at 2.5 × the carrier (Normal);
   turned up, it slides toward 1.25 × and the sub-octave appears. The defaults and Koch's
   behaviours stay intact, and the cost is chosen by the player.
2. **Have the escapement read only the membrane.** Filter the frame's frequency out of the signal
   the release phase is read from, so the frame ringing near the note can't mistime releases.
   Might keep double speed clean even with the frame close.
