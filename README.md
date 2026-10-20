# stridulation

An insect voice synth by bytebent. A scraper is dragged across a toothed file and rings a resonant
wing or body, the way crickets, katydids, grasshoppers, beetles and ants make sound. One physical
contact model runs from a **cog rattle**, where wing speed and tooth spacing set the pitch, to a
**clockwork**, where the ringing wing holds the scraper back and releases one tooth per cycle, so
the wing sets the pitch. A softer scraper gives the stick-slip bursts of bark beetles and
ultrasonic katydids.

Status: **prototype, batch 06 of 10**. The reference engine has the file, the force-driven
stroke, the plectrum with its escapement and its spring, two wings joined through the plectrum,
glide, a second mode, the body, loudness compensation, Pitch lock, and the Temperature, Size and
Ultra macros, the song engine (chirps, phrases, rubato, tempo sync), two limbs, Scrape mode,
swell, glide and four LFOs. Field and tree crickets, a mole cricket, katydids (one of them
Jurassic, one ultrasonic), bark beetles, a leafcutter ant and two grasshoppers are test presets.
Next: the browser bench.

## Try it

Needs Node 18 or newer. No packages to install.

```sh
node tests/engine-test.js        # engine tests
node tools/render-presets.js     # test presets → renders/*.wav
node tools/perf.js               # CPU per scenario
```

## Performance

`node tools/perf.js` prints how much of one CPU core each scenario needs at 48 kHz. On a 2.1 GHz
Xeon core: 4–7% per voice, about 32% for 8 voices trilling at high notes, 48% at the worst case
(8 voices, two limbs, opening strokes, body, second mode, four LFOs). The machine's noise is
about ±4 points. Poly has 8 voices.

## Files

- `design.md`: what stridulation is and how it works, with every parameter
- `plan.md`: build batches, in order
- `research.md`: the papers behind the design and the numbers taken from them
- `tests.md`: test and experiment results per batch

The design doc is *stridulation: design and architecture*. `design.md` is this repo's copy.

## Layout

- `reference/stridulation-engine.js`: the reference engine; defines the sound
- `reference/presets.js`: test presets (renders and tests only)
- `tests/engine-test.js`: engine tests
- `tools/render-presets.js`, `tools/perf.js`: preset renders, benchmark

Later (see `plan.md`):

- `source/StridulationDSP.h`: C++ port, real-time safe, no JUCE dependency
- `source/PluginProcessor.*`, `source/PluginEditor.*`, `ui/index.html`: JUCE instrument and its
  web-view interface
- `tests/`: C++ against reference comparison, plugin wrapper test
- `tools/bench/`: bench (`stridulation.html`)

## License note

The plugin will be built with [JUCE](https://juce.com) 8, which is available under the AGPLv3
or a commercial licence. Keeping this repository public and open source satisfies the AGPL.
