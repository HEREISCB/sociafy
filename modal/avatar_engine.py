"""Sociafy Avatar engine — audio-driven talking-head video. The underlying
model is never named to users; only this internal module references the repo.

Single-pipeline: when given a voice reference + script, it first synthesizes
speech by calling the already-deployed voice engine, then animates the face
photo to that audio. When given an audioUrl it skips synthesis.

Deploy:  modal deploy modal/avatar_engine.py
Then set MODAL_AVATAR_ENGINE_URL to the printed `fastapi_app` URL.

Routes (one base URL):
  POST /avatar/submit  { imageUrl, voice?{refAudioUrl,refText}, script?, audioUrl?,
                         prompt?, aspect, quality, expressive? }  -> { callId }
  GET  /avatar/result?callId=...                                 -> { status, videoUrl?, error? }

DEPLOY-TIME RECONCILIATION: the render() body invokes the cloned repo's avatar
inference entrypoint. Confirm the exact script name + flags against the repo
checked into the image (run_demo_avatar_single_audio_to_video.py) and the
checkpoint layout under /weights, then lock pricing via the benchmark step.
"""

import json
import os
import subprocess
import uuid

import modal
from fastapi import FastAPI, Header

from common import require_secret, upload_r2, download_tmp

app = modal.App("sociafy-avatar-engine")
weights = modal.Volume.from_name("sociafy-avatar-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg")
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "torchaudio==2.6.0",
        "huggingface_hub",
        "librosa",
        "soundfile",
        "boto3",
        "fastapi[standard]",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/meituan-longcat/LongCat-Video /opt/engine",
        "pip install -r /opt/engine/requirements.txt",
        "pip install -r /opt/engine/requirements_avatar.txt",
        "pip install flash-attn==2.7.4.post1 --no-build-isolation",
    )
)
secrets = [modal.Secret.from_name("sociafy-r2"), modal.Secret.from_name("sociafy-engine")]

CKPT = "/weights/avatar-1.5"


@app.cls(gpu="H100", image=image, volumes={"/weights": weights}, secrets=secrets, timeout=1800, scaledown_window=180)
class AvatarEngine:
    @modal.enter()
    def load(self):
        # Download the (unnamed-to-users) avatar checkpoint once into the Volume.
        if not os.path.isdir(CKPT):
            from huggingface_hub import snapshot_download

            snapshot_download("meituan-longcat/LongCat-Video-Avatar-1.5", local_dir=CKPT)
            weights.commit()

    def _audio_for(self, payload: dict) -> str:
        """Resolve the driving audio: synthesize via the voice engine when a
        voice reference + script are supplied, else use the provided track."""
        voice = payload.get("voice")
        script = payload.get("script")
        if voice and script:
            VoiceEngine = modal.Cls.from_name("sociafy-voice-engine", "VoiceEngine")
            audio_url = VoiceEngine().synth.remote(voice["refAudioUrl"], voice.get("refText", ""), script)
            return download_tmp(audio_url, "wav")
        return download_tmp(payload["audioUrl"], "wav")

    @modal.method()
    def render(self, payload: dict) -> str:
        img = download_tmp(payload["imageUrl"], "png")
        audio = self._audio_for(payload)
        quality = payload.get("quality", "720p")
        resolution = "720P" if quality == "720p" else "480P"

        work = f"/tmp/{uuid.uuid4().hex}"
        os.makedirs(work, exist_ok=True)
        spec = {
            "image_path": img,
            "audio_path": audio,
            "prompt": payload.get("prompt") or "A person speaking naturally to the camera.",
            "resolution": resolution,
            "aspect_ratio": payload.get("aspect", "9:16"),
            "expressive": bool(payload.get("expressive", False)),
        }
        input_json = f"{work}/input.json"
        with open(input_json, "w") as f:
            json.dump([spec], f)

        out_dir = f"{work}/out"
        os.makedirs(out_dir, exist_ok=True)
        # Distilled 8-step int8 path (single H100). If this OOMs, switch the
        # class to gpu="A100-80GB:2" and add --context_parallel_size=2.
        subprocess.run(
            [
                "python", "/opt/engine/run_demo_avatar_single_audio_to_video.py",
                "--checkpoint_dir", CKPT,
                "--stage_1", "at2v",
                "--input_json", input_json,
                "--output_dir", out_dir,
                "--model_type", "avatar-v1.5",
                "--use_distill",
                "--use_int8",
            ],
            check=True,
            cwd="/opt/engine",
        )

        mp4 = next((os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".mp4")), None)
        if not mp4:
            raise RuntimeError("avatar_no_output")
        return upload_r2(mp4, f"avatar/{uuid.uuid4().hex}.mp4", "video/mp4")


web_app = FastAPI()


@web_app.post("/avatar/submit")
def avatar_submit(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    call = AvatarEngine().render.spawn(item)
    return {"callId": call.object_id}


@web_app.get("/avatar/result")
def avatar_result(callId: str, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    fc = modal.FunctionCall.from_id(callId)
    try:
        return {"status": "done", "videoUrl": fc.get(timeout=0)}
    except TimeoutError:
        return {"status": "pending"}
    except Exception as e:  # noqa: BLE001 — surface a short reason to the poller
        return {"status": "failed", "error": str(e)[:300]}


@app.function(image=image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
