// What the page is reading. The head's bottom rule turns ochre while a route is in flight and names the
// routes. It is deliberately LATE: a read that lands inside 180ms never shows a bar at all, because a bar
// that flickers on every beat is worse than no bar. Hiding is immediate: the moment nothing is in flight,
// the rule is gone.
//
// Named exports only.

import { onReading } from './read.js'

export function mountReadingLine($) {
  const readingLine = $('reading-line')
  const readingWhat = $('reading-what')
  let readingTimer = 0
  onReading((names) => {
    clearTimeout(readingTimer)
    if (names.length === 0) {
      readingLine.hidden = true
      readingWhat.hidden = true
      return
    }
    readingWhat.textContent = names.length > 3 ? `reading ${names.length} readings` : `reading ${names.join(' · ')}`
    if (readingLine.hidden) {
      readingTimer = setTimeout(() => {
        readingLine.hidden = false
        readingWhat.hidden = false
      }, 180)
    }
  })
}
