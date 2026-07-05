# Korg prologue-8 / prologue-16 (2018) — Hardware Spec (for the software replica)

Compiled from: **[OM]** Owner's Manual E6/E7 (FW 2.0; https://cdn.korg.com/us/support/download/files/f2f233103ddbf550c5733668d80fee64.pdf,
E7 https://cdn.korg.com/us/support/download/files/523f9061019ea3c2785c5c4e69edb4f5.pdf; block/program-architecture
diagrams verified from rendered pages), **[MIDIimp]** official MIDI Implementation Revision 1.01, 2020.2.10
(https://cdn.korg.com/us/support/download/files/aa7cbf7a5dcf8c98f143ba869f349c69.txt via
https://www.korg.com/us/support/download/manual/0/778/4066/; local copy in docs/hardware/, gitignored),
**[KorgWeb]** product/spec pages + FW 2.00 notes (https://www.korg.com/us/news/2019/091302/), **[SoS]**, **[MR]**
(review + ultimate guide), **[Loopop]** (video, transcript unavailable), **[decoder]** gazzar/loguetools +
anthonyray/patchlogue. UNCONFIRMED items → §17; official-doc errata → §16.

## 1. Architecture / signal path

- **8 voices (prologue-8, 49 keys) / 16 voices (prologue-16, 61 keys)**; per voice: 2 analog VCOs + digital
  **MULTI ENGINE** (same NOISE/VPM/USER structure as the minilogue xd, binary-compatible logue-sdk units) →
  3-ch mixer → 2-pole VCF → VCA. Voices sum → shared stereo digital FX (**MOD FX**, then **DELAY-or-REVERB**,
  48 kHz/24-bit) → (prologue-16 only) analog **L.F. COMP** → OUT L/R. [OM p.4 block diagram]
- **Bitimbral**: MAIN + SUB timbre, each a full parameter copy; SUB ON halves voices (16→8+8, 8→4+4; no other
  split of the pool). TIMBRE TYPE [LAYER, XFADE, SPLIT]. **Voice modes and depth are PER TIMBRE.**
- 500 programs; 4 live-set banks × 8 slots; program SORT categories. Pitch-bend + mod wheels; velocity;
  **no keybed aftertouch** (MIDI aftertouch receive added in FW 2.00). Auto-tune: boot ~15 s + background
  tuning while silent; warm-up drift is real (§17).

## 2. Program architecture — program-global vs per-timbre [OM p.17 diagram, MIDIimp TABLE 3]

**Program-global** (stored once): name, category, octave, TEMPO 30.0–600.0, TIMBRE TYPE/BALANCE 0-127/POSITION
(Sub↔Main)/SPLIT POINT (C-1..G9)/SUB ON/EDIT TIMBRE, the whole FX section (mod fx type/subtypes-per-type/speed/
depth/on + delay-reverb OFF/DELAY/REVERB + type/time/depth/dry-wet + **two FX ROUTINGs [MAIN+SUB, MAIN, SUB]**),
ARP block (off/on/latch, type, range, rate, gate time, TARGET [Main+Sub, Main, Sub]), AMP VELOCITY, PORTAMENTO
MODE, PROGRAM LEVEL 12-132 = −18..+6 dB, MICRO TUNING + SCALE KEY + program tuning.
**Per-timbre** (×2, identical 126-byte blocks at 80/206): portamento time, VOICE SPREAD, VOICE MODE TYPE
[POLY, MONO, UNISON, CHORD] + DEPTH, both VCOs (wave/octave/pitch/shape), PITCH EG target/int, RING/SYNC,
CROSS MOD, MULTI (routing/type/octave/selects/shapes/shift-shapes(VPM+USER only)/levels/VPM params 1-6/user
params), CUTOFF/RES/EG INT/drive/low-cut/keytrack, both ADSRs, LFO block + target-osc/key-sync/voice-sync,
EG velocity/legato?, M.WHEEL ASSIGN (32 dests, note P23) + RANGE ±100%, MIDI AFTERTOUCH assign (FW2).

## 3. Panel (prologue-16; the 8 moves TIMBRE/SPREAD to menus and drops L.F. COMP)

MASTER block: bend + mod wheels, OCTAVE ±2 buttons, MASTER, PORTAMENTO [Off, 0..127], **VOICE SPREAD** 0..127
(16 only; stereo voice placement), VOICE MODE SELECT (4 LEDs) + **VOICE MODE DEPTH**. TIMBRE (16 only):
SUB ON/PGM FETCH, MAIN/SUB BALANCE (64 = equal; **turning LEFT increases the MAIN timbre** [OM] — so 0 = full
main, 127 = full sub), TYPE [LAYER, XFADE, SPLIT], PANEL edit-select [SUB, +, MAIN]. VCO1/VCO2:
WAVE [SQR, TRI, SAW], OCTAVE [2',4',8',16'], PITCH ±1200¢ (family piecewise), SHAPE. MODULATION: **PITCH EG
switch [VCO 2, VCO 1+2, ALL(+multi)] + INT ±4800¢**; SYNC/RING 3-way [RING, off, SYNC] (exclusive; CROSS MOD
knob stacks with either). MULTI ENGINE: NOISE/VPM/USR + OCTAVE + own 7-seg display + TYPE + SHAPE (+SHIFT
SHAPE). MIXER: VCO1/VCO2/MULTI 0..1023. FILTER: CUTOFF, RESONANCE, EG INT ±100% (family quadratic), DRIVE
[0/50/100%], **LOW CUT [OFF, ON]** (gentle non-resonant HPF), KEYTRACK [0/50/100%]. AMP EG + EG: 2× full ADSR.
LFO: WAVE, **MODE [BPM, SLOW, FAST]** (no 1-shot; SLOW 0.05–28 Hz, FAST 0.5 Hz–2.8 kHz), RATE, INT 0..511
(SHIFT = invert), TARGET [CUTOFF, SHAPE, PITCH]. EFFECT: MOD FX OFF/ON/SELECT + SPEED/DEPTH;
DELAY/REVERB [OFF, DELAY, REVERB] + TIME/DEPTH (+ FW2 dry/wet). L.F. COMP (16): GAIN + ON/OFF + VU.
ARPEGGIATOR: ON/LATCH (hold = latch, blinks), TEMPO, RANGE 1-4 oct, TYPE. EDIT/WRITE/EXIT/SHIFT + PROGRAM/VALUE
+ main display (oscilloscope mode available).

## 4. Voice modes (per timbre; VOICE MODE DEPTH zones [MIDIimp P13])

- **POLY**: 0-255 = Poly; 256-1023 = **DUO** (stacks 2 voices/key; depth raises stacked level + detune) — the
  xd's POLY/DUO semantics.
- **MONO**: Sub 0..1023 — voices 2+3 join at −1 oct, further right voice 4 at −2 oct (the OG MONO model).
- **UNISON**: detune 0..50¢ across ALL of the timbre's voices (8 or 16 when solo-timbre — a monster stack).
- **CHORD**: the family 14-chord zone table (5th … Maj7b5, same boundaries as xd/OG).
- Allocation: round-robin with release tails; steal on exhaustion (policy undocumented; pre-FW1.30 repeated
  notes could land on differently-drifted voices — §17). EG Legato menu [Off, On] for MONO/UNISON/CHORD.

## 5. EG structure

Two full ADSRs (0..1023 each). AMP EG → VCA (+ Amp Velocity 0..127, program-global). **EG (mod) is shared**:
simultaneously → cutoff via FILTER EG INT (±100%, bipolar quadratic) and → pitch via the PITCH EG switch
[VCO 2, VCO 1+2, ALL] + INT (±4800¢, family piecewise P17) — no target menu like the xd. EG Velocity 0..127
scales cutoff-EG int. Attack max ≈ 3 s; segments near-linear with an audible decay→sustain cusp [SoS].
(OM p.33 prose mentions EG→LFO; the block diagram shows no such path — treat as doc looseness, §16.)

## 6. Multi engine — identical to the xd's

NOISE [High, Low, Peak, Decim] (same shape ranges; octave switch keytracks Peak/Decim only); VPM 16 types +
SHAPE = mod depth 1.00-15.00 + SHIFT SHAPE = ratio + 6 menu params ±100% (map to our VpmTrims); USER 16 slots.
**No SHIFT-SHAPE-NOISE field in program data** (unlike the xd) [MIDIimp timbre +36-37 reserved]. Multi Routing
[Pre VCF, Post VCF]. User slots: 16 osc / 16 modfx / 8 delay / 8 reverb.

## 7. Effects (program-global, shared stereo)

- **MOD FX**: types CHORUS(8 subs)/ENSEMBLE(3)/PHASER(8)/FLANGER(8)/USER(16) — identical lists to the xd.
  SPEED/DEPTH only. **ROUTING [MAIN+SUB, MAIN, SUB]**.
- **DELAY or REVERB, mutually exclusive** (byte 62: 0/1/2 = OFF/DELAY/REVERB; separate on/off at 72): DELAY 12
  types (same list as xd incl. BPM variants + Doubling) + USER1-8; REVERB 10 types (Hall, Smooth, Arena, Plate,
  Room, Early Ref, Space, Riser, Submarine, Horror) + USER1-8. TIME/DEPTH (+ FW2 DRY WET CC111). Own ROUTING.
- **L.F. COMP** (prologue-16 only): analog low-frequency compressor/booster, LAST in chain, GAIN + ON/OFF + VU.
  **Not stored in programs, zero MIDI presence** [OM p.37, MIDIimp grep] — replica: app-level state (persisted
  like UI prefs), a documented deviation from "physical knob only".

## 8. LFO

One per voice; WAVE [SQR, TRI, SAW]; MODE [BPM, SLOW 0.05-28 Hz, FAST 0.5-2800 Hz] — **no 1-shot**; BPM zones =
the family 16-division table (4 … 1/36) [MIDIimp P22]; INT 0..511 + SHIFT-invert (xd-style bipolar store 0..1023
center 512); TARGET [CUTOFF, SHAPE, PITCH] + menu LFO Target OSC [All, VCO1+2, VCO2, Multi], Key Sync, Voice Sync.

## 9. Wheels / aftertouch

- MOD WHEEL: per-timbre **M.WHEEL ASSIGN** (32 destinations [MIDIimp P23]: BALANCE, PORTAMENTO, V.SPREAD,
  V.M DEPTH, VCO/MULTI pitches-shapes-levels, CUTOFF, RESONANCE, both EG ADSRs + ints, LFO RATE/INT, FX
  params, GATE TIME) × M.WHEEL RANGE ±100%. **The wheel transmits its assigned destination's CC — there is no
  CC1 in the receive map** [MIDIimp]; replica maps incoming CC1 → wheel deflection as a documented usability
  deviation. Pitch bend: per-direction ranges.
- FW 2.00 MIDI AFTERTOUCH assign (receive-only), same destination list.

## 10. Arpeggiator (program-global; **no step sequencer, no motion sequencing**)

OFF/ON/LATCH (byte 73); TYPE 6 [MIDIimp P12]: MANUAL, RISE, FALL, RISE FALL, RANDOM, POLY RANDOM (Poly Random =
2 random notes at once, POLY mode only); RANGE 1-4 octaves (raw 0..15, mapping UNCONFIRMED); FW2 ARP RATE
[64th … 4th; the three sources disagree on the exact list — §16] + GATE TIME 1..73 = 0-100%; ARP TARGET
[Main+Sub, Main, Sub]; TEMPO is the program's 30.0-600.0 BPM.

## 11. MIDI CC map — plain 7-bit (**no NRPN, no 10-bit pairs**; 10-bit granularity is SysEx-only)

Knobs: CC5 PORTAMENTO, CC8 TIMBRE BALANCE*, CC14 VOICE SPREAD*, CC16-19 AMP EG, CC20-23 EG, CC24 LFO RATE,
CC26 LFO INT, CC27 VM DEPTH, CC28/29 MOD FX SPEED/DEPTH, CC30/31 DL-RV TIME/DEPTH, CC33 MULTI LEVEL, CC34/35
VCO PITCH, CC36/37 SHAPE, CC39/40 LEVEL, CC41 CROSS MOD, CC42 PITCH EG INT, CC43/44/45 CUTOFF/RES/CUTOFF EG INT,
CC54 MULTI SHAPE, CC104 MULTI SHIFT SHAPE, CC111 DL-RV DRY WET. Switches: CC48/49/52 octaves (quartiles),
CC50/51/57 waves (thirds), CC53 MULTI TYPE, CC56 LFO TARGET, CC58 LFO MODE [BPM, SLOW, FAST], CC80 RING/OFF/SYNC,
CC81 PITCH EG [VCO1?, VCO1+2, VCO2] (§16 enum order), CC82 LOW CUT, CC83 KEYTRACK, CC84 DRIVE, CC85 TIMBRE EDIT*,
CC86 TIMBRE TYPE*, CC88 MOD FX TYPE (5 zones — doc prints 4, §16), CC89 DELAY/REVERB (halves; **no OFF via CC**),
CC90/91 DL-RV/MOD-FX subtype?, CC92/94 FX on/offs, CC103 MULTI SUB TYPE. (*16-only params.) Bank Select LSB 0-4
+ PC → 500 programs. **SUB timbre via a dedicated global "MIDI Sub CC Ch"** — same CCs on a second channel;
the panel's TIMBRE EDIT (CC85) scopes which timbre panel edits address.

## 12. SysEx essentials (family ID 4B 01)

Header F0 42 3g 00 01 4B. Functions: 10/1C/0E/16 requests, 40/4C/46/51 dumps, tuning 14/15/44/45 (same MTS
384-byte user-scale / 36-byte user-octave format as monologue/xd), user-unit API 17-1E/47-4A + CRC-checked
slots, ACK/NAK 23/24/26-2F. **Program = 336 internal bytes** ('PROG' + program block 0-79 + timbre1 80-205 +
timbre2 206-331 + 'PRED') → 384 wire bytes. 16-bit fields annotated H-byte-first (loguetools parses prologue
big-endian but the sister xd little-endian — §17 verify). LIVESET dump = 4 banks × 8 program numbers.

## 13. Voice spread + stereo

VOICE SPREAD 0..127 (per timbre) pans voices across the stereo field (per-voice static placement,
implementation curve UNCONFIRMED). The per-voice VCA is drawn dual L/R in the block diagram; the replica's
voice sum must become stereo-capable with per-timbre buses (FX routings need MAIN/SUB submixes).

## 14. prologue-8 vs prologue-16 (one definition, two variants)

Differences: 8/16 voices (4+4 vs 8+8 bitimbral), 49/61 keys, TIMBRE panel section + VOICE SPREAD knob +
L.F. COMP hardware only on the 16 (the 8 reaches timbre/spread via PROGRAM EDIT; L.F. COMP absent entirely).
No reported voicing differences. Programs are format-identical.

## 15. Modeling notes

- One shared voice pool with a per-voice timbre tag (steals cross timbres like hardware); LAYER = 2 voices per
  note (one per timbre), SPLIT = key-range dispatch, XFADE = **key-position** crossfade of timbre gains (not
  wheel; BALANCE assign gives wheel fades).
- Perf (measured on our xd engine, Node): ≈2.34% realtime per active voice + 2.5% fixed → 16 voices ≈ 40% of a
  core average. Feasible; ship an optional voice-cap fallback for low-end machines.
- StepSeq stays constructed-but-dormant (costs ~0); Program.seq.bpm carries TEMPO into the arp.
- Sound character targets: smoother/warmer than the xd, "mellow darkness", filter less aggressive [KVR/SoS];
  same multi engine.

## 16. Known doc errata / discrepancies (MIDIimp rev 1.01)

1. All tuning-message headers print the **monologue's** family ID (00 01 44) instead of 4B — a Korg
   copy-paste across the whole family (the xd doc has it too). Accept both on receive.
2. CC88 MOD FX TYPE receive table lists only 4 zones (omits USER) while transmit sends 5 values — use xd-style
   5 zones.
3. MULTI SUB TYPE NOISE CC zone count inconsistent (8 zones printed for 4 types).
4. ARP RATE: doc range 1~12, doc list 11 values, manual lists 10 (omits 32th) — three-way off-by-one.
5. LIVESET size math ("146 bytes 7-bit → 128 8-bit" ≠ Korg packing arithmetic).
6. OM p.33 "EG modulates … and the LFO" contradicts the block diagram (no EG→LFO path); p.5/p.6 panel-item
   numbering swapped; CC81 PITCH EG zone order [VCO1, VCO1+2, VCO2] vs program enum [VCO 2, VCO 1+2, ALL] —
   reconcile on hardware.
7. loguetools orders timbre bytes +50/+51/+52 as drive/keytrack/low-cut; the doc says drive/**low-cut**/keytrack.

## 17. UNCONFIRMED / calibration targets (no prologue hardware owned)

Program-payload 16-bit endianness (doc-BE vs the xd's file-LE precedent) + timbre offsets +51/+52; XFADE
key-position curve; VOICE SPREAD pan law; DUO stacked level/detune curves; MONO sub crossfade; steal policy +
whether FW1.30 changed repeated-note allocation; LOW CUT corner frequency; DRIVE stage gains; L.F. COMP
character (threshold/ratio/makeup vs pure boost — one GAIN knob); FX routing submix behavior; arp RANGE raw
mapping + RATE list; CC81/CC90/CC91 details; warm-up drift magnitude; VPM param 1-6 ↔ VpmTrims field order.
