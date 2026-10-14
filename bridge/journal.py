"""A small local parent journal. No audio, headers or provider error bodies."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import inspect
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid

log = logging.getLogger("uvicorn.error")
current = ContextVar("parent_turn", default=None)
_secrets: tuple[str, ...] = ()


def configure_secrets(*values):
    global _secrets
    _secrets = tuple(value for value in values if value)


def clean(value, limit=1800):
    text = str(value)
    for secret in sorted(_secrets, key=len, reverse=True):
        text = text.replace(secret, "[clé masquée]")
    text = re.sub(r"(?:sk-or-v1-|sk-|github_pat_|ghp_)[A-Za-z0-9_-]{12,}", "[clé masquée]", text)
    return text[:limit]


class Journal:
    def __init__(self, path, max_turns=1000, retention_days=30):
        self.path = Path(path)
        self.max_turns = max(1, min(int(max_turns), 10000))
        self.retention_days = max(1, min(int(retention_days), 365))
        self.lock = threading.Lock()
        self.epoch = 0
        self.last_save_failed = False

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            os.chmod(self.path, 0o600)
            connection.execute("PRAGMA secure_delete=ON")
            connection.execute("CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, session TEXT, started REAL, payload TEXT)")
            with connection:
                yield connection
        finally:
            connection.close()

    def prune(self, connection):
        connection.execute("DELETE FROM turns WHERE started < ?", (time.time() - self.retention_days * 86400,))
        connection.execute("DELETE FROM turns WHERE id NOT IN (SELECT id FROM turns ORDER BY started DESC, id DESC LIMIT ?)", (self.max_turns,))

    def add(self, event, epoch):
        with self.lock, self.connection() as connection:
            if epoch != self.epoch:
                return
            connection.execute("INSERT INTO turns VALUES (?, ?, ?, ?)", (event['id'], event['session_id'], event['started'], json.dumps(event, ensure_ascii=False)))
            self.prune(connection)
            self.last_save_failed = False

    def read(self):
        with self.lock, self.connection() as connection:
            self.prune(connection)
            rows = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM turns ORDER BY started DESC, id DESC LIMIT 200")]
            count, failed, average = connection.execute("SELECT COUNT(*), SUM(json_extract(payload, '$.status') != 'ok'), AVG(json_extract(payload, '$.total_ms')) FROM turns").fetchone()
        return {"turns": rows, "summary": {"turns": count, "failed": failed or 0, "average_ms": round(average or 0)}, "retention_days": self.retention_days, "max_turns": self.max_turns, "shown_limit": 200, "last_save_failed": self.last_save_failed}

    def delete(self, session=None):
        with self.lock, self.connection() as connection:
            if session is None:
                connection.execute("DELETE FROM turns")
            else:
                connection.execute("DELETE FROM turns WHERE session = ?", (session,))
            self.epoch += 1  # A turn already in progress cannot bring deleted data back.


store = Journal(os.getenv("PARENTS_DB_PATH", "local/parents.sqlite3"), os.getenv("PARENTS_MAX_TURNS", "1000"), os.getenv("PARENTS_RETENTION_DAYS", "30"))


@contextmanager
def phase(name):
    event = current.get()
    start = time.monotonic()
    if event is not None:
        event['stage'] = name
    try:
        yield
    finally:
        if event is not None:
            event['timings_ms'][name] = event['timings_ms'].get(name, 0) + round((time.monotonic() - start) * 1000)


def stage(name):
    if (event := current.get()) is not None:
        event['stage'] = name


def message(text):
    if (event := current.get()) is not None:
        event['message'] = clean(text)


def reply(text, cards, tools):
    if (event := current.get()) is not None:
        event['reply'] = clean(text)
        # These have already passed the bridge's bounded shape validation.
        event['cards'] = safe_tree(cards[:8])
        event['tools'] = safe_tree(tools[:8])


def safe_tree(value):
    if isinstance(value, dict):
        return {clean(key, 40): safe_tree(item) for key, item in list(value.items())[:10]}
    if isinstance(value, list):
        return [safe_tree(item) for item in value[:40]]
    if isinstance(value, str):
        return clean(value, 240)
    return value if isinstance(value, (int, float, bool)) or value is None else clean(value, 240)


def trace(kind):
    def decorate(function):
        signature = inspect.signature(function, eval_str=True)

        @wraps(function)
        async def wrapped(*args, **kwargs):
            bound = signature.bind(*args, **kwargs).arguments
            session = bound.get('session_id') or getattr(bound.get('body'), 'session_id', '')
            try:
                session = str(uuid.UUID(session))
            except (ValueError, TypeError, AttributeError):
                return await function(*args, **kwargs)
            event = {"id": str(uuid.uuid4()), "session_id": session, "started": time.time(), "kind": kind, "status": "ok", "stage": "validation", "http_status": 200, "message": "", "reply": "", "cards": [], "tools": [], "timings_ms": {}}
            epoch = store.epoch
            token = current.set(event)
            start = time.monotonic()
            try:
                if kind == 'text':
                    message(getattr(bound.get('body'), 'text', ''))
                return await function(*args, **kwargs)
            except BaseException as error:
                event['status'] = 'cancelled' if isinstance(error, asyncio.CancelledError) else 'error'
                event['http_status'] = getattr(error, 'status_code', 499 if event['status'] == 'cancelled' else 500)
                raise
            finally:
                event['total_ms'] = round((time.monotonic() - start) * 1000)
                current.reset(token)
                try:
                    await asyncio.to_thread(store.add, event, epoch)
                except Exception:
                    store.last_save_failed = True
                    log.warning("Parent journal could not save a turn")

        wrapped.__signature__ = signature
        return wrapped
    return decorate
