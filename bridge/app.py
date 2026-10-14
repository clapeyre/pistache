"""Local demo bridge for typed and explicit-start/finish voice turns.

Chat runs through the private Pi service; speech uses the configured Bifrost
aliases. Only completed turns enter the bounded in-memory session history.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import math
import os
import re
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import journal


MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(10 * 1024 * 1024)))
MAX_AUDIO_SECONDS = float(os.getenv("MAX_AUDIO_SECONDS", "45"))
MAX_CONCURRENT_TURNS = int(os.getenv("MAX_CONCURRENT_TURNS", "2"))
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", str(2 * 60 * 60)))
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "100"))
MAX_HISTORY_TURNS = int(os.getenv("MAX_HISTORY_TURNS", "8"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "fr-FR-EloiseNeural")
STT_PROVIDER = os.getenv("STT_PROVIDER", "bifrost")
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "bifrost")
SPEECH_BASE_URL = os.getenv("SPEECH_BASE_URL", "http://bifrost:8080/v1").rstrip("/")
def _secret_from_env(name: str) -> str:
    path = os.getenv(f"{name}_FILE", "").strip()
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return os.getenv(name, "")


SPEECH_API_KEY = _secret_from_env("SPEECH_API_KEY")
STT_MODEL = os.getenv("STT_MODEL", "openrouter/openai/gpt-transcribe")
TTS_MODEL = os.getenv("TTS_MODEL", "openrouter/pistache-tts")
TTS_VOICE = os.getenv("TTS_VOICE", "ff_siwis")
logger = logging.getLogger("uvicorn.error")
PI_SERVICE_BASE_URL = os.getenv("PI_SERVICE_BASE_URL", "http://pi-service:8788/v1").rstrip("/")
PI_SERVICE_API_KEY = _secret_from_env("PI_SERVICE_API_KEY")
PI_SERVICE_MODEL = os.getenv("PI_SERVICE_MODEL", "pistache-chat")
PISTACHE_BRIDGE_TOKEN = os.getenv("PISTACHE_BRIDGE_TOKEN", "")
AUTH_MODE = os.getenv("AUTH_MODE", "token")
CORS_ORIGINS = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
journal.configure_secrets(SPEECH_API_KEY, PI_SERVICE_API_KEY, PISTACHE_BRIDGE_TOKEN)


@dataclass
class Session:
    messages: list[dict[str, str]] = field(default_factory=list)
    updated_at: float = field(default_factory=time.monotonic)
    generation: int = 0
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: int = 0


_sessions: dict[str, Session] = {}
_sessions_lock = asyncio.Lock()
_turn_slots = asyncio.Semaphore(MAX_CONCURRENT_TURNS)
_whisper: object | None = None
_whisper_lock = asyncio.Lock()


def _require_config() -> None:
    placeholder_markers = ("replace-with-", "same-key-configured", "your-api-key")
    if AUTH_MODE not in {"token", "network"}:
        raise RuntimeError("Unsupported authentication mode")
    if AUTH_MODE == "token" and (not PISTACHE_BRIDGE_TOKEN or any(marker in PISTACHE_BRIDGE_TOKEN.lower() for marker in placeholder_markers)):
        raise RuntimeError("PISTACHE_BRIDGE_TOKEN must be set to a private random secret before startup")
    if not PI_SERVICE_BASE_URL.startswith(("http://", "https://")):
        raise RuntimeError("PI_SERVICE_BASE_URL must be an HTTP(S) URL")
    if PI_SERVICE_API_KEY and any(marker in PI_SERVICE_API_KEY.lower() for marker in placeholder_markers):
        raise RuntimeError("PI_SERVICE_API_KEY must be a real service key or empty")
    if MAX_AUDIO_BYTES <= 0 or MAX_AUDIO_SECONDS <= 0 or MAX_CONCURRENT_TURNS <= 0:
        raise RuntimeError("Audio and concurrency limits must be positive")
    if STT_PROVIDER not in {"local", "bifrost"} or TTS_PROVIDER not in {"edge", "bifrost"}:
        raise RuntimeError("Unsupported speech provider")
    if SPEECH_API_KEY and "bifrost" in {STT_PROVIDER, TTS_PROVIDER}:
        speech_url = urlsplit(SPEECH_BASE_URL)
        private_http_hosts = {"bifrost", "localhost", "127.0.0.1", "::1", "host.docker.internal"}
        if not SPEECH_API_KEY or speech_url.scheme not in {"http", "https"} or (speech_url.scheme == "http" and speech_url.hostname not in private_http_hosts):
            raise RuntimeError("Speech requires a private virtual key and an internal Bifrost or HTTPS endpoint")


@asynccontextmanager
async def lifespan(_: FastAPI):
    _require_config()
    yield


app = FastAPI(title="Pistache Voice Bridge", docs_url=None, redoc_url=None, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def parent_no_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/parents", "/parents")):
        response.headers["Cache-Control"] = "no-store"
    return response


def _device_cookie_value() -> str:
    return hmac.new(PISTACHE_BRIDGE_TOKEN.encode(), b"pistache-device", "sha256").hexdigest()


async def authenticate(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    if AUTH_MODE == "network":
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin", "")
            expected = f"{request.url.scheme}://{request.url.netloc}"
            if not origin or not hmac.compare_digest(origin.rstrip("/"), expected.rstrip("/")):
                raise HTTPException(status_code=403, detail="Same-origin request required")
        return
    if authorization and authorization.startswith("Bearer "):
        if hmac.compare_digest(authorization[7:], PISTACHE_BRIDGE_TOKEN):
            return
        raise HTTPException(status_code=401, detail="Authentication failed")
    cookie = request.cookies.get("pistache_device", "")
    if cookie and hmac.compare_digest(cookie, _device_cookie_value()):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.url.netloc}"
            if not origin or not hmac.compare_digest(origin.rstrip("/"), expected.rstrip("/")):
                raise HTTPException(status_code=403, detail="Same-origin request required")
        return
    raise HTTPException(status_code=401, detail="Authentication required")


class HealthResponse(BaseModel):
    status: str


class VoiceResponse(BaseModel):
    reply: str
    audio_base64: str
    audio_mime: str = "audio/mpeg"
    session_id: str
    cards: list[dict] = Field(default_factory=list)
    toolCalls: list[dict] = Field(default_factory=list)


class TextTurnRequest(BaseModel):
    text: str = Field(min_length=2, max_length=1800)
    session_id: str


class TextTurnResponse(BaseModel):
    reply: str
    session_id: str
    cards: list[dict] = Field(default_factory=list)
    toolCalls: list[dict] = Field(default_factory=list)


@app.post("/api/login")
async def login(response: Response, authorization: str | None = Header(default=None)) -> dict[str, bool]:
    """Exchange the bridge secret for a browser-only, scoped device cookie."""
    if AUTH_MODE == "network":
        raise HTTPException(status_code=404, detail="Device login is not used")
    if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(
        authorization[7:], PISTACHE_BRIDGE_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Authentication failed")
    response.set_cookie(
        key="pistache_device",
        value=_device_cookie_value(),
        max_age=30 * 24 * 60 * 60,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/api",
    )
    return {"ok": True}


@app.delete("/api/login")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(key="pistache_device", path="/api", secure=True, httponly=True, samesite="strict")
    return {"ok": True}


def _get_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    return _whisper


def _transcribe(path: str) -> tuple[str, float]:
    model = _get_whisper()
    segments, info = model.transcribe(path, language="fr", beam_size=3, vad_filter=True)
    pieces: list[str] = []
    observed_end = 0.0
    for segment in segments:
        observed_end = max(observed_end, float(segment.end))
        clean = segment.text.strip()
        if clean:
            pieces.append(clean)
    return " ".join(pieces).strip(), max(observed_end, float(getattr(info, "duration", 0) or 0))


def _inspect_duration(path: str) -> float:
    """Read container metadata before running a potentially expensive model."""
    import av

    with av.open(path) as container:
        audio_streams = [stream for stream in container.streams if stream.type == "audio"]
        if not audio_streams:
            raise ValueError("No audio stream")
        duration = container.duration
        if duration is not None:
            seconds = float(duration) / float(av.time_base)
            if math.isfinite(seconds) and seconds > 0:
                return seconds
        stream = audio_streams[0]
        if stream.duration is not None and stream.time_base is not None:
            seconds = float(stream.duration * stream.time_base)
            if math.isfinite(seconds) and seconds > 0:
                return seconds
        # Browser MediaRecorder often emits WebM/fragmented MP4 without duration
        # metadata. Decode audio frames as a bounded fallback instead of passing
        # an unbounded clip to Whisper.
        samples = 0
        sample_rate = 0
        for frame in container.decode(stream):
            sample_rate = frame.sample_rate or sample_rate
            if sample_rate:
                samples += frame.samples
                seconds = samples / sample_rate
                if seconds > MAX_AUDIO_SECONDS:
                    return seconds
        if samples and sample_rate:
            seconds = samples / sample_rate
            if math.isfinite(seconds) and seconds > 0:
                return seconds
    raise ValueError("Audio duration is unavailable")


_GARBAGE = re.compile(r"^[\W_]+$", re.UNICODE)
_REPEATED = re.compile(r"\b(\w+)(?:\s+\1){4,}\b", re.IGNORECASE | re.UNICODE)


def _plain_text_reply(text: str) -> str:
    """Remove common Markdown presentation while keeping the spoken words intact."""
    cleaned_lines: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"^\s{0,3}(?:#{1,6}\s+|>\s*)", "", line)
        line = re.sub(r"^\s{0,3}(?:[-+*]\s+|\d+[.)]\s+)", "", line)
        if re.fullmatch(r"\s{0,3}(?:[-*_]\s*){3,}\s*", line):
            continue
        cleaned_lines.append(line)
    text = "\n".join(cleaned_lines)
    text = re.sub(r"```[^\n]*\n?", "", text)
    text = re.sub(r"~~~[^\n]*\n?", "", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"`+([^`]+)`+", r"\1", text)
    # Delimiters must touch their content. This leaves spaced multiplication
    # such as "7 * 5" alone, as well as underscores inside identifiers.
    text = re.sub(r"(?<!\w)(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?!\w)", r"\2", text)
    text = re.sub(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])", r"\1", text)
    text = re.sub(r"(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])", r"\1", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _valid_transcript(text: str) -> bool:
    normalized = " ".join(text.split())
    if len(normalized) < 2 or len(normalized) > 1800:
        return False
    if _GARBAGE.fullmatch(normalized) or _REPEATED.search(normalized):
        return False
    words = re.findall(r"[\wÀ-ÿ'-]+", normalized, flags=re.UNICODE)
    return len(words) >= 1 and len(set(w.casefold() for w in words)) >= min(2, len(words))


async def _speak(text: str) -> bytes:
    if TTS_PROVIDER == "bifrost":
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=8)) as client:
                response = await client.post(
                    f"{SPEECH_BASE_URL}/audio/speech",
                    headers={"Authorization": f"Bearer {SPEECH_API_KEY}"},
                    json={"model": TTS_MODEL, "input": text, "voice": TTS_VOICE, "response_format": "mp3"},
                )
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="La voix de Pistache met trop de temps. Réessaie.")
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="La voix de Pistache est momentanément indisponible")
        if response.is_error or not response.headers.get("content-type", "").startswith("audio/"):
            raise HTTPException(status_code=502, detail="La voix de Pistache est momentanément indisponible")
        if not response.content or len(response.content) > 2 * 1024 * 1024:
            raise HTTPException(status_code=502, detail="La réponse vocale est invalide")
        return response.content
    import edge_tts

    communicator = edge_tts.Communicate(text, EDGE_TTS_VOICE)
    audio = bytearray()
    async for chunk in communicator.stream():
        if chunk.get("type") == "audio":
            audio.extend(chunk["data"])
            if len(audio) > 2 * 1024 * 1024:
                raise RuntimeError("Speech audio exceeded the size limit")
    if not audio:
        raise RuntimeError("Speech synthesis returned no audio")
    return bytes(audio)


async def _pi_reply(history: list[dict[str, str]], transcript: str) -> tuple[str, list[dict], list[dict]]:
    payload = {
        "model": PI_SERVICE_MODEL,
        "messages": [*history, {"role": "user", "content": transcript}],
        "temperature": 0.6,
        "max_tokens": 220,
        "stream": False,
    }
    headers = {"Content-Type": "application/json"}
    if PI_SERVICE_API_KEY:
        headers["Authorization"] = f"Bearer {PI_SERVICE_API_KEY}"
    timeout = httpx.Timeout(connect=8.0, read=50.0, write=10.0, pool=8.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{PI_SERVICE_BASE_URL}/chat/completions", json=payload, headers=headers)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The voice service took too long to answer")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="The voice service is unavailable")
    if response.is_error:
        raise HTTPException(status_code=502, detail="The voice service could not answer")
    try:
        result = response.json()
        reply = result["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail="The voice service returned an invalid response")
    if not isinstance(reply, str) or not reply.strip():
        raise HTTPException(status_code=502, detail="The voice service returned an empty response")
    if re.match(r"^HTTP\s+[45]\d\d:\s*(?:Upstream error|Service|Error)", reply.strip(), re.IGNORECASE):
        raise HTTPException(status_code=503, detail="Pistache est occupée pour le moment. Réessaie dans un instant.")
    metadata = result.get("pistache", {})
    if isinstance(metadata, dict):
        journal.usage(metadata.get('usage'))
    cards = _safe_cards(metadata.get("cards", [])) if isinstance(metadata, dict) else []
    tool_calls = _safe_tool_calls(metadata.get("toolCalls", [])) if isinstance(metadata, dict) else []
    reply = _plain_text_reply(reply)
    if not reply:
        raise HTTPException(status_code=502, detail="The voice service returned an empty response")
    return reply[:1800], cards, tool_calls


def _safe_cards(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    safe: list[dict] = []
    for card in value[:8]:
        if not isinstance(card, dict):
            continue
        kind = card.get("type")
        if kind == "word" and isinstance(card.get("word"), str) and isinstance(card.get("letters"), list):
            word = card["word"][:80]
            letters = [str(letter)[:12] for letter in card["letters"][:40] if isinstance(letter, (str, int, float))]
            safe.append({"type": "word", "word": word, "letters": letters})
        elif kind == "math" and all(isinstance(card.get(key), (int, float)) and math.isfinite(card[key]) and abs(card[key]) <= 1_000_000_000_000 for key in ("a", "b", "result")):
            operation = {"add": "+", "subtract": "−", "multiply": "×", "divide": "÷"}.get(card.get("operation"), card.get("operation"))
            if operation in {"+", "−", "×", "÷"}:
                safe.append({"type": "math", "a": card["a"], "operation": operation, "b": card["b"], "result": card["result"]})
    return safe


def _safe_tool_calls(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [{"name": str(item.get("name", "tool"))[:80], **{str(k)[:40]: (str(v)[:240] if isinstance(v, (str, int, float, bool)) else json.dumps(v, ensure_ascii=False)[:240]) for k, v in item.items() if k != "name"}} for item in value[:8] if isinstance(item, dict)]


async def _read_upload_limited(audio: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await audio.read(min(64 * 1024, MAX_AUDIO_BYTES + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio recording is too large")
        chunks.append(chunk)
    if total < 512:
        raise HTTPException(status_code=400, detail="Recording is too short")
    return b"".join(chunks)


async def _session_for(session_id: str) -> Session:
    async with _sessions_lock:
        now = time.monotonic()
        stale = [key for key, value in _sessions.items()
                 if value.active == 0 and now - value.updated_at > SESSION_TTL_SECONDS]
        for key in stale:
            _sessions.pop(key, None)
        session = _sessions.get(session_id)
        if session is None:
            if len(_sessions) >= MAX_SESSIONS:
                idle = [key for key, value in _sessions.items() if value.active == 0]
                if not idle:
                    raise HTTPException(status_code=503, detail="Voice sessions are busy")
                oldest = min(idle, key=lambda key: _sessions[key].updated_at)
                _sessions.pop(oldest, None)
            session = _sessions[session_id] = Session()
        session.updated_at = now
        session.active += 1
        return session


async def _transcribe_safely(path: str) -> tuple[str, float]:
    """Wait for the native worker to release its file even if the request cancels."""
    if STT_PROVIDER == "bifrost":
        try:
            with open(path, "rb") as audio:
                async with httpx.AsyncClient(timeout=httpx.Timeout(65, connect=8)) as client:
                    response = await client.post(
                        f"{SPEECH_BASE_URL}/audio/transcriptions",
                        headers={"Authorization": f"Bearer {SPEECH_API_KEY}"},
                        data={"model": STT_MODEL, "language": "fr", "response_format": "json"},
                        files={"file": (Path(path).name, audio, "application/octet-stream")},
                    )
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="La transcription met trop de temps. Réessaie.")
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="La transcription est momentanément indisponible")
        if response.is_error:
            raise HTTPException(status_code=502, detail="La transcription est momentanément indisponible")
        try:
            transcript = response.json()["text"]
            if not isinstance(transcript, str):
                raise ValueError("Invalid transcript")
        except (ValueError, KeyError, TypeError):
            raise HTTPException(status_code=502, detail="La transcription reçue est invalide")
        return transcript.strip(), 0.0
    worker = asyncio.create_task(asyncio.to_thread(_transcribe, path))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        try:
            await asyncio.shield(worker)
        except Exception:
            pass
        raise


async def _inspect_duration_safely(path: str) -> float:
    worker = asyncio.create_task(asyncio.to_thread(_inspect_duration, path))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        try:
            await asyncio.shield(worker)
        except Exception:
            pass
        raise


@app.get("/api/health", response_model=HealthResponse, dependencies=[Depends(authenticate)])
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/api/text-turn", response_model=TextTurnResponse, dependencies=[Depends(authenticate)])
@journal.trace("text")
async def text_turn(body: TextTurnRequest) -> TextTurnResponse:
    try:
        uuid.UUID(body.session_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid session id")
    transcript = " ".join(body.text.split())
    if not _valid_transcript(transcript):
        raise HTTPException(status_code=422, detail="Écris une petite phrase pour Pistache.")
    async with _turn_slots:
        session = await _session_for(body.session_id)
        try:
            async with session.turn_lock:
                async with _sessions_lock:
                    generation = session.generation
                    history = list(session.messages)
                with journal.phase("reply"):
                    reply, cards, tool_calls = await _pi_reply(history, transcript)
                journal.reply(reply, cards, tool_calls)
                journal.stage("delivery")
                async with _sessions_lock:
                    current = _sessions.get(body.session_id)
                    if current is not session or current.generation != generation:
                        raise HTTPException(status_code=409, detail="La conversation a été réinitialisée. Réessaie.")
                    current.messages.extend([{"role": "user", "content": transcript}, {"role": "assistant", "content": reply}])
                    current.messages = current.messages[-(MAX_HISTORY_TURNS * 2):]
                    current.updated_at = time.monotonic()
                return TextTurnResponse(reply=reply, session_id=body.session_id, cards=cards, toolCalls=tool_calls)
        finally:
            async with _sessions_lock:
                session.active = max(0, session.active - 1)


@app.post("/api/voice", response_model=VoiceResponse, dependencies=[Depends(authenticate)])
@journal.trace("voice")
async def voice_turn(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    response: Response = None,
) -> VoiceResponse:
    session: Session | None = None
    try:
        try:
            uuid.UUID(session_id)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="Invalid session id")

        async with _turn_slots:
            session = await _session_for(session_id)
            async with session.turn_lock:
                async with _sessions_lock:
                    generation = session.generation
                    history = list(session.messages)

                with journal.phase("recording"):
                    raw_audio = await _read_upload_limited(audio)
                suffix = Path(audio.filename or "recording.webm").suffix.lower()
                if suffix not in {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac"}:
                    suffix = ".webm"
                temp_path: str | None = None
                try:
                    with tempfile.NamedTemporaryFile(prefix="pistache-voice-", suffix=suffix, delete=False) as stream:
                        temp_path = stream.name
                        stream.write(raw_audio)
                    del raw_audio
                    try:
                        with journal.phase("recording"):
                            duration = await _inspect_duration_safely(temp_path)
                    except Exception:
                        raise HTTPException(status_code=422, detail="Je n’arrive pas à lire cet enregistrement. Réessaie.")
                    if duration > MAX_AUDIO_SECONDS:
                        raise HTTPException(status_code=413, detail="Recording is longer than allowed")
                    async with _whisper_lock:
                        stt_start = time.monotonic()
                        try:
                            with journal.phase("transcription"):
                                transcript, _ = await _transcribe_safely(temp_path)
                        except HTTPException:
                            raise
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            raise HTTPException(status_code=422, detail="Je n’arrive pas à entendre cet enregistrement. Réessaie.")
                    journal.message(transcript)
                    if not _valid_transcript(transcript):
                        raise HTTPException(status_code=422, detail="Je n’ai pas bien entendu. Réessaie.")

                    stt_ms = (time.monotonic() - stt_start) * 1000
                    llm_start = time.monotonic()
                    with journal.phase("reply"):
                        reply, cards, tool_calls = await _pi_reply(history, transcript)
                    journal.reply(reply, cards, tool_calls)
                    llm_ms = (time.monotonic() - llm_start) * 1000
                    tts_start = time.monotonic()
                    try:
                        with journal.phase("speech"):
                            speech = await asyncio.wait_for(_speak(reply), timeout=25)
                    except HTTPException:
                        raise
                    except asyncio.TimeoutError:
                        raise HTTPException(status_code=504, detail="La voix de Pistache met trop de temps. Réessaie.")
                    except Exception:
                        raise HTTPException(status_code=502, detail="La voix de Pistache est momentanément indisponible")
                    tts_ms = (time.monotonic() - tts_start) * 1000
                    logger.info("Voice timings: stt_ms=%.0f llm_ms=%.0f tts_ms=%.0f", stt_ms, llm_ms, tts_ms)
                    if response is not None:
                        response.headers["Server-Timing"] = f"stt;dur={stt_ms:.0f}, llm;dur={llm_ms:.0f}, tts;dur={tts_ms:.0f}"

                    # Reset may run during STT, model generation, or TTS. Do not
                    # let a stale turn restore history after reset or eviction.
                    journal.stage("delivery")
                    async with _sessions_lock:
                        current = _sessions.get(session_id)
                        if current is not session or current.generation != generation:
                            raise HTTPException(status_code=409, detail="La conversation a été réinitialisée. Réessaie.")
                        current.messages.extend([
                            {"role": "user", "content": transcript},
                            {"role": "assistant", "content": reply},
                        ])
                        current.messages = current.messages[-(MAX_HISTORY_TURNS * 2):]
                        current.updated_at = time.monotonic()

                    return VoiceResponse(reply=reply, audio_base64=base64.b64encode(speech).decode("ascii"), session_id=session_id, cards=cards, toolCalls=tool_calls)
                finally:
                    if temp_path:
                        try:
                            os.unlink(temp_path)
                        except FileNotFoundError:
                            pass
    finally:
        await audio.close()
        if session is not None:
            async with _sessions_lock:
                session.active = max(0, session.active - 1)


@app.delete("/api/session/{session_id}", dependencies=[Depends(authenticate)])
async def reset_session(session_id: str) -> dict[str, bool]:
    try:
        uuid.UUID(session_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid session id")
    async with _sessions_lock:
        session = _sessions.get(session_id)
        if session is not None:
            session.generation += 1
            session.messages.clear()
            session.updated_at = time.monotonic()
    return {"ok": True}


@app.get("/api/parents/activity", dependencies=[Depends(authenticate)])
async def parent_activity():
    try:
        activity = await asyncio.to_thread(journal.store.read)
    except Exception:
        raise HTTPException(status_code=503, detail="Le journal est momentanément indisponible.")
    activity["models"] = {"chat": journal.clean(PI_SERVICE_MODEL, 120), "transcription": journal.clean(STT_MODEL, 120), "speech": journal.clean(TTS_MODEL, 120)}
    return activity


@app.delete("/api/parents/activity", dependencies=[Depends(authenticate)])
async def parent_clear():
    try:
        await asyncio.to_thread(journal.store.delete)
    except Exception:
        raise HTTPException(status_code=503, detail="Le journal n’a pas pu être effacé.")
    return {"ok": True}


@app.get('/api/parents/metrics', dependencies=[Depends(authenticate)])
async def parent_metrics(period: str = '7d'):
    if period not in {'24h', '7d', '30d'}:
        raise HTTPException(status_code=400, detail='Invalid period')
    try:
        return await asyncio.to_thread(journal.store.metrics, period)
    except Exception:
        raise HTTPException(status_code=503, detail='Les graphiques sont indisponibles.')


class ProfileEdit(BaseModel):
    content: str = Field(max_length=8000)
    revision: str | None = Field(default=None, max_length=64)


async def _parent_profiles(method, filename=None, body=None):
    if filename is not None and filename not in {'USER.md', 'SOUL.md', 'SYSTEM.md', 'MEMORY.md', 'profile.json'}:
        raise HTTPException(status_code=400, detail='Unknown profile file')
    headers = {'Authorization': f'Bearer {PI_SERVICE_API_KEY}'} if PI_SERVICE_API_KEY else {}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.request(method, f'{PI_SERVICE_BASE_URL}/parents/context' + (f'/{filename}' if filename else ''), headers=headers, json=body)
        if response.is_error:
            raise HTTPException(status_code=response.status_code if response.status_code in {400, 403, 409, 413} else 503, detail='Le profil n’a pas pu être lu ou enregistré.')
        return response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(status_code=503, detail='Le service de profil est indisponible.')


@app.get('/api/parents/profile', dependencies=[Depends(authenticate)])
async def parent_profiles():
    return await _parent_profiles('GET')


@app.put('/api/parents/profile/{filename}', dependencies=[Depends(authenticate)])
async def parent_save_profile(filename: str, body: ProfileEdit):
    return await _parent_profiles('PUT', filename, body.model_dump())


@app.delete("/api/parents/sessions/{session_id}", dependencies=[Depends(authenticate)])
async def parent_delete_session(session_id: str):
    try:
        session_id = str(uuid.UUID(session_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    try:
        await asyncio.to_thread(journal.store.delete, session_id)
    except Exception:
        raise HTTPException(status_code=503, detail="Cette conversation n’a pas pu être effacée.")
    return {"ok": True}


# Mounted last so API routes always take precedence. It also serves setup.html,
# the manifest, icons, and the child interface from the same origin.
DIST_DIR = Path(os.getenv("WEB_DIST", str(Path(__file__).parent.parent / "dist"))).resolve()
app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="pwa")
