"""PC par Office TV app ka demo: wahi phone wala page, par links/files PC par khulte hain.

Chalane ke liye:  python demo.py   (sirf Python chahiye, koi extra install nahi)
"""
import json
import os
import random
import re
import socket
import subprocess
import sys
import webbrowser
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

PORT = 8080
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "..", "app", "src", "main", "assets", "index.html")
UPLOADS = os.path.join(HERE, "uploads")
os.makedirs(UPLOADS, exist_ok=True)
PIN = f"{random.randint(0, 9999):04d}"

# On the TV this list is the real installed apps; on the PC we offer web apps.
APPS = {
    "Gmail": "https://mail.google.com", "Google Drive": "https://drive.google.com",
    "Google Sheets": "https://docs.google.com/spreadsheets", "Google Meet": "https://meet.google.com",
    "Google Chat": "https://chat.google.com", "YouTube": "https://www.youtube.com",
}
state = {"keepAwake": True, "volume": 5}


def ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def res(ok, msg):
    return {"ok": ok, "msg": msg}


def open_url(url):
    url = (url or "").strip()
    if not url:
        return res(False, "Link khaali hai.")
    if not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I):
        url = "https://" + url
    webbrowser.open(url)
    print("  → khola:", url)
    return res(True, "Link PC par khul gaya (TV par bhi aise hi khulega).")


def open_file(path):
    print("  → file khol rahe:", path)
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # Windows only
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except OSError as e:
        return res(False, f"PC par file nahi khul payi: {e}")
    return res(True, os.path.basename(path) + " PC par khul gayi (TV par bhi aise hi khulegi).")


def safe(name):
    n = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(name or ""))
    return ("file" + n if not n or n.startswith(".") else n)[-120:]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        if self.headers.get("X-Pin") == PIN:
            return True
        self.send(401, res(False, "PIN galat hai."))
        return False

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            with open(PAGE, encoding="utf-8") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if not path.startswith("/api/") or not self.authed():
            return None if path.startswith("/api/") else self.send(404, "Not found", "text/plain")
        if path == "/api/status":
            return self.send(200, {"name": "PC Demo (TV jaisa)", "android": "demo", "accessibility": True,
                                   "needsPermission": False, "keepAwake": state["keepAwake"],
                                   "volume": state["volume"], "maxVolume": 15})
        if path == "/api/apps":
            return self.send(200, [{"label": k, "pkg": k} for k in APPS])
        if path == "/api/files":
            files = sorted(os.listdir(UPLOADS), key=lambda n: -os.path.getmtime(os.path.join(UPLOADS, n)))
            return self.send(200, [{"name": n, "size": os.path.getsize(os.path.join(UPLOADS, n))} for n in files])
        return self.send(404, res(False, "Unknown"))

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self.authed():
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path == "/api/upload":
            msg = BytesParser(policy=default).parsebytes(
                b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
            for part in msg.iter_parts():
                if part.get_param("name", header="content-disposition") == "file":
                    dest = os.path.join(UPLOADS, safe(part.get_filename()))
                    with open(dest, "wb") as f:
                        f.write(part.get_payload(decode=True))
                    r = open_file(dest)
                    r["name"] = os.path.basename(dest)
                    return self.send(200, r)
            return self.send(200, res(False, "File nahi mili."))

        body = json.loads(raw or b"{}")
        if path == "/api/open":
            r = open_url(body.get("url"))
        elif path == "/api/youtube":
            q = (body.get("q") or "").strip()
            r = open_url(q if q.startswith("http") or "youtu" in q
                         else "https://www.youtube.com/results?search_query=" + quote(q))
        elif path == "/api/app":
            r = open_url(APPS.get(body.get("pkg"), ""))
        elif path == "/api/file/open":
            p = os.path.join(UPLOADS, safe(body.get("name")))
            r = open_file(p) if os.path.isfile(p) else res(False, "File nahi mili.")
        elif path == "/api/file/delete":
            p = os.path.join(UPLOADS, safe(body.get("name")))
            ok = os.path.isfile(p)
            if ok:
                os.remove(p)
            r = res(ok, "File hata di." if ok else "File nahi mili.")
        elif path == "/api/key":
            print("  → remote button:", body.get("key"))
            r = res(True, f"'{body.get('key')}' dabaya (TV par yeh button chalega; PC demo mein sirf dikhata hai).")
        elif path == "/api/volume":
            state["volume"] = round(int(body.get("percent", 30)) * 15 / 100)
            r = res(True, f"Volume {body.get('percent')}% (TV par sach mein badlega).")
        elif path == "/api/awake":
            state["keepAwake"] = bool(body.get("on"))
            r = res(True, "Screen hamesha on rahegi." if state["keepAwake"] else "Screen normal time par band hogi.")
        else:
            r = res(False, "Unknown")
        self.send(200, r)


if __name__ == "__main__":
    addr = ip()
    print("=" * 60)
    print(" Office TV — PC DEMO chal raha hai")
    print(f" Is PC par kholein:   http://localhost:{PORT}/?pin={PIN}")
    print(f" Phone par kholein:   http://{addr}:{PORT}/?pin={PIN}  (same Wi-Fi)")
    print(f" PIN: {PIN}      Band karne ke liye: Ctrl+C")
    print("=" * 60)
    webbrowser.open(f"http://localhost:{PORT}/?pin={PIN}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
