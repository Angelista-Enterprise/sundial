// three.js, once per page: the first scene card imports the vendored module
// (670 KB, r160, MIT); every later one gets the same promise. A failed load is
// forgotten, so the next card tries again.

let three = null

export const loadThree = () =>
  (three ??= import('@sundial/nodus/vendor/three.module.js').catch((error) => {
    three = null
    throw error
  }))
