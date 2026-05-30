# Stub media

Placeholder assets returned by the gen-job poller when the Modal engines are
not configured (`MODAL_*` env vars unset). They let the full
compose → avatar/voice → publish flow run locally without GPUs.

`avatar.mp4` and `tts.wav` here are tiny placeholders — the flow only needs the
asset to resolve. Drop in real short sample files if you want playable previews
during local development.
