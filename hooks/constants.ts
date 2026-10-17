// ids and sizes more than one module needs; plain strings, never a state
// reference (each module declares its own of those)
export const PANE = 'session-insights'
export const COMMAND = 'session-usage'
// the tab a preview's full view opens in
export const VIEW_PANE = 'session-insights-view'

/**
 * About how many CSS pixels one column is on the surfaces that draw SVG: a
 * remote surface counts columns in the advance of its code font.
 */
export const PX_PER_COLUMN = 7.6
