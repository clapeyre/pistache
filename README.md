# Pistache

A small French-speaking companion I built for my kid. There’s a frog, a button
to talk, and a couple of little tools for exploring words and doing arithmetic.
I had fun making it, so here it is.

This is a snapshot of what we’re using at home, with our family’s details and
deployment plumbing taken out. It’s a hobby project, still finding its feet.

## What’s inside?

- A browser app: tap to start talking, tap again when you’re done. Pauses are fine.
  You can also type, replay replies, and install it as a PWA.
- A **Python bridge**: the browser’s small backend. It sends recordings for
  transcription, passes the conversation to Pi, and turns the reply into audio.
- A **Pi service**: uses the Pi agent runtime, with just two tools:
  `show_word` displays a word and its letters; `calculate` handles simple arithmetic.
  Pi’s usual shell and filesystem tools are disabled.
- A separate adult recorder page for collecting your own test phrases locally.
  It doesn’t send those recordings to the chat service.

```text
Browser → Python bridge → Pi service → Bifrost → chat model
               └────────────────────→ Bifrost → transcription / speech
```

Here, “Pi” means the agent runtime from `@earendil-works/pi-coding-agent`,
not Raspberry Pi hardware. It’s an intentional part of the design: Pi handles
the conversation and tool loop, while the gateway handles model access.
Pi is pinned to 0.84.4 in this snapshot.

## Try it

You’ll need Docker Compose and your own reachable **Bifrost** gateway.
Bifrost is external to this stack for now. No home server, Traefik or existing
Docker networks are assumed.

1. Copy `.env.example` to `.env`.
2. Set your gateway URLs and a scoped gateway key in `.env`.
3. Configure the model routes in Bifrost, then run:

```sh
docker compose up --build
```

Open **http://localhost:8765**. Start with a typed message, then try voice.
The gateway address in the example is a placeholder: replace it with yours.
Chat and speech URLs include `/v1`. The gateway must be reachable from inside
the containers. If it runs on your host machine, use an address reachable from Docker.

The example uses these routes; change them in `.env` if you prefer:

| Setting | Example | What to configure in Bifrost |
|---|---|---|
| `BIFROST_MODEL` | `pistache-chat` | An alias pointing to a chat model with tool calling |
| `STT_MODEL` | `openrouter/openai/gpt-transcribe` | An OpenRouter transcription route |
| `TTS_MODEL` | `openrouter/pistache-tts` | An OpenRouter alias pointing to `hexgrad/kokoro-82m` |
| `TTS_VOICE` | `ff_siwis` | The French Kokoro voice used at home |

Give the gateway key access to those routes and their provider keys. Your provider
keys stay in Bifrost; the browser never gets them. This repository doesn’t include
a Bifrost configuration export. Docker users on the host can inspect container
environment variables; the services also support `_API_KEY_FILE` settings if you
prefer mounted secret files.

Compose binds the browser backend to loopback and keeps Pi on the internal network.
For a phone or tablet, put it behind your own private HTTPS access (a VPN or an
authenticated proxy, for example). Browsers need HTTPS for microphone access away
from localhost. `AUTH_MODE=network` relies on that private access layer; keep this
example local rather than opening its port to the internet.

## Make it yours

`examples/context/` contains a generic persona and profile. Copy those files into
`local/context/`, edit them, and set `CONTEXT_DIR=./local/context` in `.env`.
The profile is read-only at runtime. Pi's conversation context lives in RAM;
there’s no persistent learning or memory-writing feature yet. The separate parent
journal below keeps a record to look back on, without feeding it back into Pi.

## Pistache, côté parents

Open **Réglages adultes → Pistache, côté parents** (or `/parents.html`).
It shows recent conversations, word/math tools, and how long transcription,
Pi's reply and speech synthesis took. Failed voice turns keep any transcript and
reply already produced, with the stage that failed. “Réponse prête” means the
server finished, not that the speaker on your device played it.

The journal stays on your server in SQLite. Compose gives it a persistent
`parent-journal` volume; native runs use `local/parents.sqlite3`, or set
`PARENTS_DB_PATH` to another local path. No recordings or generated audio are
saved in this journal. It keeps up to 1,000 exchanges for 30 days; adjust
`PARENTS_MAX_TURNS` and `PARENTS_RETENTION_DAYS` in `.env`. Expiry runs when
the journal is read or a turn is saved. The page shows the latest 200 exchanges.

You can erase a conversation or the whole journal. That removes journal entries,
including preventing already-running turns from bringing them back; it doesn't
reset Pi's current conversation or erase copies you made separately. Turn recording
continues for new conversations. A storage hiccup won't stop the child chatting;
the parent page will report when the journal can't be read.

There’s no extra parent password: this page uses the same private access as the
rest of Pistache. Anyone who can reach your private site can read or erase the
journal, including a child using that site. Keep it behind that private access.
Text, keys and recordings still stay out of Git; SQLite files are ignored too.

Actual voice turns go to the configured models. The adult recorder page is separate:
it keeps its clips and manual transcripts in that browser’s IndexedDB until you
export or delete them. Browser storage can disappear, so export anything you want
to keep. Please keep your own recordings, profiles and keys out of Git; `local/`,
secrets, audio exports and backups are ignored here.

## Why Bifrost? Could I use something else?

It was already running at home. The first public version keeps that working path.
The calls use OpenAI-style endpoints: streamed chat completions with tool calls,
audio transcription, and speech synthesis. Changing the chat gateway should be
a small adaptation. Voice depends on the replacement offering compatible audio
endpoints too. We haven’t tested other gateways yet, and the environment variables
are still named after Bifrost. A bundled Bifrost example can come later.

## A few tests at home

We tried 25 transcription models on 15 short French recordings from one child.
Some kept the hesitations better; others produced tidier sentences.
See [the results](docs/transcription-tests.md). It’s a small home experiment: YMMV.
The recordings and transcripts stay private; only aggregate numbers are included.

## Development

Python 3.11+ and Node.js 22+:

```sh
python -m venv .venv
# Activate .venv, then:
python -m pip install -r bridge/requirements.txt
python -m pytest tests
cd pi-service
npm ci --ignore-scripts
npm test
```

The tests use fake providers rather than real keys or children’s recordings.
They cover the bridge/Pi contract, tool limits, context handling and authentication.
Real microphone and speaker behavior still needs a check on your device.

## License

[MIT](LICENSE). Dependencies keep their own licenses. Have fun with it.
