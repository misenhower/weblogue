# Korg minilogue (original, 2016) — Hardware Spec (for the software replica)

Compiled from: **[OM]** Owner's Manual (https://cdn.korg.com/us/support/download/files/23be1d77cac2c42e6f6c586cf0f75ffb.pdf),
**[MIDIimp]** official MIDI Implementation Revision 1.10, 2016.07.10 (https://cdn.korg.com/us/support/download/files/9491c06ef6ee0ba63a947c5e74dd5d4f.txt),
**[KorgWeb]** product/spec pages, **[SoS]** Sound on Sound review, **[MR]** MusicRadar review + how-to,
**[editor]** jeffkistler/minilogue-editor (hardware-verified program decoder).
Items marked UNCONFIRMED are best-effort inferences; see §16. The official MIDIimp contains errata — see §15.

## 1. Architecture / signal path

- 4-voice polyphonic. Per voice: VCO1 + VCO2 + NOISE (white) → 3-ch mixer → VCF (2/4-pole LP) → VCA.
  Program architecture: 2 VCO, 1 VCF, 2 EG, 1 VCA, 1 LFO, DELAY. [KorgWeb spec, OM p.62]
- Post-voice-sum (after VCAs): voices sum + AUDIO IN → **HI PASS + DELAY block** with feedback loop → OUT. [OM p.3 block diagram]
- 200 programs: 001–100 preset, 101–200 user. 8 favorites in global data. 37 slim keys, velocity, **no aftertouch**.
- **Strictly MONO output** (single 6.3mm mono OUTPUT jack; the delay line is mono — stereo output arrived with the xd).
- **No** multi engine, **no** drive switch, **no** ModFX/reverb, **no** microtuning, **no** joystick (assignable SLIDER instead).

## 2. Master

- OCTAVE switch ±2 (stored 0..4). TEMPO knob 56.0–240.0 BPM (SEQ EDIT BPM accepts 10.0–300.0 — support both). [OM p.11, p.39]
- SLIDER: assignable, default PITCH BEND; 29 destinations (§11); movements recordable into motion lanes.

## 3. Voice modes (buttons 1–8; stored per program, **no CC**; VM DEPTH knob 0..1023 = CC27)

Enum (program byte 64 b0-2) [MIDIimp P11]: 0 POLY, 1 DUO, 2 UNISON, 3 MONO, 4 CHORD, 5 DELAY, 6 ARP, 7 SIDE CHAIN.
DEPTH semantics per mode [OM p.24-25, MIDIimp P12]:

- **POLY**: 4-voice poly; depth = chord **Invert 0..8** (inverts the held chord upward in steps). Exact voicing behavior UNCONFIRMED.
- **DUO**: 2-voice poly, unison pairs; depth = detune 0..50 cents (linear).
- **UNISON**: 4-voice mono stack; depth = detune 0..50 cents (>50% reads as supersaw [MR]).
- **MONO**: mono + sub-oscillator: depth first brings in voices 2+3 at **−1 octave**, further right adds voice 4 at
  **−2 octaves**. Subs are real voices playing the same patch (same wave/shape — inference). Depth crossfade curve UNCONFIRMED.
- **CHORD** zones (14): `0-73 5th | 74-146 sus2 | 147-219 m | 220-292 Maj | 293-365 sus4 | 366-438 m7 | 439-511 7 |
  512-585 7sus4 | 586-658 Maj7 | 659-731 aug | 732-804 dim | 805-877 m7b5 | 878-950 mMaj7 | 951-1023 Maj7b5` (same table as xd).
- **DELAY**: voices 2, 3, 4 replay voice 1's note in delayed sequence; depth = tempo-synced spacing, 12 zones
  [MIDIimp P12, corrected]: `0-85 1/192 | 86-170 1/128 | 171-255 1/64 | 256-341 1/48 | 342-426 1/32 | 427-511 1/24 |
  512-597 1/16 | 598-682 1/12 | 683-767 1/8 | 768-853 1/6 | 854-938 3/16 | 939-1023 1/4` (doc misprints 521 for 512).
  Per-echo level decay and EG retrigger behavior UNCONFIRMED. 1/192 ≈ flange/phase territory [MR].
- **ARP** (13 types, same names as xd; hold button 7 = latch). Zones [MIDIimp P12] — **note: boundaries differ from the xd's**:
  `0-78 MANUAL 1 | 79-157 MANUAL 2 | 158-236 RISE 1 | 237-315 RISE 2 | 316-393 FALL 1 | 394-472 FALL 2 |
  473-551 RISE FALL 1 | 552-630 RISE FALL 2 | 631-708 POLY 1 | 709-787 POLY 2 | 788-866 RANDOM 1 | 867-945 RANDOM 2 | 946-1023 RANDOM 3`.
- **SIDE CHAIN**: each new note lowers the volume of previously-played voices; depth 0..1023 = reduction range
  (max ≈ mutes held notes [MR]). Duck curve/recovery UNCONFIRMED.

## 4. VCO1 / VCO2

- Per VCO: WAVE [SQR, TRI, SAW] (stored 0,1,2), OCTAVE [16',8',4',2'], PITCH 0..1023 → ±1200 cents, SHAPE 0..1023. [OM p.15-16]
- PITCH raw→cents [MIDIimp P2, exact — same table as xd]:
  `0-4:-1200 | 4-356:-1200..-256 | 356-476:-256..-16 | 476-492:-16..0 | 492-532:0 | 532-548:0..16 | 548-668:16..256 | 668-1020:256..1200 | 1020-1023:1200`.
- SHAPE: SQR = pulse width; TRI = fold/harmonics; SAW = square-ish blend (same panel meaning as xd).
- VCO2 MODULATION section: CROSS MOD DEPTH 0..1023 (VCO1 → VCO2 pitch, audio rate);
  **PITCH EG INT** knob ±4800 cents (EG → **VCO2 pitch only**, bipolar center-0) [OM p.17], raw→cents [MIDIimp P3, corrected]:
  `0-4:-4800 | 4-356:-4800..-1024 | 356-476:-1024..-64 | 476-492:-64..0 | 492-532:0 | 532-548:0..64 | 548-668:64..1024 | 668-1020:1024..4800 | 1020-1023:4800`
  (positive rows corrected — official doc copy-pasted the P2 table; see §15);
  SYNC [OFF/ON] and RING [OFF/ON] are **two separate toggles, combinable** (+ cross mod on top; "any combination" [SoS]).
  RING: VCO1 ring-modulates VCO2 (sum+difference). SYNC: VCO2 phase forced by VCO1.

## 5. MIXER

- VCO1 0..1023, VCO2 0..1023, **NOISE 0..1023** — plain white noise, pre-VCF, per voice. [OM p.18]

## 6. FILTER

- Low-pass, **FILTER TYPE switch: 2-POLE (12 dB/oct) / 4-POLE (24 dB/oct)**. CUTOFF 0..1023 (≈20 Hz–20 kHz [SoS]),
  RESONANCE 0..1023 (self-oscillates in both modes at high res [SoS/MR]). No drive.
- EG INT knob bipolar ±100% (left of center = inverted EG polarity); raw→percent = the same quadratic as the xd
  [MIDIimp P4]: `0-11:-100 | 11-492: -((492-v)^2*4641*100)/2^30 | 492-532: 0 | 532-1013: ((v-532)^2*4641*100)/2^30 | 1013-1023: 100`.
- KEY TRACK [0/50/100%], VELOCITY [0/50/100%] (velocity → cutoff). [OM p.19-20]
- **Character**: level/low-end drops as resonance rises (>~25% [MR]) — a defining OG trait the xd revoicing removed;
  cause is level drop in the resonance feedback path [maffez mod page]. Model this; do not reuse the xd res taper.

## 7. Envelopes (2× full ADSR)

- AMP EG: ADSR 0..1023 each → VCA only. Amp Velocity: menu (stored byte 33, 0..127).
- **EG** (assignable, full ADSR — xd later demoted this to AD): three simultaneous taps, each with its own depth control:
  (1) → VCO2 pitch via PITCH EG INT (±4800c, §4); (2) → cutoff via FILTER EG INT (±100%, §6);
  (3) → LFO rate **or** int via EG MOD switch (§8, exclusive).
- Both EGs digitally generated; segments sweep near-constant-rate (linear-ish, audible cusps possible [SoS]); snappy [MR].

## 8. LFO (one per voice, digital)

- WAVE [SQR, TRI, SAW]. **EG MOD switch [OFF, RATE, INT]**: RATE = EG modulates LFO speed (in conjunction with RATE knob);
  INT = EG modulates LFO intensity (with INT knob). This replaces the xd's MODE switch — there is **no 1-shot** on the OG. [OM p.21-22]
- RATE 0..1023, Hz range unpublished (family reference 0.05–28 Hz from the xd manual; UNCONFIRMED for OG).
  EG MOD=RATE can push effective rate above the knob range into audio territory — extent UNCONFIRMED.
- BPM Sync ON: 16 zones of 64 [MIDIimp P5], divisions `4, 2, 1, 3/4, 1/2, 3/8, 1/3, 1/4, 3/16, 1/6, 1/8, 1/12, 1/16, 1/24, 1/32, 1/36`
  (manual says "…1/64" but the MIDIimp table ends at 1/36 — trust MIDIimp).
- INT 0..1023 **unipolar** (the xd's 512-centered bipolar store came later). TARGET [CUTOFF, SHAPE, PITCH] — SHAPE and
  PITCH act on **both VCOs** (no Target-Osc menu like the xd). Program flags: LFO Key Sync, LFO BPM Sync, LFO Voice Sync. [OM p.36-38]

## 9. DELAY (the only effect; post-VCA, shared across voices)

- HI PASS CUTOFF 0..1023, TIME 0..1023 (**not** tempo-syncable; ms range UNCONFIRMED), FEEDBACK 0..1023
  (max "a tad greater than unity" — runs away into self-oscillation [SoS]).
- Character: analog HPF + lo-fi digital delay line; noisy/tape-like/characterful [SoS/MR/maffez]. Worth modeling the grunge.
- **OUTPUT ROUTING [BYPASS, PRE FILTER, POST FILTER]** — "FILTER" = the delay's own HPF, *not* the VCF [OM p.23]:
  BYPASS = delay AND HPF both bypassed (pure path); PRE FILTER = HPF applied **only to the wet** (each repeat thins out);
  POST FILTER = HPF applied to **dry + wet**. Trick: TIME/FEEDBACK at 0 + POST = static HPF tone shaper [MR].
  CC88 zone order vs program-data enum order conflict — see §15.

## 10. Sequencer

- 16 steps; per step **up to 4 notes** (note + velocity; velocity 0 = no event) + per-note gate byte
  (bits0-6: 0..72 = 0–100%, 73..127 = TIE; bit7 = trigger switch; TIE + next-step trigger 0 ⇒ note continues). [MIDIimp S4]
- Step Length 1..16; Step Resolution [1/16, 1/8, 1/4, 1/2, 1/1]; BPM 10.0–300.0 (stored ×10, 12-bit); Swing −75..+75;
  Default Gate Time 0–100% (stored 0..72); per-step On/Off masks. Real-time rec (overdub, REST erases), step rec
  (release advances; REST = rest; REST+key = tie), step edit via buttons 1-8 with 1-8/9-16 page toggle. [OM p.26-31]
- **Motion: 4 lanes**, records all panel knobs AND switches except MASTER, TEMPO, OCTAVE (motion param IDs [MIDIimp S3-1,
  corrected] include SYNC, RING, FILTER TYPE, DELAY ROUTING, plus PITCH BEND and GATE TIME from the slider).
  Per lane: On/Off + Smooth On/Off; per step **two 8-bit values** (Data1, Data2): Smooth OFF or switch-type → Data1 only
  (stepped); Smooth ON → interpolate Data1→Data2 across the step. (Coarser than the xd's 10-bit 5-point lanes.)
- Key trigger transpose: SHIFT+PLAY, relative to first recorded note.

## 11. Menu params (per program)

- Bend Range + / − : 1..12 semitones (byte 66 nibbles). Portamento Time: byte 61, encoding `0,1..129 = OFF,0..128`.
- Flags (byte 69): LFO Key Sync, LFO BPM Sync, LFO Voice Sync, Portamento BPM, Portamento Mode [Auto, On].
- Program Level: byte 71, stored 77..127 = −25..+25 (units unstated; likely 0.5 dB steps UNCONFIRMED).
- Slider Assign (byte 72, 29 destinations, exact order) [MIDIimp P13]: PITCH BEND, GATE TIME, VCO1 PITCH, VCO1 SHAPE,
  VCO2 PITCH, VCO2 SHAPE, CROSS MOD DEPTH, VCO2 PITCH EG INT, VCO1 LEVEL, VCO2 LEVEL, NOISE LEVEL, CUTOFF, RESONANCE,
  FILTER EG INT, AMP EG ATTACK/DECAY/SUSTAIN/RELEASE, EG ATTACK/DECAY/SUSTAIN/RELEASE, LFO RATE, LFO INT,
  DELAY HI PASS CUTOFF, DELAY TIME, DELAY FEEDBACK, PORTAMENTO, VOICE MODE DEPTH. Slider Range −100..+100% (storage UNCONFIRMED).
- Keyboard Octave (byte 73 b0-2, 0..4 = −2..+2). Global (not per program): master tune ±50c, transpose ±12,
  velocity curves 1-8 + Const127, knob mode Jump/Catch/Scale, audio-in on/off.

## 12. MIDI CC map — **Revision 1.10** (firmware ≥ 1.10; launch firmware used a different map, see §15)

All 7-bit (0..127 → scale to raw 0..1023; **no** CC63 10-bit LSB scheme — that is the xd).
Knobs: CC16-19 AMP EG A/D/S/R, CC20-23 EG A/D/S/R, CC24 LFO RATE, CC26 LFO INT, CC27 VM DEPTH,
CC29 DELAY HI PASS, CC30 DELAY TIME, CC31 DELAY FEEDBACK, CC33 NOISE, CC34/35 VCO1/2 PITCH, CC36/37 VCO1/2 SHAPE,
CC39/40 VCO1/2 LEVEL, CC41 CROSS MOD, CC42 PITCH EG INT, CC43 CUTOFF, CC44 RESONANCE, CC45 CUTOFF EG INT.
Switches (rx zones / tx values): CC48/49 VCO1/2 OCTAVE (quartiles; tx 0,42,84,127), CC50/51 VCO1/2 WAVE (thirds
0-42 SQR / 43-85 TRI / 86-127 SAW), CC56 LFO TARGET (thirds), CC57 LFO EG MOD (thirds OFF/RATE/INT), CC58 LFO WAVE (thirds),
CC80 SYNC (0-63 Off / 64-127 On — **normal polarity, unlike the xd's inverted rx**), CC81 RING (same), CC82 CUTOFF VELOCITY
(thirds), CC83 KEY TRACK (thirds), CC84 FILTER TYPE (0-63 2-POLE / 64-127 4-POLE), CC88 DELAY ROUTING (thirds; order §15).
Also: Bank Select MSB/LSB (CC0=0, CC32=0..1) + PC 0-99 → programs 1-200; pitch bend; CC64 sustain **not listed** —
the OG has no damper input? (UNCONFIRMED — verify; xd receives CC64). Note-off tx as 8n vv=64. No CC for VOICE MODE.

## 13. SysEx (program dump — the calibration rig's patch-setting path)

- Header `F0 42 3g 00 01 2C`; functions: 0x10 current-program request, 0x1C program request (2-byte prog no),
  0x0E global request, 0x40 current program dump, 0x4C 1-program dump, 0x51 global dump, 0x23 ACK, 0x24/0x26 NAK.
  Standard Korg 7↔8-bit packing (448-byte program → 512 wire bytes; 96-byte global → 110).
- Program: bytes 0-3 `PROG`, 4-15 name (12 ASCII), knobs stored 10-bit split (upper 8 bits at bytes 20-51/70,
  lower 2 bits packed in bytes 52-64; authoritative layout = TABLE 2, confirmed by [editor] — note P1 quick-ref has errors).
  Sequence: bytes 96-447, `SEQD` + BPM/length/swing/gate/resolution + step masks + 4 motion slots (2 bytes each:
  on/smooth flags + param ID) + motion per-step masks + 16 × 20-byte step blocks (4 notes, 4 vels, 4 gate/trig bytes,
  4 slots × 2 motion bytes).

## 14. Modeling notes

- Filter: model the resonance-vs-bass tradeoff (§6) — it is the OG's signature; 2/4-pole switchable; self-osc usable as sine VCO.
- Delay: lo-fi digital line + analog HPF; feedback just over unity; noisy — some grit is authentic.
- VCOs: same analog VCO family as the xd replica's (polyBLEP + shape morphs reusable); drift behavior as xd (free-running).
- EG→LFO (EG MOD) is the OG's most distinctive mod trick (delayed vibrato via INT, accelerating wobble via RATE).
- Voices are mono-summed after VCA into the shared HPF+delay; AUDIO IN merges at the same point (audio-in out of scope).

## 15. Known doc errata / discrepancies (official MIDIimp rev 1.10)

1. Note P3 (PITCH EG INT): positive rows `668-1020: 256-1200 / 1020-1023: 1200` are copy-paste from P2; corrected to
   1024→4800 / 4800 by symmetry (§4). Verify on hardware.
2. Note P12 (DELAY mode): 1/16 zone printed `521-597`; must be `512-597`.
3. Note P1 quick-reference bit locations conflict with TABLE 2 for EG RELEASE / LFO RATE / LFO INT lower bits;
   TABLE 2 is correct (confirmed by [editor] against hardware).
4. Note S3-1 motion param IDs 17-24 print duplicated names; corrected by symmetry to VCO1/VCO2 PITCH/SHAPE/OCTAVE/WAVE.
   ID 52 printed "LFO TYPE" = LFO WAVE.
5. DELAY ROUTING order: CC88 zones documented BYPASS/POST/PRE but program enum is 0=BYPASS, 1=PRE, 2=POST — one is a doc
   error; verify which the hardware obeys via CC before finalizing the CC decoder.
6. CC map changed at firmware 1.10 (launch 1.00 used CC1-13/64-67/90-92); implement rev 1.10 only.
7. Slider Assign range printed 0..79 in TABLE 2 vs 29 enumerated values in P13 — clamp to 0..28.

## 16. UNCONFIRMED / calibration targets (extends docs/hardware-calibration.md; OG hardware not owned — from manuals/recordings only)

LFO Hz range + EG-MOD RATE depth scaling; delay TIME ms range, line character (sample rate/noise), feedback max;
EG segment times/curves; DELAY-mode echo levels + EG retrigger; MONO sub depth crossfade; SIDE CHAIN duck curve/recovery;
POLY Invert 0..8 voicing behavior; filter res-vs-bass amount + self-osc threshold + 4-pole taper; program level dB units;
CC64 sustain reception; preset-slot overwritability (SoS says no, manual implies yes).
