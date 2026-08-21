#!/usr/bin/env python3
"""Dev server for dotdot: python stdlib static server with revalidation.

Differs from `python3 -m http.server` in three response headers:
`Cache-Control: no-cache`, so the browser revalidates modules on each load
(304s keep it fast) and edits are never masked by heuristic caching; plus
COOP `same-origin` and COEP `require-corp`, whose cross-origin isolation
lets the k-mer engine fan matching across CPU cores via SharedArrayBuffer.

Usage: python3 scripts/serve.py [port]   (default 8420, binds 127.0.0.1)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        # Cross-origin isolation unlocks SharedArrayBuffer, which the k-mer
        # engine uses to fan matching out across CPU cores. The app's own
        # assets are same-origin, and its UCSC reads are explicit CORS
        # requests (js/io/ranged.js), which require-corp already permits.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8420
    handler = partial(NoCacheHandler, directory='.')
    with ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'dotdot dev server: http://127.0.0.1:{port}/')
        httpd.serve_forever()
