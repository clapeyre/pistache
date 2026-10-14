import asyncio
import json
import time
import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as bridge
import journal


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(bridge, "AUTH_MODE", "network")
    bridge._sessions.clear()
    bridge._sessions_lock = asyncio.Lock()
    bridge._turn_slots = asyncio.Semaphore(2)
    bridge._whisper_lock = asyncio.Lock()
    with TestClient(bridge.app, base_url="https://testserver") as client:
        yield client


def post(client, session=None, text="Explique-moi la lune"):
    return client.post("/api/text-turn", headers={"Origin": "https://testserver"}, json={"text": text, "session_id": session or str(uuid.uuid4())})


def event(session=None, age=0):
    return {"id": str(uuid.uuid4()), "session_id": session or str(uuid.uuid4()), "started": time.time()-age, "status": "ok", "total_ms": 12, "message": "Une phrase synthétique"}


def test_local_journal_survives_reopen_and_prunes(tmp_path):
    path = tmp_path / "journal.sqlite3"
    store = journal.Journal(path, max_turns=2, retention_days=1)
    store.add(event(age=90000), store.epoch)
    for _ in range(3):
        store.add(event(), store.epoch)
    reopened = journal.Journal(path, max_turns=2, retention_days=1)
    assert reopened.read()["summary"]["turns"] == 2
    assert all(row['started'] > time.time()-86400 for row in reopened.read()['turns'])
    reopened.delete()
    assert journal.Journal(path).read()['turns'] == []


def test_session_deletion_keeps_other_sessions_and_blocks_inflight():
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    epoch = journal.store.epoch
    journal.store.add(event(first), epoch)
    journal.store.add(event(second), epoch)
    journal.store.delete(first)
    journal.store.add(event(first), epoch)
    assert [row['session_id'] for row in journal.store.read()['turns']] == [second]


def test_text_turn_journal_tools_no_cache_and_delete(client, monkeypatch):
    async def answer(*_):
        return "Voici lune", [{"type": "word", "word": "lune", "letters": list("lune")}], [{"name": "show_word", "arguments": "lune"}]
    monkeypatch.setattr(bridge, "_pi_reply", answer)
    session = str(uuid.uuid4())
    assert post(client, session).status_code == 200
    response = client.get('/api/parents/activity')
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    assert data['summary']['turns'] == 1
    turn = data['turns'][0]
    assert turn['message'] == 'Explique-moi la lune'
    assert turn['reply'] == 'Voici lune'
    assert turn['tools'][0]['name'] == 'show_word'
    assert 'reply' in turn['timings_ms']
    assert client.delete(f'/api/parents/sessions/{session}').status_code == 403
    assert client.delete(f'/api/parents/sessions/{session}', headers={'Origin': 'https://outside.invalid'}).status_code == 403
    assert client.delete(f'/api/parents/sessions/{session}', headers={'Origin': 'https://testserver'}).status_code == 200
    assert client.get('/api/parents/activity').json()['turns'] == []
    assert len(bridge._sessions[session].messages) == 2
    assert client.get('/parents.html').headers['cache-control'] == 'no-store'


def test_existing_token_auth_protects_journal(client, monkeypatch):
    monkeypatch.setattr(bridge, 'AUTH_MODE', 'token')
    monkeypatch.setattr(bridge, 'PISTACHE_BRIDGE_TOKEN', 'synthetic-parent-test-key')
    assert client.get('/api/parents/activity').status_code == 401
    assert client.get('/api/parents/activity', headers={'Authorization': 'Bearer synthetic-parent-test-key'}).status_code == 200


def test_raw_provider_errors_and_keys_are_not_saved(client, monkeypatch):
    journal.configure_secrets('a-local-synthetic-secret')
    async def answer(*_):
        raise HTTPException(status_code=502, detail='provider https://private.invalid a-local-synthetic-secret')
    monkeypatch.setattr(bridge, '_pi_reply', answer)
    assert post(client, text='a-local-synthetic-secret').status_code == 502
    turn = journal.store.read()['turns'][0]
    assert turn['stage'] == 'reply'
    assert turn['http_status'] == 502
    assert turn['message'] == '[clé masquée]'
    assert 'private.invalid' not in json.dumps(turn)
    assert 'a-local-synthetic-secret' not in json.dumps(turn)


def test_voice_speech_failure_keeps_transcript_reply_but_no_audio(client, monkeypatch):
    async def duration(*_): return 2.0
    async def transcribe(*_): return ('Quel est ce mot ?', 2.0)
    async def answer(*_): return ('Le mot est lune.', [], [])
    async def speak(*_): raise HTTPException(status_code=504, detail='private provider failure')
    monkeypatch.setattr(bridge, '_inspect_duration_safely', duration)
    monkeypatch.setattr(bridge, '_transcribe_safely', transcribe)
    monkeypatch.setattr(bridge, '_pi_reply', answer)
    monkeypatch.setattr(bridge, '_speak', speak)
    session = str(uuid.uuid4())
    result = client.post('/api/voice', headers={'Origin': 'https://testserver'}, files={'audio': ('private-filename.webm', b'a'*700, 'audio/webm')}, data={'session_id': session})
    assert result.status_code == 504
    turn = journal.store.read()['turns'][0]
    assert turn['message'] == 'Quel est ce mot ?'
    assert turn['reply'] == 'Le mot est lune.'
    assert turn['stage'] == 'speech'
    assert set(turn['timings_ms']) >= {'transcription', 'reply', 'speech'}
    assert 'private-filename' not in json.dumps(turn)
    assert 'audio' not in turn
    assert bridge._sessions[session].messages == []


def test_storage_failure_does_not_fail_child_turn(client, monkeypatch):
    async def answer(*_): return ('Bonjour !', [], [])
    def unavailable(*_): raise OSError('private disk details')
    monkeypatch.setattr(bridge, '_pi_reply', answer)
    monkeypatch.setattr(journal.store, 'add', unavailable)
    assert post(client).status_code == 200
    assert client.get('/api/parents/activity').json()['last_save_failed'] is True
    monkeypatch.setattr(journal.store, 'read', unavailable)
    response = client.get('/api/parents/activity')
    assert response.status_code == 503
    assert 'private disk details' not in response.text


def test_concurrent_contexts_are_separate_and_cancellation_is_recorded():
    @journal.trace('voice')
    async def turn(session_id, text):
        journal.message(text)
        with journal.phase('reply'):
            await asyncio.sleep(0.01)
        if text == 'cancel':
            raise asyncio.CancelledError()
        journal.reply(text + ' reply', [], [])
    async def run():
        await asyncio.gather(turn(str(uuid.uuid4()), 'first'), turn(str(uuid.uuid4()), 'second'))
        with pytest.raises(asyncio.CancelledError):
            await turn(str(uuid.uuid4()), 'cancel')
    asyncio.run(run())
    rows = journal.store.read()['turns']
    assert {(row['message'], row['reply']) for row in rows if row['status'] == 'ok'} == {('first', 'first reply'), ('second', 'second reply')}
    assert next(row for row in rows if row['message'] == 'cancel')['status'] == 'cancelled'


def test_delete_all_discards_already_started_turn(client, monkeypatch):
    async def answer(*_):
        await asyncio.to_thread(journal.store.delete)
        return ('Bonjour !', [], [])
    monkeypatch.setattr(bridge, '_pi_reply', answer)
    assert post(client).status_code == 200
    assert journal.store.read()['turns'] == []


def test_transcription_failure_records_stage_without_advancing_history(client, monkeypatch):
    async def duration(*_): return 2.0
    async def transcribe(*_): raise HTTPException(status_code=502, detail='private raw error')
    monkeypatch.setattr(bridge, '_inspect_duration_safely', duration)
    monkeypatch.setattr(bridge, '_transcribe_safely', transcribe)
    session = str(uuid.uuid4())
    response = client.post('/api/voice', headers={'Origin': 'https://testserver'}, files={'audio': ('clip.webm', b'a'*700, 'audio/webm')}, data={'session_id': session})
    assert response.status_code == 502
    turn = journal.store.read()['turns'][0]
    assert turn['stage'] == 'transcription'
    assert turn['message'] == turn['reply'] == ''
    assert bridge._sessions[session].messages == []


def test_voice_success_is_journaled_without_audio(client, monkeypatch):
    async def duration(*_): return 2.0
    async def transcribe(*_): return ('Un petit calcul', 2.0)
    async def answer(*_): return ('Deux plus deux font quatre.', [], [])
    async def speak(*_): return b'synthetic-audio-bytes'
    monkeypatch.setattr(bridge, '_inspect_duration_safely', duration)
    monkeypatch.setattr(bridge, '_transcribe_safely', transcribe)
    monkeypatch.setattr(bridge, '_pi_reply', answer)
    monkeypatch.setattr(bridge, '_speak', speak)
    response = client.post('/api/voice', headers={'Origin': 'https://testserver'}, files={'audio': ('clip.webm', b'a'*700, 'audio/webm')}, data={'session_id': str(uuid.uuid4())})
    assert response.status_code == 200
    turn = journal.store.read()['turns'][0]
    assert turn['status'] == 'ok'
    assert turn['stage'] == 'delivery'
    assert turn['reply'] == 'Deux plus deux font quatre.'
    assert 'audio_base64' not in turn


def test_deletion_api_clears_journal_and_rejects_invalid_session(client):
    journal.store.add(event(), journal.store.epoch)
    assert client.delete('/api/parents/sessions/bad', headers={'Origin': 'https://testserver'}).status_code == 400
    assert client.delete('/api/parents/activity', headers={'Origin': 'https://testserver'}).status_code == 200
    assert client.get('/api/parents/activity').json()['summary']['turns'] == 0
