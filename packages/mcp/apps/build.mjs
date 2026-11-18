#!/usr/bin/env node
// Bundles each Sundial MCP App into one HTML file: its script (the shell's drawing modules,
// the ext-apps bridge) inlined, its style (the host-variable palette and the shell's own
// rules for what it draws) inlined. One file, no fetches: an MCP App is drawn in a sandbox
// that may load nothing else.
//
// Run: node apps/build.mjs            → apps/dist/{today,figure,goals,notices,ledger,ask}.html (gitignored)
// `pnpm --filter @sundial/mcp build` and `sundial install` run it after tsc.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const APPS = ['today', 'figure', 'goals', 'notices', 'ledger', 'ask']
const SHELL_CSS = join(HERE, '..', '..', '..', 'plugins', 'sundial-theme', 'shell', 'app.css')

/** The shell rules the apps draw with, by selector; never the page, the board or a pane. */
const KEEP = /(^|[\s,>+~(])(\.|table\.|tr\.|button\.)(surface|axis|legend|swatch|grid|flow|gauge|gauges|plate|arc|trail|goal-trail|link)(-[\w-]+)?\b/
const DROP = /\.pane-body|\.turn|^body|\.wk\b|\.proposal|\.canvas-frame|\.stage-act|\.surface-stub/

/** Top-level rules of a stylesheet, as [selector, body] pairs; @-blocks are skipped whole. */
export function rulesOf(css) {
  const out = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const selector = text.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    if (!selector.startsWith('@')) out.push([selector, text.slice(open + 1, j - 1).trim()])
    i = j
  }
  return out
}

export function shellCss(css = readFileSync(SHELL_CSS, 'utf8')) {
  return rulesOf(css)
    .filter(([selector]) => KEEP.test(selector) && !DROP.test(selector))
    .map(([selector, body]) => `${selector} { ${body} }`)
    .join('\n')
}

export async function bundle(name) {
  const result = await build({
    stdin: { contents: `import { boot } from './lib.js'\nimport { draw } from './${name}.js'\nboot('${name}', draw)\n`, resolveDir: HERE, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
}

export async function html(name, { shell = shellCss() } = {}) {
  // The palette comes AFTER the shell's rules: it maps the colours and overrides the few layouts the apps size differently.
  const palette = readFileSync(join(HERE, 'palette.css'), 'utf8')
  const js = await bundle(name)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sundial · ${name}</title>
<style>
${shell}
${palette}
</style></head>
<body><main id="root"></main>
<script type="module">${js}</script>
</body></html>
`
}

export async function buildApps(outDir = join(HERE, 'dist')) {
  mkdirSync(outDir, { recursive: true })
  const shell = shellCss()
  const written = []
  for (const name of APPS) {
    const file = join(outDir, `${name}.html`)
    writeFileSync(file, await html(name, { shell }))
    written.push(file)
  }
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await buildApps()
  for (const f of files) console.log(`built ${f} (${readFileSync(f).length} bytes)`)
}
