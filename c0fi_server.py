#!/usr/bin/env python3
"""
c0fi_server.py — C0fi's local web-access engine, all in one file.

Replaces the old two-piece setup (a separate "Agentic Browser" server.py
plus mcp_bridge.py importing it). One process, one port, no pip deps,
gives every c0fi node real capability:

    GET  /api/search?q=...     real DuckDuckGo results (Search node "proxy" mode)
    GET  /api/read?url=...     clean readable text of a page (Read Page node "proxy" mode)
    GET  /api/health
    POST /mcp                  same two tools + ask_llm, exposed as MCP (Tool Server node)

Why this exists instead of relying on the browser alone: a page can't
directly fetch duckduckgo.com/html or an arbitrary article URL and read
the response — those sites don't send CORS headers for browser JS. This
process fetches server-side (no CORS enforcement between two programs on
your own machine) and re-serves the result to the browser with
Access-Control-Allow-Origin: *.

Zero dependencies. Run once, point every c0fi node at the same port:

    python3 c0fi_server.py            # port 8790
    python3 c0fi_server.py 9000       # custom port
"""
import json
import math
import re
import socket
import sys
from html.parser import HTMLParser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, unquote, urlparse
from urllib.request import Request, urlopen

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) C0fi/1.0"
)
OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate"
OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embeddings"
DEFAULT_MODEL = "qwen3-coder:30b"
EMBED_MODEL = "nomic-embed-text"  # only used if USE_EMBEDDINGS is turned on below
USE_EMBEDDINGS = False            # lexical retrieval by default (zero setup); see kb_search()
KNOWLEDGE_DIR = Path(__file__).resolve().parent / "knowledge"
PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "c0fi-engine", "version": "1.1.0"}

# ---------------------------------------------------------------- readable page

class ReadableHTMLParser(HTMLParser):
    """Strips nav/script/style junk, keeps prose blocks and outbound links."""

    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._current_link = None
        self.links = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag in {"script", "style", "noscript", "svg", "canvas", "nav", "header", "footer", "aside", "form"}:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title = True
        if tag == "a" and attr.get("href"):
            self._current_link = {"href": attr["href"], "text": ""}
        if tag in {"p", "div", "section", "article", "li", "br", "h1", "h2", "h3", "h4", "blockquote"}:
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "svg", "canvas", "nav", "header", "footer", "aside", "form"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
        if tag == "a" and self._current_link:
            label = clean_text(self._current_link["text"])
            href = self._current_link["href"]
            if label and not href.startswith(("javascript:", "mailto:", "tel:")):
                self.links.append({"title": label[:120], "url": absolute_url(self.base_url, href)})
            self._current_link = None
        if tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "blockquote"}:
            self.text.append("\n")

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._in_title:
            self.title += data
            return
        if self._current_link is not None:
            self._current_link["text"] += data
        self.text.append(data)


def clean_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def absolute_url(base_url, href):
    if href.startswith("//"):
        return f"{urlparse(base_url).scheme}:{href}"
    if href.startswith(("http://", "https://")):
        return href
    parsed = urlparse(base_url)
    if href.startswith("/"):
        return f"{parsed.scheme}://{parsed.netloc}{href}"
    path = parsed.path.rsplit("/", 1)[0]
    return f"{parsed.scheme}://{parsed.netloc}{path}/{href}"


def fetch_url(url):
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*"})
    with urlopen(request, timeout=12) as response:
        content_type = response.headers.get("content-type", "")
        charset = response.headers.get_content_charset() or "utf-8"
        raw = response.read(2_000_000)
    return raw.decode(charset, errors="replace"), content_type, url


def readable_page(url):
    html, content_type, final_url = fetch_url(url)
    parser = ReadableHTMLParser(final_url)
    parser.feed(html)
    blocks = [clean_text(block) for block in "".join(parser.text).split("\n")]
    paragraphs = [block for block in blocks if is_readable_block(block)]
    text = clean_text(" ".join(paragraphs))
    links = dedupe_links(parser.links)
    return {
        "url": final_url,
        "title": clean_text(parser.title) or urlparse(final_url).netloc,
        "contentType": content_type,
        "excerpt": " ".join(paragraphs[:10])[:5000],
        "paragraphs": paragraphs[:32],
        "links": links[:24],
        "wordCount": len(text.split()),
    }


def is_readable_block(block):
    if len(block) < 55:
        return False
    if len(block.split()) < 9:
        return False
    lower = block.lower()
    nav_terms = ("skip to content", "privacy policy", "advertise", "cookie", "all rights reserved")
    if any(term in lower for term in nav_terms):
        return False
    if re.search(r"[a-z][A-Z][a-z]", block) and len(re.findall(r"[a-z][A-Z][a-z]", block)) > 4:
        return False
    link_like_tokens = sum(1 for token in block.split() if token.startswith(("http", "www.")))
    return link_like_tokens < 3


def dedupe_links(links):
    seen = set()
    out = []
    for link in links:
        key = link["url"].split("#", 1)[0]
        if key not in seen:
            seen.add(key)
            out.append(link)
    return out


def unwrap_search_link(link):
    parsed = urlparse(link["url"])
    params = parse_qs(parsed.query)
    if "uddg" in params:
        return {"title": link["title"], "url": unquote(params["uddg"][0])}
    return link


def search_web(query):
    search_url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    page = readable_page(search_url)
    results = []
    for link in page["links"]:
        result = unwrap_search_link(link)
        if "duckduckgo.com" not in urlparse(result["url"]).netloc:
            results.append(result)
        if len(results) == 8:
            break
    if not results:
        results = [{"title": "Open search results", "url": search_url}]
    return {"query": query, "results": results, "source": search_url}


def ask_ollama(model, prompt):
    body = json.dumps({
        "model": model, "prompt": prompt, "stream": False,
        "options": {"temperature": 0.7, "num_ctx": 8192},
    }).encode("utf-8")
    request = Request(OLLAMA_GENERATE_URL, data=body, method="POST",
                       headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return clean_text(payload.get("response", ""))


# ---------------------------------------------------------------- knowledge base (local files)
#
# Drop .txt / .md files into the  knowledge/  folder next to this script. kb_search retrieves
# the passages most relevant to a query, each tagged with its source filename, so a C0fi flow
# can answer grounded in YOUR documents. Retrieval is LEXICAL by default (keyword overlap,
# BM25-ish) — zero setup, no model needed. To switch to SEMANTIC retrieval (better when the
# question's wording differs from the document's), set USE_EMBEDDINGS = True above and pull an
# embedding model first:  ollama pull nomic-embed-text

STOPWORDS = set("the a an of to in on for and or is are was were be been it its this that with "
                "as at by from your you i we our my how what when where who why do does can".split())


def _stem(w):
    # crude, consistent plural/verb folding — need not be a real word, just applied to both
    # query and documents so "cost"/"costs", "bag"/"bags", "refund"/"refunds" collide.
    for suf in ("ies", "es", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[:-len(suf)] + ("y" if suf == "ies" else "")
    return w


def _tokenize(text):
    return [_stem(w) for w in re.findall(r"[a-z0-9']+", (text or "").lower())
            if w not in STOPWORDS and len(w) > 1]


def _kb_dir(folder=""):
    """Resolve a collection folder under knowledge/. Empty = the knowledge/ root itself.
    Only a single plain subfolder name is allowed — no slashes, no '..' — so a query can't
    escape the knowledge/ directory."""
    folder = (folder or "").strip().strip("/")
    if not folder or "/" in folder or "\\" in folder or ".." in folder or folder.startswith("."):
        return KNOWLEDGE_DIR
    return KNOWLEDGE_DIR / folder


def kb_collections():
    """Subfolders of knowledge/ that hold at least one .txt/.md file — i.e. named knowledge bases."""
    if not KNOWLEDGE_DIR.is_dir():
        return []
    out = []
    for d in sorted(KNOWLEDGE_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith(".") and any(
                p.suffix.lower() in (".txt", ".md") for p in d.iterdir() if p.is_file()):
            out.append(d.name)
    return out


def kb_files(folder=""):
    d = _kb_dir(folder)
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir()
                  if p.is_file() and p.suffix.lower() in (".txt", ".md") and not p.name.startswith("."))


def kb_chunks(folder=""):
    """Every file split into paragraph-ish chunks: [(filename, chunk_text), ...]."""
    chunks = []
    for p in kb_files(folder):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for block in re.split(r"\n\s*\n", text):
            block = block.strip()
            if len(block) >= 20:
                chunks.append((p.name, clean_text(block)))
    return chunks


def _embed(text):
    body = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode("utf-8")
    request = Request(OLLAMA_EMBED_URL, data=body, method="POST",
                       headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8")).get("embedding", [])


def _cosine(a, b):
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def kb_search(query, k=3, folder=""):
    """Return the top-k chunks most relevant to query, each as {file, score, text}.
    folder selects a named collection (subfolder of knowledge/); empty = knowledge/ root."""
    chunks = kb_chunks(folder)
    if not chunks:
        return []
    if USE_EMBEDDINGS:
        try:
            qv = _embed(query)
            scored = [(_cosine(qv, _embed(txt)), fn, txt) for fn, txt in chunks]
        except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError):
            scored = _lexical_scores(query, chunks)  # fall back if the embed model isn't available
    else:
        scored = _lexical_scores(query, chunks)
    scored.sort(key=lambda t: t[0], reverse=True)
    top = [{"file": fn, "score": round(sc, 4), "text": txt} for sc, fn, txt in scored[:max(1, int(k))] if sc > 0]
    return top


def _lexical_scores(query, chunks):
    """BM25-lite: reward query terms that are rare across the corpus and present in the chunk."""
    qterms = set(_tokenize(query))
    if not qterms:
        return [(0.0, fn, txt) for fn, txt in chunks]
    df = {}  # document frequency of each term across chunks
    tokenized = []
    for fn, txt in chunks:
        toks = _tokenize(txt); tokenized.append(toks)
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    n = len(chunks)
    out = []
    for (fn, txt), toks in zip(chunks, tokenized):
        tf = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        for t in qterms & set(toks):
            idf = math.log(1 + n / (1 + df.get(t, 0)))
            score += idf * (tf[t] / (tf[t] + 1.5))  # saturating term frequency
        out.append((score, fn, txt))
    return out


# ---------------------------------------------------------------- MCP surface

TOOLS = [
    {
        "name": "web_search",
        "description": "Search the web via DuckDuckGo. Returns up to 8 results as titles and URLs.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "read_page",
        "description": "Fetch a URL and return its readable text: title, paragraphs, and outbound links, with navigation junk stripped.",
        "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
    },
    {
        "name": "ask_llm",
        "description": "Send a prompt to the local Ollama model and return the completion.",
        "inputSchema": {
            "type": "object",
            "properties": {"prompt": {"type": "string"}, "model": {"type": "string", "description": f"default {DEFAULT_MODEL}"}},
            "required": ["prompt"],
        },
    },
    {
        "name": "kb_search",
        "description": "Search your local knowledge base (.txt/.md files) for passages relevant to a query. Returns the top matches, each tagged with its source filename. Use this to answer grounded in your own documents. Optionally pass 'folder' to search a named collection (a subfolder of knowledge/, e.g. 'coffee' or 'cofi-guide').",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "k": {"type": "number", "description": "how many passages to return (default 3)"},
                "folder": {"type": "string", "description": "named collection = subfolder of knowledge/ (blank = the knowledge/ root)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "kb_list",
        "description": "List the knowledge base. With no folder: names the available collections (subfolders) and any files in the knowledge/ root. With a folder: lists that collection's files.",
        "inputSchema": {"type": "object", "properties": {"folder": {"type": "string"}}},
    },
]


def run_tool(name, args):
    if name == "web_search":
        result = search_web(args["query"])
        lines = [f'Search results for "{result["query"]}":']
        for i, item in enumerate(result.get("results", []), 1):
            lines.append(f'{i}. {item.get("title", "(untitled)")}\n   {item.get("url", "")}')
        return "\n".join(lines)
    if name == "read_page":
        page = readable_page(args["url"])
        paragraphs = "\n\n".join(page.get("paragraphs", []))
        links = "\n".join(f'- {l.get("title", "")}: {l.get("url", "")}' for l in page.get("links", [])[:12])
        return f'PAGE: {page.get("title", "")} ({page.get("url", "")})\nWORDS: {page.get("wordCount", 0)}\n\n{paragraphs}\n\nLINKS:\n{links}'
    if name == "ask_llm":
        return ask_ollama(args.get("model") or DEFAULT_MODEL, args["prompt"])
    if name == "kb_search":
        folder = args.get("folder", "")
        hits = kb_search(args["query"], args.get("k", 3), folder)
        if not hits:
            files = [p.name for p in kb_files(folder)]
            if not files:
                where = f"knowledge/{folder}" if folder else "knowledge/"
                cols = kb_collections()
                hint = f" Available collections: {', '.join(cols)}." if cols else ""
                return (f"No documents found in {where} (next to c0fi_server.py). "
                        f"Add .txt/.md files there.{hint}")
            return f"No relevant passage found in {', '.join(files)} for: {args['query']}"
        return "\n\n".join(f"[from {h['file']}]\n{h['text']}" for h in hits)
    if name == "kb_list":
        folder = args.get("folder", "")
        if folder:
            files = kb_files(folder)
            if not files:
                return f"Collection '{folder}' is empty or missing."
            return f"Files in collection '{folder}':\n" + "\n".join(f"- {p.name}" for p in files)
        cols = kb_collections()
        root = kb_files()
        parts = []
        if cols:
            parts.append("Collections (pass as folder):\n" + "\n".join(f"- {c}" for c in cols))
        if root:
            parts.append("Files in knowledge/ root:\n" + "\n".join(f"- {p.name}" for p in root))
        return "\n\n".join(parts) or f"knowledge/ is empty or missing ({KNOWLEDGE_DIR}). Add .txt/.md files or subfolders."
    raise ValueError(f"unknown tool: {name}")


def handle_rpc(message):
    method = message.get("method", "")
    msg_id = message.get("id")
    params = message.get("params") or {}
    if msg_id is None:
        return None
    if method == "initialize":
        return _result(msg_id, {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO})
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments") or {}
        try:
            text = run_tool(name, args)
            return _result(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except Exception as exc:
            return _result(msg_id, {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True})
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"method not found: {method}"}}


def _result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


# ---------------------------------------------------------------- http plumbing

class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json({"ok": True})
        if parsed.path == "/api/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            if not query:
                return self._json({"ok": False, "error": "Missing q"}, 400)
            try:
                return self._json({"ok": True, "search": search_web(query)})
            except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError) as exc:
                return self._json({"ok": False, "error": str(exc)})
        if parsed.path == "/api/read":
            url = parse_qs(parsed.query).get("url", [""])[0]
            if not url:
                return self._json({"ok": False, "error": "Missing url"}, 400)
            try:
                return self._json({"ok": True, "page": readable_page(unquote(url))})
            except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError) as exc:
                return self._json({"ok": False, "error": str(exc)})
        if parsed.path == "/api/kb":
            q = parse_qs(parsed.query)
            query = q.get("q", [""])[0]
            folder = q.get("folder", [""])[0]
            if not query:
                return self._json({"ok": True, "collections": kb_collections(),
                                    "files": [p.name for p in kb_files(folder)]})
            try:
                k = int(q.get("k", ["3"])[0])
            except ValueError:
                k = 3
            try:
                return self._json({"ok": True, "hits": kb_search(query, k, folder)})
            except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError) as exc:
                return self._json({"ok": False, "error": str(exc)})
        if parsed.path == "/mcp":
            return self._json({"mcp": True, "transport": "streamable-http", "endpoint": "POST /mcp",
                                "server": SERVER_INFO, "tools": [t["name"] for t in TOOLS]})
        self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/mcp":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            message = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}, 400)
        try:
            response = handle_rpc(message)
        except Exception:
            response = {"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32603, "message": "internal error"}}
        if response is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._json(response)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("c0fi_server: " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        sys.exit(
            f"c0fi_server: port {port} is already in use ({exc}).\n"
            f"Don't fight the squatter — pick another port:  python3 c0fi_server.py {port + 5}\n"
            f"(then update the proxy URL / Tool Server node URL in C0fi to match)"
        )
    print(f"C0fi engine running at http://127.0.0.1:{port}  (search + read + MCP tools)", flush=True)
    print(f"  GET  /api/search?q=...   GET /api/read?url=...   POST /mcp", flush=True)
    httpd.serve_forever()
