/**
 * Small DOM helpers shared by the synth front panels (xd, og).
 *
 * The section chrome keeps the xd- class names: shared styling (section
 * boxes, silkscreen titles) lives under those classes in theme.css/panel.css
 * and both panels reuse it.
 */

export function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  if (text !== undefined) d.textContent = text
  return d
}

export function row(cls: string, ...children: HTMLElement[]): HTMLDivElement {
  const r = div(cls)
  r.append(...children)
  return r
}

/** Silkscreen section box with a title set into the top border. */
export function section(title: string, cls: string, ...children: HTMLElement[]): HTMLElement {
  const s = div(`xd-section ${cls}`)
  s.append(div('xd-section-title', title))
  s.append(...children)
  return s
}
