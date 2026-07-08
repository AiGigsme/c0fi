# Getting started with C0fi

## What C0fi is
C0fi is a single-file, local visual workflow engine. The local LLM (via Ollama) is not just a node — it is the engine that decides, orchestrates, creates, and builds the workflow. Everything runs against your own Ollama; there are no accounts and no telemetry.

## The fast way to start
From the C0fi folder, run the launcher:

    ./start.sh

It starts the c0fi_server.py engine on port 8790, opens the newest c0fi HTML file in your browser, and stops everything it started when you press Ctrl+C. To also start the page-agent browser-automation bridge, run `./start.sh --with-page-agent`.

## Connecting Ollama (the second-port method)
C0fi runs in the browser, so Ollama must accept browser connections (CORS). The reliable way is to run a second Ollama instance on its own port just for browser tools:

    OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="*" ollama serve

Then open Engine settings in C0fi, set the endpoint to http://localhost:11435, test the connection, pick a model, and save. The header dot turns green when the engine is online. Both Ollama instances share the same model store, so nothing re-downloads.

## Running a flow
Load a demo from the "Load demo flow" dropdown or build one, then press the Brew button. The Brew Log tab on the right shows a timestamped record of everything that happens: prompts, decisions, tool calls, outputs, and errors. Think and Critic node output streams in live as the model generates it.
