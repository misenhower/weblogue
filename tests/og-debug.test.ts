// @vitest-environment happy-dom
/*
 * SERVICE MODE drawer over the OG synth definition: the panel is
 * synth-agnostic and takes an injected DebugDef — construct it with
 * OG_DEBUG_DEF over an OG Store, check the stage labels are the OG's signal
 * path (NOISE present; no MULTI/MOD FX/REVERB), that the routing badges
 * follow the OG program, and that a full synthetic dbg frame renders.
 */
import { describe, expect, it } from 'vitest'
import { Store } from '../src/state/store'
import { P } from '../src/synths/og/params'
import { OG_DEF } from '../src/synths/og/def'
import { DBG_TAP_SIZE } from '../src/synths/og/engine'
import { OG_DEBUG_DEF } from '../src/synths/og/debug-def'
import { DebugPanel } from '../src/ui/debugpanel'
import type { FromEngine } from '../src/shared/messages'
import { makeStoreDef } from './helpers/audio'

const OG_TEST_DEF = makeStoreDef(OG_DEF, { bankKey: 'og-test-debug' })

/** Synthetic OG telemetry frame: 12 tap rings + 4 voice records. */
function fakeMsg(): Extract<FromEngine, { t: 'dbg' }> {
  const taps = Array.from({ length: 12 }, () => {
    const a = new Float32Array(DBG_TAP_SIZE)
    for (let i = 0; i < a.length; i++) a[i] = Math.sin((i / a.length) * Math.PI * 6)
    return a
  })
  return {
    t: 'dbg',
    taps,
    voices: [
      { note: 60, on: true, amp: 0.8, drift1: 1.2, drift2: -0.7, modEg: 0.4, lfo: 0.2, hz: 262.1 },
      { note: 64, on: true, amp: 0.5, drift1: -2.4, drift2: 0.3, modEg: 0.1, lfo: -0.6, hz: 329.6 },
      { note: 0, on: false, amp: 0, drift1: 0, drift2: 0, modEg: 0, lfo: 0, hz: 0 },
      { note: 0, on: false, amp: 0, drift1: 0, drift2: 0, modEg: 0, lfo: 0, hz: 0 },
    ],
    load: 0.27,
    tapped: 0,
  }
}

function make(): { store: Store; panel: DebugPanel } {
  const store = new Store(OG_TEST_DEF)
  store.initCurrent()
  return { store, panel: new DebugPanel({ store, def: OG_DEBUG_DEF }) }
}

describe('DebugPanel with OG_DEBUG_DEF', () => {
  it('constructs over an OG store: 9 scopes, 4 lanes, health strip', () => {
    const { panel } = make()
    expect(panel.el.querySelectorAll('.xd-svc-scope').length).toBe(9)
    expect(panel.el.querySelectorAll('.xd-svc-lane').length).toBe(4)
    expect(panel.el.querySelector('.xd-svc-load')).toBeTruthy()
  })

  it('stage labels are the OG path: NOISE in, MULTI/MOD FX/REVERB out', () => {
    const { panel } = make()
    const labels = [...panel.el.querySelectorAll('.xd-svc-tap .xd-svc-label')].map(
      (n) => n.textContent,
    )
    expect(labels).toContain('NOISE')
    expect(labels).toContain('VCA')
    expect(labels).toContain('OUTPUT')
    const joined = labels.join('\n')
    expect(joined).not.toContain('MULTI')
    expect(joined).not.toContain('MOD FX')
    expect(joined).not.toContain('REVERB')
  })

  it('modulator lanes are AMP EG / EG / LFO (the OG EG is a full ADSR)', () => {
    const { panel } = make()
    const labels = [...panel.el.querySelectorAll('.xd-svc-mod .xd-svc-label')].map(
      (n) => n.textContent,
    )
    expect(labels).toEqual(['AMP EG · V1', 'EG · V1', 'LFO · V1'])
  })

  it('routing badges follow the OG program (fixed EG target, unipolar LFO)', () => {
    const { store, panel } = make()
    const badges = [...panel.el.querySelectorAll('.xd-svc-badge')] as HTMLElement[]
    expect(badges.map((b) => b.textContent)).toEqual([
      'EG → CUTOFF',
      'PITCH EG → VCO 2',
      'LFO → PITCH', // OG default LFO target (og-spec.md §8)
    ])
    // Unipolar LFO INT: raw 0 = fully off (dimmed badge), raw 1023 = full.
    const lfoBadge = badges[2]
    expect(lfoBadge.style.opacity).toBe('0.35')
    store.setParam(P.LFO_INT, 1023, 'ui')
    expect(lfoBadge.style.opacity).toBe('1')
    store.setParam(P.LFO_TARGET, 0, 'ui')
    expect(lfoBadge.textContent).toBe('LFO → CUTOFF')
    // SYNC/RING/X-MOD badges light from the program.
    store.setParam(P.SYNC, 1, 'ui')
    expect(panel.el.querySelectorAll('.xd-svc-mini')[0].classList.contains('is-on')).toBe(true)
  })

  it('a full synthetic dbg frame updates lanes, load, and scopes', () => {
    const { panel } = make()
    expect(() => panel.update(fakeMsg())).not.toThrow()
    const notes = [...panel.el.querySelectorAll('.xd-svc-note')].map((n) => n.textContent)
    expect(notes[0]).toBe('C4')
    expect(notes[2]).toBe('--')
    expect(panel.el.querySelector('.xd-svc-htext')!.textContent).toBe('27%')
    // Repeated frames wrap the sparkline history without throwing.
    for (let i = 0; i < 140; i++) panel.update(fakeMsg())
  })
})
