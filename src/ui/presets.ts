/*
 * PRESETS & FILES group for the settings drawer: export the working program
 * (.json / Korg native), export the bank as a weblogue pack, and import any
 * of those — including Korg librarian files (.mnlgxdprog/.mnlgxdlib etc.),
 * which lets the hardware's factory library load straight into the bank.
 *
 * Imports stage first: audition programs into the working copy via a
 * popover, then bulk-write into bank slots from a chosen start slot.
 */
import type { Store } from '../state/store'
import type { SynthDef } from '../synths/def'
import type { Program } from '../shared/program'
import { makePack, parsePack } from '../shared/pack'
import { parseKorgContainer, buildKorgProgFile } from '../shared/korgfile'
import { hasBankSlot } from '../state/persist'
import { showMenu, closeMenu, type MenuItem } from './menu'
import { bindHold } from './hold'
import { div, row } from './dom'

export function buildPresetsGroup(pane: HTMLElement, opts: { store: Store; def: SynthDef }): void {
  const { store, def } = opts
  const codec = def.korgFile

  pane.appendChild(div('xd-set-group', 'PRESETS & FILES'))

  const status = div('xd-set-status')
  const setStatus = (msg: string, isError = false): void => {
    status.textContent = msg
    status.classList.toggle('is-error', isError)
  }

  /* ---- export ------------------------------------------------------ */

  const exProgram = actionBtn('PROGRAM .JSON', () => {
    download(fileSafe(store.program.name) + '.json', def.serializeProgram(store.program), 'application/json')
    setStatus('Exported "' + store.program.name + '" as JSON.')
  })
  const exButtons = [exProgram]

  if (codec) {
    exButtons.push(
      actionBtn('.' + codec.progExt.toUpperCase(), () => {
        void buildKorgProgFile(codec.product, codec.infoTag, codec.encodeProgBin(store.program))
          .then((bytes) => {
            download(fileSafe(store.program.name) + '.' + codec.progExt, bytes, 'application/octet-stream')
            setStatus('Exported "' + store.program.name + '" for the Korg librarian.')
          })
          .catch((err: unknown) => setStatus('Export failed: ' + String(err), true))
      }),
    )
  }

  exButtons.push(
    actionBtn('BANK PACK', () => {
      const programs: Program[] = []
      for (let i = 0; i < def.numSlots; i++) {
        // Content-based: slots with a stored entry (factory-seeded on first
        // run, or user-written — even one named 'Init Program') export;
        // never-written slots don't.
        if (!hasBankSlot(def, i)) continue
        const p = store.bankProgram(i)
        if (p) programs.push(p)
      }
      download(def.id + '-bank.weblogue-pack.json', makePack(def, def.title + ' bank', programs), 'application/json')
      setStatus('Exported ' + programs.length + ' non-empty slots as a pack.')
    }),
  )

  pane.appendChild(row('xd-set-row', div('xd-set-label', 'EXPORT'), row('xd-set-btnrow', ...exButtons)))

  /* ---- import ------------------------------------------------------ */

  const accepts = ['.json']
  if (codec) accepts.push('.' + codec.progExt, ...codec.libExts.map((e) => '.' + e))

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = accepts.join(',')
  fileInput.className = 'xd-set-file'
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0]
    fileInput.value = '' // allow re-picking the same file
    if (f) void importFile(f)
  })

  const importBtn = actionBtn('IMPORT FILE…', () => fileInput.click())
  pane.appendChild(row('xd-set-row', div('xd-set-label', 'IMPORT'), row('xd-set-btnrow', importBtn, fileInput)))
  pane.appendChild(status)

  /* ---- staging (appears after a successful import parse) ------------ */

  const staging = div('xd-set-import')
  staging.style.display = 'none'
  pane.appendChild(staging)
  let staged: Program[] = []

  // Default write target: right after the factory presets.
  let startSlot = Math.min(def.factoryPresets.length, def.numSlots - 1) // 0-based

  function stage(programs: Program[], sourceName: string, skipped: number): void {
    // An open BROWSE popover indexes into the old staged array — close it.
    closeMenu()
    staged = programs
    staging.textContent = ''
    staging.style.display = ''

    const title = div('xd-set-import-title', sourceName + ' — ' + programs.length + ' program' + (programs.length === 1 ? '' : 's'))
    const discard = document.createElement('button')
    discard.className = 'xd-set-clear'
    discard.textContent = '✕'
    discard.title = 'Discard import'
    discard.addEventListener('click', () => {
      closeMenu() // a BROWSE popover would pick into the discarded array
      staged = []
      staging.style.display = 'none'
      setStatus('')
    })
    staging.appendChild(row('xd-set-row', title, discard))

    const browse = actionBtn('BROWSE / AUDITION', () => {
      const items: MenuItem[] = staged.map((p, i) => ({
        label: String(i + 1).padStart(3, '0') + '  ' + p.name,
        value: i,
      }))
      showMenu(browse, items, (v) => {
        const p = staged[Number(v)]
        if (p) {
          store.loadProgramData(p)
          setStatus('Loaded "' + p.name + '" into the edit buffer (unsaved).')
        }
      })
    })

    /* start-slot stepper (1-based display) */
    const slotVal = div('xd-set-value xd-set-num')
    const syncSlot = (): void => {
      slotVal.textContent = String(startSlot + 1).padStart(3, '0')
    }
    const step = (d: number): void => {
      startSlot = Math.max(0, Math.min(def.numSlots - 1, startSlot + d))
      syncSlot()
    }
    const minus = stepBtn('−', () => step(-1))
    const plus = stepBtn('+', () => step(1))
    syncSlot()

    const write = actionBtn('WRITE TO BANK', () => {
      const r = store.importPrograms(staged, startSlot)
      if (r.written === 0) {
        setStatus('Nothing was written.', true)
        return
      }
      const last = startSlot + r.written
      let msg = 'Wrote ' + r.written + ' program' + (r.written === 1 ? '' : 's') + ' to slots ' + String(startSlot + 1).padStart(3, '0') + '–' + String(last).padStart(3, '0') + '.'
      if (r.written < staged.length) msg += ' (' + (staged.length - r.written) + ' did not fit in the bank.)'
      setStatus(msg, false)
      if (!r.persisted) setStatus(msg + ' Storage quota hit — some slots are in memory only.', true)
    })

    staging.appendChild(row('xd-set-row', browse))
    staging.appendChild(row('xd-set-row', div('xd-set-label', 'START SLOT'), row('xd-set-numwrap', minus, slotVal, plus)))
    staging.appendChild(row('xd-set-row', write))

    setStatus(skipped > 0 ? skipped + ' entr' + (skipped === 1 ? 'y' : 'ies') + ' could not be read and were skipped.' : '')
  }

  // Latest-wins: a slow parse must not stage/report over a newer pick.
  let importGen = 0

  async function importFile(f: File): Promise<void> {
    const gen = ++importGen
    try {
      const lower = f.name.toLowerCase()
      if (lower.endsWith('.json')) {
        const text = await f.text()
        if (gen !== importGen) return
        const pack = parsePack(def, text)
        if (!pack) {
          setStatus('Not a ' + def.title + ' program or pack file.', true)
          return
        }
        if (pack.programs.length === 0) {
          setStatus('No ' + def.title + ' programs could be read from ' + f.name + '.', true)
          return
        }
        stage(pack.programs, f.name, pack.skipped)
      } else if (codec) {
        const bins = await parseKorgContainer(new Uint8Array(await f.arrayBuffer()))
        if (gen !== importGen) return
        if (bins.length === 0) {
          setStatus('No programs found in ' + f.name + '.', true)
          return
        }
        const programs: Program[] = []
        let skipped = 0
        for (const b of bins) {
          const p = codec.decodeProgBin(b.data)
          if (p) programs.push(p)
          else skipped++
        }
        if (programs.length === 0) {
          setStatus('No ' + def.title + ' programs could be decoded from ' + f.name + '.', true)
          return
        }
        stage(programs, f.name, skipped)
      } else {
        setStatus('Unsupported file type.', true)
      }
    } catch (err) {
      if (gen === importGen) setStatus('Import failed: ' + String(err), true)
    }
  }
}

/* -------------------------------------------------------------------- */
/* helpers (shared with the settings drawer)                             */
/* -------------------------------------------------------------------- */

/** Settings-drawer action button (.xd-set-btn), fires on click. */
export function actionBtn(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'xd-set-btn'
  b.textContent = label
  b.addEventListener('click', fn)
  return b
}

/** Settings-drawer −/+ stepper button (.xd-set-step), repeats while held. */
export function stepBtn(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'xd-set-step'
  b.textContent = label
  bindHold(b, fn)
  return b
}

function fileSafe(name: string): string {
  const s = name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')
  return s || 'program'
}

function download(name: string, data: Uint8Array | string, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
