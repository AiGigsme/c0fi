# C0fi

**Single-file visual workflow builder where your local LLM builds, wires, and runs the flows — n8n-style canvas, 100% on your machine via Ollama.**

![C0fi — the "Self-consistency + verify (deterministic rule-check)" demo on the canvas, with the C0fi Orchestrator panel that builds and edits flows from plain language](docs/screenshot.png)

C0fi is in the spirit of n8n, rebuilt around one inversion — the whole canvas is a single loop the model lives inside: **decide → orchestrate → create → build → run → learn**. Via [Ollama](https://ollama.com), the model **decides** (Decision/Critic nodes), **orchestrates** (a chat panel that sees the whole canvas and rewires it), **creates** (describe a flow in plain language and it builds the nodes and wires), and **builds** (edits, extends, and re-runs flows mid-conversation, including ones you drew by hand) — then you **run** the flow and **learn** from what comes back in the Brew Log, feeding the next pass.

Everything runs in one HTML file against your own Ollama. No accounts, no telemetry, no cloud. Flows export as JSON you own; finished flows export as standalone single-file apps; and flows can now **run themselves on a schedule** (Auto Brews).

- **App:** [`c0fi-v7.0.html`](c0fi-v7.0.html)
- **Full user guide:** [`c0fi-user-guide-v7.0.html`](c0fi-user-guide-v7.0.html) — open it in a browser

---

## Quickstart

**Requirements:** [Ollama](https://ollama.com) + a mid-size instruct model (7B–14B handles the strict-JSON orchestration well), and `python3` (standard library only — no `pip install`) for real web search / page reading.

```bash
# 1. Start Ollama with browser origins allowed (a second instance on its own port
#    sidesteps the desktop app that owns 11434):
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="*" ollama serve

# 2. From this folder, launch the local engine + open the app:
./start.sh                     # search + read + MCP tools on :8790, opens the newest c0fi-v*.html
./start.sh --with-page-agent   # also starts the Page Agent bridge (real browser actions)
```

Then in the app: **Engine settings** → set the endpoint to `http://localhost:11435`, press **Enter** to connect, pick a model, **Save**. The header dot goes green. Load a demo from the dropdown and hit **⏻ Brew**.

> **Standalone mode:** with *only* Ollama running (no `c0fi_server.py`), C0fi still works — Web Search and Read Page fall back through DuckDuckGo instant answers and the keyless r.jina.ai reader automatically. The local engine just upgrades quality and adds real result pages.

See the [user guide](c0fi-user-guide-v7.0.html) §2 for the CORS details, the single-instance method, and troubleshooting.

---

## What's in the box

| File | What it is |
| --- | --- |
| `c0fi-v7.0.html` | The whole app — canvas, node palette, Orchestrator, Build App, Auto Brews, 21 demos. One file, no build step. |
| `c0fi-user-guide-v7.0.html` | Complete guide (setup, every node, MCP, the brew model, Auto Brews, recipes, troubleshooting). |
| `c0fi_server.py` | Zero-dependency local engine on `:8790` — real DuckDuckGo search + clean page reading, an MCP tool surface (`web_search`, `read_page`, `ask_llm`), and `kb_search`/`kb_list` RAG over `knowledge/`. |
| `mcp_stdio_bridge.py` | Generic adapter that exposes any stdio MCP server over HTTP+CORS, so browser-based C0fi can reach the wider MCP ecosystem. |
| `start.sh` | Launcher — starts the engine, opens the newest app version, cleans up its children on `Ctrl+C`. |
| `knowledge/` | Sample RAG collections: `coffee/` (a demo shop KB), `cofi-guide/` (C0fi's own docs), `user-docs/` (drop your own `.txt`/`.md` here). |
| `test/` | Headless jsdom test harness (see below). |
| `archive/` | Every earlier `c0fi-vX.Y.html` and user guide, kept for reference and the test self-check. |

## Nodes

`Trigger` · `C0fi Think` · `Decision` · `Code Branch` · `For Each` · `Gather` (join/barrier → array) · `Web Search` · `Read Page` · `Tool Server` (MCP) · `Watch Task` · `HTTP Request` · `Transform` (JS) · `Memory` (shared blackboard) · `Critic Loop` · `Interaction` (live chat) · `Output` · `Escalate` (hand off to a human, with the reason).

Drag them from the palette, or just describe what you want in the Orchestrator and let C0fi wire it.

![A complete flow, end to end: the "Self-consistency + verify (deterministic rule-check)" demo — three independent samples reason over a logic puzzle, a majority vote picks the answer, then a deterministic JS rule-checker either accepts it or routes the wrong majority to a Reject node, ~21 nodes running entirely on local models](docs/full-flow.png)

*Above: one of the 21 built-in demos — three samples each reason step-by-step over the same puzzle and cast a vote, a majority tally picks the winner, then a deterministic "Check the rules" node tests the winning answer against the puzzle's actual rules in plain JS; only a rule-valid answer clears the Code Branch, and a wrong majority is routed to a Reject-and-explain node instead of being trusted. Voting alone can launder a systematic model error into false confidence — the verifier checks the answer, not the model.*

## Auto Brews — flows that run themselves

The **⏰ Auto Brews** button (next to *Clear canvas*) schedules whole flows to brew automatically — **every N minutes**, **daily at a time**, or **weekly on the days you pick** (e.g. every Monday at 1 am, or Mon/Wed/Fri at 09:00). Build a flow, confirm it with **⏻ Brew**, then deploy it to the Auto Brews list; deploy as many as you want, each **pausable, deletable, and running independently**. Every run can **auto-save its result to a `.txt`** file, and there's a **⤓ Save .txt** for the last result on demand.

A background run **snapshots your canvas, runs the scheduled flow, and restores your canvas** — it never loses the work you have open and won't hijack the canvas mid-edit. A single engine lock keeps brews from colliding: a busy engine **holds and retries** instead. Deleting a brew that's running **stops it** for you.

> **Tier 1 (in-browser):** Auto Brews fire while the C0fi tab stays open and the machine is awake — closing the tab pauses them. Deployed brews persist across reloads. See guide §11.

## Build App

The **▶ Build App** button turns the current flow into a standalone `.html` — the same engine with the flow baked in and the builder chrome hidden. A flow with an Interaction node becomes a **chat app**; a batch flow becomes a **form app**. Exported apps still need Ollama reachable (and `c0fi_server.py` if the flow uses web/tool nodes) — if one opens with no engine in reach, it shows a short "run me on Ollama" hint instead of failing silently.

> An exported app runs its baked-in `Transform`/`Code Branch` JavaScript on the opener's machine and talks to their local engine — **only share apps you built, and only open ones from people you trust.**

## Hands — acting on real web pages

C0fi's `Web Search` and `Read Page` nodes are **eyes**: they fetch and read. [Page Agent](https://github.com/alibaba/page-agent) (MIT) is **hands** — a Chrome extension that reads the DOM as text and lets a local model click, type, and navigate real, *logged-in* pages. It can't fold into the Python engine (it needs the extension and a live tab), so it stays an optional add-on, wrapped as an MCP tool. A flow can draft an article and then actually publish it.

The chain: **C0fi → stdio bridge (`:8794`) → `@page-agent/mcp` → hub tab (WebSocket, `:38401`) → extension → the LLM in the extension's panel.**

```
./start.sh --with-page-agent
```

Setup, in order — steps 1, 2 and 4 are one-time and human-only:

1. Install **Page Agent Ext** from the Chrome Web Store (≥ 1.5.11 for MCP) and enable it. **Chrome only** — the hub tab must open in Chrome, not whatever your OS default browser is.
2. In the extension's config panel, set the LLM: base URL `http://localhost:11435/v1`, your Ollama model, any non-empty key. Prove it by running a trivial task in the side panel first — that panel is the brain MCP tasks will use.
3. Launch the bridge (`./start.sh --with-page-agent`, or bare: `python3 mcp_stdio_bridge.py 8794 -- npx -y @page-agent/mcp`).
4. In Chrome, open `http://localhost:38401` so the launcher opens the hub tab with its `?ws=` parameter. **Keep exactly one hub tab.**
5. In C0fi: **Tool Server** node → `http://localhost:8794/mcp` → discover. `get_status` should report `connected: true`. Run tasks through a **⟳ Watch Task** node with `cleanup`/`stopTool` = `stop_task`.

The server exposes three tools: `execute_task` (blocking, natural-language), `get_status` (`{connected, busy}`), `stop_task`.

**Writing tasks that succeed.** Numbered steps, explicit STOP lines, and a ban on side-quests keep a local model on the road:

```
1. Open linkedin.com/feed.  2. Click Start a post.
3. Paste the following text.  4. STOP — do NOT click Post.

{{memory.draft}}
```

Stage big jobs as several small tasks — each gets a fresh agent run — rather than one monolith.

> **Keep a human on the final button for anything consequential.** The example above deliberately stops short of publishing. Restarting the bridge kills the hub and orphans the tab, so a "connected" tab can be stale — re-check with `get_status`, not the tab.

> **Consent lives in Chrome.** Approval prompts and the Auto-approve toggle appear in the extension, not in the browser running C0fi — keep Chrome visible during action brews. Denying stops the brew cold; that's the kill-switch working.

See guide §6 for the full treatment, including why `LLM_*` environment variables on the bridge can abort tasks mid-start.

---

## Testing

A headless [jsdom](https://github.com/jsdom/jsdom) harness runs without a browser or Ollama.

```bash
cd test
npm install        # first time only — pulls jsdom (this is the 25MB node_modules, git-ignored)
npm test           # smoke (build/boot, all 21 demos, export round-trips) + runtime (brews flows)
npm run test:self  # also runs known-broken archived versions, which MUST fail (proves the harness)
```

- **`smoke.mjs`** catches the two bug classes that slip past syntax checks: a stray `</script>` truncating the inline script, and null-deref after a DOM wipe. It auto-targets the newest `c0fi-v*.html` in the root.
- **`runtime.mjs`** actually *brews* flows headlessly — verifying Gather joins to one array, the fan-in count-join idiom still works, undo/redo round-trips, and the focus-mode chat surfacing.

---

## What's new in v7.0 — brews that remember, and admit defeat

Three changes aimed at the same thing: making an *unattended* run trustworthy. A loop that can't carry anything forward and can't say "I couldn't do this" is really just a one-shot on a timer.

- **▤ Memory between runs** — an Auto Brew can now keep **its own blackboard** across runs instead of starting blank. Tick *Remember memory between runs* when deploying (or flip **▤ Memory: fresh/kept** on a deployed brew). A critic ledger keeps growing night over night, a "seen already" list stays seen, a lessons-learned key accumulates. Still **fully isolated from your canvas** — a background run can neither read nor clobber the memory you have open. **⌫ Clear memory** forgets it on demand, and oversized keys are clamped (newest kept) so a nightly append can't blow the storage quota.
- **⚑ Escalate node** — a terminal "I couldn't do this on my own" exit, with a reason and a severity (`blocked` / `needs-review` / `fyi`). Wire the failure side of a verification branch into it instead of letting a half-done result reach an Output. A scheduled run that reaches one is reported as **escalated, not ok**, its reason shows in the Auto Brews list, and it lands at the top of the auto-saved `.txt` — so the morning after, you read what it *couldn't* do, not just what it did.
- **New flow vs. edit, decided in code** — describing a *new* flow while another is on the canvas used to bolt a second, disconnected graph onto the first: both fired on Brew, the wiring couldn't be inferred, and the only fix was Clear canvas + reload. C0fi now detects this deterministically (a plan that brings its own Trigger and touches nothing existing) and clears first, in **one undoable step** — ⌘/Ctrl+Z brings the old flow straight back. Asking to *change, extend or fix* what's there never clears, and **✨ Refine** never clears.
- **Builds always come out wired** — measured across repeated runs, roughly **1 in 6** builds came back with nodes but no connects; the old recovery asked the same model to fix its own wiring, and when that failed too you got a canvas of red nodes and a shrug. There's now a deterministic fallback: unwired nodes are chained **left-to-right in the order they were laid out**, which is the sequence the builder already expressed. A **Decision/Code Branch fan-out is never guessed** — silently taking branch A drops branch B and looks finished — so those stay flagged for you.
- **⟳ Working indicator** — the Orchestrator now shows a spinner and a **live elapsed-seconds counter** while the model thinks, instead of a motionless `…` that's indistinguishable from a hang.
- **● Local engine status light** — a second dot in the header for `c0fi_server.py`, alongside the Ollama one. Green when it answers on `/api/health`, red when nothing's listening. Click it for the exact launch command (port included) and a plain statement of what still works without it — search and page-reading fall back automatically, but Tool Server, Watch Task and RAG nodes will fail. Set the port under **Engine settings → Local engine**.
- **HTTP Request checks the status code** — a non-2xx response used to flow downstream as if it had succeeded, so a 404 page or a 500 error body became the payload the next node reasoned over and the brew still reported `ok`. Now it fails the branch loudly. Set the node's **onError** to `pass` to opt back in for flows that deliberately inspect error responses.

<details>
<summary>Earlier — v6.8 (weekly Auto Brews)</summary>

- **📅 Weekly schedule** — a third Auto Brew mode alongside *every N minutes* and *daily at time*. Pick any combination of **Mon–Sun** plus a 24-hour time: "every Monday at 1 am," "Mon/Wed/Fri at 09:00," "weekends at noon." Tick all seven and it reads *every day*.
- The schedule shows in the list as e.g. `Mon, Wed, Fri at 09:00`; the next-run estimate accounts for the selected weekdays.
- Deploying weekly requires **at least one day** checked.

</details>

<details>
<summary>Earlier — v6.7 (Auto Brews)</summary>

- **⏰ Auto Brews** — deploy whole flows to a scheduled list that brews automatically (**every N minutes** or **daily at HH:MM**) while the tab is open. Many brews run independently; each persists across reloads.
- **Deploy / Pause / Run now / Update flow / Delete** per brew — plus a live active/total count on the button.
- **Auto-save results to `.txt`** — each run can download its Output as a timestamped file; a **⤓ Save .txt** grabs the last result anytime.
- **Swap-run-restore** — a background brew snapshots your canvas, runs the scheduled flow, and restores your open work untouched; it won't hijack the canvas while you're editing.
- **One engine lock, hold-and-retry** — brews never collide; a busy engine makes a manual run retry in 2 min and a scheduled run retry every 15 s.
- **Stop-on-delete** — deleting an Auto Brew that's mid-run stops it for you.

</details>

<details>
<summary>Earlier — v6.2</summary>

- **Model pool** — Engine settings holds four model slots (Model, Verifier, Model C, Model D), so one flow can mix different local models.
- **Per-node model override** — each node has a live dropdown of your available models plus slot tokens (`@1`–`@4`); a judge, a critic, and a drafter can each run on a different model.
- **Verifier bench + repair loop demo** — three independent judges (reading the Verifier / Model C / Model D slots) score a draft, a Count+Branch join waits for all three, and anything flagged routes to a repair specialist.
- **One-row status line** — long status messages are clamped to a single row (full text stays in the Brew Log).
- **Exported-app offline hint** — a standalone app that opens with no engine reachable shows a short "run me on Ollama" message instead of failing silently.

</details>

<details>
<summary>Earlier — v6.1</summary>

- **⇉ Gather node** — a join/barrier that waits for every incoming wire, then outputs all inputs as one array (no manual counter).
- **Undo / redo + copy-paste** — ⌘/Ctrl+Z / ⌘⇧Z, and ⌘/Ctrl+C/V to clone a node.
- **Engine settings persist** across reloads — connect once.
- **Instant Stop** — cancels an in-flight model generation immediately, not just at the next node.
- **Focus-mode chat** — a waiting Interaction node shows a "✍ your turn" badge and floats a reply bar onto the canvas.
- Bad-model warning at connect time; misc fixes.

</details>

---

## Credits & license

C0fi is released under the [MIT License](LICENSE).

Optional browser-automation hands come from [Page Agent](https://github.com/alibaba/page-agent) (MIT), integrated as an MCP tool — it is not bundled here; install it separately if you want real browser actions (guide §6).

Built to run entirely on your own machine — your flows, your files, your model. · [c0fi.com](https://c0fi.com)
