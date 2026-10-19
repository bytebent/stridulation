# stridulation

An insect voice synth by bytebent. A scraper is dragged across a toothed file and rings a resonant
wing or body, the way crickets, katydids, grasshoppers, beetles and ants make sound. One physical
contact model runs from a **cog rattle**, where wing speed and tooth spacing set the pitch, to a
**clockwork**, where the ringing wing holds the scraper back and releases one tooth per cycle, so
the wing sets the pitch. A softer scraper gives the stick-slip bursts of bark beetles and
ultrasonic katydids.

Status: **prototype, batch 03 of 10**. The reference engine has the file, the force-driven
stroke, the plectrum with its escapement and one wing: a field cricket locks one tooth per wing
cycle, doubles its speed when overdriven, and becomes a cog rattle with Escapement at 0. Next:
the full radiator (two wings, glide, body), loudness compensation and Pitch lock.

## Try it

Needs Node 18 or newer. No packages to install.

```sh
node tests/engine-test.js        # engine tests
node tools/render-presets.js     # test presets → renders/*.wav
node tools/perf.js               # CPU per scenario
```

## Performance

`node tools/perf.js` prints how much of one CPU core each scenario needs at 48 kHz. On a 2.1 GHz
Xeon core: about 1.6% per voice, 12.5% for 8 voices trilling at high notes. The wing's
integration is about a quarter of that; the full design (two nonlinear wings, a body, two
limbs) is projected near 27% for 8 voices. Poly has 8 voices.

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
