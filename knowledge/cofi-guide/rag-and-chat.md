# RAG over your files, and interactive chat

## The knowledge folder
Put .txt or .md files into the knowledge/ folder next to c0fi_server.py, and the kb_search tool retrieves the passages most relevant to a query, each tagged with its source filename, so a flow can answer grounded in your own documents instead of the web. Call it from a Tool Server node with tool kb_search and arguments like {"query":"{{input}}","k":3}.

## Collections
The knowledge/ folder can hold subfolders, each a separate named knowledge base called a collection. Pass a "folder" argument to kb_search to search one collection, for example {"query":"{{input}}","k":3,"folder":"coffee"}. The kb_list tool with no folder names the available collections. This keeps unrelated knowledge bases from mixing — for example a coffee-shop collection and a C0fi-guide collection.

## Lexical versus semantic retrieval
Retrieval is lexical by default: keyword and BM25-style scoring with light stemming, which needs no setup and suits FAQ-style docs where the answer shares words with the question. For semantic matching that handles different wording, set USE_EMBEDDINGS to True near the top of c0fi_server.py and pull an embedding model first with `ollama pull nomic-embed-text`. It falls back to lexical if the embedding model is not available.

## Building a chat-with-your-docs bot
Wire an Interaction node in a loop with kb_search: the Interaction node asks the user, a Memory node remembers the question, kb_search retrieves relevant passages, an LLM answers grounded only in those passages, and the answer wires back to the Interaction node for the next turn. The "Chat with your docs" and "Chat with the C0fi guide" demos show this, and the "Help desk" demo adds a router that classifies the question and searches the right collection automatically.

## After editing the server
If you change c0fi_server.py while an old copy is still running, kill the old instance before restarting, or the stale one keeps answering without the new tools. Find and kill it with: lsof -ti :8790 | xargs kill
