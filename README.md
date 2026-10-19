# stridulation

An insect voice synth by bytebent. A scraper is dragged across a toothed file and rings a resonant
wing or body, the way crickets, katydids, grasshoppers, beetles and ants make sound. One physical
contact model runs from a **cog rattle**, where wing speed and tooth spacing set the pitch, to a
**clockwork**, where the ringing wing holds the scraper back and releases one tooth per cycle, so
the wing sets the pitch. A softer scraper gives the stick-slip bursts of bark beetles and
ultrasonic katydids.

Status: **design**. Nothing is built yet. The reference engine and browser bench come first,
then the C++ port and the JUCE plugin.

## Files

- `design.md`: what stridulation is and how it works, with every parameter
- `plan.md`: build batches, in order
- `research.md`: the papers behind the design and the numbers taken from them
- `tests.md`: test and experiment results per batch

The design doc is *stridulation: design and architecture*. `design.md` is this repo's copy.

## Planned layout

- `reference/stridulation-engine.js`: the reference engine; defines the sound
- `reference/presets.js`: test presets (bench and tests only)
- `source/StridulationDSP.h`: C++ port, real-time safe, no JUCE dependency
- `source/PluginProcessor.*`, `source/PluginEditor.*`, `ui/index.html`: JUCE instrument and its
  web-view interface
- `tests/`: engine tests, C++ against reference comparison, plugin wrapper test
- `tools/`: bench (`stridulation.html`), performance and preset renders

## License note

The plugin will be built with [JUCE](https://juce.com) 8, which is available under the AGPLv3
or a commercial licence. Keeping this repository public and open source satisfies the AGPL.
