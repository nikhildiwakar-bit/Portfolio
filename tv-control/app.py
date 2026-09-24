"""Claude se dono TVs control karne wala chhota web app."""
import json
import os
import threading
import time

import anthropic
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from tv import KEYS, TV

BASE = os.path.dirname(os.path.abspath(__file__))
UPLOADS = os.path.join(BASE, "uploads")
os.makedirs(UPLOADS, exist_ok=True)

with open(os.path.join(BASE, "tvs.json"), encoding="utf-8") as f:
    CONFIG = json.load(f)
TVS = {k: TV(k, v["name"], v["ip"], v.get("port", 5555)) for k, v in CONFIG["tvs"].items()}

client = anthropic.Anthropic()  # ANTHROPIC_API_KEY environment variable se key leta hai
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")

tv_enum = {"type": "string", "enum": list(TVS)}
TOOLS = [
    {"name": "tv_status", "description": "Check whether a TV is connected, awake, and which app is on screen.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum}, "required": ["tv"]}},
    {"name": "open_url", "description": "Open a website, meeting link (Zoom/Meet/Teams), YouTube link or online PDF on a TV.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "url": {"type": "string"}}, "required": ["tv", "url"]}},
    {"name": "youtube", "description": "Play a YouTube link or search YouTube on a TV.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "query_or_url": {"type": "string"}}, "required": ["tv", "query_or_url"]}},
    {"name": "show_file", "description": "Copy an uploaded file (PDF, PPT, image, video) to a TV and open it. Use a filename from the uploaded list.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "filename": {"type": "string"}}, "required": ["tv", "filename"]}},
    {"name": "list_apps", "description": "List apps installed on a TV (package names).",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum}, "required": ["tv"]}},
    {"name": "open_app", "description": "Launch an installed app by package name.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "package": {"type": "string"}}, "required": ["tv", "package"]}},
    {"name": "press_key", "description": "Press a remote-control key: " + ", ".join(KEYS),
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "key": {"type": "string", "enum": list(KEYS)}}, "required": ["tv", "key"]}},
    {"name": "set_volume", "description": "Set volume as a percentage 0-100.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum, "percent": {"type": "integer"}}, "required": ["tv", "percent"]}},
    {"name": "restart_tv", "description": "Reboot a TV. Use only if the user asks, or the TV is stuck and other fixes failed.",
     "input_schema": {"type": "object", "properties": {"tv": tv_enum}, "required": ["tv"]}},
]


def run_tool(name, args):
    tv = TVS[args["tv"]]
    if not tv.ensure():
        return f"ERROR: {tv.name} ({tv.serial}) se connect nahi ho pa raha. TV on hai aur same Wi-Fi par hai?"
    if name == "tv_status":
        return tv.status()
    if name == "open_url":
        return tv.open_url(args["url"])
    if name == "youtube":
        return tv.youtube(args["query_or_url"])
    if name == "show_file":
        path = os.path.join(UPLOADS, secure_filename(args["filename"]))
        return tv.show_file(path) if os.path.exists(path) else "ERROR: file not found"
    if name == "list_apps":
        return tv.list_apps()
    if name == "open_app":
        return tv.open_app(args["package"])
    if name == "press_key":
        return tv.key(args["key"])
    if name == "set_volume":
        return tv.set_volume(args["percent"])
    if name == "restart_tv":
        return tv.restart()
    return "ERROR: unknown tool"


def system_prompt():
    tvs = "\n".join(f"- {k}: {t.name}" for k, t in TVS.items())
    files = ", ".join(sorted(os.listdir(UPLOADS))) or "(none)"
    return (
        "You control office display screens for the user through the tools. TVs:\n"
        f"{tvs}\nUploaded files available for show_file: {files}\n"
        "If the user doesn't name a TV and there is more than one, ask which one (or 'dono' = both). "
        "Reply briefly in the user's language (Hindi/Hinglish/English). "
        "If an action fails, say plainly what went wrong and what the user can check."
    )


history = []
lock = threading.Lock()


def chat(user_text):
    history.append({"role": "user", "content": user_text})
    for _ in range(10):
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=16000, system=system_prompt(), tools=TOOLS,
            messages=history, thinking={"type": "adaptive"},
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        history.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "refusal":
            return "Yeh request poori nahi ho saki."
        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                try:
                    out = run_tool(b.name, b.input)
                except Exception as e:  # keep the loop alive on any TV-side error
                    out = f"ERROR: {e}"
                results.append({"type": "tool_result", "tool_use_id": b.id,
                                "content": out[:4000] or "ok", "is_error": out.startswith("ERROR")})
        history.append({"role": "user", "content": results})
    return "Bahut saare steps ho gaye, dobara try karein."


def watchdog():
    """Reconnect dropped TVs and keep them awake."""
    while True:
        for tv in TVS.values():
            if tv.ensure() and CONFIG.get("keep_awake", True):
                tv.keep_awake()
        time.sleep(CONFIG.get("watchdog_seconds", 60))


app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html", tvs=TVS)


@app.post("/api/chat")
def api_chat():
    text = (request.json or {}).get("message", "").strip()
    if not text:
        return jsonify(reply="")
    with lock:
        try:
            return jsonify(reply=chat(text))
        except anthropic.AuthenticationError:
            history.clear()
            return jsonify(reply="API key galat hai ya set nahi hai."), 500
        except anthropic.APIError as e:
            history.clear()
            return jsonify(reply=f"Claude API error: {e}"), 500


@app.post("/api/reset")
def api_reset():
    with lock:
        history.clear()
    return jsonify(ok=True)


@app.post("/api/upload")
def api_upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="no file"), 400
    name = secure_filename(f.filename)
    f.save(os.path.join(UPLOADS, name))
    return jsonify(filename=name)


@app.get("/api/status")
def api_status():
    return jsonify({k: t.is_connected() for k, t in TVS.items()})


if __name__ == "__main__":
    threading.Thread(target=watchdog, daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
