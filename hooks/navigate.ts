// What a click in the pane does, on every surface: filter to a row, or lead
// from a details entry to what it was (its file, its page, its call, its turn).



import type { Group, Preview } from '../types'
import { PANE } from './constants'
import { NO_FILTER } from './filter'
import { contentPreview, filePreview, firstTurn, jumpToTurn, leadOf, openPage, openView, showInFilesPane, turnPreview } from './leads'
import type { PaneContext } from './pane'
import type { RowActions } from './rows'
import type { Host } from './host'


export type PaneActions = RowActions & {
  addTurn: (value: string) => void
  addCat: (value: string) => void
  dropTurn: (turn: number) => void
  dropCat: (cat: string) => void
  clearFilter: () => void
  closePreview: () => void
  openFull: (p: Preview) => void
}

export function paneActions(host: Host, ctx: PaneContext): PaneActions {
  const { raw, filter, isLive, setFilter } = ctx

  // a details entry's click: a file in the Files pane (else here), a page in
  // the browser, a command, output or skill here, anything else its turn in
  // the chat; nothing filters, and a step that cannot says why
  const show = async (p: Preview | undefined, what: string) => {
    if (!p) return host.ui.toast(`Could not find ${what}.`)
    await host.state.set('preview', p)
    void host.ui.scroll({ in: PANE, to: { key: 'preview-close' }, block: 'start' }).catch(() => undefined)
  }
  const goTo = async (g: Group) => {
    const lead = leadOf(g)
    const turn = firstTurn(g)
    if (lead === 'file' && g.ref?.path) {
      if (await showInFilesPane(host, g.ref.path)) return
      // outside the session's folders the Files pane opens nothing: show it here
      return show((await filePreview(host, g.ref.path)) ?? (await contentPreview(host, raw, g).catch(() => undefined)), g.ref.path)
    }
    if (lead === 'page' && g.ref?.url) {
      if (!(await openPage(host, g.ref.url))) host.ui.toast(`Could not open ${g.ref.url}`)
      return
    }
    if (lead === 'show') return show(await contentPreview(host, raw, g).catch(() => undefined), g.label)
    if (lead === 'turn' && turn !== undefined) {
      // the chat is scrolled where the surface lets a plugin (the terminal);
      // the desktop does not, so the turn is shown here instead
      if (isLive && (await jumpToTurn(host, raw, turn)) === undefined) return
      return show(await turnPreview(host, raw, turn).catch(() => undefined), `turn ${turn}`)
    }
  }

  return {
    goTo,
    // a row's click picks it alone, or drops it when it is the one picked
    onlyTurn: turn => setFilter({ ...filter, turns: filter.turns.length === 1 && filter.turns[0] === turn ? [] : [turn] }),
    onlyCat: cat => setFilter({ ...filter, cats: filter.cats.length === 1 && filter.cats[0] === cat ? [] : [cat] }),
    // the dropdowns add, the chips remove
    addTurn: value => {
      if (value !== 'all') setFilter({ ...filter, turns: [...filter.turns, Number(value)].sort((a, b) => a - b) })
    },
    addCat: value => {
      if (value !== 'all') setFilter({ ...filter, cats: [...filter.cats, value] })
    },
    dropTurn: turn => setFilter({ ...filter, turns: filter.turns.filter(x => x !== turn) }),
    dropCat: cat => setFilter({ ...filter, cats: filter.cats.filter(x => x !== cat) }),
    clearFilter: () => setFilter(NO_FILTER),
    closePreview: () => void host.state.set('preview', null),
    openFull: p => void openView(host, p),
  }
}
