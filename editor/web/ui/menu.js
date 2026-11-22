// Context menus.

import { h, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'

const html = htm.bind(h)
let host = null
let opener = null
let menuGeneration = 0

export function closeMenu({ restoreFocus = false } = {}) {
  if (host) render(null, host)
  const target = opener
  opener = null
  if (restoreFocus && target?.isConnected) target.focus?.()
}

export function openMenu(x, y, items) {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
    window.addEventListener('pointerdown', e => {
      if (!e.target.closest?.('.menu')) closeMenu()
    }, true)
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && host?.firstChild) {
        e.preventDefault()
        e.stopPropagation()
        closeMenu({ restoreFocus: true })
      }
    }, true)
  }
  render(html`<${Menu} key=${++menuGeneration} x=${x} y=${y} items=${items} />`, host)
}

function Menu({ x, y, items, sub }) {
  const menuRef = useRef(null)
  const [openSub, setOpenSub] = useState(null)
  const left = Math.max(8, Math.min(x, innerWidth - 260))
  const flipSub = left + 530 > innerWidth
  const inlineSub = innerWidth < 620 || (flipSub && left < 264) ||
    items.length * 32 > innerHeight - 24 || y + 190 > innerHeight
  const subRows = inlineSub ? (items[openSub]?.sub?.length ?? 0) : 0
  const top = Math.max(8, Math.min(y, innerHeight - items.length * 32 - subRows * 54 - 20))

  useEffect(() => {
    const first = menuRef.current?.querySelector('button.menu-item:not(:disabled)')
    first?.focus?.()
  }, [x, y, items])

  const focusItem = (list, index) => {
    if (!list.length) return
    list[(index + list.length) % list.length]?.focus?.()
  }

  const onMenuKeyDown = e => {
    const list = [...(menuRef.current?.querySelectorAll(':scope > button.menu-item:not(:disabled), :scope > .menu-sub-wrap > button.menu-item:not(:disabled)') ?? [])]
    const idx = list.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusItem(list, idx + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusItem(list, idx < 0 ? list.length - 1 : idx - 1) }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); focusItem(list, 0) }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); focusItem(list, list.length - 1) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }) }
    else if (e.key === 'Tab') { closeMenu() }
  }

  const renderSub = (subItems, parentIdx) => html`
    <div class=${`submenu ${inlineSub ? 'inline' : flipSub ? 'flip-left' : ''}`} role="menu" onKeyDown=${e => {
      const list = [...e.currentTarget.querySelectorAll(':scope > button.menu-item:not(:disabled)')]
      const idx = list.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusItem(list, idx + 1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusItem(list, idx < 0 ? list.length - 1 : idx - 1) }
      else if (e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopPropagation()
        setOpenSub(null)
        menuRef.current?.querySelector(`[data-menu-idx="${parentIdx}"]`)?.focus?.()
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }) }
    }}>
      ${subItems.map(s => s.sep ? html`<div class="menu-sep" role="separator"></div>` : html`
        <button type="button" role="menuitem" disabled=${Boolean(s.disabled)}
          class=${`menu-item ${s.danger ? 'danger' : ''} ${s.disabled ? 'disabled' : ''}`}
          onClick=${e => { e.stopPropagation(); if (s.disabled) return; closeMenu(); s.run?.() }}>
          <span>${s.label}</span>${s.hint ? html`<kbd>${s.hint}</kbd>` : null}
        </button>`)}
    </div>`

  return html`
    <div ref=${menuRef} role="menu" class=${`menu ${inlineSub ? 'scrollable' : ''} ${sub ? 'sub' : ''}`} style=${{ left: `${left}px`, top: `${top}px` }} onKeyDown=${onMenuKeyDown}>
      ${items.map((it, idx) =>
        it.sep
          ? html`<div class="menu-sep" role="separator"></div>`
          : it.sub
            ? html`<div class=${`menu-sub-wrap has-sub ${openSub === idx ? 'open' : ''}`} onMouseEnter=${() => !inlineSub && setOpenSub(idx)} onMouseLeave=${() => !inlineSub && setOpenSub(cur => (cur === idx ? null : cur))}>
                <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded=${openSub === idx} data-menu-idx=${idx}
                  disabled=${Boolean(it.disabled)} class=${`menu-item has-sub ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
                  onClick=${e => { e.stopPropagation(); if (!it.disabled) setOpenSub(cur => inlineSub && cur === idx ? null : idx) }}
                  onKeyDown=${e => {
                    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault(); e.stopPropagation()
                      const parent = e.currentTarget.parentElement
                      setOpenSub(idx)
                      setTimeout(() => parent?.querySelector('.submenu button.menu-item:not(:disabled)')?.focus?.(), 0)
                    }
                  }}>
                  <span>${it.label}</span><span class="chev" aria-hidden="true">›</span>
                </button>
                ${openSub === idx ? renderSub(it.sub, idx) : null}
              </div>`
            : html`<button type="button" role="menuitem" disabled=${Boolean(it.disabled)}
                class=${`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
                onClick=${() => { if (it.disabled) return; closeMenu(); it.run?.() }}>
                <span>${it.label}</span>${it.hint ? html`<kbd>${it.hint}</kbd>` : null}
              </button>`,
      )}
    </div>
  `
}
