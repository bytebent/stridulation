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
| 02 | **Contact and one wing** | Tooth table, force-driven stroke, plectrum tip and the release law, one linear wing (frame + membrane), sub-sample event writer, Tick. Test runner. | Tests 1, 2, 3, 6, 8 · **You:** listen to the field cricket at several Escapement settings | |
| 03 | **Cost** | `perf.js` at the worst case (Clockwork and Spring, high carrier, two wings, body, two limbs). Decides the step rule for stroke and tip and the Poly voice count. | Numbers in the README | |
| 04 | **Full radiator** | Nonlinear frame, two wings with Wings detune, Glide by file position, Second mode, Body. | Tests 4 (escapement half), 5 | |
| 05 | **Spring and macros** | Spring contact, Temperature, Size, Ultra and Time. | Tests 4, 7 · **You:** listen to the ten archetypes | |
| 06 | **Song, limbs, Scrape** | Pattern engine (Rate, Chirp, Chirp rate, Phrase, Rubato, Sync), Arc and Arc growth, Open, Shape, two limbs with Lag and Swap, Scrape mode, Swell, Glide, four LFOs. | Tests: stroke timing exact at any buffer size; note-off finishes the stroke · **You:** listen | |
| 07 | **Bench** | `stridulation.html`: keyboard as on the other benches, notched Escapement and Spring knobs, live file view, test presets, DSP meter. | **You:** first listening round | |
| 08 | **C++ port** | `StridulationDSP.h`, `dsp_cli.cpp`, `compare.js`. | Tests: C++ matches the reference | |
| 09 | **Plugin** | JUCE wrapper, web-view UI with the live view, presets, installer, CI. | CI green · **You:** play it in a host | |
| 10 | **Listening round** | Tuning defaults and ranges from what you hear, against the reference recordings. | **You** | |
