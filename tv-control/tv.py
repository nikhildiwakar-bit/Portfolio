"""ADB-over-Wi-Fi control for Android TVs / panels."""
import os
import shlex
import subprocess
import urllib.parse

KEYS = {
    "home": "KEYCODE_HOME", "back": "KEYCODE_BACK", "up": "KEYCODE_DPAD_UP",
    "down": "KEYCODE_DPAD_DOWN", "left": "KEYCODE_DPAD_LEFT", "right": "KEYCODE_DPAD_RIGHT",
    "ok": "KEYCODE_DPAD_CENTER", "play_pause": "KEYCODE_MEDIA_PLAY_PAUSE",
    "next": "KEYCODE_MEDIA_NEXT", "previous": "KEYCODE_MEDIA_PREVIOUS",
    "volume_up": "KEYCODE_VOLUME_UP", "volume_down": "KEYCODE_VOLUME_DOWN",
    "mute": "KEYCODE_VOLUME_MUTE", "wake": "KEYCODE_WAKEUP", "sleep": "KEYCODE_SLEEP",
    "page_down": "KEYCODE_PAGE_DOWN", "page_up": "KEYCODE_PAGE_UP",
}

MIME = {
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg",
}


class TV:
    def __init__(self, key, name, ip, port=5555):
        self.key, self.name, self.serial = key, name, f"{ip}:{port}"

    def _adb(self, *args, timeout=20):
        try:
            r = subprocess.run(["adb", "-s", self.serial, *args],
                               capture_output=True, text=True, timeout=timeout)
            return (r.stdout + r.stderr).strip()
        except subprocess.TimeoutExpired:
            return "ERROR: TV ne jawab nahi diya (timeout)"
        except FileNotFoundError:
            return "ERROR: adb install nahi hai (README dekhein)"

    def shell(self, cmd, timeout=20):
        return self._adb("shell", cmd, timeout=timeout)

    def connect(self):
        try:
            r = subprocess.run(["adb", "connect", self.serial],
                               capture_output=True, text=True, timeout=10)
            return r.stdout.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"ERROR: {e}"

    def is_connected(self):
        try:
            r = subprocess.run(["adb", "-s", self.serial, "get-state"],
                               capture_output=True, text=True, timeout=5)
            return r.stdout.strip() == "device"
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False

    def ensure(self):
        if not self.is_connected():
            self.connect()
        return self.is_connected()

    # ---- actions ----
    def wake(self):
        return self.shell(f"input keyevent {KEYS['wake']}")

    def open_url(self, url):
        self.wake()
        return self.shell("am start -a android.intent.action.VIEW -d " + shlex.quote(url))

    def youtube(self, query_or_url):
        if query_or_url.startswith("http"):
            url = query_or_url
        else:
            url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query_or_url)
        return self.open_url(url)

    def show_file(self, local_path):
        name = os.path.basename(local_path).replace(" ", "_")
        remote = f"/sdcard/Download/{name}"
        out = self._adb("push", local_path, remote, timeout=300)
        if "error" in out.lower():
            return out
        mime = MIME.get(os.path.splitext(name)[1].lower(), "*/*")
        self.wake()
        return self.shell("am start -a android.intent.action.VIEW -t " + shlex.quote(mime)
                          + " -d " + shlex.quote("file://" + remote))

    def list_apps(self):
        return self.shell("pm list packages -3").replace("package:", "")

    def open_app(self, package):
        self.wake()
        return self.shell("monkey -p " + shlex.quote(package)
                          + " -c android.intent.category.LAUNCHER 1")

    def key(self, name):
        code = KEYS.get(name)
        if not code:
            return f"ERROR: unknown key {name}"
        return self.shell(f"input keyevent {code}")

    def set_volume(self, level):
        level = max(0, min(int(level), 100))
        # Android media volume is 0..max (usually 15); scale from percent.
        out = self.shell("cmd media_session volume --stream 3 --get")
        mx = 15
        if "range [" in out:
            try:
                mx = int(out.split("range [")[1].split("..")[1].split("]")[0])
            except (IndexError, ValueError):
                pass
        v = round(level * mx / 100)
        out = self.shell(f"cmd media_session volume --stream 3 --set {v}")
        if "Error" in out or "not found" in out:
            out = self.shell(f"media volume --stream 3 --set {v}")
        return out or f"volume set to {v}/{mx}"

    def status(self):
        power = self.shell("dumpsys power | grep -m1 mWakefulness=")
        focus = self.shell("dumpsys window | grep -m1 mCurrentFocus")
        return f"connected={self.is_connected()} {power} {focus}"

    def keep_awake(self):
        self.shell("settings put system screen_off_timeout 2147483647")
        self.shell("svc power stayon true")

    def restart(self):
        return self._adb("reboot", timeout=15) or "restart command sent"
