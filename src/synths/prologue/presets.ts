/*
 * prologue factory preset bank — 12 programs showcasing the prologue's
 * identity (docs/prologue-spec.md §15): smooth/warm/mellow pads, strings and
 * keys, plus the bitimbral tricks (LAYER / XFADE / SPLIT), the per-timbre
 * voice modes, and the special reverbs the hardware is known for.
 *
 * Values are chosen against the real curves in ./curves.ts:
 *   - VCO PITCH raw 512 = 0 cents (dead zone 492..532); 532-548 spans
 *     0..+16c, so subtle ensemble detune lives around 537..545.
 *   - CUTOFF is exponential 16 Hz..21 kHz: ~420 = 300 Hz, ~560 = 800 Hz,
 *     ~700 = 2 kHz, ~850 = 6 kHz.
 *   - CUTOFF EG INT is the family quadratic: ~640 = +5%, ~700 = +12%,
 *     ~780 = +27%.
 *   - Envelope times are exponential; a ~1 s pad attack is raw ~850.
 *   - VOICE MODE DEPTH zones (MIDIimp P13): POLY >= 256 = DUO stack,
 *     UNISON = 0..50c detune across ALL timbre voices, MONO blends -1/-2 oct
 *     sub oscillators, CHORD picks from the 14-chord zone table.
 *
 * Conventions: program-global FX are set deliberately on every patch (OFF is
 * a choice, not an omission); per-timbre params go through TIMBRE_BLOCKS
 * ([0] = MAIN, [1] = SUB) — never key-string math; SUB_ON is set only where
 * the patch actually plays the sub timbre; every timbre gets a sensible
 * M.WHEEL ASSIGN. The prologue has no step/motion sequencing (spec §10) —
 * the StepSeq stays dormant and seq.bpm only carries TEMPO into the arp
 * (spec §15).
 */
import { P, TIMBRE_BLOCKS, clampParam } from './params'
import { initProgram } from './program'
import type { Program } from '../../shared/program'

const [MAIN, SUB] = TIMBRE_BLOCKS

// --- readable enum values (indices into the switch/menu label tables) -------
const SQR = 0
const TRI = 1
const SAW = 2
// VCO/MULTI octave: prologue program enum order is 2' -> 16' (params.ts —
// REVERSED relative to the xd/OG).
const OCT16 = 3
const OCT4 = 1
const ON = 1
const PCT50 = 1 // DRIVE / KEYTRACK 3-position [0/50/100%]
const PCT100 = 2
const TT_LAYER = 0
const TT_XFADE = 1
const TT_SPLIT = 2
const VM_POLY = 0
const VM_MONO = 1
const VM_UNISON = 2
const VM_CHORD = 3
const M_NOISE = 0
const M_VPM = 1
const N_HIGH = 0
const N_PEAK = 2
const V_SIN4 = 3
const V_AIR1 = 10
const V_DECAY1 = 12
const ROUTE_POST_VCF = 1
const LFO_SLOW = 1
const LT_SHAPE = 1
const LT_PITCH = 2
const LTO_ALL = 0
const LTO_VCO12 = 1
const LTO_MULTI = 3
const FX_CHORUS = 0
const FX_ENSEMBLE = 1
const FX_FLANGER = 3
const DLRV_OFF = 0
const DLRV_DELAY = 1
const DLRV_REVERB = 2
const DLY_STEREO = 0
const DLY_PINGPONG = 2
const RV_HALL = 0
const RV_SMOOTH = 1
const RV_ARENA = 2
const RV_PLATE = 3
const RV_ROOM = 4
const RV_SPACE = 6
const RV_SUBMARINE = 8
const FXROUTE_MAIN = 1 // FX ROUTING [Main+Sub, Main, Sub]
const ARP_LATCH = 2 // ARP_ON_LATCH [Off, On, Latch]
const ARP_POLY_RANDOM = 5
const ARP_16TH = 4 // index into ARP_RATES
const TARGET_MAIN_SUB = 0
// M.WHEEL ASSIGN destination indices (curves.WHEEL_ASSIGN_DESTS order).
const WD_BALANCE = 0
const WD_VM_DEPTH = 3
const WD_MULTI_SHAPE = 10
const WD_CUTOFF = 14
const WD_LFO_RATE = 25
const WD_LFO_INT = 26
const WD_MODFX_DEPTH = 28
const WD_DLRV_DEPTH = 30
const WD_GATE_TIME = 31

type Edit = readonly [number, number]

/** Build a program from the init defaults + a list of param edits. The
 *  optional tempo sets seq.bpm — the prologue's TEMPO page, read only by the
 *  arp (spec §15); the StepSeq itself stays dormant. */
function patch(name: string, edits: readonly Edit[], tempo?: number): Program {
  const prog = initProgram(name)
  for (const [id, v] of edits) prog.params[id] = clampParam(id, v)
  if (tempo !== undefined) prog.seq.bpm = tempo
  return prog
}

// =============================================================================
// The bank
// =============================================================================

function buildPresets(): Program[] {
  const bank: Program[] = []

  // ------------------------------------------------------------- BITIMBRAL
  // Lush LAYER pad: MAIN is a slow-blooming saw ensemble, SUB fades in a
  // VPM Air shimmer one octave up, routed post-VCF so the sparkle stays
  // unfiltered. Ensemble mod FX over both timbres into a long Hall; the
  // wheel rides MAIN/SUB BALANCE for a hands-on layer fade.
  bank.push(
    patch('Ocean Layers', [
      [P.SUB_ON, ON],
      [P.TIMBRE_TYPE, TT_LAYER],
      [P.AMP_VELOCITY, 40],
      // MAIN: warm detuned saws
      [MAIN.vco1Wave, SAW],
      [MAIN.vco2Wave, SAW],
      [MAIN.vco2Pitch, 541], // +9 cents
      [MAIN.vco2Level, 900],
      [MAIN.voiceSpread, 90],
      [MAIN.cutoff, 640],
      [MAIN.resonance, 120],
      [MAIN.keytrack, PCT50],
      [MAIN.ampAttack, 850],
      [MAIN.ampDecay, 700],
      [MAIN.ampSustain, 850],
      [MAIN.ampRelease, 800],
      [MAIN.egAttack, 700],
      [MAIN.egDecay, 800],
      [MAIN.cutoffEgInt, 640], // +5% slow bloom
      [MAIN.wheelAssign, WD_BALANCE],
      // SUB: VPM Air shimmer, slower attack so it swells in over the saws
      [SUB.multiType, M_VPM],
      [SUB.selectVpm, V_AIR1],
      [SUB.shapeVpm, 450],
      [SUB.multiOctave, OCT4],
      [SUB.multiLevel, 1023],
      [SUB.multiRouting, ROUTE_POST_VCF],
      [SUB.vpmNoiseDepth, 120], // +20% breath
      [SUB.vco1Level, 0],
      [SUB.vco2Level, 0],
      [SUB.voiceSpread, 70],
      [SUB.cutoff, 800],
      [SUB.ampAttack, 900],
      [SUB.ampDecay, 700],
      [SUB.ampSustain, 800],
      [SUB.ampRelease, 850],
      [SUB.wheelAssign, WD_BALANCE],
      // FX: ensemble into Hall, both timbres
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_ENSEMBLE],
      [P.MODFX_SPEED, 480],
      [P.MODFX_DEPTH, 600],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_HALL],
      [P.DLRV_TIME, 700],
      [P.DLRV_DEPTH, 500],
      [P.DLRV_DRYWET, 470],
      [P.PROGRAM_LEVEL, 96], // two full timbres per key
    ]),
  )

  // XFADE keyboard: warm EP-style keys on the SUB timbre crossfading into
  // airy triangle-and-noise highs on MAIN as you play up the keybed.
  // POSITION stays at its 'Sub<>Main' default = sub weights the low end
  // (UNCONFIRMED orientation + crossfade curve, spec §17 "XFADE key-position
  // curve"). Wheel opens both timbres' cutoff together.
  bank.push(
    patch('Dawn Keys', [
      [P.SUB_ON, ON],
      [P.TIMBRE_TYPE, TT_XFADE],
      [P.AMP_VELOCITY, 80],
      // SUB: warm low keys
      [SUB.vco1Wave, SAW],
      [SUB.vco1Level, 900],
      [SUB.vco2Wave, TRI],
      [SUB.vco2Pitch, 538], // +6 cents
      [SUB.vco2Level, 550],
      [SUB.cutoff, 560],
      [SUB.keytrack, PCT50],
      [SUB.egVelocity, 50],
      [SUB.ampAttack, 20],
      [SUB.ampDecay, 700],
      [SUB.ampSustain, 550],
      [SUB.ampRelease, 420],
      [SUB.wheelAssign, WD_CUTOFF],
      // MAIN: airy highs — triangle at 4' with a breath of High noise
      [MAIN.vco1Wave, TRI],
      [MAIN.vco1Octave, OCT4],
      [MAIN.vco1Level, 750],
      [MAIN.vco2Level, 0],
      [MAIN.multiType, M_NOISE],
      [MAIN.selectNoise, N_HIGH],
      [MAIN.shapeNoise, 400],
      [MAIN.multiLevel, 250],
      [MAIN.voiceSpread, 50],
      [MAIN.cutoff, 850],
      [MAIN.keytrack, PCT50],
      [MAIN.egVelocity, 40],
      [MAIN.ampAttack, 60],
      [MAIN.ampDecay, 650],
      [MAIN.ampSustain, 700],
      [MAIN.ampRelease, 500],
      [MAIN.wheelAssign, WD_CUTOFF],
      // FX: stereo chorus into a Plate
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SPEED, 400],
      [P.MODFX_DEPTH, 480],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_PLATE],
      [P.DLRV_TIME, 480],
      [P.DLRV_DEPTH, 400],
      [P.DLRV_DRYWET, 430],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // SPLIT performance patch: SUB is a legato MONO bass with the -1 oct sub
  // voice blended in below the C3 split; MAIN is a poly saw lead above it.
  // POSITION stays at 'Sub<>Main' = sub takes the low range (UNCONFIRMED
  // orientation, spec §17). The stereo delay is routed to MAIN only, so the
  // bass stays dry — the FX ROUTING trick (spec §7). Wheel adds lead vibrato
  // (LFO INT sits at zero until pushed) and opens the bass cutoff.
  bank.push(
    patch('Stage Split', [
      [P.SUB_ON, ON],
      [P.TIMBRE_TYPE, TT_SPLIT],
      [P.SPLIT_POINT, 48], // C3
      // SUB: mono bass below the split
      [SUB.voiceMode, VM_MONO],
      [SUB.vmDepth, 600], // -1 oct sub fully in, -2 oct starting
      [SUB.vco1Wave, SAW],
      [SUB.vco1Octave, OCT16],
      [SUB.vco2Wave, SQR],
      [SUB.vco2Octave, OCT16],
      [SUB.vco2Shape, 200],
      [SUB.vco2Level, 700],
      [SUB.cutoff, 430],
      [SUB.resonance, 200],
      [SUB.keytrack, PCT50],
      [SUB.drive, PCT50],
      [SUB.ampAttack, 0],
      [SUB.ampDecay, 500],
      [SUB.ampSustain, 750],
      [SUB.ampRelease, 150],
      [SUB.egDecay, 380],
      [SUB.cutoffEgInt, 700], // +12% snap
      [SUB.egLegato, ON],
      [SUB.wheelAssign, WD_CUTOFF],
      // MAIN: poly lead above the split
      [MAIN.vco1Wave, SAW],
      [MAIN.vco2Wave, SAW],
      [MAIN.vco2Pitch, 540], // +8 cents
      [MAIN.vco2Level, 900],
      [MAIN.cutoff, 700],
      [MAIN.resonance, 150],
      [MAIN.ampAttack, 20],
      [MAIN.ampDecay, 500],
      [MAIN.ampSustain, 900],
      [MAIN.ampRelease, 250],
      [MAIN.lfoWave, TRI],
      [MAIN.lfoMode, LFO_SLOW],
      [MAIN.lfoRate, 730], // ~4.6 Hz vibrato once the wheel raises LFO INT
      [MAIN.lfoTarget, LT_PITCH],
      [MAIN.lfoTargetOsc, LTO_ALL],
      [MAIN.wheelAssign, WD_LFO_INT],
      // FX: stereo delay on the lead only
      [P.MODFX_ON, 0],
      [P.DLRV_SELECT, DLRV_DELAY],
      [P.DELAY_SUB, DLY_STEREO],
      [P.DLRV_TIME, 520],
      [P.DLRV_DEPTH, 400],
      [P.DLRV_DRYWET, 420],
      [P.DLRV_ROUTING, FXROUTE_MAIN],
      [P.PROGRAM_LEVEL, 98],
    ]),
  )

  // ------------------------------------------------------------ VOICE MODES
  // The 16-voice UNISON monster: SUB stays off so the solo timbre owns the
  // whole voice pool (spec §4) — every voice detuned across ~34 cents and
  // fanned hard across the stereo field by VOICE SPREAD. Wheel rides the
  // detune depth itself.
  bank.push(
    patch('Sixteen Saws', [
      [MAIN.voiceMode, VM_UNISON],
      [MAIN.vmDepth, 700], // ~34 cents across all 16 voices
      [MAIN.voiceSpread, 127], // as wide as it goes
      [MAIN.vco1Wave, SAW],
      [MAIN.vco2Wave, SAW],
      [MAIN.vco2Pitch, 541], // +9 cents
      [MAIN.vco2Level, 950],
      [MAIN.cutoff, 720],
      [MAIN.resonance, 120],
      [MAIN.drive, PCT50],
      [MAIN.ampAttack, 30],
      [MAIN.ampDecay, 500],
      [MAIN.ampSustain, 900],
      [MAIN.ampRelease, 350],
      [MAIN.wheelAssign, WD_VM_DEPTH],
      [P.MODFX_ON, 0], // nothing between the stack and the speakers
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_ARENA],
      [P.DLRV_TIME, 500],
      [P.DLRV_DEPTH, 350],
      [P.DLRV_DRYWET, 400],
      [P.PROGRAM_LEVEL, 88], // 16 stacked voices
    ]),
  )

  // DUO-zone poly brass: POLY depth pushed past 256 stacks a detuned second
  // voice per key (spec §4); filter-EG bite + 50% drive for the sizzle,
  // velocity into the EG for playable swells.
  bank.push(
    patch('Duo Brass', [
      [P.AMP_VELOCITY, 90],
      [MAIN.voiceMode, VM_POLY],
      [MAIN.vmDepth, 620], // DUO zone (>= 256)
      [MAIN.vco1Wave, SAW],
      [MAIN.vco2Wave, SAW],
      [MAIN.vco2Pitch, 537], // +5 cents
      [MAIN.vco2Level, 800],
      [MAIN.cutoff, 480],
      [MAIN.resonance, 200],
      [MAIN.drive, PCT50],
      [MAIN.keytrack, PCT50],
      [MAIN.ampAttack, 60],
      [MAIN.ampDecay, 500],
      [MAIN.ampSustain, 800],
      [MAIN.ampRelease, 300],
      [MAIN.egAttack, 120],
      [MAIN.egDecay, 620],
      [MAIN.cutoffEgInt, 780], // +27% bite
      [MAIN.egVelocity, 80],
      [MAIN.wheelAssign, WD_CUTOFF],
      [P.MODFX_ON, 0],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_ROOM],
      [P.DLRV_TIME, 400],
      [P.DLRV_DEPTH, 350],
      [P.DLRV_DRYWET, 390],
      [P.PROGRAM_LEVEL, 94], // duo stack
    ]),
  )

  // MONO sub-osc bass: the OG MONO model (spec §4) — depth 700 blends the
  // -1 oct voice fully in with a hint of -2 oct. 100% drive, legato EG, a
  // touch of fingered portamento; kept deliberately dry.
  bank.push(
    patch('Round Bass', [
      [MAIN.voiceMode, VM_MONO],
      [MAIN.vmDepth, 700], // -1 oct full, -2 oct ~37%
      [MAIN.portamento, 25],
      [MAIN.vco1Wave, SAW],
      [MAIN.vco2Wave, SQR],
      [MAIN.vco2Shape, 200],
      [MAIN.vco2Level, 600],
      [MAIN.cutoff, 420],
      [MAIN.resonance, 180],
      [MAIN.keytrack, PCT50],
      [MAIN.drive, PCT100],
      [MAIN.ampAttack, 0],
      [MAIN.ampDecay, 500],
      [MAIN.ampSustain, 750],
      [MAIN.ampRelease, 150],
      [MAIN.egDecay, 380],
      [MAIN.cutoffEgInt, 700], // +12% snap
      [MAIN.egLegato, ON],
      [MAIN.wheelAssign, WD_CUTOFF],
      [P.MODFX_ON, 0],
      [P.DLRV_SELECT, DLRV_OFF], // dry on purpose
      [P.PROGRAM_LEVEL, 94], // 100% drive trim
    ]),
  )

  // CHORD stab: one finger lands in the m7 zone (MIDIimp P13, raw 366..438);
  // saw + hollow square through a chorus and ping-pong echoes. Wheel pushes
  // the mod-FX depth for instant motion.
  bank.push(
    patch('Velvet Stab', [
      [MAIN.voiceMode, VM_CHORD],
      [MAIN.vmDepth, 400], // m7
      [MAIN.vco1Wave, SAW],
      [MAIN.vco1Level, 800],
      [MAIN.vco2Wave, SQR],
      [MAIN.vco2Shape, 300],
      [MAIN.vco2Level, 600],
      [MAIN.cutoff, 560],
      [MAIN.resonance, 150],
      [MAIN.ampAttack, 40],
      [MAIN.ampDecay, 600],
      [MAIN.ampSustain, 400],
      [MAIN.ampRelease, 350],
      [MAIN.egDecay, 500],
      [MAIN.cutoffEgInt, 700], // +12%
      [MAIN.wheelAssign, WD_MODFX_DEPTH],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SPEED, 380],
      [P.MODFX_DEPTH, 420],
      [P.DLRV_SELECT, DLRV_DELAY],
      [P.DELAY_SUB, DLY_PINGPONG],
      [P.DLRV_TIME, 560],
      [P.DLRV_DEPTH, 400],
      [P.DLRV_DRYWET, 420],
      [P.PROGRAM_LEVEL, 92], // up to 4 voices per key
    ]),
  )

  // ----------------------------------------------------------- MULTI ENGINE
  // VPM bell keys on the Decay1 type: percussive mod envelope stretched
  // (+40% MOD DECAY), ratio shifted glassy, one octave up, velocity into the
  // strike. Wheel scans the VPM shape (mod depth).
  bank.push(
    patch('Prayer Bells', [
      [P.AMP_VELOCITY, 100],
      [MAIN.multiType, M_VPM],
      [MAIN.selectVpm, V_DECAY1],
      [MAIN.shapeVpm, 550],
      [MAIN.shiftShapeVpm, 700], // ratio shifted up: glassy partials
      [MAIN.multiOctave, OCT4],
      [MAIN.multiLevel, 1023],
      [MAIN.vpmModDecay, 140], // +40% longer strike ring
      [MAIN.vpmFeedback, 110], // +10%
      [MAIN.vco1Level, 0],
      [MAIN.vco2Level, 0],
      [MAIN.cutoff, 900],
      [MAIN.egVelocity, 40],
      [MAIN.ampAttack, 0],
      [MAIN.ampDecay, 780],
      [MAIN.ampSustain, 0],
      [MAIN.ampRelease, 800],
      [MAIN.wheelAssign, WD_MULTI_SHAPE],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SUB_CHORUS, 1], // Light
      [P.MODFX_SPEED, 420],
      [P.MODFX_DEPTH, 380],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_HALL],
      [P.DLRV_TIME, 720],
      [P.DLRV_DEPTH, 520],
      [P.DLRV_DRYWET, 460],
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // NOISE Peak 'sonar' texture: a resonant noise band pinged by a snappy amp
  // EG while a slow triangle LFO sweeps the band frequency (LFO -> SHAPE on
  // the multi engine); ping-pong echoes carry it across the stereo field.
  // Wheel speeds the sweep up.
  bank.push(
    patch('Sonar Ping', [
      [P.AMP_VELOCITY, 110],
      [MAIN.multiType, M_NOISE],
      [MAIN.selectNoise, N_PEAK],
      [MAIN.shapeNoise, 620],
      [MAIN.multiLevel, 1023],
      [MAIN.vco1Level, 0],
      [MAIN.vco2Level, 0],
      [MAIN.cutoff, 1023],
      [MAIN.resonance, 0],
      [MAIN.ampAttack, 0],
      [MAIN.ampDecay, 300],
      [MAIN.ampSustain, 0],
      [MAIN.ampRelease, 400],
      [MAIN.lfoWave, TRI],
      [MAIN.lfoMode, LFO_SLOW],
      [MAIN.lfoRate, 150], // ~0.13 Hz band drift
      [MAIN.lfoInt, 620],
      [MAIN.lfoTarget, LT_SHAPE],
      [MAIN.lfoTargetOsc, LTO_MULTI],
      [MAIN.wheelAssign, WD_LFO_RATE],
      [P.MODFX_ON, 0],
      [P.DLRV_SELECT, DLRV_DELAY],
      [P.DELAY_SUB, DLY_PINGPONG],
      [P.DLRV_TIME, 620],
      [P.DLRV_DEPTH, 550],
      [P.DLRV_DRYWET, 480],
      [P.PROGRAM_LEVEL, 104], // quiet source
    ]),
  )

  // ------------------------------------------------------------------- ARP
  // POLY RANDOM soundscape: latched arp scatters 2-note pairs (spec §10)
  // across three octaves, targeting BOTH layered timbres — saw plucks on
  // MAIN, glass VPM bells on SUB — into the Space reverb. Both voice modes
  // stay POLY (POLY RANDOM is POLY-mode-only, spec §10); the wheel stretches
  // the arp gate time.
  bank.push(
    patch('Rain Garden', [
      [P.SUB_ON, ON],
      [P.TIMBRE_TYPE, TT_LAYER],
      [P.ARP_ON_LATCH, ARP_LATCH],
      [P.ARP_TYPE, ARP_POLY_RANDOM],
      [P.ARP_RANGE, 3],
      [P.ARP_RATE, ARP_16TH],
      [P.ARP_GATE, 40],
      [P.ARP_TARGET, TARGET_MAIN_SUB],
      // MAIN: filtered saw plucks
      [MAIN.voiceMode, VM_POLY],
      [MAIN.vco1Wave, SAW],
      [MAIN.vco1Level, 700],
      [MAIN.vco2Wave, TRI],
      [MAIN.vco2Octave, OCT4],
      [MAIN.vco2Level, 500],
      [MAIN.voiceSpread, 60],
      [MAIN.cutoff, 620],
      [MAIN.resonance, 250],
      [MAIN.keytrack, PCT100],
      [MAIN.ampAttack, 0],
      [MAIN.ampDecay, 450],
      [MAIN.ampSustain, 0],
      [MAIN.ampRelease, 400],
      [MAIN.egDecay, 420],
      [MAIN.cutoffEgInt, 700], // +12%
      [MAIN.wheelAssign, WD_GATE_TIME],
      // SUB: glass VPM bells an octave up
      [SUB.voiceMode, VM_POLY],
      [SUB.multiType, M_VPM],
      [SUB.selectVpm, V_SIN4],
      [SUB.shapeVpm, 480],
      [SUB.multiOctave, OCT4],
      [SUB.multiLevel, 900],
      [SUB.vpmModDecay, 130], // +30%
      [SUB.vco1Level, 0],
      [SUB.vco2Level, 0],
      [SUB.voiceSpread, 60],
      [SUB.cutoff, 800],
      [SUB.ampAttack, 0],
      [SUB.ampDecay, 600],
      [SUB.ampSustain, 0],
      [SUB.ampRelease, 600],
      [SUB.wheelAssign, WD_GATE_TIME],
      // FX: chorus into Space
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SPEED, 420],
      [P.MODFX_DEPTH, 450],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_SPACE],
      [P.DLRV_TIME, 650],
      [P.DLRV_DEPTH, 520],
      [P.DLRV_DRYWET, 470],
      [P.PROGRAM_LEVEL, 96], // two timbres per arp step
    ], 96),
  )

  // --------------------------------------------------------------- CLASSICS
  // String machine: two PWM squares with a slow triangle LFO stirring both
  // pulse widths, straight into the stereo ensemble — the Solina recipe.
  // Wheel opens the cutoff.
  bank.push(
    patch('Tape Strings', [
      [P.AMP_VELOCITY, 40],
      [MAIN.vco1Wave, SQR],
      [MAIN.vco1Shape, 400],
      [MAIN.vco2Wave, SQR],
      [MAIN.vco2Shape, 700],
      [MAIN.vco2Pitch, 545], // +13 cents
      [MAIN.vco2Level, 850],
      [MAIN.voiceSpread, 80],
      [MAIN.cutoff, 680],
      [MAIN.resonance, 100],
      [MAIN.keytrack, PCT50],
      [MAIN.ampAttack, 700],
      [MAIN.ampDecay, 600],
      [MAIN.ampSustain, 900],
      [MAIN.ampRelease, 700],
      [MAIN.lfoWave, TRI],
      [MAIN.lfoMode, LFO_SLOW],
      [MAIN.lfoRate, 420], // ~0.7 Hz PWM stir
      [MAIN.lfoInt, 600],
      [MAIN.lfoTarget, LT_SHAPE],
      [MAIN.lfoTargetOsc, LTO_VCO12],
      [MAIN.wheelAssign, WD_CUTOFF],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_ENSEMBLE],
      [P.MODFX_SPEED, 500],
      [P.MODFX_DEPTH, 650],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_SMOOTH],
      [P.DLRV_TIME, 550],
      [P.DLRV_DEPTH, 450],
      [P.DLRV_DRYWET, 420],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // Submarine reverb special: a dark triangle drone at 16' listing gently
  // (slow LFO pitch wobble) inside the deep-sea Submarine reverb, flanger
  // mid-sweep for the underwater current. Wheel floods the reverb depth.
  bank.push(
    patch('Deep Diver', [
      [MAIN.vco1Wave, TRI],
      [MAIN.vco1Octave, OCT16],
      [MAIN.vco1Level, 1023],
      [MAIN.vco2Level, 0],
      [MAIN.voiceSpread, 40],
      [MAIN.cutoff, 380],
      [MAIN.resonance, 300],
      [MAIN.ampAttack, 600],
      [MAIN.ampDecay, 800],
      [MAIN.ampSustain, 900],
      [MAIN.ampRelease, 850],
      [MAIN.lfoWave, TRI],
      [MAIN.lfoMode, LFO_SLOW],
      [MAIN.lfoRate, 120], // ~0.11 Hz swell
      [MAIN.lfoInt, 538], // ~±60 cents of listing
      [MAIN.lfoTarget, LT_PITCH],
      [MAIN.lfoTargetOsc, LTO_ALL],
      [MAIN.wheelAssign, WD_DLRV_DEPTH],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_FLANGER],
      [P.MODFX_SUB_FLANGER, 4], // Mid Sweep
      [P.MODFX_SPEED, 300],
      [P.MODFX_DEPTH, 450],
      [P.DLRV_SELECT, DLRV_REVERB],
      [P.REVERB_SUB, RV_SUBMARINE],
      [P.DLRV_TIME, 750],
      [P.DLRV_DEPTH, 650],
      [P.DLRV_DRYWET, 520],
      [P.PROGRAM_LEVEL, 96],
    ]),
  )

  return bank
}

export const FACTORY_PRESETS: Program[] = buildPresets()
