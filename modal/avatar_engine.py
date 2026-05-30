"""Sociafy Avatar engine — audio-driven talking-head video via headless ComfyUI
with the GGUF-quantized avatar model (runs on a mid-range GPU, not an H100).

The underlying model is never named to users; only this internal module
references the repos. Single-pipeline: given a voice reference + script it first
synthesizes speech via the (already-deployed) voice engine, then animates the
face photo to that audio with the official WanVideoWrapper LongCat-avatar graph.

Deploy:  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal/avatar_engine.py
Routes (one base URL):
  POST /avatar/submit  {imageUrl, voice?{refAudioUrl,refText}, script?, audioUrl?,
                        prompt?, aspect, quality}  -> {callId}
  GET  /avatar/result?callId=...                  -> {status, videoUrl?, error?}
"""

import json
import os
import time
import urllib.request
import uuid

import modal
from fastapi import FastAPI, Header, HTTPException

app = modal.App("sociafy-avatar-engine")
# Models live in a Volume so they download once and persist across cold starts.
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


# Support models + where each lands under ComfyUI/models. Paths are best-known;
# if a loader reports "not in list", fix the (repo, file, dest) here.
GGUF_FILE = "LongCat-Avatar-15_comfy-Q4_K_M.gguf"
MODELS = [
    ("vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI", GGUF_FILE, "diffusion_models"),
    ("Kijai/WanVideo_comfy", "Wan2_1_VAE_bf16.safetensors", "vae"),
    ("Kijai/WanVideo_comfy", "umt5-xxl-enc-bf16.safetensors", "text_encoders"),
    ("Kijai/WanVideo_comfy", "LongCat_distill_lora_rank128_bf16.safetensors", "loras"),
    ("Kijai/WanVideo_comfy", "MelBandRoformer_fp32.safetensors", "diffusion_models"),
    ("Kijai/WanVideo_comfy", "wav2vec2-chinese-base_fp16.safetensors", "wav2vec2"),
]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libsndfile1", "build-essential")
    .pip_install("torch==2.6.0", "torchvision==0.21.0", "torchaudio==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("comfy-cli", "huggingface_hub", "boto3", "soundfile", "requests")
    # ComfyUI + the custom nodes the LongCat avatar workflow needs.
    .run_commands(
        "comfy --skip-prompt install --nvidia --version latest --cuda-version 12.4 || comfy --skip-prompt install --nvidia",
        f"git clone --depth 1 https://github.com/kijai/ComfyUI-WanVideoWrapper {COMFY}/custom_nodes/ComfyUI-WanVideoWrapper",
        f"git clone --depth 1 https://github.com/kijai/ComfyUI-KJNodes {COMFY}/custom_nodes/ComfyUI-KJNodes",
        f"git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite {COMFY}/custom_nodes/ComfyUI-VideoHelperSuite",
        f"git clone --depth 1 https://github.com/city96/ComfyUI-GGUF {COMFY}/custom_nodes/ComfyUI-GGUF",
        f"pip install -r {COMFY}/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt || true",
        f"pip install -r {COMFY}/custom_nodes/ComfyUI-KJNodes/requirements.txt || true",
        f"pip install -r {COMFY}/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt || true",
        f"pip install -r {COMFY}/custom_nodes/ComfyUI-GGUF/requirements.txt || true",
    )
    # Bundle the official workflow JSON into the image.
    .add_local_file("comfy/longcat_avatar_workflow.json", "/root/workflow_ui.json", copy=True)
)

secrets = [
    modal.Secret.from_name("sociafy-r2"),
    modal.Secret.from_name("sociafy-engine"),
    modal.Secret.from_name("huggingface"),
]

web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


@app.cls(gpu="L40S", image=image, volumes={MODELS_DIR: models_vol}, secrets=secrets, timeout=1800, scaledown_window=180)
class AvatarEngine:
    @modal.enter()
    def start(self):
        import subprocess
        from huggingface_hub import hf_hub_download

        # 1) Ensure models exist in the Volume, then symlink them into ComfyUI/models.
        for repo, fname, sub in MODELS:
            dest_dir = os.path.join(MODELS_DIR, sub)
            os.makedirs(dest_dir, exist_ok=True)
            dest = os.path.join(dest_dir, fname)
            if not os.path.exists(dest):
                print(f"[models] downloading {repo}/{fname} -> {sub}")
                hf_hub_download(repo_id=repo, filename=fname, local_dir=os.path.join(MODELS_DIR, "_dl", sub))
                src = os.path.join(MODELS_DIR, "_dl", sub, fname)
                os.replace(src, dest)
            comfy_dir = os.path.join(COMFY, "models", sub)
            os.makedirs(comfy_dir, exist_ok=True)
            link = os.path.join(comfy_dir, fname)
            if not os.path.exists(link):
                os.symlink(dest, link)
        models_vol.commit()

        # 2) Launch ComfyUI headless and wait until its HTTP API answers.
        self.proc = subprocess.Popen(
            ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
            cwd=COMFY,
        )
        import requests

        for _ in range(120):
            try:
                if requests.get("http://127.0.0.1:8188/system_stats", timeout=2).ok:
                    print("[comfy] server up")
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

    def _ui_to_api(self, ui: dict) -> dict:
        """Convert a ComfyUI UI-format workflow to the /prompt API graph using
        the running server's /object_info for per-node input ordering."""
        import requests

        info = requests.get("http://127.0.0.1:8188/object_info", timeout=30).json()
        # link_id -> (from_node_id, from_output_slot)
        links = {l[0]: (l[1], l[2]) for l in ui.get("links", [])}
        prompt = {}
        for node in ui["nodes"]:
            ctype = node.get("type")
            if ctype in ("Note", "MarkdownNote", "Reroute", "PreviewAny", "GetNode", "SetNode"):
                continue
            spec = info.get(ctype, {})
            in_spec = spec.get("input", {})
            ordered = list(in_spec.get("required", {}).keys()) + list(in_spec.get("optional", {}).keys())
            connected = {}
            for inp in node.get("inputs", []) or []:
                if inp.get("link") is not None and inp["link"] in links:
                    connected[inp["name"]] = list(links[inp["link"]])
            inputs = {}
            widget_names = [n for n in ordered if n not in connected]
            wv = node.get("widgets_values", []) or []
            for i, name in enumerate(widget_names):
                if i < len(wv):
                    inputs[name] = wv[i]
            inputs.update(connected)
            prompt[str(node["id"])] = {"class_type": ctype, "inputs": inputs}
        return prompt

    def _patch(self, prompt: dict, img: str, audio: str, prompt_text: str, resolution: str):
        """Point LoadImage/LoadAudio at our files, select the GGUF unet, set size."""
        w, h = (480, 854) if resolution == "480p" else (720, 1280)
        for nid, n in prompt.items():
            ct = n["class_type"]
            ins = n["inputs"]
            if ct == "LoadImage":
                ins["image"] = os.path.basename(img)
            elif ct == "LoadAudio":
                ins["audio"] = os.path.basename(audio)
            elif ct == "WanVideoModelLoader" and "model" in ins:
                ins["model"] = GGUF_FILE
            elif ct == "WanVideoTextEncodeCached":
                for k in ("positive_prompt", "prompt", "text"):
                    if k in ins and isinstance(ins[k], str):
                        ins[k] = prompt_text
            elif ct == "ImageResizeKJv2":
                if "width" in ins:
                    ins["width"] = w
                if "height" in ins:
                    ins["height"] = h

    @modal.method()
    def render(self, payload: dict) -> str:
        import shutil
        import requests

        img = download_tmp(payload["imageUrl"], "png")
        audio = self._audio_for(payload)
        resolution = "720p" if payload.get("quality") == "720p" else "480p"
        prompt_text = payload.get("prompt") or "A person speaking naturally to the camera, looking ahead."

        # ComfyUI reads inputs from its input dir by basename.
        in_dir = os.path.join(COMFY, "input")
        os.makedirs(in_dir, exist_ok=True)
        shutil.copy(img, os.path.join(in_dir, os.path.basename(img)))
        shutil.copy(audio, os.path.join(in_dir, os.path.basename(audio)))

        with open("/root/workflow_ui.json") as f:
            ui = json.load(f)
        prompt = self._ui_to_api(ui)
        self._patch(prompt, img, audio, prompt_text, resolution)

        cid = uuid.uuid4().hex
        r = requests.post("http://127.0.0.1:8188/prompt", json={"prompt": prompt, "client_id": cid}, timeout=60)
        if not r.ok:
            raise RuntimeError(f"prompt_rejected: {r.text[:500]}")
        pid = r.json()["prompt_id"]

        # Poll history until this prompt completes.
        for _ in range(360):  # up to ~30 min
            time.sleep(5)
            h = requests.get(f"http://127.0.0.1:8188/history/{pid}", timeout=15).json()
            if pid in h:
                entry = h[pid]
                status = entry.get("status", {})
                if status.get("status_str") == "error" or status.get("completed") is False and status.get("messages"):
                    # surface the first error message
                    raise RuntimeError(f"comfy_error: {json.dumps(status)[:600]}")
                outs = entry.get("outputs", {})
                # Find a video output (VHS_VideoCombine).
                for _node, out in outs.items():
                    vids = out.get("gifs") or out.get("videos") or []
                    if vids:
                        fn = vids[0]["filename"]
                        sub = vids[0].get("subfolder", "")
                        path = os.path.join(COMFY, "output", sub, fn)
                        if os.path.exists(path):
                            return upload_r2(path, f"avatar/{uuid.uuid4().hex}.mp4", "video/mp4")
                if status.get("completed"):
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
        return {"status": "failed", "error": str(e)[:600]}


@app.function(image=web_image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
