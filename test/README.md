# C0fi smoke test

A headless test that catches the class of bugs static/syntax checks miss — the ones that only
show up when a real HTML parser and DOM run the app together. It runs the app in **jsdom** (no
browser download), so it's fast and CI-friendly.

## Run it

    cd test
    npm install          # first time only (pulls jsdom)
    npm test             # auto-tests the highest-versioned c0fi-v*.html in the project root
    node smoke.mjs ../c0fi-v6.2.html      # or test a specific file
    npm run test:self    # also run the archived KNOWN-BROKEN versions, which MUST fail

Exit code is 0 only if the current app passes (and, in self-check mode, the known-broken
fixtures fail as expected). Wire `npm test` into a pre-publish step if you like.

## What it checks

1. **No `</script>` inside the inline script** — an HTML parser ends the `<script>` at the first
   `</script>` it sees, *even inside a JS comment or string*. One slipped in once and killed the
   whole app while every JS syntax check passed. (Caught: v5.3.)
2. **The builder boots and every demo builds nodes** in a real DOM — if the script was truncated
   or a demo throws during `addNode`/`renderNode`, this fails.
3. **Build App → re-parse → boot** for both a **chat** flow and a **form** flow. The exported
   file is loaded fresh in jsdom to confirm it enters app-mode without throwing. This exercises
   the DOM-mutation paths where a null-dereference-after-`innerHTML`-wipe hid. (Caught: v5.4.)

Async errors (a throw inside an un-awaited `startAppMode`, say) are captured via
`process.on('uncaughtException'/'unhandledRejection')` and reported as failures rather than
crashing the runner.

## Target selection

With no path argument it auto-picks the highest-versioned `c0fi-v*.html` in the project root
(numeric sort, so `v5.10` beats `v5.9`; guide files are excluded). Pass an explicit path to test
a different file. Nothing to update on a version bump.

## Limitation

jsdom is not a full browser — it has no layout, and a few APIs are stubbed (`fetch`, `prompt`,
`URL.createObjectURL`, `<dialog>.showModal`). It verifies **structure, script execution, and DOM
wiring** — not pixels. A visual once-over in a real browser is still worth it for anything that
changes how things *look*; this catches the "the app is silently broken" bugs.
