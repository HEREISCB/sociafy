"""Sociafy Avatar engine — audio-driven talking-head video via headless ComfyUI
running LTX-2.3 (image + audio -> lip-synced video). Runs on an L40S (no H100).

The underlying model is never named to users. Single-pipeline: given a voice
reference + script it first synthesizes speech via the (already-deployed) voice
engine, then animates the face photo to that audio with LTX-2.3 ia2v.

Deploy:  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal/avatar_engine.py
Routes:  POST /avatar/submit {imageUrl, voice?{refAudioUrl,refText}, script?,
         audioUrl?, prompt?, aspect, quality} -> {callId}
         GET  /avatar/result?callId=... -> {status, videoUrl?, error?}
"""

import json
import os
import time
import urllib.request
import uuid

import modal
from fastapi import FastAPI, Header, HTTPException

app = modal.App("sociafy-avatar-engine")
models_vol = modal.Volume.from_name("sociafy-comfy-models", create_if_missing=True)
MODELS_DIR = "/models"
COMFY = "/root/comfy/ComfyUI"


# --- inlined helpers (Modal mounts only the entrypoint file) ---
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


# LTX-2.3 models. (repo, repo_filename, comfy_subfolder). repo_filename may
# include a subpath; we store under the basename in the comfy subfolder.
CKPT = "ltx-2.3-22b-dev-fp8.safetensors"
TEXT_ENCODER = "gemma_3_12B_it_fp4_mixed.safetensors"
DISTILL_LORA = "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors"
MODELS = [
    ("Lightricks/LTX-2.3-fp8", CKPT, "checkpoints"),
    ("Comfy-Org/ltx-2", f"split_files/text_encoders/{TEXT_ENCODER}", "text_encoders"),
    ("Comfy-Org/ltx-2.3", f"split_files/loras/{DISTILL_LORA}", "loras"),
]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install("comfy-cli", "huggingface_hub", "boto3", "soundfile", "requests", "fastapi")
    .run_commands(
        "comfy --skip-prompt install --nvidia --version latest --cuda-version 12.4 || comfy --skip-prompt install --nvidia",
        # LTX nodes are largely in ComfyUI core now; add the official node pack as
        # a safety net for any ia2v node not yet in core.
        f"git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo {COMFY}/custom_nodes/ComfyUI-LTXVideo",
        f"pip install -r {COMFY}/custom_nodes/ComfyUI-LTXVideo/requirements.txt || true",
    )
)

secrets = [
    modal.Secret.from_name("sociafy-r2"),
    modal.Secret.from_name("sociafy-engine"),
    modal.Secret.from_name("huggingface"),
]
web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


def _ref(node_id, slot=0):
    return [str(node_id), slot]


def build_ltx_ia2v_prompt(img_name, audio_name, prompt_text, w, h, length, fps, duration):
    """Hand-authored minimal LTX-2.3 image+audio->video API graph."""
    neg = "blurry, low quality, distorted, deformed, static frame, watermark, text, subtitles"
    g = {
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "te": {"class_type": "LTXAVTextEncoderLoader", "inputs": {"text_encoder": TEXT_ENCODER, "ckpt_name": CKPT, "device": "default"}},
        "lora": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": _ref("ckpt", 0), "lora_name": DISTILL_LORA, "strength_model": 0.5}},
        "avae": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": CKPT}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": _ref("te", 0), "text": prompt_text}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": _ref("te", 0), "text": neg}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {"positive": _ref("pos", 0), "negative": _ref("neg", 0), "frame_rate": float(fps)}},
        "img": {"class_type": "LoadImage", "inputs": {"image": img_name}},
        "pre": {"class_type": "LTXVPreprocess", "inputs": {"image": _ref("img", 0), "img_compression": 18}},
        "emptyvid": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": w, "height": h, "length": length, "batch_size": 1}},
        "vid_guide": {"class_type": "LTXVImgToVideoInplace", "inputs": {"vae": _ref("ckpt", 2), "image": _ref("pre", 0), "latent": _ref("emptyvid", 0), "strength": 1.0, "bypass": False}},
        "trim": {"class_type": "TrimAudioDuration", "inputs": {"audio": _ref("loadaudio", 0), "start_index": 0.0, "duration": float(duration)}},
        "aenc": {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": _ref("trim", 0), "audio_vae": _ref("avae", 0)}},
        "mask": {"class_type": "SolidMask", "inputs": {"value": 0.0, "width": w, "height": h}},
        "amask": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": _ref("aenc", 0), "mask": _ref("mask", 0)}},
        "concat": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": _ref("vid_guide", 0), "audio_latent": _ref("amask", 0)}},
        "loadaudio": {"class_type": "LoadAudio", "inputs": {"audio": audio_name}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
        "guider": {"class_type": "CFGGuider", "inputs": {"model": _ref("lora", 0), "positive": _ref("cond", 0), "negative": _ref("cond", 1), "cfg": 1.0}},
        "sampler": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "sigmas": {"class_type": "ManualSigmas", "inputs": {"sigmas": "1.0, 0.99375, 0.9875, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
        "sample": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": _ref("noise", 0), "guider": _ref("guider", 0), "sampler": _ref("sampler", 0), "sigmas": _ref("sigmas", 0), "latent_image": _ref("concat", 0)}},
        "sep": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": _ref("sample", 0)}},
        "vdec": {"class_type": "VAEDecode", "inputs": {"samples": _ref("sep", 0), "vae": _ref("ckpt", 2)}},
        "adec": {"class_type": "LTXVAudioVAEDecode", "inputs": {"samples": _ref("sep", 1), "audio_vae": _ref("avae", 0)}},
        "mkvid": {"class_type": "CreateVideo", "inputs": {"images": _ref("vdec", 0), "audio": _ref("adec", 0), "fps": float(fps)}},
        "save": {"class_type": "SaveVideo", "inputs": {"video": _ref("mkvid", 0), "filename_prefix": "sociafy_avatar", "format": "auto", "codec": "auto"}},
    }
    return g


@app.cls(gpu="L40S", image=image, volumes={MODELS_DIR: models_vol}, secrets=secrets, timeout=1800, scaledown_window=180)
class AvatarEngine:
    @modal.enter()
    def start(self):
        import subprocess
        import requests
        from huggingface_hub import hf_hub_download

        for repo, fname, sub in MODELS:
            dest_dir = os.path.join(MODELS_DIR, sub)
            os.makedirs(dest_dir, exist_ok=True)
            dest = os.path.join(dest_dir, os.path.basename(fname))
            if not os.path.exists(dest):
                print(f"[models] downloading {repo}/{fname} -> {sub}")
                p = hf_hub_download(repo_id=repo, filename=fname, local_dir=os.path.join(MODELS_DIR, "_dl"))
                os.replace(p, dest)
            comfy_dir = os.path.join(COMFY, "models", sub)
            os.makedirs(comfy_dir, exist_ok=True)
            link = os.path.join(comfy_dir, os.path.basename(fname))
            if not os.path.exists(link):
                os.symlink(dest, link)
        models_vol.commit()

        self.proc = subprocess.Popen(
            ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
            cwd=COMFY,
        )
        for _ in range(120):
            try:
                if requests.get("http://127.0.0.1:8188/system_stats", timeout=2).ok:
                    print("[comfy] up")
                    break
            except Exception:
                time.sleep(2)
        else:
            raise RuntimeError("comfyui_failed_to_start")

    def _audio_for(self, payload: dict) -> str:
        voice = payload.get("voice")
        script = payload.get("script")
        if voice and script:
            VoiceEngine = modal.Cls.from_name("sociafy-voice-engine", "VoiceEngine")
            audio_url = VoiceEngine().synth.remote(voice["refAudioUrl"], voice.get("refText", ""), script)
            return download_tmp(audio_url, "wav")
        return download_tmp(payload["audioUrl"], "wav")

    @modal.method()
    def render(self, payload: dict) -> str:
        import shutil
        import requests
        import soundfile as sf

        img = download_tmp(payload["imageUrl"], "png")
        audio = self._audio_for(payload)
        aspect = payload.get("aspect", "9:16")
        w, h = {"9:16": (512, 768), "1:1": (640, 640), "16:9": (768, 512)}.get(aspect, (512, 768))

        try:
            dur = min(10.0, sf.info(audio).frames / float(sf.info(audio).samplerate))
        except Exception:
            dur = 5.0
        fps = 24
        length = (int(round(dur * fps)) // 8) * 8 + 1

        in_dir = os.path.join(COMFY, "input")
        os.makedirs(in_dir, exist_ok=True)
        shutil.copy(img, os.path.join(in_dir, os.path.basename(img)))
        shutil.copy(audio, os.path.join(in_dir, os.path.basename(audio)))

        prompt_text = payload.get("prompt") or "A person speaking naturally to the camera, looking ahead, subtle head movement."
        graph = build_ltx_ia2v_prompt(os.path.basename(img), os.path.basename(audio), prompt_text, w, h, length, fps, dur)

        cid = uuid.uuid4().hex
        r = requests.post("http://127.0.0.1:8188/prompt", json={"prompt": graph, "client_id": cid}, timeout=60)
        if not r.ok:
            raise RuntimeError(f"prompt_rejected: {r.text[:600]}")
        pid = r.json()["prompt_id"]

        for _ in range(360):
            time.sleep(5)
            try:
                # ComfyUI's server is single-threaded; while it's loading the
                # 22B model or sampling it won't answer, so tolerate timeouts.
                h_resp = requests.get(f"http://127.0.0.1:8188/history/{pid}", timeout=30).json()
            except Exception:
                continue
            if pid in h_resp:
                entry = h_resp[pid]
                st = entry.get("status", {})
                if st.get("status_str") == "error":
                    raise RuntimeError(f"comfy_error: {json.dumps(st)[:700]}")
                for _node, out in entry.get("outputs", {}).items():
                    vids = out.get("videos") or out.get("gifs") or []
                    if vids:
                        fn = vids[0]["filename"]
                        sub = vids[0].get("subfolder", "")
                        path = os.path.join(COMFY, "output", sub, fn)
                        if os.path.exists(path):
                            return upload_r2(path, f"avatar/{uuid.uuid4().hex}.mp4", "video/mp4")
                if st.get("completed"):
                    raise RuntimeError("avatar_completed_without_video")
        raise RuntimeError("avatar_timeout")


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
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "error": str(e)[:700]}


@app.function(image=web_image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
