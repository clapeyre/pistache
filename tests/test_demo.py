import base64
import asyncio
import sys
import uuid
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import app as bridge  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(bridge, "AUTH_MODE", "token")
    monkeypatch.setattr(bridge, "PISTACHE_BRIDGE_TOKEN", "test-bridge-token")
    monkeypatch.setattr(bridge, "PI_SERVICE_API_KEY", "")
    bridge._sessions.clear()
    bridge._sessions_lock = asyncio.Lock()
    bridge._turn_slots = asyncio.Semaphore(bridge.MAX_CONCURRENT_TURNS)
    bridge._whisper_lock = asyncio.Lock()
    with TestClient(bridge.app, base_url="https://testserver") as test_client:
        yield test_client
    bridge._sessions.clear()


def auth():
    return {"Authorization": "Bearer test-bridge-token"}


def test_typed_turn_carries_valid_cards_and_keeps_history(client, monkeypatch):
    async def answer(history, text):
        assert history == []
        assert text == "Montre moi le mot lune"
        return "Voici le mot lune !", [{"type": "word", "word": "lune", "letters": ["l", "u", "n", "e"]}], [{"name": "show_word", "arguments": {"word": "lune"}}]

    monkeypatch.setattr(bridge, "_pi_reply", answer)
    sid = str(uuid.uuid4())
    response = client.post("/api/text-turn", headers=auth(), json={"session_id": sid, "text": "  Montre   moi le mot lune "})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reply"] == "Voici le mot lune !"
    assert body["cards"] == [{"type": "word", "word": "lune", "letters": ["l", "u", "n", "e"]}]
    assert body["toolCalls"][0]["name"] == "show_word"
    assert [item["role"] for item in bridge._sessions[sid].messages] == ["user", "assistant"]


def test_typed_turn_bounds_inputs_and_enforces_same_origin(client, monkeypatch):
    sid = str(uuid.uuid4())
    assert client.post("/api/text-turn", headers=auth(), json={"session_id": sid, "text": "x"}).status_code == 422
    assert client.post("/api/text-turn", headers=auth(), json={"session_id": "bad", "text": "Bonjour Pistache"}).status_code == 400

    monkeypatch.setattr(bridge, "AUTH_MODE", "network")
    response = client.post("/api/text-turn", json={"session_id": sid, "text": "Bonjour Pistache"})
    assert response.status_code == 403
    response = client.post("/api/text-turn", headers={"Origin": "https://outside.invalid"}, json={"session_id": sid, "text": "Bonjour Pistache"})
    assert response.status_code == 403


def test_math_card_operation_is_normalized_and_bad_cards_are_dropped():
    assert bridge._safe_cards([{"type": "math", "a": 3, "operation": "multiply", "b": 4, "result": 12}]) == [
        {"type": "math", "a": 3, "operation": "×", "b": 4, "result": 12}
    ]
    assert bridge._safe_cards([{"type": "math", "a": 3, "operation": "eval", "b": 4, "result": 12}, {"type": "html", "content": "no"}]) == []


def test_plain_text_reply_removes_common_markdown_without_changing_symbols():
    source = """## Bonjour
**Papillon** est un mot.
- Première idée
2. [La suite](https://example.test)
```text
C++ : 7 * 5 = 35
```"""
    assert bridge._plain_text_reply(source) == """Bonjour
Papillon est un mot.
Première idée
La suite
C++ : 7 * 5 = 35"""
    assert bridge._plain_text_reply("Voici *un mot* et `x + y`, sans foo_bar.") == "Voici un mot et x + y, sans foo_bar."


def test_voice_turn_preserves_explicit_audio_flow_and_carries_cards(client, monkeypatch):
    monkeypatch.setattr(bridge, "STT_PROVIDER", "local")
    monkeypatch.setattr(bridge, "_inspect_duration", lambda _path: 3.0)
    monkeypatch.setattr(bridge, "_transcribe", lambda _path: ("Bonjour Pistache", 3.0))

    async def answer(_history, _text):
        return "Cinq fois deux, ça fait dix.", [{"type": "math", "a": 5, "operation": "×", "b": 2, "result": 10}], []

    async def speech(_text):
        return b"sample-mp3"

    monkeypatch.setattr(bridge, "_pi_reply", answer)
    monkeypatch.setattr(bridge, "_speak", speech)
    sid = str(uuid.uuid4())
    response = client.post("/api/voice", headers=auth(), files={"audio": ("clip.webm", b"a" * 700, "audio/webm")}, data={"session_id": sid})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["cards"][0]["result"] == 10
    assert body["transcript"] == "Bonjour Pistache"
    assert body["audio_base64"] == base64.b64encode(b"sample-mp3").decode("ascii")


def test_cleaned_model_reply_is_shared_by_text_history_voice_and_speech(client, monkeypatch):
    markdown = "## Bonjour\n**Papillon** s’écrit p-a-p-i-l-l-o-n."
    cleaned = "Bonjour\nPapillon s’écrit p-a-p-i-l-l-o-n."
    requests = []

    class FakeResponse:
        is_error = False

        def json(self):
            return {"choices": [{"message": {"content": markdown}}]}

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, json, headers):
            requests.append(json)
            return FakeResponse()

    monkeypatch.setattr(bridge.httpx, "AsyncClient", FakeClient)
    sid = str(uuid.uuid4())
    text_response = client.post("/api/text-turn", headers=auth(), json={"session_id": sid, "text": "Comment l’écrire ?"})
    assert text_response.status_code == 200, text_response.text
    assert text_response.json()["reply"] == cleaned
    assert bridge._sessions[sid].messages[-1] == {"role": "assistant", "content": cleaned}

    monkeypatch.setattr(bridge, "STT_PROVIDER", "local")
    monkeypatch.setattr(bridge, "_inspect_duration", lambda _path: 3.0)
    monkeypatch.setattr(bridge, "_transcribe", lambda _path: ("Redis-le-moi", 3.0))
    spoken = []

    async def speech(text):
        spoken.append(text)
        return b"sample-mp3"

    monkeypatch.setattr(bridge, "_speak", speech)
    voice_response = client.post("/api/voice", headers=auth(), files={"audio": ("clip.webm", b"a" * 700, "audio/webm")}, data={"session_id": sid})
    assert voice_response.status_code == 200, voice_response.text
    assert voice_response.json()["reply"] == cleaned
    assert spoken == [cleaned]
    assert bridge._sessions[sid].messages[-1] == {"role": "assistant", "content": cleaned}
    assert requests[1]["messages"][-2] == {"role": "assistant", "content": cleaned}


def test_markdown_only_model_reply_is_rejected_after_cleanup(monkeypatch):
    class FakeResponse:
        is_error = False

        def json(self):
            return {"choices": [{"message": {"content": "### \n---\n```text\n```"}}]}

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(bridge.httpx, "AsyncClient", FakeClient)
    import asyncio

    with pytest.raises(bridge.HTTPException) as error:
        asyncio.run(bridge._pi_reply([], "Bonjour Pistache"))
    assert error.value.status_code == 502


def test_speech_config_allows_loopback_for_local_tunnel(monkeypatch):
    monkeypatch.setattr(bridge, "AUTH_MODE", "network")
    monkeypatch.setattr(bridge, "PI_SERVICE_BASE_URL", "http://pi-service:8788/v1")
    monkeypatch.setattr(bridge, "PI_SERVICE_API_KEY", "")
    monkeypatch.setattr(bridge, "STT_PROVIDER", "bifrost")
    monkeypatch.setattr(bridge, "TTS_PROVIDER", "bifrost")
    monkeypatch.setattr(bridge, "SPEECH_BASE_URL", "http://127.0.0.1:8080/v1")
    monkeypatch.setattr(bridge, "SPEECH_API_KEY", "test-key")
    bridge._require_config()


def test_pi_request_matches_service_contract_and_sanitizes_response(monkeypatch):
    captured = {}

    class FakeResponse:
        is_error = False

        def json(self):
            return {
                "choices": [{"message": {"content": "Une idée !"}}],
                "pistache": {
                    "cards": [{"type": "math", "a": 4, "operation": "add", "b": 3, "result": 7}, {"type": "html", "content": "ignored"}],
                    "toolCalls": [{"name": "calculate", "arguments": {"a": 4, "b": 3}}],
                },
            }

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, json, headers):
            captured.update(url=url, payload=json, headers=headers)
            return FakeResponse()

    monkeypatch.setattr(bridge.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(bridge, "PI_SERVICE_API_KEY", "")
    import asyncio

    reply, cards, calls = asyncio.run(bridge._pi_reply([], "Combien font quatre et trois ?"))
    assert captured["url"] == "http://pi-service:8788/v1/chat/completions"
    assert captured["payload"]["model"] == "pistache-chat"
    assert captured["payload"]["messages"] == [{"role": "user", "content": "Combien font quatre et trois ?"}]
    assert reply == "Une idée !"
    assert cards == [{"type": "math", "a": 4, "operation": "+", "b": 3, "result": 7}]
    assert calls[0]["name"] == "calculate"


def test_audio_duration_inspector_reads_a_bounded_wav(tmp_path):
    clip = tmp_path / "short.wav"
    with wave.open(str(clip), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\0\0" * 8_000)
    assert bridge._inspect_duration(str(clip)) == pytest.approx(0.5, abs=0.02)
