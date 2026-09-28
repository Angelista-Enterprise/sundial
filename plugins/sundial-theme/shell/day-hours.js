// The waking day's start hour, for the client.
//
// A twin of `WAKING_DAY_START_HOUR` in `packages/helpers/src/local-day.ts`,
// which the client cannot import — the shell is plain ES modules served from
// disk and does not resolve workspace packages. *day-arc.test.js* holds the two
// equal by reading the helper's source, for the same reason `palette.test.js`
// holds the clock width in two files: when one drifts nothing looks broken, the
// axis simply names the wrong hour on every tick.
export const WAKING_DAY_START_HOUR = 4
