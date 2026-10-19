// Context menus.

import { h, render } from 'preact'
import htm from 'htm'

const html = htm.bind(h)
let host = null

export function closeMenu() {
  if (host) render(null, host)
}

export function openMenu(x, y, items) {
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
    window.addEventListener('pointerdown', e => {
      if (!e.target.closest?.('.menu')) closeMenu()
    }, true)
    window.addEventListener('keydown', e => e.key === 'Escape' && closeMenu())
  }
  render(html`<${Menu} x=${x} y=${y} items=${items} />`, host)
}

function Menu({ x, y, items, sub }) {
  const left = Math.min(x, innerWidth - 260)
  const top = Math.min(y, innerHeight - items.length * 28 - 20)

  return html`
    <div class=${`menu ${sub ? 'sub' : ''}`} style=${{ left: `${left}px`, top: `${Math.max(8, top)}px` }}>
      ${items.map(it =>
        it.sep
          ? html`<div class="menu-sep"></div>`
          : html`<div class=${`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''} ${it.sub ? 'has-sub' : ''}`}
              onClick=${() => {
                if (it.disabled || it.sub) return
                closeMenu()
                it.run?.()
              }}>
              <span>${it.label}</span>${it.hint ? html`<kbd>${it.hint}</kbd>` : it.sub ? html`<span class="chev">›</span>` : null}
              ${it.sub ? html`<div class="submenu">${it.sub.map(s => html`<div class="menu-item" onClick=${e => (e.stopPropagation(), closeMenu(), s.run())}>${s.label}</div>`)}</div>` : null}
            </div>`,
      )}
    </div>
  `
}
