import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import journal


@pytest.fixture(autouse=True)
def isolated_parent_journal(tmp_path, monkeypatch):
    monkeypatch.setattr(journal, "store", journal.Journal(tmp_path / "parents.sqlite3"))
    monkeypatch.setattr(journal, "_secrets", ())
