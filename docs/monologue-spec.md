# Korg monologue (2016) — Hardware Spec (for the software replica)

Compiled from: **[OM]** Owner's Manual (https://cdn.korg.com/us/support/download/files/d05d6cb06052aed2b067eea2dfa4f7cd.pdf,
59 pp; block diagram/panel/EG pages verified from rendered images), **[MIDIimp]** official MIDI Implementation
Revision 1.00, 2019.02.19 (https://cdn.korg.com/us/support/download/files/16ee9047b932f624ed640d98940ff798.txt via
https://www.korg.com/us/support/download/manual/0/733/4231/), **[KorgWeb]** product/spec pages, **[SoS]** Sound on Sound
review, **[MR]** MusicRadar review + how-to, **[AM]** Attack Magazine, **[decoder]** jgoizueta/monologue (community
program parser used to resolve official-doc errata). UNCONFIRMED items are inferences; see §15/§16.

## 1. Architecture / signal path

- **Monophonic.** VCO1 + VCO2 (+NOISE GEN into VCO2's wave selector) + AUDIO IN → 2-ch MIXER → VCF (2-pole LP) →
  VCA → **DRIVE** → OUTPUT. [OM p.3 block diagram] DRIVE is **post-VCA, the final stage** before the output jack.
- **Strictly MONO output** (6.3mm mono jack; headphone jack carries the same mono signal). **No effects of any
  kind** (the manual's program-architecture page claiming "plus Effects" is a copy-paste error).
- 100 programs: 1–80 preset, 81–100 user. 25 slim velocity keys, **E-to-E** (bass/guitar-friendly), no aftertouch.
- MASTER knob = analog output volume (not program data, not motion-recordable). OLED doubles as an oscilloscope.
- Analog auto-tune: SHIFT+REC runs a ~15 s tune cycle; pitch/tone drift after power-on is real and admitted [OM].

## 2. Panel (23 dedicated controls; [OM p.4], step buttons are 1–16 — the p.4 list printing "1–8" is a typo)

MASTER + **DRIVE 0..1023** knobs; OCTAVE 5-way (±2, LED); horizontal assignable **SLIDER** (like the OG's — default
PITCH BEND, 16 destinations §11); VCO1: WAVE [SAW, TRI, SQR] + SHAPE 0..1023 only (**no pitch/octave/level on
VCO1** — pitch follows the master OCTAVE; level is the MIXER knob); VCO2: OCTAVE [16'..2'], PITCH ±1200¢ (1-cent
steps; SHIFT = semitones), WAVE [SAW, TRI, **NOISE**], **SYNC/RING 3-position switch**, SHAPE; MIXER: VCO1 / VCO2
levels 0..1023; FILTER: CUTOFF, RESONANCE (only two — keytrack/velocity are menu params §11); EG: TYPE / ATTACK /
DECAY / INT / TARGET; LFO: WAVE / MODE / RATE / INT / TARGET; SEQUENCER: TEMPO knob 56.0–240.0 BPM (SEQ EDIT BPM
accepts **10.0–600.0**), KEY TRG/HOLD button, **MOTION/SLIDE/NOTE** 3-pos edit switch, EDIT MODE/WRITE/EXIT,
PLAY/REC/REST/SHIFT, 16 step buttons, PROGRAM/VALUE knob.

## 3. VCO1 / VCO2

- PITCH raw→cents: the family piecewise table [MIDIimp P2, exact — same as xd/OG]:
  `0-4:-1200 | 4-356:-1200..-256 | 356-476:-256..-16 | 476-492:-16..0 | 492-532:0 | 532-548:0..16 | 548-668:16..256 | 668-1020:256..1200 | 1020-1023:1200`.
  VCO1 PITCH exists in program data + CC34 (receive-only) but has **no panel knob**.
- SHAPE per wave: SQR = pulse width; SAW = "odd harmonics, more hollow" morph; TRI = "(slightly crackly)
  wavefolding" [SoS]. **NOISE: SHAPE has no effect** — plain white noise from a discrete generator, colored only
  downstream by the VCF/DRIVE. RING with NOISE selected rings VCO1 × noise (grungy percussion).
- **SYNC/RING is one exclusive 3-position switch** (program byte 32 b0-1: 0=RING, 1=OFF, 2=SYNC): SYNC = VCO2 hard
  sync to VCO1; RING = VCO1 ring-modulates VCO2, the product **replaces** VCO2's output. No cross mod on this synth
  (the audio-rate FAST LFO "greatly offsets the absence" [SoS]).

## 4. FILTER

- 2-pole (12 dB/oct) LP, "much more aggressive... reminiscent of the Korg MS-20" [MR]; self-oscillates at max
  resonance (with keytrack: a playable third oscillator). **Keeps its bass at high resonance** — the OG's low-end
  rolloff does NOT apply here [SoS "bite doesn't come at the expense of the bass end", DailyAnalog comparison].
  Do not reuse the OG's resLoss voicing; this filter needs its own SvfCfg (resLoss ≈ 0, hotter taper). UNCONFIRMED
  numeric voicing — calibration-class.
- Cutoff Velocity [0/50/100%] and Cutoff Key Track [0/50/100%] are **menu** params (§11).

## 5. EG (single 2-stage; ATTACK 0..1023, DECAY 0..1023)

- TYPE [A/D, A/G/D, GATE] — program byte 34 b0-1 stores **0=GATE, 1=A/G/D, 2=A/D** [MIDIimp].
  VCA behavior: **A/D** = attack→peak→decay to 0 even while held (percussive); **A/G/D** = attack→hold at fixed
  max while held (gate level not adjustable)→DECAY acts as release from note-off; **GATE** = flat rectangular gate
  ("time-based changes cannot be made to the VCA") — the A/D envelope is then free purely for the TARGET [OM p.19-20, AM].
- TARGET [CUTOFF, PITCH 2, PITCH] (program: 0=CUTOFF, 1=PITCH 2, 2=PITCH): in **all three types** an
  Attack/Decay envelope scaled by INT modulates the target (PITCH = both VCOs; PITCH 2 = VCO2 only).
- INT: bipolar ±511 (knob positive, SHIFT+turn negative). Stored 0..1023; center-512 encoding is the community
  reading [decoder] — the official doc gives no mapping. UNCONFIRMED encoding + depth scaling.
- **Retrigger resets the EG to ZERO** (not from current level): "if you play a new note during the release phase,
  the envelope is reset to zero — an uncomfortable silence with a slow attack" [SoS, forums]. Default is
  multi-trigger; **enabling Portamento switches to single-trigger (legato)** even at time=0. Differs from our
  family restart-from-current-level model — needs a hard-reset retrigger option in the voice.

## 6. LFO (digital; one per the single voice)

- WAVE [SQR, TRI, SAW]. MODE [FAST, SLOW, 1-SHOT] (program byte 36 b2-3: 0=1-SHOT, 1=SLOW, 2=FAST):
  **FAST = 0.5 Hz – 2.8 kHz** (true audio rate; "noticeable parameter stepping" at fast rates is authentic [MR]);
  SLOW = 0.05–28 Hz; 1-SHOT = stops one **half-cycle** after note-on (0.05–28 Hz; saw = decay envelope, tri = "wow",
  sqr = "hiccup" [SoS]). Raw→Hz curves UNCONFIRMED (assume exponential per family).
- INT 0..1023 knob, SHIFT+turn negative (bipolar, center-512 stored — community reading, UNCONFIRMED).
- TARGET [CUTOFF, SHAPE, PITCH] — SHAPE and PITCH hit **both VCOs**. **No EG→LFO modulation** (that's the OG's
  EG MOD; the monologue's EG targets are pitch/pitch2/cutoff only).
- LFO BPM Sync ON (menu): RATE quantizes per mode — manual: FAST → 1/8…1/2048, SLOW & 1-SHOT → 4…1/64; but
  [MIDIimp P3] gives the standard family 16-zone table (4…1/36). **Conflict** — see §15.

## 7. DRIVE

- Continuous 0..1023 knob, **post-VCA analog overdrive**, the last stage: "rougher, darker… even fully cranked,
  drive never becomes too much, nor does it excessively boost the volume" [SoS]; "saturates the output — great on
  percussive sounds" [MR]; perceived intensity varies with program levels [AM]. Raw→gain/makeup curve UNCONFIRMED
  (reverse-engineer; tanh-family shaper with makeup, smoothed).

## 8. Sequencer (16-step MONOPHONIC)

- Per step: 1 note + velocity? (**note only + per-step GATE TIME 0..72/TIE**; 22-byte step events [MIDIimp S2 —
  TABLE 2's 12-byte stride listing is a typo, correct stride 22, Step 16 at 426..447]), step on/off + **per-step
  SLIDE on/off** (program-level bitmasks bytes 68-69 — slide is NOT in the step event) + active-step masks + per-slot
  motion enables.
- **SLIDE**: flagged step glides INTO the next step's note; glide amount = PROGRAM EDIT "Slide Time" 0–100% (byte 40,
  0..72) — separate from Portamento. **KEY TRG/HOLD**: lit = sequence plays while a key is held, transposed by the
  played key (reference note UNCONFIRMED); held = latched HOLD, keys transpose live.
- Motion: **4 slots**, records all panel knobs/switches except MASTER, TEMPO, OCTAVE; per-slot per-step enable
  bitmasks; **4 data bytes per slot per step** (Data1↔Data2 smoothing like the OG; Data3/Data4 undocumented —
  between OG's 2-byte and xd's 5-point formats). Motion param IDs [MIDIimp S1-1]: 13-24 VCO1/2 pitch/shape/octave/
  wave/levels, 23 CUTOFF, 24 RESONANCE, 25 SYNC/RING, 26-30 EG params, 31+ LFO params… (full list in MIDIimp).
- Timing: Step Length 1..16, Resolution [1/16, 1/8, 1/4, 1/2, 1/1], Swing ±75%, Default Gate Time 0-100%,
  BPM stored 100-3000 (=10.0-300.0) [MIDIimp bytes 52-53] though SEQ EDIT accepts up to 600 — see §15.

## 9. Program data (SysEx; the calibration/librarian path)

- Header `F0 42 3g 00 01 44` (Family ID 44 01). Functions: 0x10/0x1C/0x0E requests, 0x40/0x4C/0x51 dumps,
  0x23/0x24/0x26 ACK/NAK/format-error, plus 0x14/0x15 user tuning requests and 0x44/0x45 tuning dumps.
- Program = 448 internal bytes ('PROG' 0-3, name 4-15, 'SEQD' at 48) → 512 wire bytes (7-to-8 packing).
  Knob upper-8-bits at bytes 16-29, packed lower-2-bits at 30-35 — **erratum**: note P1's summary swaps offsets
  26/27/28; TABLE 2 is correct (26=EG INT, 27=LFO RATE, 28=LFO INT) [decoder-verified].
- Key switch fields: byte 32 b0-1 SYNC/RING, b2-4 KEYBOARD OCTAVE; byte 34 b0-1 EG TYPE, b6-7 EG TARGET;
  byte 36 b0-1 LFO WAVE, b2-3 LFO MODE, b4-5 LFO TARGET; byte 38 MICRO TUNING 0..139; byte 40 Slide Time;
  byte 41 Portamento (`0,1..129 = OFF,0..128` quirk); byte 44 Slider Assign; Program Level 77..127 = -25..+25.

## 10. MIDI CC map (7-bit only — **no** xd-style 10-bit CC pairs)

Knobs (0..127): CC16 ATTACK, CC17 DECAY, CC24 LFO RATE, CC25 EG INT, CC26 LFO INT, **CC28 DRIVE**,
CC34 VCO1 PITCH (**receive-only**), CC35 VCO2 PITCH, CC36/37 VCO1/2 SHAPE, CC39/40 VCO1/2 LEVEL, CC43 CUTOFF,
CC44 RESONANCE. Switches (3-way zones 0-42/43-85/86-127; tx 0/64/127; octave quartiles): CC48 VCO1 OCTAVE
(**receive-only**), CC49 VCO2 OCTAVE, CC50 VCO1 WAVE (SQR/TRI/SAW), CC51 VCO2 WAVE (**NOISE**/TRI/SAW),
CC56 LFO TARGET, CC58 LFO WAVE, CC59 LFO MODE (1-SHOT/SLOW/FAST), **CC60 SYNC/RING (RING/OFF/SYNC)**,
CC61 EG TYPE (GATE, A/G/D, A/D), CC62 EG TARGET. Rx-only: CC120/122/123. PC 0-99. Pitch bend tx/rx.

## 11. Menu params (per program unless noted)

Portamento Time (Off,0..128) + Portamento Mode [Auto, On]; Slide Time 0-100%; LFO BPM Sync [Off, On];
Cutoff Velocity [0/50/100%]; Cutoff Key Track [0/50/100%]; Amp Velocity 0..127; Program Level 77..127 (=-25..+25);
Bend Range +/− (1..12); Slider Assign (16 destinations, default PITCH BEND; incl. GATE TIME, VCO pitches/shapes/
levels, CUTOFF, RESONANCE, EG/LFO params, DRIVE — exact order per MIDIimp byte 44 table); Slider Range;
Microtuning (byte 38: 0 Equal Temp, presets incl. Pure Major/Minor, Pythagorean, Werckmeister, Kirnburger,
Slendro, Pelog, **AFX 001-006** (Aphex Twin, full-range non-octave-repeating), **DC 001-003** (Dorian Concept,
FW 2.00), 6 USER SCALEs, 6 USER OCTAVEs) + Scale Key/Program Tuning. Global: master tune ±50¢, transpose ±12,
velocity curves 1-8 + Const127, knob mode, audio-in on/off.

## 12. Microtuning data

USER SCALE = 384 bytes: 128 notes × 3 bytes [semitone 0..127, 14-bit fraction in 0.0061¢ units] — MTS format.
USER OCTAVE = 36 bytes: 12 notes × 3 bytes (semitone 0..23 = +0..+23, 116..127 = −12..−1, + fraction).
Live reception of standard MTS Bulk Tuning Dump and Realtime Single-Note Tuning Change while editing a user slot.

## 13. Velocity

Velocity → cutoff via Cutoff Velocity [0/50/100%] (block diagram draws velocity into the VCF node) and
velocity → volume via Amp Velocity 0..127 (0 = off). Whether Amp Velocity scales the fixed GATE-type VCA level
is UNCONFIRMED. Global velocity curves as §11.

## 14. Modeling notes

- **EG retrigger = hard reset to zero** (multi-trigger; single-trigger when Portamento on) — the monologue's
  signature percussive snap and its "silence with slow attack" quirk. Our AdsrEg restarts from current level;
  the mono voice needs a reset-to-zero mode.
- Filter: aggressive, bass-retaining 2-pole — its own SvfCfg voicing (NOT the OG's resLoss).
- DRIVE post-VCA: with one voice this is equivalently a master stage; keep it inside the voice between VCA and
  output tap for SERVICE MODE stage coherence — or as an engine FX-chain stage; decide at build.
- FAST LFO at audio rates: the Lfo slew limiter (1 ms full swing) triangle-izes squares above ~500 Hz — use a
  shorter slewTime; visible stepping at fast rates is authentic hardware behavior.
- No arp, no effects: the engine's FX chain is empty and dsp/arp.ts is not constructed.

## 15. Known doc errata / discrepancies

1. [MIDIimp] note P1 vs TABLE 2: byte offsets 26/27/28 swapped in P1; TABLE 2 correct (26=EG INT, 27=LFO RATE,
   28=LFO INT) [decoder-verified].
2. [MIDIimp] TABLE 2 lists 12-byte step-event stride; note S2 + "Step 16 = 426..447" prove 22-byte stride.
3. [MIDIimp] receive footnote *5-6 (LFO MODE zones) missing from the footnote list (assume standard 3-way).
4. [MIDIimp] note P12 prints value 22 as "VCO 1 LEVEL" (should be VCO 2 LEVEL); assorted typos ("PICTH 2").
5. LFO BPM-sync divisions: manual says per-mode lists (FAST 1/8..1/2048, SLOW 4..1/64); MIDIimp P3 gives the
   family 16-zone 4..1/36 table. Trust MIDIimp for the stored zones; per-mode display UNCONFIRMED.
6. SEQ EDIT BPM accepts 10.0-600.0 [OM] but the stored field is 100-3000 = 10.0-300.0 [MIDIimp] — verify >300.
7. [OM p.4] "Buttons 1–8" is a typo for 1–16; [OM] program-architecture "plus Effects" is a copy-paste error.
8. VCO2 SYNC/RING header printed "[OFF, ON]" in one place; body text + program data confirm 3-position.

## 16. UNCONFIRMED / calibration targets (no monologue hardware owned — manuals/recordings only)

EG INT / LFO INT bipolar center-512 encoding (community-only); EG depth scalings per target; EG A/D exact
decay-continues semantics on early note-off; GATE-type + Amp Velocity interaction; LFO raw→Hz curves per mode +
FAST slew/stepping character; DRIVE raw→gain/makeup curve; filter voicing (taper, self-osc threshold, bass
retention amount); slide glide curve (linear vs exponential, Slide Time → seconds); key-trigger transpose
reference note; motion Data3/Data4 semantics; factory init defaults (extract from a program dump).
