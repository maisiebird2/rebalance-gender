"""
Simple disk-based JSON cache so we don't re-hit APIs on every run.
Cache files live in .cache/ relative to the project root.
"""
import json
import hashlib
from pathlib import Path

CACHE_DIR = Path(".cache")


def _key_to_path(namespace: str, key: str) -> Path:
    safe = hashlib.md5(key.encode()).hexdigest()
    return CACHE_DIR / namespace / f"{safe}.json"


def get(namespace: str, key: str):
    """Return cached value or None."""
    path = _key_to_path(namespace, key)
    if path.exists():
        return json.loads(path.read_text())
    return None


def set(namespace: str, key: str, value) -> None:
    """Write value to cache."""
    path = _key_to_path(namespace, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def cached(namespace: str, key: str):
    """Decorator-style context helper — use get/set directly instead."""
    raise NotImplementedError("Use cache.get / cache.set directly.")
