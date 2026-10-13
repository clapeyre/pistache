# A few French transcription tests at home

On 8 October 2026, we tried 25 models through OpenRouter with the same 15 short
recordings from one child. Some questions were repeated. This helped us pick a
transcription model for Pistache; it’s a small home experiment, not a leaderboard.
YMMV, especially with a different child, microphone or style of speaking.

Two ways of scoring gave slightly different pictures:

- **Literal WER**: how closely the model wrote what was actually said, including
  hesitations, repeated words and half-finished syllables.
- **Clean WER**: how close it was to a manually tidied version of those sentences.
  This rewards smoother wording; it doesn’t tell us whether the model understood.

Lower is better. Fish Audio did best on the literal score in this run. GPT Transcribe
and Whisper-1 did best on the cleaned score. That difference was interesting to us:
preserving speech and tidying it up aren’t quite the same job.

| Model | Successful / attempted | Scored clips | Literal WER | Clean WER | Clean exact | Median seconds | P95 seconds | Run USD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fish-audio/transcribe-1-pro | 15/15 | 14 | 2.4% | 8.7% | 10 | 0.80 | 1.39 | 0.00940 |
| microsoft/mai-transcribe-1.5 | 15/15 | 14 | 3.2% | 8.7% | 10 | 1.07 | 1.58 | 0.00940 |
| google/chirp-3 | 15/15 | 14 | 4.0% | 6.1% | 10 | 1.84 | 2.99 | 0.02507 |
| google/gemini-3.5-transcribe | 15/15 | 14 | 4.8% | 10.4% | 10 | 2.30 | 3.14 | 0.00439 |
| microsoft/mai-transcribe-2 | 15/15 | 14 | 5.6% | 11.3% | 9 | 2.23 | 6.55 | 0.00261 |
| elevenlabs/scribe-v2 | 15/15 | 14 | 7.2% | 13.0% | 9 | 0.98 | 1.62 | 0.00266 |
| openai/gpt-transcribe | 15/15 | 14 | 9.6% | 1.7% | 12 | 0.65 | 1.44 | 0.00705 |
| openai/whisper-1 | 15/15 | 14 | 9.6% | 1.7% | 12 | 1.20 | 1.52 | 0.00940 |
| nvidia/parakeet-tdt-0.6b-v3 | 15/15 | 14 | 9.6% | 7.0% | 10 | 0.49 | 0.73 | 0.00217 |
| deepgram/nova-3 | 15/15 | 14 | 9.6% | 13.9% | 7 | 0.53 | 1.56 | 0.00623 |
| qwen/qwen3-asr-flash-2026-02-10 | 15/15 | 14 | 11.2% | 4.3% | 12 | 1.45 | 1.99 | 0.00276 |
| openai/gpt-4o-mini-transcribe | 15/15 | 14 | 12.0% | 5.2% | 11 | 0.63 | 0.81 | 0.00204 |
| openai/whisper-large-v3 | 15/15 | 14 | 12.0% | 5.2% | 12 | 0.60 | 5.68 | 0.00400 |
| assemblyai/universal-3-5-pro | 15/15 | 14 | 12.0% | 7.8% | 11 | 0.39 | 0.85 | 0.01086 |
| qwen/qwen3-asr-0.6b | 15/15 | 14 | 12.8% | 5.2% | 10 | 0.79 | 1.51 | 0.00029 |
| mistralai/voxtral-small-24b-2507-stt | 15/15 | 14 | 13.6% | 7.0% | 10 | 1.10 | 1.94 | 0.00435 |
| mistralai/voxtral-mini-transcribe | 15/15 | 14 | 13.6% | 7.0% | 11 | 0.35 | 0.97 | 0.00395 |
| fish-audio/transcribe-1 | 15/15 | 14 | 14.4% | 7.0% | 11 | 0.53 | 1.05 | 0.00940 |
| openai/gpt-4o-transcribe | 15/15 | 14 | 14.4% | 7.0% | 9 | 0.71 | 0.97 | 0.00403 |
| qwen/qwen3-asr-1.7b | 15/15 | 14 | 15.2% | 7.8% | 11 | 0.62 | 1.19 | 0.00065 |
| mistralai/voxtral-mini-3b-2507 | 15/15 | 14 | 17.6% | 10.4% | 9 | 0.58 | 1.04 | 0.00145 |
| nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b | 15/15 | 14 | 17.6% | 15.7% | 7 | 2.57 | 3.65 | 0.00029 |
| openai/whisper-large-v3-turbo | 15/15 | 14 | 62.4% | 62.6% | 2 | 1.25 | 10.09 | 0.00047 |
| x-ai/grok-stt-1.0 | 14/15 | 13 | 13.3% | 16.4% | 7 | 0.63 | 1.11 | 0.00231 |
| meta/muse-voice-transcribe-1.0 | 0/1 | 0 | — | — | 0 | — | — | 0.00000 |

We used identical 16 kHz mono PCM16 WAV inputs, a French language hint, and no
reference text or question prompt. Scoring ignored case, accents, punctuation,
speaker tags and bracketed audio annotations. One clip had an unclear passage, so
14 clips went into the aggregate scores. WER is total word edits divided by total
reference words. Hypotheses weren’t tidied before scoring.

Each model got one request per clip, with four requests in flight and no retries.
Times include network and OpenRouter routing. Costs are the reported total for
this run, not a price list. The two models that didn’t finish all 15 clips aren’t
directly comparable with the rest. With so few clips, don’t read much into small
differences or the P95 timings.

The recordings and transcripts stay private, so the exact test can’t be rerun from
this repo. [The aggregate JSON](transcription-summary.json) has the same numbers.
These were transcription tests, not tests of Pistache’s replies or tools.
