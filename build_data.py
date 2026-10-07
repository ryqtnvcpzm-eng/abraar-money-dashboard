#!/usr/bin/env python3
"""Launcher for build_data.mjs (encryption uses WebCrypto-identical
PBKDF2-SHA256 + AES-256-GCM, which Node >= 19 provides natively).
Usage: python3 build_data.py   —  requires Node on PATH."""
import shutil, subprocess, sys, os
here = os.path.dirname(os.path.abspath(__file__))
node = shutil.which("node")
if not node:
    sys.exit("Node >= 19 is required (the browser decrypts with WebCrypto; "
             "Node implements the identical scheme). Install Node and retry.")
sys.exit(subprocess.call([node, os.path.join(here, "build_data.mjs")]))
