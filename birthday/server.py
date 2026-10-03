#!/usr/bin/env python3
"""Serves the birthday page and /api/birthdays (reads staff from Nucleus).

The Nucleus key stays here on the server (read from .env) and never goes to the browser.
Run:  python3 server.py      then open http://localhost:8000
No NUCLEUS_URL set -> demo mode using staff.json.
"""
import json, os, sys, urllib.request, urllib.parse
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

def load_env(path=os.path.join(HERE, '.env')):
    if os.path.exists(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"\''))

load_env()
G = lambda k, d='': os.environ.get(k, d)

URL        = G('NUCLEUS_URL')             # staff API endpoint
KEY        = G('NUCLEUS_KEY')             # API key / token
AUTH_HDR   = G('NUCLEUS_AUTH_HEADER', 'Authorization')
AUTH_PFX   = G('NUCLEUS_AUTH_PREFIX', 'Bearer ')   # use empty for a raw key header
LIST_PATH  = G('NUCLEUS_LIST_PATH')       # e.g. "data.staff" if the array is nested
F_NAME     = G('FIELD_NAME', 'name')
F_DOB      = G('FIELD_DOB', 'dob')
F_ROLE     = G('FIELD_ROLE', 'designation')
F_PHOTO    = G('FIELD_PHOTO', 'photo')
PHOTO_BASE = G('PHOTO_BASE')              # prefix if photo is a relative path
PHOTO_AUTH = G('PHOTO_NEEDS_KEY') == '1'  # fetch photos through this server with the key
DOB_FMT    = G('DOB_FORMAT', '%Y-%m-%d')  # e.g. %d-%m-%Y

def dig(obj, path):
    for part in filter(None, path.split('.')):
        obj = obj[part]
    return obj

def nucleus_request(url):
    req = urllib.request.Request(url)
    if KEY:
        req.add_header(AUTH_HDR, AUTH_PFX + KEY)
    return urllib.request.urlopen(req, timeout=20)

def fetch_staff():
    if not URL:
        return json.load(open(os.path.join(HERE, 'staff.json'), encoding='utf-8'))
    with nucleus_request(URL) as r:
        return dig(json.load(r), LIST_PATH)

def month_day(raw):
    from datetime import datetime
    raw = str(raw or '').strip()
    for fmt in (DOB_FMT, '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
        for text in (raw, raw[:10], raw.split('T')[0].split(' ')[0]):
            try:
                d = datetime.strptime(text, fmt)
                return '%02d-%02d' % (d.month, d.day)
            except ValueError:
                pass
    return None

def photo_url(p):
    ph = p.get(F_PHOTO) or ''
    if not ph:
        return ''
    if not ph.startswith(('http://', 'https://', 'data:')):
        ph = PHOTO_BASE.rstrip('/') + '/' + ph.lstrip('/')
    if PHOTO_AUTH and ph.startswith('http'):
        return '/api/photo?u=' + urllib.parse.quote(ph, safe='')
    return ph

def todays(md):
    out = []
    for p in fetch_staff():
        if month_day(p.get(F_DOB)) == md:
            out.append({'name': p.get(F_NAME, ''), 'designation': p.get(F_ROLE, '') or '', 'photo': photo_url(p)})
    return out

class H(SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/api/birthdays':
            md = (q.get('date') or [''])[0]
            if len(md) != 5:
                t = date.today(); md = '%02d-%02d' % (t.month, t.day)
            try:
                return self._json(200, todays(md))
            except Exception as e:
                sys.stderr.write('Nucleus error: %r\n' % e)
                return self._json(502, {'error': 'Could not read staff from Nucleus', 'detail': str(e)})
        if u.path == '/api/photo' and PHOTO_AUTH:
            target = (q.get('u') or [''])[0]
            if PHOTO_BASE and not target.startswith(PHOTO_BASE.rstrip('/')) and not (URL and urllib.parse.urlparse(target).netloc == urllib.parse.urlparse(URL).netloc):
                return self._json(403, {'error': 'host not allowed'})
            try:
                with nucleus_request(target) as r:
                    data = r.read()
                    self.send_response(200)
                    self.send_header('Content-Type', r.headers.get('Content-Type', 'image/jpeg'))
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers(); self.wfile.write(data)
                return
            except Exception as e:
                return self._json(502, {'error': str(e)})
        if u.path in ('/server.py', '/.env') or u.path.startswith('/.'):
            return self._json(404, {'error': 'not found'})
        return super().do_GET()

if __name__ == '__main__':
    port = int(G('PORT', '8000'))
    print('Birthday page: http://localhost:%d   (%s)' % (port, 'Nucleus: ' + URL if URL else 'demo mode, staff.json'))
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
