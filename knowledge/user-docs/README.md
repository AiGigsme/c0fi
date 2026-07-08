# Your documents go here

This folder is your personal knowledge base. Drop your own `.txt` or `.md` files into
`knowledge/user-docs/` — a product FAQ, a policy handbook, meeting notes, anything — and the
"Chat with YOUR docs" demo will answer questions grounded only in these files.

Steps:
1. Copy your `.txt` / `.md` files into this folder (`knowledge/user-docs/`).
2. Delete this README so it does not show up in answers.
3. Restart the engine if it was already running, then Brew the "Chat with YOUR docs" demo and ask away.

No wiring needed — the demo's Search node is already pointed at this folder
(`kb_search` with `"folder":"user-docs"`). Retrieval is lexical by default; for semantic
matching set `USE_EMBEDDINGS = True` in `c0fi_server.py` and pull an embedding model first.
