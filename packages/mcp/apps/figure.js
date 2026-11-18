// The figure app: one `gnomon_compose_figure` result, drawn with the web client's own renderers.
import { renderFigure } from '../../../plugins/sundial-theme/shell/figures.js'
import { el } from '../../../plugins/sundial-theme/shell/surfaces.js'

/** `structuredContent` is the Figure itself (or `{ unavailable }`): `renderFigure` draws both. */
export function draw(figure) {
  return renderFigure(figure) ?? el('div', { class: 'surface-fail', text: 'No figure to draw.' })
}
