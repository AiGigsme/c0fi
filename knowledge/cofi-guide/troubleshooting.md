# Troubleshooting C0fi

## Red dot or "engine offline"
Ollama is not reachable or is rejecting browser origins. The fastest fix is to start a dedicated instance with browser origins allowed: OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="*" ollama serve, then point Engine settings at http://localhost:11435. The start.sh launcher warns you at launch if neither port answers.

## Web Search returns almost nothing
You are on the ddg-api source, which only returns instant answers. Start c0fi_server.py (or run ./start.sh) and set the search node's source to proxy for real result lists.

## The Orchestrator chats but does not build
The model returned prose instead of the JSON C0fi expects. Try a stronger instruct model, or rephrase your message as a direct command like "Build a flow that...".

## A Decision picks the wrong branch
Make branch labels distinctive — PUBLISH,REVISE works better than A,B for small models — and restate them in the question. If the test is mechanical rather than a judgment call, switch to a Code Branch, which cannot misjudge.

## "Loop safety valve hit"
This is working as intended: a cycle ran out of passes. Raise Max loop iterations in Engine settings if the loop is deliberate, or convert the iteration to a For Each node, which does not consume the valve. An Interaction node also resets the valve each turn.

## Nothing happens on Brew
Check that there is a Trigger node and that it is wired forward. The Brew Log names the exact failure otherwise.

## Tool Server "NetworkError" or port already in use
Nothing that speaks CORS is answering at that URL. Probe the URL in a browser: a JSON probe means the engine or bridge is up; an HTML 404 page means a different server is squatting on the port. Start on a free port, for example python3 c0fi_server.py 8795, and update the node URL. To find what owns a port: lsof -i :8790. To kill the engine by name: pkill -f c0fi_server.py.

## kb_search says no documents found
Make sure your files are in the knowledge/ folder (or the right collection subfolder) next to c0fi_server.py, and that you restarted the engine after adding them. Remember to kill any old engine instance first.
