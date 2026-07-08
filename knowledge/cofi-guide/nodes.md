# C0fi node reference

## Trigger
Every flow starts from a Trigger node. Its payload is the initial text handed downstream.

## C0fi Think
Sends its prompt to the local model and passes the output downstream. Use {{input}} for whatever arrived on the in-port and {{memory.key}} for any value on the shared blackboard. Its output streams into the Brew Log live.

## Decision
Asks the model a question and fires exactly one outgoing branch. It uses a model call, so reserve it for genuine judgment calls. Branch labels are a comma list like A,B or YES,NO. Verdicts run on the Verifier model if one is set.

## Code Branch
A deterministic fork that picks a branch with JavaScript and no model call — instant, free, and 100% reliable. The code is the body of function(input, memory) and must return one of the branch labels. Prefer Code Branch over Decision whenever the choice is mechanical, such as "does this look like a URL", "is this list empty", or "is this valid JSON".

## For Each
A native loop over a list. Its "each" port fires once per item; its "done" port fires once after all items, carrying the aggregated memory key. Items run one at a time, in order — not in parallel. For Each does not consume the loop safety valve per item, so you can iterate long lists.

## Web Search and Read Page
Web Search returns DuckDuckGo results; Read Page fetches a URL as clean readable text. In "proxy" mode they use the local c0fi_server.py engine on port 8790 for real results; fallbacks are ddg-api and the jina reader.

## Tool Server and Watch Task
Tool Server calls any tool on any MCP server over HTTP. Watch Task is for long-running tools like browser agents: it starts a job, polls for progress, collects the result, and calls a stop tool automatically on timeout or stop.

## Transform, Memory, Critic, Output
Transform runs raw JavaScript over the payload. Memory reads or writes the shared blackboard (write, append, read). Critic Loop is a review-and-revise cycle that enforces a quality bar and keeps a ledger of banned phrases. Output collects the final result.

## Interaction
The Interaction node pauses the brew and waits for you to type a reply, then continues. Wired in a loop it makes a multi-turn chatbot; the whole conversation is one brew. It resets the loop safety valve each turn, so a chat can run indefinitely. Type the end word (default "bye") or press Stop to end.
