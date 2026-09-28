# Contributing

Thank you for looking. Sundial is small and opinionated; these rules keep it that way.

## Run it from a checkout

```bash
pnpm install
npx tsc -b tsconfig.json      # dsh imports the built dist/, so build after any package change
npx vitest run                # every test runs against a throwaway SUNDIAL_HOME
zsh test/e2e-install.sh       # install → first run → uninstall in ~/.sundial-test on test ports
```

Never run `npm install`: this is a pnpm workspace. The web client
(`plugins/sundial-theme/shell/`) has no build step; a browser reload picks up an
edit. A host-side change needs `sundial restart`.

Run a second instance next to your own with its own folder, label and ports:

```bash
SUNDIAL_HOME=~/.sundial-dev SUNDIAL_LABEL=dev.sundial.dev SUNDIAL_WEB_PORT=3280 SUNDIAL_PHONE_PORT=8967 SUNDIAL_CHROME_PORT=9423 node bin/sundial install --no-sidecars
```

`--no-sidecars` builds the macOS helpers but never starts them, so no permission
prompt appears.

## The law

- **A new capability is a new field on the kernel state and a new rule in
  `RULE_MANIFEST`**, never a module with its own mutable state. Rules are pure
  `(state, event)` functions; side effects happen only in the effect executor.
- **Redaction happens once, at ingest** (`packages/helpers/src/sanitize-at-ingest.ts`).
  A new sensor field that can hold free text, a path, a URL or an address gets a
  line there and a test in `sanitize-at-ingest.test.ts`. A read path never
  redacts again.
- **Embeddings stay local.** Do not add a remote embedding path.
- **Nothing binds beyond loopback**, and every web route goes through
  `shell/guard.js` (a test enforces it).
- **Sundial is the software, Gnomon is the agent.** Name new software things
  `sundial-*` / `SUNDIAL_*`; keep `gnomon_*` for the agent's own tools and voice.
- Laziest change that works. No new dependency unless there is no other way.

The design wiki (`almanac/`, why things are shaped the way they are) is not in
the v0 public tree. It ships after a privacy scrub.

## Pull requests

One change per PR, with a test when behaviour changes. Say what you ran. CI runs
the typecheck, the tests, a secret scan and the end-to-end install.

Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.
