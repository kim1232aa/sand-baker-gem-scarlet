#!/usr/bin/env python3
"""TCP 127.0.0.1:port → Tor unix SOCKS. HTTP probes are closed (no HTML)."""
from __future__ import annotations

import os
import select
import socket
import threading
from pathlib import Path


def splice(a: socket.socket, b: socket.socket) -> None:
    pair = [a, b]
    try:
        while True:
            r, _, _ = select.select(pair, [], [], 120)
            if not r:
                break
            for s in r:
                other = b if s is a else a
                data = s.recv(65536)
                if not data:
                    return
                other.sendall(data)
    except OSError:
        return
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def handle(client: socket.socket, unix_path: Path) -> None:
    try:
        client.settimeout(8)
        first = client.recv(1, socket.MSG_PEEK)
        if not first or first[0] != 5:
            return
        if not unix_path.exists():
            return
        up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        up.settimeout(8)
        up.connect(str(unix_path))
        client.settimeout(None)
        up.settimeout(None)
        splice(client, up)
    except OSError:
        try:
            client.close()
        except OSError:
            pass


def listen_one(host: str, port: int, unix_path: Path) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(128)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c, unix_path), daemon=True).start()


def start(plan: list[dict], root: Path) -> None:
    for slot in plan:
        path = root / slot["id"] / "socks.sock"
        t = threading.Thread(
            target=listen_one,
            args=("127.0.0.1", int(slot["port"]), path),
            daemon=True,
            name=f"gate-{slot['id']}",
        )
        t.start()
