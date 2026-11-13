#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import webbrowser


class Utf8Handler(SimpleHTTPRequestHandler):
    # Say the files are UTF-8, so symbols like ▾, ★ and å show correctly in every browser
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    }


def main():
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Utf8Handler)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Lunch Wheel is running at {url}")
    try:
        if not webbrowser.open(url):
            print("Your browser did not open automatically. Copy the address above into your browser.")
    except Exception as error:
        print(f"Could not open your browser automatically: {error}")
        print(f"Open this address manually: {url}")

    print("Keep this window open while using the page. Press Ctrl+C to stop the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLunch Wheel server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
