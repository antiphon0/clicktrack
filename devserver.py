"""Dev server for web/ that refuses to let the browser cache anything.

python -m http.server serves Last-Modified and lets the browser cache freely. index.html
has a fixed URL, so a plain reload can serve a stale index.html which then pulls stale
game.js/renderer.js from cache. Mixed old JS against new HTML throws on elements that no
longer exist and kills init(), leaving a blank note track that looks like a code bug.

The ?v= cache busters in index.html cannot fix that on their own, because they live inside
the very file that went stale. No-store headers do.
"""
import http.server
import socketserver

PORT = 8080
DIRECTORY = "web"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet; the game loop makes this noisy otherwise


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True  # so a restart right after a kill does not hit TIME_WAIT


if __name__ == "__main__":
    with ReusableServer(("", PORT), NoCacheHandler) as httpd:
        print(f"Serving {DIRECTORY}/ at http://localhost:{PORT} (no-store)")
        httpd.serve_forever()
