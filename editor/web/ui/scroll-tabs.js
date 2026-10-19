import { h } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { Icon } from './icons.js'

const html = htm.bind(h)

/**
 * Splits a tab strip into the tabs that fit and the tabs listed under More.
 * `widths` are each tab's width including its gap, `available` the strip's inner width and
 * `moreWidth` the More button's width including its gap. The active tab always stays visible;
 * when it would overflow it takes the place of the last tabs that fit. Returns tab indices in order.
 */
export function fitTabs(widths, available, active, moreWidth) {
  const all = widths.map((_, index) => index)
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (!(available > 0) || total <= available) return { visible: all, overflow: [] }
  const budget = available - moreWidth
  const visible = []
  let used = 0
  for (const index of all) {
    if (used + widths[index] > budget) break
    visible.push(index)
    used += widths[index]
  }
  if (active >= 0 && !visible.includes(active)) {
    while (visible.length && used + widths[active] > budget) used -= widths[visible.pop()]
    visible.push(active)
  }
  return { visible, overflow: all.filter(index => !visible.includes(index)) }
}

// The list of overflowed tabs. It is fixed to the viewport so a panel's clipping cannot cut it off.
function MoreMenu({ id, items, anchor, onPick, onClose }) {
  const list = useRef(null)
  useEffect(() => {
    list.current?.querySelector('[role="menuitem"]')?.focus()
    const outside = event => { if (!list.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  const rect = anchor.current?.getBoundingClientRect()
  const right = rect ? Math.max(8, innerWidth - rect.right) : 8
  const style = rect ? { top: `${Math.round(rect.bottom + 4)}px`, right: `${Math.round(right)}px`, maxHeight: `${Math.max(120, innerHeight - rect.bottom - 16)}px` } : undefined
  const keys = event => {
    const items = [...list.current.querySelectorAll('[role="menuitem"]')]
    const at = items.indexOf(document.activeElement)
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key]
    if (move !== undefined) {
      event.preventDefault(); event.stopPropagation()
      items[(move + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      onClose(true)
    } else if (event.key === 'Tab') {
      onClose(false)
    }
  }

  return html`<div class="tab-more-menu" id=${id} role="menu" ref=${list} style=${style} onKeyDown=${keys}>
    ${items.map(([tabId, name]) => html`<button type="button" role="menuitem" tabIndex="-1" key=${tabId} onClick=${() => onPick(tabId)}>${name}</button>`)}
  </div>`
}

/**
 * A tab strip. By default it scrolls when the tabs do not fit. With `overflow="menu"` it shows
 * the tabs that fit with whole labels and lists the rest under a More button.
 */
export function ScrollTabs({ tabs, value, onChange, label, small = false, overflow = 'scroll' }) {
  const menuMode = overflow === 'menu'
  const strip = useRef(null), box = useRef(null), ruler = useRef(null), more = useRef(null), refocus = useRef(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [hidden, setHidden] = useState('')
  const [open, setOpen] = useState(false)
  const names = tabs.map(t => `${t[0]}:${t[1]}`).join('|')
  const measure = () => {
    const el = strip.current
    if (el && !menuMode) setEdges({ left: el.scrollLeft > 1, right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1 })
  }
  const fit = () => {
    const outer = box.current, row = ruler.current, list = strip.current
    if (!menuMode || !outer || !row || !list || !outer.clientWidth) return
    const px = (style, side) => parseFloat(style[side]) || 0
    const outerStyle = getComputedStyle(outer), listStyle = getComputedStyle(list)
    const gap = px(listStyle, 'columnGap')
    const cells = [...row.children], moreCell = cells[tabs.length]
    const widths = tabs.map((_, index) => (cells[index]?.getBoundingClientRect().width ?? 0) + gap)
    const moreStyle = moreCell ? getComputedStyle(moreCell) : null
    const moreWidth = moreCell ? moreCell.getBoundingClientRect().width + px(moreStyle, 'marginLeft') + px(moreStyle, 'marginRight') : 72
    // Every width carries one gap, but n tabs only have n - 1 gaps between them.
    const available = outer.clientWidth - px(outerStyle, 'paddingLeft') - px(outerStyle, 'paddingRight') - px(listStyle, 'paddingLeft') - px(listStyle, 'paddingRight') + gap
    const { overflow: rest } = fitTabs(widths, available, tabs.findIndex(t => t[0] === value), moreWidth)
    const next = rest.map(index => tabs[index][0]).join('|')
    setHidden(prev => (prev === next ? prev : next))
  }
  const revealActive = () => {
    if (!menuMode) strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  // Resize and selection changes both keep the current tab visible.
  const latest = useRef(null)
  latest.current = { measure, fit, revealActive }
  useEffect(() => {
    const el = menuMode ? box.current : strip.current, observer = new ResizeObserver(() => { latest.current.revealActive(); latest.current.measure(); latest.current.fit() })
    observer.observe(el); measure()
    return () => observer.disconnect()
  }, [names, menuMode])
  useLayoutEffect(fit, [names, value, menuMode])
  useEffect(() => {
    revealActive()
    measure()
  }, [value, names, menuMode])
  useEffect(() => {
    if (refocus.current == null) return
    strip.current?.querySelector(`[data-tab="${CSS.escape(refocus.current)}"]`)?.focus()
    refocus.current = null
  })
  const scroll = direction => strip.current?.scrollBy({ left: direction * Math.max(80, strip.current.clientWidth * .7), behavior: 'auto' })
  const keyboard = (event, index) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    onChange(tabs[next][0])
    // A tab listed under More becomes visible once it is the active tab, so show it now and move focus to it.
    const target = strip.current.querySelectorAll('[role="tab"]')[next]
    if (target) target.hidden = false
    target?.focus()
  }
  const hiddenIds = menuMode && hidden ? new Set(hidden.split('|')) : new Set()
  const overflowed = tabs.filter(([id]) => hiddenIds.has(id) && id !== value)
  const menuId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-more`
  // When the strip widens until nothing overflows, the menu closes rather than waiting to
  // reopen, and steal focus, the next time the strip narrows. Focus inside the menu would drop
  // to the page when it unmounts, so it moves to the active tab. Read before the menu unmounts.
  const focusInMenu = open && !overflowed.length && Boolean(globalThis.document?.getElementById?.(menuId)?.contains(globalThis.document.activeElement))
  useEffect(() => {
    if (!open || overflowed.length) return
    setOpen(false)
    if (focusInMenu) strip.current?.querySelector('[aria-selected="true"]')?.focus()
  })
  const closeMenu = restore => {
    setOpen(false)
    if (restore) more.current?.focus()
  }
  const pick = id => {
    refocus.current = id
    setOpen(false)
    onChange(id)
  }

  return html`<div class=${`tab-scroll ${small ? 'small' : ''} ${menuMode ? 'with-more' : ''}`} ref=${box}>
    ${edges.left && !menuMode ? html`<button class="tab-overflow previous" aria-label=${`Scroll ${label.toLowerCase()} left`} onClick=${() => scroll(-1)}>‹</button>` : null}
    <div class=${`tabs ${small ? 'small' : ''}`} role="tablist" aria-label=${label} ref=${strip} onScroll=${measure}>
      ${tabs.map(([id, name]) => html`<button role="tab" data-tab=${id} aria-selected=${value === id} tabIndex=${value === id ? 0 : -1} class=${value === id ? 'on' : ''} hidden=${hiddenIds.has(id) && value !== id} onClick=${() => onChange(id)} onKeyDown=${e => keyboard(e, tabs.findIndex(t => t[0] === id))}>${name}</button>`)}
    </div>
    ${edges.right && !menuMode ? html`<button class="tab-overflow next" aria-label=${`Scroll ${label.toLowerCase()} right`} onClick=${() => scroll(1)}>›</button>` : null}
    ${menuMode && overflowed.length ? html`<button type="button" class=${`tab-more ${open ? 'open' : ''}`} ref=${more} aria-haspopup="menu" aria-expanded=${open} aria-controls=${open ? menuId : undefined} aria-label=${`More ${label.toLowerCase()}: ${overflowed.map(t => t[1]).join(', ')}`} onClick=${() => setOpen(!open)}>More<${Icon} name="chevron-down" size=${14} /></button>` : null}
    ${menuMode && open && overflowed.length ? html`<${MoreMenu} id=${menuId} items=${overflowed} anchor=${more} onPick=${pick} onClose=${closeMenu} />` : null}
    ${menuMode ? html`<div class=${`tabs tab-ruler ${small ? 'small' : ''}`} ref=${ruler} aria-hidden="true" inert>${tabs.map(([id, name]) => html`<button type="button" tabIndex="-1" class=${value === id ? 'on' : ''} key=${id}>${name}</button>`)}<button type="button" tabIndex="-1" class="tab-more">More<${Icon} name="chevron-down" size=${14} /></button></div>` : null}
  </div>`
}
