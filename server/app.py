"""ボーカル・ピッチエディタ API サーバー（FastAPI）。

CLAUDE.md 10.3 のエンドポイントを実装する。設計原則 P4 に従い、
音声実体（原音・sp・ap）はサーバー常駐、クライアントとは JSON + WAV のみ交換する。

起動:
    cd server && conda activate pitch
    uvicorn app:app --reload --port 8000
    → http://localhost:8000/
"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pitch.audio_io import load_audio_fileobj
from pitch.analysis import analyze, Analysis
from pitch.segmentation import segment_notes
from pitch.render import render_output
from pitch.schema import notes_to_json, notes_from_json, f32_to_b64

app = FastAPI(title="Vocal Pitch Editor")


@dataclass
class Session:
    analysis: Analysis
    duration_sec: float


SESSIONS: dict[str, Session] = {}


# --------------------------------------------------------------------------
# POST /api/session — 音声をアップロードして解析（sp/ap はサーバー常駐）
# --------------------------------------------------------------------------

@app.post("/api/session")
async def create_session(audio: UploadFile = File(...),
                         sampleRate: int = Form(None)):
    raw = await audio.read()
    try:
        la = load_audio_fileobj(io.BytesIO(raw), audio.filename or "")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"音声を読み込めませんでした: {exc}")

    a = analyze(la.samples, la.sample_rate)   # F0 + sp + ap
    notes = segment_notes(a)

    sid = uuid.uuid4().hex
    SESSIONS[sid] = Session(analysis=a, duration_sec=la.duration_sec)

    return {
        "sessionId": sid,
        "sampleRate": a.sample_rate,
        "durationSec": la.duration_sec,
        "hopSec": a.hop_sec,
        "f0Hz": f32_to_b64(a.f0_hz),      # 描画用
        "rmsDb": f32_to_b64(a.rms_db),    # 音量表示用
        "notes": notes_to_json(notes),
    }


# --------------------------------------------------------------------------
# POST /api/render — EditState を受けて全区間を再合成し WAV を返す
# --------------------------------------------------------------------------

class RenderRequest(BaseModel):
    sessionId: str
    editState: dict
    mode: str = "preview"


@app.post("/api/render")
def render(req: RenderRequest):
    sess = SESSIONS.get(req.sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません（再アップロードしてください）")

    es = req.editState or {}
    notes = notes_from_json(es.get("notes", []))
    master_gain_db = float(es.get("masterGainDb", 0.0))

    y = render_output(sess.analysis, notes, master_gain_db=master_gain_db)
    y = np.clip(y, -1.0, 1.0)   # 簡易保護（正式なリミッターは Phase 5）

    buf = io.BytesIO()
    sf.write(buf, y.astype(np.float32), sess.analysis.sample_rate,
             format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.delete("/api/session/{sid}")
def delete_session(sid: str):
    SESSIONS.pop(sid, None)
    return {"ok": True}


# --------------------------------------------------------------------------
# 静的フロントエンド
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse("static/index.html")


# 開発用: フロントの #demo 自動読み込みで使うサンプル音声。無ければ 404。
@app.get("/api/dev/sample")
def dev_sample():
    import os
    path = "out/test_vocal.wav"
    if not os.path.exists(path):
        raise HTTPException(404, "サンプルがありません（make_test_audio.py を実行）")
    return FileResponse(path, media_type="audio/wav", filename="sample.wav")


app.mount("/static", StaticFiles(directory="static"), name="static")
