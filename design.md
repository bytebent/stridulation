# stridulation · design

A playable insect voice. MIDI in, stereo audio out. A plectrum on a spring is dragged across a
file of teeth by a muscle-driven wing; each tooth it passes strikes a resonant wing or body. The
wing's swing can feed back and time each release, which is the cricket's escapement.

Labels: **[Decided]** you chose it, **[Proposed]** suggested and not yet confirmed, **[Open]**
still to decide. Sources for every number are in `research.md`.

---

## 1. What it is

- **Name:** stridulation, lowercase like mouth-tube and beak-tube. [Decided]
- **Accent colours:** orange and green. [Decided]
- **Plugin code:** `Strd` for now (the four-letter id DAWs use to tell plugins apart). [Decided]
- **Scope:** every insect that stridulates: crickets, mole and tree crickets, katydids,
  grasshoppers, wetas, beetles, ants, velvet ants, bugs, stick insects and caterpillars. [Decided]
- **The radiator is inside the instrument.** The wing resonator paces the scraper, so a separate
  body effect would break the feedback. Burrows and leaf baffles can come later as a body
  effect. [Decided]
- **No tymbals.** Cicadas and other tymbal insects are out. [Decided]
- An **AU/VST3 instrument for macOS** plus a standalone app, like Throat, Dolphin and Syrinx.
  [Proposed]
- Built the bytebent way: JavaScript reference engine and browser bench first, then the C++
  port, then the JUCE plugin. 4× oversampling, fixed 32-sample blocks, seeded and
  deterministic. [Proposed]
- **One model, continuous knobs with notches.** Clockwork, cog rattle and spring stick-slip come
  from two continuous knobs, **Escapement** and **Spring**. Each knob has a notch (a detent the
  knob settles into while dragging) at each named model: Escapement at Cog rattle (0) and
  Clockwork (1), Spring at Stiff (0) and Spring (0.8). Values in between stay playable.
  [Decided]

## 2. Signal flow

```
notes and song ─► stroke (muscle force, wing) ─► contact (file + plectrum tip) ─┬─► wings L/R ─┬─► out
                        ▲                               │      ▲                └─► body ──────┤
                        └──── teeth hold the wing back ─┘      │                               │
                                                               └── wing swing times release ◄──┘ (wings only)
                                          contact ── tick (raw clicks) ─────────────────────────► out
```

Temperature, Size and Ultra act on song, stroke and wings together. With Limbs set to Two, the
stroke and contact run twice, one leg per side.

## 3. File and stroke

### The file

- A **tooth table** built off the audio thread from Teeth, Spacing, Jitter, Gaps and Height,
  swapped in at a stroke boundary. The same table plays every stroke, so the rhythm of teeth is
  spatial, not random. [Proposed]
- **Spacing gradient.** In *Teleogryllus* the 252 teeth are closer together at the end the
  plectrum meets first. In *Gryllus campestris* plectrum speed is exactly proportional to tooth
  spacing (slope 4.12 kHz against a 4.2 kHz song). With the escapement on, a gradient makes the
  wing accelerate while the pitch holds; with it off, it becomes a pitch sweep. [Proposed]
- **Gaps:** missing teeth make the wing jump forward, then resume. [Proposed]
- **Jitter:** Sismondo's model stays natural with ±5% random force and period per impact; Jitter
  perturbs tooth position and height by that order. [Proposed]
- **Height:** how hard a tooth holds the plectrum (matters for Spring). [Proposed]

### The stroke

- The wing is a **mass with damping pulled by a muscle force**, not a fixed speed. With the harps
  removed, closing was up to 3× faster and 5× more variable (10,000–18,000 teeth per second; a
  toothless file about 20,000). A force-driven wing gives this; a speed-driven one cannot.
  [Proposed]
- **Speed** is relative: 1 is the free speed that strikes teeth at the carrier rate at mid-file.
  A clockwork needs a wing that would run faster than its regulator: it locks between Speed 1.2
  and 2.9 and doubles near 6, so the default is 2. [Proposed]
- **Curve:** muscle force through the stroke, a twitch that rises then falls. [Proposed]
- **Arc:** share of the file one stroke uses. **Arc growth:** later pulses of a chirp use more
  file and are louder, as in *G. campestris*. [Proposed]
- **Open:** opening-stroke level. Crickets sing on closing; grasshoppers sound both ways;
  *Arachnoscelis arachnoides* sings on opening. [Proposed]
- **Shape** of the leg path for grasshoppers: Smooth, Steps or Vibrate (Elsner 1974). [Proposed]

## 4. Contact

One model for every insect: a plectrum tip on a spring behind the wing, caught by each tooth until
it can pass, where the file's own vibration can lower the tooth and let it go. [Proposed]

```
m_p·p'' = k_s·(u − p) − c_p·p'        release when  k_s·(u − p) > h_n·(1 − E·g(y))
```

u is the wing, p the plectrum tip, k_s the plectrum spring, h_n the height of tooth n, y the file
displacement from the wing radiator, E the Escapement amount. Crossing a tooth delivers a force
pulse to the radiator (impact); letting go delivers a smaller one (release). Event times are found
between samples and written as force pulses of width **Tooth time**, as Dolphin writes its clicks.

This follows Bennet-Clark & Bailey's (2002) phase model: impact at the low point of the file's
swing (270°), drive through the first part of the cycle, release as the file swings up. Both
impact and release make sound. g(y) and the engagement depth are tuned by ear and against tests
1–3 (§11); no paper gives them as equations. [Decided]

As built in batch 02 (details in `tests.md`), the escapement acts through the phase of the file's
vibration:
- a caught plectrum is released near the top of the swing (90°), once the file has swung back
  down since the last release (re-arming);
- a plectrum that meets a tooth within half a cycle of a release, while the file is still high,
  slides over it (Koch's double speed);
- a push beyond the escapement's hold releases at any phase;
- the escapement's authority scales with the wing's ringing amplitude (so a stroke starts as a cog
  rattle and tunes in) and with its Q (half at Q 5, so a wing without a harp can't regulate).

| Escapement | Spring | Behaviour | Insects |
|---|---|---|---|
| High | Stiff | **Clockwork**: the wing times every release, one tooth per cycle, pitch = wing. Speed follows spacing. | Field and mole crickets |
| Low | Stiff | **Cog rattle**: wing speed and spacing set the tooth rate; the wing just rings. Pitch follows speed and temperature. | Tree crickets, katydids, grasshoppers, beetles, ants |
| Any | Soft | **Spring**: the tip lodges, loads, then slips over several teeth fast: bursts. | Ultrasonic katydids, bark beetles |

- **Clockwork:** speed at a given place on the file is always the same (CV 4.9%), sometimes
  exactly 2× or 3×, never in between (Koch et al. 1988). Overdriven, the model skips whole teeth.
  The stroke starts as a cog rattle and tunes into the clockwork once the wing rings; the model
  does this because g(y) is small until y grows.
- **Tree crickets:** tooth rate drives the wing. Carrier rises from 3.0 kHz at 15 °C to 4.6 kHz at
  32 °C with no jump at the 4 kHz wing resonance; missing teeth speed the plectrum only 10–15%
  (Sismondo 1993).
- **Spring:** *Dendroctonus valens* loads for 8–12.5 ms, then pulses one per tooth at about 695
  per second; simple chirps 13.6 ± 1.7 ms with 9.1 ± 1.1 pulses, interrupted chirps 54 ± 13.1 ms
  from several catch-and-release events (Lindeman & Yack 2019).
- **Faults are features:** jumped teeth, noisy catches, held and resumed pulses, free ring-down
  when the escapement stops (Bennet-Clark & Bailey 2002). Speed and Jitter reach them.
- **Tick:** the escapement's own sound, far quieter than the song, near twice the carrier when
  impact and release are 180° apart, irregular otherwise. Tick mixes the raw contact pulses to
  the output. [Proposed]

## 5. Radiators

Each side has a wing built as Sismondo's (1993) two-stage oscillator, plus a second mode and a
low-Q body. Turning the Q down takes the same structure from a pure tone to clicks. [Proposed]

```
M1·X'' + C1·X' + Rcpl·(X − Y) + R1·X + Rnl·X⁵ = F(t)        (frame, struck by the teeth)
M2·Y'' + C2·Y' + Rcpl·(Y − X) + R2·Y = 0                    (membrane, radiates)
```

- Sismondo integrated this with RK4 and, varying only tooth-strike rate and force, got 1:1,
  period doubling, and 4:3 and 5:4 locks, matching *O. nigricornis*. **Nonlinear** sets Rnl.
  [Proposed]
- **Ring** is the membrane's Q. Measured: harp 25 (Nocke 1971); free wings 25.1 and 23.9, damped
  pulses 23.4 (Bennet-Clark 2003); song decay 23 (Bennet-Clark & Bailey 2002); *Oecanthus* 25–35
  (Sismondo 1993). Default 25. [Proposed]
- Y is the file displacement the contact reads, so the wing that sounds is the wing that holds
  the escapement.
- **Two wings**, one per side. *Teleogryllus* free resonances 4.56 kHz (left) and 4.21 kHz (right)
  while the song is 4.8 kHz: the plectrum stiffens both up to the song (Bennet-Clark 2003).
  **Wings** sets the free detune. As built, the membranes are joined through the plectrum
  (strongly while engaged, lightly when free), so they sing as one and beat in the free tail.
  [Proposed]
- **Stiffening:** a cubic spring that saturates, not X⁵ (Sismondo notes either works; X⁵ was
  unstable at the frame's real amplitude). The n:m locks of test 5 aren't reproduced yet with
  this frame. [Open]
- **Glide** bends the wing frequency by plectrum position, not time: the anterior file end is more
  flexible, so the resonance driven there is lower, and drive amplitude rises from the posterior
  end to the middle then falls (Bennet-Clark 2003). Measured falls: 10% *G. campestris*, 10.6%
  *G. bimaculatus*, 16% *Modicogryllus*, under 6% in mole crickets. [Proposed]
- **Second** adds a higher, weaker mode: the mirror, or *Gryllus* courtship components at
  13–17 kHz. [Proposed]
- **Body** adds the ringing of an insect without a radiator. *Atta sexdens*: each tooth strike
  rings the gaster at about 1.05 kHz and about 10 kHz (Q 1–3), energy to 30–40 kHz. Body tone sets
  the low mode; the high follows at about 10×. [Proposed]

## 6. Song

| Level | Made by | Field cricket | Grasshopper (*C. biguttulus*) |
|---|---|---|---|
| Impulse | one tooth or peg | one carrier cycle, ~0.2 ms | 0.9 ms |
| Pulse / syllable | one stroke | 20–22 ms | 9.1 ms |
| Chirp | a group of strokes | 3–5 pulses | 72.5 ms |
| Sequence | a run of chirps | calling bout | 2.9 s, grouped again into 15 s |

- **Rate** (strokes per second within a chirp), **Chirp** (strokes per chirp, 0 = trill),
  **Chirp rate**, **Phrase** (sequence length, 0 = endless), **Rubato** (seeded), **Sync** (host
  tempo). [Proposed]
- Note-off lets the current stroke finish. [Proposed]
- **Two legs** (grasshoppers): different patterns per leg, almost never in sync, a phase lag timed
  to the millisecond that fills the gaps, and role swaps from time to time; impulse rate modulates
  far more than amplitude (*O. viridulus*: 0.2–0.5 per ms through most of the upstroke, 3 at its
  end, 4 on the downstroke). **Limbs**, **Lag**, **Swap**, and Leg B offsets. [Proposed]
- **Scrape** mode: each note is one stroke, so rhythms are played on the keyboard; with the mod
  wheel on wing position, the stroke follows the wheel like a guiro. In the first version.
  [Decided]

## 7. Macros

- **Temperature** (5–40 °C): pattern rates follow Walker's tree-cricket rule,
  rate(T) = rate₂₅ × (T − 4) / 21. Muscle force follows (T + 17) / 42, a line through the
  *Oecanthus* carrier endpoints (derived, to check by ear). The pitch then does what each insect
  does: locked to the wing with the escapement on (*G. campestris*: Q₁₀ about 0.07 for closing
  speed and carrier), following speed with it off (*Oecanthus*), and in between rising until it
  reaches the wing resonance, then holding. [Proposed]
- **Size** (0.25–4×): file length, spacing and arc. With Keytrack off it also sets the carrier
  from the katydid fit ln f = 3.68 − 0.81 ln L, 4.7 kHz at 1×. [Proposed]
- **Ultra** (÷1–÷16) divides every frequency; **Time** (0–1) chooses how much of the matching time
  stretch to keep (0 real rhythm, 1 full expansion, default 0.5). For ultrasonic katydids, bark
  beetles and ants. [Proposed]

## 8. Playing

| Input | Sets |
|---|---|
| Note | wing frequency and the free speed that matches it |
| Velocity | muscle force of each stroke |
| Hold | runs the song; note-off finishes the stroke |
| Mod wheel | speed offset, or wing position in Scrape |
| Aftertouch | force |
| Pitch bend | wing frequency |

- Keytrack on by default; Tune ±24 st; Ultra divides after. [Proposed]
- **Pitch lock**, off by default: holds the sounding pitch on the note even where the escapement
  pulls it sharp with drive (+0.6% at Speed 2, up to +7.5% at the edge of the lock). [Decided]
- **Loudness compensation**: evens out the level between a locked clockwork, a cog rattle and a
  slow scrape, which otherwise differ by up to about 50 dB. [Decided]
- Mono or Poly; Poly has 8 voices (cost batch). [Decided]
- Glide in Mono; Swell (attack and release on force); four LFOs as in Dolphin. [Proposed]
- **Chorus** (many insects that synchronise or alternate) needs pulse-coupled agents, not voice
  polyphony. Left out for now. [Decided]

## 9. Parameters

48 parameters, all [Proposed] unless noted. Hero control: **Escapement**.

| Group | id | Range | Default | Notes |
|---|---|---|---|---|
| File | `teeth` | 8–400 | 120 | *Teleogryllus* 252, *D. valens* ~63, *O. nigricornis* 43 |
| File | `spacing` | −1…+1 | +0.4 | + = closer at the start of the stroke |
| File | `jitter` | 0–0.3 | 0.05 | seeded, per tooth |
| File | `gaps` | 0–0.5 | 0 | fraction of missing teeth |
| File | `height` | 0–1 | 0.5 | how hard a tooth holds |
| Contact | `escapement` | 0–1 | 0.9 | notches: Cog rattle 0, Clockwork 1 [Decided] |
| Contact | `spring` | 0–1 | 0.1 | notches: Stiff 0, Spring 0.8 [Decided] |
| Contact | `toothtime` | 10–1000 µs, log | 25 | force pulse width |
| Contact | `tick` | 0–1 | 0.15 | raw contact to output |
| Wing | `tune` | ±24 st | 0 | |
| Wing | `ring` | 0.7–60, log | 25 | membrane Q |
| Wing | `wings` | 0–30% | 8% | left–right free detune |
| Wing | `glide` | −30…+30% | −10% | bend by file position |
| Wing | `nonlinear` | 0–1 | 0.2 | frame stiffening |
| Wing | `second` | 1–4× | 2.0 | second mode ratio |
| Wing | `secondlevel` | −48…0 dB | −24 | |
| Wing | `body` | 0–1 | 0 | low-Q body |
| Wing | `bodytone` | 300 Hz–3 kHz, log | 1 kHz | high body mode at ~10× |
| Stroke | `speed` | 0.01–8, log | 2 | 1 = matched at mid-file; clockwork locks at 1.2–2.9 |
| Stroke | `curve` | 0–1 | 0.5 | muscle twitch shape |
| Stroke | `arc` | 0.1–1 | 0.8 | share of file per stroke |
| Stroke | `arcgrow` | 0–1 | 0.3 | |
| Stroke | `open` | 0–1 | 0 | opening-stroke level |
| Stroke | `shape` | Smooth, Steps, Vibrate | Smooth | |
| Stroke | `limbs` | One, Two | One | |
| Stroke | `lag` | 0–0.5 cycle | 0.1 | two limbs only |
| Stroke | `swap` | 0–1 | 0.2 | chance per chirp |
| Song | `play` | Song, Scrape | Song | Scrape [Decided] |
| Song | `rate` | 0.5–150 Hz, log | 30 | strokes per second |
| Song | `chirp` | 0–64 | 4 | 0 = trill |
| Song | `chirprate` | 0.2–10 Hz, log | 2.5 | |
| Song | `phrase` | 0–60 s | 0 | 0 = endless |
| Song | `sync` | Off, On | Off | |
| Song | `rubato` | 0–1 | 0.1 | |
| World | `temperature` | 5–40 °C | 25 | |
| World | `size` | 0.25–4×, log | 1 | |
| World | `ultra` | ÷1–÷16 | ÷1 | |
| World | `ultratime` | 0–1 | 0.5 | |
| World | `keytrack` | Off, On | On | |
| Voice | `poly` | Mono, Poly | Mono | Poly: 8 voices [Decided] |
| Voice | `pitchlock` | Off, On | Off | [Decided] |
| Out | `loudness` | 0–1 | 1 | loudness compensation amount [Decided] |
| Voice | `glidetime` | 0–2 s | 0 | Mono only |
| Voice | `attack` | 1 ms–4 s | 5 ms | Swell, on force |
| Voice | `release` | 1 ms–4 s | 50 ms | Swell, on force |
| Out | `spread` | 0–1 | 0.5 | |
| Out | `volume` | −48…+6 dB | 0 | |
| Out | `seed` | integer | 1 | |

Not counted: four LFOs (Modulation page) and the Leg B offsets [Open].

## 10. Archetypes (test presets)

| Preset | Contact | Carrier | Timing |
|---|---|---|---|
| Field cricket (*G. campestris*) | Clockwork | 5 kHz, glide −10%, Q 25 | 3–4 pulse chirps |
| Field cricket (*T. oceanicus*) | Clockwork, 252 teeth | 4.8 kHz; wings 4.56 / 4.21 kHz | 4-pulse chirp, then paired-pulse trill |
| Mole cricket (*G. gryllotalpa*) | Clockwork | 1.7 kHz, glide under 6% | long trill |
| Tree cricket (*O. nigricornis*) | Cog rattle, 43 teeth, Nonlinear up | 3.0–4.6 kHz with temperature | 25–65 pulses/s |
| Pure-tone katydid (*Tympanophora similis*) | Cog rattle | 6.5 kHz, glide 7.7% | variable chirps |
| Grasshopper (*C. biguttulus*) | Cog rattle, two legs, Ring low | clicks around 8 kHz | impulse 0.9 ms, syllable 9.1 ms, chirp 72.5 ms |
| Grasshopper (*O. viridulus*) | Cog rattle, two legs | clicks | impulse rate 0.25 → 4 per ms |
| Bark beetle (*D. valens*) | Spring, ~63 teeth | peaks near 7 and 30 kHz (Ultra) | 13.6 ms chirps, ~9 pulses at ~695/s |
| Leafcutter ant (*Atta sexdens*) | Cog rattle, Body only | body 1.05 and ~10 kHz, Q 1–3 | strikes 1.7 ± 0.4 ms apart; ~50 ms strokes, ~5/s |
| Jurassic katydid (*Archaboilus musicus*) | pure tone | 6.4 kHz | ~16 ms pulses |

Reference recordings for listening: Singing Insects of North America (used by Ganchev &
Potamitis 2007) and Ragge & Reynolds (1998) for the European crickets.

## 11. Engine and tests

- RK4 for the wing oscillators; the stroke and tip with sub-steps when the spring is stiff. The
  cost batch picks the step rule. Events between samples, written with Dolphin's sub-sample
  writer. Idle voices, unused modes and the second limb cost nothing. [Proposed]
- **Live view:** the file as a row of teeth, the plectrum moving along it, each tooth lighting as
  it is struck (colour while the escapement holds, grey when it slips), the wing's swing below.
  [Proposed]

Tests that tie it to the papers:

1. Clockwork: tooth rate = carrier within 1%; speed ∝ spacing with slope = carrier.
2. Overdriven clockwork jumps to 2× speed, nothing stable in between.
3. Gaps: the wing accelerates across and resumes; Ring near 0.7 makes closing ~3× faster.
4. Escapement off: carrier follows temperature like *Oecanthus*; on: holds within Q₁₀ 0.07.
5. Nonlinear up, drive mistuned: 4:3 and 5:4 locks, and beats between the wings.
6. Free decay after the last tooth has Q within 10% of Ring.
7. Spring: loading times and pulse rates in the *D. valens* range.
8. House tests: same output at any buffer size, same seed same output, no allocation in process.

## 12. Open

- Leg B. Temperature rules for katydids, grasshoppers and beetles.
  Vendoring into krill.
