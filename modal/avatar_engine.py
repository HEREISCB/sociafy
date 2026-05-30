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
import urllib.request
import uuid

import modal
from fastapi import FastAPI, Header, HTTPException


# --- inlined helpers (Modal mounts only this entrypoint file) ---
def require_secret(x_engine_secret):
    expected = os.environ.get("ENGINE_SECRET")
    if not expected or x_engine_secret != expected:
        raise HTTPException(status_code=401, detail="bad_secret")


def upload_r2(local_path: str, key: str, content_type: str) -> str:
    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    client.upload_file(local_path, os.environ["R2_BUCKET_NAME"], key, ExtraArgs={"ContentType": content_type})
    base = os.environ["R2_PUBLIC_URL_BASE"].rstrip("/")
    return f"{base}/{key}"


def download_tmp(url: str, suffix: str) -> str:
    path = f"/tmp/{uuid.uuid4().hex}.{suffix}"
    urllib.request.urlretrieve(url, path)
    return path

app = modal.App("sociafy-avatar-engine")
weights = modal.Volume.from_name("sociafy-avatar-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "libsndfile1")
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
    # Prebuilt flash-attn wheel (matches torch 2.6 / cu12 / py310) — avoids a
    # from-source build that would need the CUDA toolkit at image-build time.
    .pip_install(
        "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/"
        "flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl"
    )
    .run_commands(
        "git clone --depth 1 https://github.com/meituan-longcat/LongCat-Video /opt/engine",
        # The repo's requirement files include system libs (libsndfile1, via apt)
        # flash-attn (prebuilt wheel above), and serving-only packages that
        # aren't on PyPI (e.g. tritonserverclient). Install line-by-line and
        # tolerate failures so one unresolvable serving extra can't kill the
        # build — the core inference deps (torch/diffusers/transformers/…)
        # install fine, and a genuinely-missing dep will surface at render time.
        "cat /opt/engine/requirements.txt /opt/engine/requirements_avatar.txt "
        "| sed 's/#.*//' | grep -viE 'libsndfile1|flash[-_]attn|tritonserverclient' "
        "| sed '/^[[:space:]]*$/d' "
        "| while read -r pkg; do pip install \"$pkg\" || echo \"SKIP $pkg\"; done",
    )
)
secrets = [
    modal.Secret.from_name("sociafy-r2"),
    modal.Secret.from_name("sociafy-engine"),
    modal.Secret.from_name("huggingface"),  # authenticated HF model downloads
]

# Light image for the web/router layer so endpoints cold-start in ~seconds.
# Only the GPU class below needs the heavy avatar image.
web_image = modal.Image.debian_slim(python_version="3.10").pip_install("fastapi[standard]")

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
        import soundfile as sf

        img = download_tmp(payload["imageUrl"], "png")
        audio = self._audio_for(payload)
        quality = payload.get("quality", "720p")
        resolution = "720p" if quality == "720p" else "480p"

        # Match the repo's input-JSON schema (assets/avatar/single_example_1.json):
        # { prompt, cond_image, cond_audio: { person1 } }. We always have a face
        # photo, so this is the audio-image-to-video (ai2v) path.
        work = f"/tmp/{uuid.uuid4().hex}"
        os.makedirs(work, exist_ok=True)
        spec = {
            "prompt": payload.get("prompt") or "A person speaking naturally to the camera, looking ahead.",
            "cond_image": img,
            "cond_audio": {"person1": audio},
        }
        input_json = f"{work}/input.json"
        with open(input_json, "w") as f:
            json.dump(spec, f)  # the demo script reads a single object, not a list

        # Segments roughly track audio length so longer scripts aren't truncated.
        try:
            dur = sf.info(audio).frames / float(sf.info(audio).samplerate)
        except Exception:
            dur = 5.0
        num_segments = max(1, min(8, round(dur / 5.0)))

        out_dir = f"{work}/out"
        os.makedirs(out_dir, exist_ok=True)
        # Distilled 8-step int8 path (single H100). If this OOMs, switch the
        # class to gpu="A100-80GB:2" and add --context_parallel_size=2 (and run
        # via torchrun --nproc_per_node=2).
        proc = subprocess.run(
            [
                "python", "/opt/engine/run_demo_avatar_single_audio_to_video.py",
                "--checkpoint_dir", CKPT,
                "--stage_1", "ai2v",
                "--input_json", input_json,
                "--output_dir", out_dir,
                "--resolution", resolution,
                "--num_segments", str(num_segments),
                "--model_type", "avatar-v1.5",
                "--use_distill",
                "--use_int8",
            ],
            cwd="/opt/engine",
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            # Surface the tail of stderr so failures aren't opaque to the poller.
            raise RuntimeError(f"inference_failed: {(proc.stderr or proc.stdout)[-600:]}")

        # save_video_ffmpeg writes ai2v_demo_1.mp4 (it appends the extension).
        mp4 = next(
            (os.path.join(out_dir, f) for f in sorted(os.listdir(out_dir)) if f.endswith(".mp4")),
            None,
        )
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


@app.function(image=web_image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
