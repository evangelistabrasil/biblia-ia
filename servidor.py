#!/usr/bin/env python3
"""Servidor local que entrega o app.

  python servidor.py                 # notebook: celular abre pelo Wi-Fi
  python servidor.py 8080 --local    # Termux no celular: abre em http://localhost:8080
"""
import argparse
import functools
import http.server
import os
import socket


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript",
                      ".wasm": "application/wasm", ".json": "application/json",
                      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
                      ".png": "image/png", ".onnx": "application/octet-stream",
                      ".sh": "text/plain; charset=utf-8", ".zip": "application/zip"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("DEBUG") or not args or str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)


def ips_locais():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.0.1", 80)); ips.add(s.getsockname()[0]); s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("porta", nargs="?", type=int, default=8000)
    ap.add_argument("--pasta", default="web")
    ap.add_argument("--local", action="store_true", help="só neste aparelho (localhost)")
    a = ap.parse_args()

    if a.local:
        print(f"\n  Abra no Chrome deste celular:  http://localhost:{a.porta}\n")
        print("  Lá, na aba Mais, toque em 'Baixar a Bíblia completa'.")
        print("  Depois de baixado, o app funciona mesmo com o Termux fechado.\n  Para parar: Ctrl+C\n")
        host = "127.0.0.1"
    else:
        ips = ips_locais()
        ip = ips[0] if ips else "SEU-IP"
        url = f"http://{ip}:{a.porta}"
        print("\n  No celular (mesma rede Wi-Fi), abra no Chrome:\n")
        print(f"      {url}\n")
        try:
            import qrcode
            qr = qrcode.QRCode(border=1); qr.add_data(url); qr.make()
            qr.print_ascii(invert=True)
            print("  (ou aponte a câmera do celular para o QR code acima)\n")
        except ImportError:
            pass
        if len(ips) > 1:
            print("  Se não abrir, tente: " + ", ".join(f"http://{i}:{a.porta}" for i in ips[1:]))
        if os.path.exists(os.path.join(a.pasta, "app.zip")):
            print("  Para GUARDAR o app no celular e usar sem internet, rode no Termux do celular:\n")
            print(f"      curl -O {url}/termux.sh && bash termux.sh {ip}:{a.porta}\n")
        print("  Para parar o servidor: Ctrl+C\n")
        host = "0.0.0.0"

    srv = http.server.ThreadingHTTPServer((host, a.porta), functools.partial(Handler, directory=a.pasta))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  Servidor parado.")
