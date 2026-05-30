"""Sociafy Voice engine — zero-shot voice cloning (clone TTS) + reference
validation/transcription. The underlying model is intentionally not named in
any user-facing string; only this internal module references the package.

Deploy:  modal deploy modal/voice_engine.py
Then set MODAL_VOICE_ENGINE_URL to the printed `fastapi_app` URL and
MODAL_WEBHOOK_SECRET to the sociafy-engine ENGINE_SECRET.

Routes (one base URL):
  POST /voice/prepare   { refAudioUrl }                  -> validate + transcribe (sync)
  POST /tts/submit      { refAudioUrl, refText, text }   -> { callId }
  GET  /tts/result?callId=...                            -> { status, audioUrl?, error? }
"""

import uuid

import modal
from fastapi import FastAPI, Header

from common import require_secret, upload_r2, download_tmp

app = modal.App("sociafy-voice-engine")
weights = modal.Volume.from_name("sociafy-voice-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.8.0",
        "torchaudio==2.8.0",
        "soundfile",
        "boto3",
        "fastapi[standard]",
        "faster-whisper",
        "omnivoice",  # zero-shot TTS package (name not exposed to users)
    )
)
secrets = [modal.Secret.from_name("sociafy-r2"), modal.Secret.from_name("sociafy-engine")]


@app.cls(gpu="L4", image=image, volumes={"/weights": weights}, secrets=secrets, scaledown_window=120)
class VoiceEngine:
    @modal.enter()
    def load(self):
        import torch
        from omnivoice import OmniVoice
        from faster_whisper import WhisperModel

        self.tts = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
        self.whisper = WhisperModel("large-v3", device="cuda", compute_type="float16")

    @modal.method()
    def synth(self, ref_audio_url: str, ref_text: str, text: str) -> str:
        import soundfile as sf

        ref = download_tmp(ref_audio_url, "wav")
        audio = self.tts.generate(text=text, ref_audio=ref, ref_text=ref_text)
        out = f"/tmp/{uuid.uuid4().hex}.wav"
        sf.write(out, audio[0], 24000)
        return upload_r2(out, f"tts/{uuid.uuid4().hex}.wav", "audio/wav")

    @modal.method()
    def prepare(self, ref_audio_url: str) -> dict:
        import soundfile as sf

        path = download_tmp(ref_audio_url, "wav")
        info = sf.info(path)
        dur = info.frames / float(info.samplerate)
        if dur < 8:
            return {"ok": False, "error": "too_short"}
        if dur > 60:
            return {"ok": False, "error": "too_long"}
        segments, lang = self.whisper.transcribe(path)
        transcript = " ".join(s.text for s in segments).strip()
        if not transcript:
            return {"ok": False, "error": "no_speech"}
        return {"ok": True, "durationS": round(dur, 1), "transcript": transcript, "language": lang.language}


web_app = FastAPI()


@web_app.post("/voice/prepare")
def voice_prepare(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    return VoiceEngine().prepare.remote(item["refAudioUrl"])


@web_app.post("/tts/submit")
def tts_submit(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    call = VoiceEngine().synth.spawn(item["refAudioUrl"], item.get("refText", ""), item["text"])
    return {"callId": call.object_id}


@web_app.get("/tts/result")
def tts_result(callId: str, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    fc = modal.FunctionCall.from_id(callId)
    try:
        return {"status": "done", "audioUrl": fc.get(timeout=0)}
    except TimeoutError:
        return {"status": "pending"}
    except Exception as e:  # noqa: BLE001 — surface a short reason to the poller
        return {"status": "failed", "error": str(e)[:300]}


@app.function(image=image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
