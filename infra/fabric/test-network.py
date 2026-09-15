#!/usr/bin/env python3
"""Compatibility entrypoint for the disposable order-workflow example network."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parents[2] / "examples/order-workflow/test-network.py"), run_name="__main__")
