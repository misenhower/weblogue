# Korg minilogue xd — Hardware Spec (for the software replica)

Compiled from: **[OM]** Owner's Manual E7, **[MIDIimp]** official MIDI Implementation rev 1.01,
**[KorgWeb]** product page, **[logueSDK]** logue-sdk docs, **[SoS]** Sound on Sound reviews.
Items marked UNCONFIRMED are best-effort inferences.

## 1. Architecture / signal path

- 4-voice polyphonic. Per voice: 2 VCO (SQR/TRI/SAW) + MULTI ENGINE (NOISE / VPM / USER), 1 VCF, 2 EG, 1 LFO, 1 VCA. [OM p.66]
- Block diagram [OM p.4]: `4-VOICE ASSIGNER → VOICE 1..4 → Voice Mixer → DIGITAL EFFECTS → OUT L/R`.
  Inside a voice: VCO1 (PITCH←LFO/EG), VCO2 (PITCH←EG, FM←CROSS MOD from VCO1, OSC SYNC←VCO1, RING MOD by VCO1),
  MULTI (SHAPE←LFO, PITCH←LFO/EG) → 3-ch mixer → VCF (cutoff←EG/keytrack/LFO; DRIVE into filter) → VCA (←AMP EG, velocity).
- **Voices are mono-summed pre-FX**; FX chain: `MOD FX → DELAY → REVERB`, stereo, delay/reverb mix wet in place. [logueSDK]
- Menu `Multi Routing [Pre VCF, Post VCF]`: Post = MULTI bypasses the VCF, rejoins before VCA. [OM p.38]
- 500 program slots.

## 2. Master

- OCTAVE switch ±2 (stored in program as 0..4). TEMPO knob 56.0–240.0 BPM (SEQ EDIT BPM 10.0–300.0).
- PORTAMENTO 0–127. Joystick: X = pitch bend (per-direction Bend Range Off,1..12), Y+ = Mod1 (CC1), Y- = Mod2 (CC2), assignable.

## 3. Voice modes + VOICE MODE DEPTH (knob stored 0..1023)

Panel switch: ARP/LATCH, CHORD, UNISON, POLY. (Push ARP switch down again = LATCH, LED blinks.)

- **POLY**: `0..255 = Poly; 256..1023 = Duo 0..1023` — DUO stacks a detuned 2nd voice per note (drops to 2-voice poly);
  knob raises stacked-voice level AND detune together. [MIDIimp P2, OM p.17]
- **UNISON**: all 4 voices stacked mono; depth = detune 0..50 cents.
- **CHORD** zones [MIDIimp P2]: 0-73 5th | 74-146 sus2 | 147-219 m | 220-292 Maj | 293-365 sus4 | 366-438 m7 |
  439-511 7 | 512-585 7sus4 | 586-658 Maj7 | 659-731 aug | 732-804 dim | 805-877 m7b5 | 878-950 mMaj7 | 951-1023 Maj7b5.
  (Manual panel list has a leading "Mono" at far left; MIDIimp omits it.)
- **ARP** zones [MIDIimp P2]: 0-78 MANUAL 1 | 79-156 MANUAL 2 | 157-234 RISE 1 | 235-312 RISE 2 | 313-390 FALL 1 |
  391-468 FALL 2 | 469-546 RISE FALL 1 | 547-624 RISE FALL 2 | 625-702 POLY 1 | 703-780 POLY 2 | 781-858 RANDOM 1 |
  859-936 RANDOM 2 | 937-1023 RANDOM 3. **No octave-range setting.** Arp Rate (SEQ EDIT):
  `64th,48th,32th,24th,16th,16.th,12th,8th,8.th,6th,4th`; Arp Gate Time 0–100%; swing applies.

## 4. VCO1 / VCO2

- WAVE [SQR,TRI,SAW] = 0,1,2. OCTAVE [16',8',4',2'] = 0..3.
- PITCH 0..1023 → cents [MIDIimp P5]:
  `0-4:-1200 | 4-356:-1200..-256 | 356-476:-256..-16 | 476-492:-16..0 | 492-532:0 | 532-548:0..16 | 548-668:16..256 | 668-1020:256..1200 | 1020-1023:1200` (linear within segments).
- SHAPE: SQR = pulse width (PWM under LFO); TRI = wavefold emphasizing 3rd/5th harmonics; SAW = morph toward
  square-ish blend, attenuating even harmonics. [OM p.18, SoS, MR]
- **SYNC and RING are two separate ON/OFF toggles on the xd** (can both be ON). SYNC: VCO2 phase forced by VCO1.
  RING: VCO1 ring-modulates VCO2 (replaces the VCO2 mixer path). CROSS MOD DEPTH: **VCO1 modulates pitch of VCO2**
  at audio rate. [OM p.19, p.4]

## 5. MULTI ENGINE

Shape/shift-shape/type are stored **separately per engine type** (NOISE/VPM/USER each keep their own). Multi Octave 16'..2'.

### NOISE (SHAPE per type) [OM p.20]
- High: HPF cutoff 10.0 Hz–21.0 kHz. Low: LPF cutoff 10.0 Hz–21.0 kHz.
- Peak: bandpass **BANDWIDTH** 110.0–880.0 Hz (center: UNCONFIRMED, model as keytracked).
- Decim: decimator RATE 240 Hz–48.0 kHz; SHIFT+SHAPE = keytrack of rate 0–100%.

### VPM — 16 types, 2-op (carrier+modulator, feedback, noise-mod, internal mod EG) [OM p.21]
SHAPE = MOD DEPTH (index, per-type range e.g. 0–15); SHIFT+SHAPE = RATIO OFFSET (e.g. 1:4,1:2,1:1,2:1..., per type).
1 Sin1 (sine car+mod) | 2 Sin2 (mod self-feedback) | 3 Sin3 (3x harmonic mod) | 4 Sin4 (5x harmonic mod) |
5 Saw1 (modulated saw carrier) | 6 Saw2 (sine sim of saw) | 7 Squ1 (square carrier) | 8 Squ2 (sine sim of square) |
9 Fat1 (1/4 sub mod, fb, driven carrier) | 10 Fat2 (3/4 sub mod, fb, driven) | 11 Air1 (noise-modulated sine) |
12 Air2 (noise+sine mod) | 13 Decay1 (decaying mod amount) | 14 Decay2 (strong decaying mod) | 15 Creep | 16 Throat (atonal, evolving).
Menu VPM params (±100%, 0 = type default): Feedback, Noise Depth, Shape Mod Int, Mod Attack, Mod Decay, Mod Key Track.

### USER: 16 slots on hardware (SDK binaries); replica ships built-ins.

## 6-7. Mixer / Filter

- Levels VCO1/VCO2/MULTI 0..1023.
- VCF: **2-pole LP** [KorgWeb]. Cutoff span ≈20 Hz–20 kHz (UNCONFIRMED, exp). Resonance can distort; keeps low end
  fairly well at high res. DRIVE [0%,50%,100%] **drives signal into the filter** (pre-filter saturation).
  KEYTRACK [0,50,100%], centered on C4 (100% = 1 oct cutoff per keyboard oct).

## 8. Envelopes

- AMP EG: full ADSR → VCA. Times undocumented; slowest attack ≈3 s [SoS]; decay/release max ≈10+ s (UNCONFIRMED).
  Segments sweep near-constant-rate (digitally generated, more linear than RC). Amp Velocity menu 0..127 (0 = off).
- EG (mod): **Attack + Decay only**; decay continues after key-up. EG INT stored 0..1023 → percent [MIDIimp P10]:
  `0-11: -100 | 11-492: -((492-v)^2*4641*100)/2^30 | 492-532: 0 | 532-1013: ((v-532)^2*4641*100)/2^30 | 1013-1023: 100`.
- EG TARGET data 0,1,2 = **CUTOFF, PITCH 2, PITCH**. PITCH = VCO1+VCO2+MULTI; PITCH 2 = VCO2 only.
  EG→pitch cents at 100%: UNCONFIRMED (use ±4800c).
- EG Velocity menu 0..127 scales cutoff EG INT by velocity.
- Family quirk: EGs restart from zero on retrigger (UNCONFIRMED officially).

## 9. LFO (one per voice)

- WAVE [SQR,TRI,SAW]=0,1,2. MODE [1-SHOT, NORMAL, BPM]: 1-SHOT stops after a **half-cycle**; NORMAL free 0.05–28 Hz.
- RATE 0..1023; BPM mode divisions in 64-wide zones [MIDIimp P11]:
  `4, 2, 1, 3/4, 1/2, 3/8, 1/3, 1/4, 3/16, 1/6, 1/8, 1/12, 1/16, 1/24, 1/32, 1/36` (fractions of whole note).
- INT: panel 0..511, SHIFT+INT inverts (0..-511); stored 0..1023 with 512 = 0.
- TARGET [CUTOFF, SHAPE, PITCH]=0,1,2 routed to `LFO Target OSC` menu [All, VCO1+2, VCO2, Multi].
- LFO Key Sync (phase reset on note-on), LFO Voice Sync (phase shared across voices).

## 10. Effects (all three sections can run simultaneously; 32-bit float stereo DSP)

- TIME 0..1023, DEPTH 0..1023 per section. DELAY & REVERB each also store DRY WET 0..1024 (SHIFT+DEPTH);
  MOD FX has no dry/wet (insert).
- MOD FX types/subs:
  CHORUS [Stereo, Light, Deep, Triphase, Harmonic, Mono, Feedback, Vibrato];
  ENSEMBLE [Stereo, Light, Mono];
  PHASER [Stereo, Fast, Orange, Small, Small Reso, Black, Formant, Twinkle];
  FLANGER [Stereo, Light, Mono, High Sweep, Mid Sweep, Pan Sweep, Mono Sweep, Triphase]; USER slots.
- DELAY subs (order): Stereo, Mono, Ping Pong, Hipass, Tape, One Tap, Stereo BPM, Mono BPM, Ping BPM, Hipass BPM,
  Tape BPM, Doubling (+USER). TIME = time/division, DEPTH = feedback/intensity (max feedback just under unity).
- REVERB subs (order): Hall, Smooth, Arena, Plate, Room, Early Ref, Space, Riser (octave-up shimmer),
  Submarine (octave-down, dark), Horror (unstable) (+USER). TIME = decay, DEPTH = level.

## 11. Sequencer

- 16 steps; Step Length 1..16; Step Resolution [1/16,1/8,1/4,1/2,1/1]; BPM 10.0–300.0 (stored ×10);
  Swing -75..+75%; Default Gate Time 0–100% (stored 0..72).
- Per step: up to **8 notes** (note + velocity 1..127 + per-note gate 7 bits: 0..72 = 0–100%, 73..127 = TIE;
  bit7 = trigger switch). TIE + next-step trigger 0 ⇒ note continues.
- Two per-step masks: Step On/Off and Active Step (skip).
- Step rec: from step 1 or pressed step; key release finalizes; REST = rest; REST+held key = tie; auto-advance.
  Realtime rec: overdub while playing; REST held erases. Step edit: hold step(s)+key writes notes; hold step+knob
  writes a motion value to those steps.
- **Motion seq: 4 lanes.** Each lane: on/off, smooth on/off, param id. Per lane per step: **5 data points** (10-bit).
  Smooth ON: interpolate p1→p2 over first 1/4 of step, p2→p3 next 1/4, p3→p4, p4→p5. Smooth OFF or switch-type
  param: only point 1, no interpolation. Recordable params ≈ all panel params + PITCH BEND + GATE TIME;
  NOT recordable: MASTER, TEMPO knob, master OCTAVE, DRIVE, multi USER type, FX section-select.

## 12. Menu params (engine-relevant)

- X+/X- Bend Range: Off,1..12 each. Y+/Y- Assign (29 dests, exact order):
  GATE TIME, PORTAMENTO, V.M DEPTH, VCO1 PITCH, VCO1 SHAPE, VCO2 PITCH, VCO2 SHAPE, CROSS MOD, MULTI SHAPE,
  VCO1 LEVEL, VCO2 LEVEL, MULTI LEVEL, CUTOFF, RESONANCE, A.EG ATTACK, A.EG DECAY, A.EG SUSTAIN, A.EG RELEASE,
  EG ATTACK, EG DECAY, EG INT, LFO RATE, LFO INT, MOD FX SPEED, MOD FX DEPTH, REVERB TIME, REVERB DEPTH,
  DELAY TIME, DELAY DEPTH. Y+/Y- Range -100..+100%.
- Microtuning: Equal Temp, Pure Major, Pure Minor, Pythagorean, Werckmeister, Kirnburger, Slendro, Pelog, Ionian,
  Dorian, Aeolian, Major Penta, Minor Penta, Reverse, AFX/DC/user scales. Scale Key ±12. Program Tuning ±50 cent.
  Program Transpose ±12.
- LFO Target OSC / Key Sync / Voice Sync; EG Velocity 0..127; Amp Velocity 0..127; Multi Octave; Multi Routing;
  EG Legato (UNISON/CHORD legato retrigger); Portamento Mode [Auto, On]; Portamento BPM; Program Level
  -18.0..+6.0 dB (stored 12..132).
- Global: Master Tune ±50c, velocity curves 1-8+Const127, Knob Mode Jump/Catch/Scale.

## 13. MIDI CC map (main)

CC1 JoyY+, CC2 JoyY-, CC5 Portamento, CC16-19 AMP EG A/D/S/R, CC20/21 EG A/D, CC22 EG INT, CC23 EG TARGET
(thirds CUTOFF/PITCH2/PITCH), CC24 LFO RATE, CC26 LFO INT, CC27 VM DEPTH, CC28/29 MODFX TIME/DEPTH,
CC33 MULTI LEVEL, CC34/35 VCO1/2 PITCH, CC36/37 VCO1/2 SHAPE, CC39/40 VCO1/2 LEVEL, CC41 CROSS MOD,
CC43 CUTOFF, CC44 RESONANCE, CC48/49 VCO1/2 OCTAVE (quartiles), CC50/51 VCO1/2 WAVE (thirds),
CC53 MULTI TYPE (thirds), CC54 MULTI SHAPE, CC56 LFO TARGET, CC57 LFO WAVE, CC58 LFO MODE, CC63 = LSB (lower
3 bits sent BEFORE the MSB CC for 10-bit params: v10 = (msb7<<3)|lsb3), CC64 sustain, CC80 SYNC (rx 0-63=ON!),
CC81 RING (same), CC83 KEYTRACK, CC84 DRIVE, CC88 MODFX TYPE (fifths), CC89 DELAY SUB, CC90 REVERB SUB,
CC92/93/94 MODFX/DELAY/REVERB ON, CC96 MODFX SUB, CC103 MULTI SUB, CC104 MULTI SHIFT SHAPE, CC105/106/107
DELAY TIME/DEPTH/DRYWET, CC108/109/110 REVERB TIME/DEPTH/DRYWET. Pitch bend per-direction range. Channel
pressure → assignable dest.

## 14. Modeling notes

- Filter: 2-pole OTA-ish; drive interacts with resonance (pre-filter). EGs digital, near-linear segments.
- xd sync sweeps are clean (no discontinuity); RING+SYNC can combine; CROSS MOD is VCO1→VCO2 audio-rate FM.
- LFO max 28 Hz (audio-adjacent). Voices mono until MOD FX. VCOs very stable (auto-tune); keep drift subtle.

## 15. Known doc discrepancies

SYNC/RING CC polarity conflict (trust 0=ON receive/SysEx); CHORD leading "Mono" (manual) vs none (MIDIimp);
LFO BPM list ends 1/36 (MIDIimp) not 1/64 (manual); Program Level 12..132 vs NRPN 0..120 (same dB span).
