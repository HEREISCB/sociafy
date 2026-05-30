"""Shared helpers for the Sociafy GPU engines.

Auth: every web route calls require_secret() with the X-Engine-Secret header so
only the Sociafy app can invoke the engines. Output handoff: engines upload
artifacts straight to Cloudflare R2 and return the public URL, so the Next.js
poller never has to download/re-upload.

Secrets expected (Modal Secrets):
  sociafy-engine: ENGINE_SECRET
  sociafy-r2:     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
                  R2_BUCKET_NAME, R2_PUBLIC_URL_BASE
"""

import os
import uuid
import urllib.request

from fastapi import HTTPException


def require_secret(x_engine_secret: str | None) -> None:
    expected = os.environ.get("ENGINE_SECRET")
    if not expected or x_engine_secret != expected:
        raise HTTPException(status_code=401, detail="bad_secret")


def _r2_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_r2(local_path: str, key: str, content_type: str) -> str:
    """Upload a local file to R2 and return its public URL."""
    _r2_client().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        key,
        ExtraArgs={"ContentType": content_type},
    )
    base = os.environ["R2_PUBLIC_URL_BASE"].rstrip("/")
    return f"{base}/{key}"


def download_tmp(url: str, suffix: str) -> str:
    """Download a URL to a unique /tmp path and return it."""
    path = f"/tmp/{uuid.uuid4().hex}.{suffix}"
    urllib.request.urlretrieve(url, path)
    return path
