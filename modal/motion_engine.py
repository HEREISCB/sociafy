"""Sociafy Motion engine — brand-kit motion graphics rendered headless on CPU
(motion/render.mjs → pinned HTML-to-video renderer + headless Chrome + ffmpeg).
No GPU. The renderer is never named to users.

Deploy:  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal/motion_engine.py
Routes:  POST /motion/submit {template, aspect, vars, videoKey, posterKey} -> {callId}
         GET  /motion/result?callId=... -> {status, videoKey?, posterKey?, videoUrl?,
                                             posterUrl?, sizeBytes?, error?}

The app picks the R2 keys (inside users/<id>/) so the engine uploads straight
into the user's library prefix; finalizeVideoJob only has to claim the row.
"""

import json
import os
import pathlib
import subprocess
import tempfile

import modal
from fastapi import FastAPI, Header, HTTPException

app = modal.App("sociafy-motion-engine")

HF = "hyperframes@0.8.141"
CHROME = "152.0.7977.30"  # the headless shell HF pins
MOTION_SRC = pathlib.Path(__file__).resolve().parent.parent / "motion"
TEMPLATES = ("stat", "showcase", "sting")
ASPECTS = ("9:16", "16:9")
SHARED = ("kit.js", "kit.css", "gsap.min.js")


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


# Re-create the template symlinks after the copy: however the upload treated
# them (followed, skipped), the result is the layout render.mjs expects.
relink = " && ".join(
    f"cd /app/motion/templates/{t} && rm -rf fonts {' '.join(SHARED)} && ln -s ../../fonts fonts"
    + "".join(f" && ln -s ../_shared/{f} {f}" for f in SHARED)
    for t in TEMPLATES
)

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install(
        "ffmpeg", "ca-certificates", "fonts-noto-core", "fonts-noto-cjk", "fonts-noto-color-emoji",
        # headless Chrome runtime libs
        "libnss3", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libdrm2", "libxkbcommon0",
        "libxcomposite1", "libxdamage1", "libxfixes3", "libxrandr2", "libgbm1", "libasound2",
        "libpango-1.0-0", "libcairo2", "libx11-xcb1", "libxshmfence1",
    )
    .pip_install("boto3", "fastapi")
    # Pin the renderer and bake its Chrome in, so a render never downloads anything.
    .apt_install("curl", "unzip")
    # `hyperframes browser ensure` hangs in the image build after its download hits 100%;
    # fetch the same Chrome headless shell directly and point the renderer at it.
    .run_commands(
        f"mkdir -p /app && cd /app && npm init -y >/dev/null && npm i {HF}",
        f"curl -fsSL -o /tmp/chs.zip https://storage.googleapis.com/chrome-for-testing-public/{CHROME}/linux64/chrome-headless-shell-linux64.zip"
        " && unzip -q /tmp/chs.zip -d /opt && rm /tmp/chs.zip",
    )
    .env({
        "HYPERFRAMES_BROWSER_PATH": "/opt/chrome-headless-shell-linux64/chrome-headless-shell",
        "HYPERFRAMES_NO_TELEMETRY": "1",
        "HYPERFRAMES_NO_UPDATE_CHECK": "1",
    })
    .add_local_dir(str(MOTION_SRC), "/app/motion", copy=True, ignore=["samples"])
    .run_commands(relink)
)

secrets = [modal.Secret.from_name("sociafy-r2"), modal.Secret.from_name("sociafy-engine")]
web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


@app.function(image=image, secrets=secrets, cpu=2.0, memory=2048, timeout=600, scaledown_window=60)
def render(payload: dict) -> dict:
    template, aspect = payload.get("template"), payload.get("aspect", "9:16")
    video_key, poster_key = payload.get("videoKey", ""), payload.get("posterKey", "")
    if template not in TEMPLATES or aspect not in ASPECTS:
        raise RuntimeError("bad_template_or_aspect")
    # Only ever write inside a user's prefix.
    if not (video_key.startswith("users/") and poster_key.startswith("users/")):
        raise RuntimeError("bad_key")

    with tempfile.TemporaryDirectory() as tmp:
        vars_path, out = os.path.join(tmp, "vars.json"), os.path.join(tmp, "out.mp4")
        poster = os.path.join(tmp, "poster.jpg")
        with open(vars_path, "w") as f:
            json.dump(payload.get("vars") or {}, f)
        r = subprocess.run(
            ["node", "/app/motion/render.mjs", "--template", template, "--aspect", aspect, "--vars", vars_path, "--out", out],
            cwd="/app", capture_output=True, text=True, timeout=540,
        )
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"render_failed: {(r.stderr or r.stdout)[-600:]}")
        # Poster = the settled end card (logo, tagline, CTA), 0.8s before the end.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-sseof", "-0.8", "-i", out, "-frames:v", "1", "-q:v", "3", poster], check=True)

        video_url = upload_r2(out, video_key, "video/mp4")
        poster_url = upload_r2(poster, poster_key, "image/jpeg")
        return {
            "videoKey": video_key, "posterKey": poster_key,
            "videoUrl": video_url, "posterUrl": poster_url, "sizeBytes": os.path.getsize(out),
        }


web_app = FastAPI()


@web_app.post("/motion/submit")
def motion_submit(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    call = render.spawn(item)
    return {"callId": call.object_id}


@web_app.get("/motion/result")
def motion_result(callId: str, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    fc = modal.FunctionCall.from_id(callId)
    try:
        return {"status": "done", **fc.get(timeout=0)}
    except TimeoutError:
        return {"status": "pending"}
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "error": str(e)[:700]}


@app.function(image=web_image, secrets=secrets)
@modal.asgi_app()
def fastapi_app():
    return web_app
