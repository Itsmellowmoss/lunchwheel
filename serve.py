#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import webbrowser


def main():
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer(("127.0.0.1", 0), SimpleHTTPRequestHandler)
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
