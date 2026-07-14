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
import os
import uuid
from datetime import datetime
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
from pitch.render import render_master, render_output, mix_vocal_backing, \
    true_peak_limit, normalize_true_peak
from pitch.schema import notes_to_json, notes_from_json, f32_to_b64

app = FastAPI(title="Vocal Pitch Editor")


@dataclass
class Backing:
    pcm: np.ndarray          # shape=(N, 2) float32、ボーカルと同一 SR（ステレオ保持）
    sample_rate: int
    duration_sec: float
    channels: int


@dataclass
class Session:
    analysis: Analysis
    duration_sec: float
    file_name: str = "vocal"
    backing: Backing = None


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
    stem = os.path.splitext(os.path.basename(audio.filename or "vocal"))[0]
    SESSIONS[sid] = Session(analysis=a, duration_sec=la.duration_sec, file_name=stem)

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


def _render_vocal(sess: Session, es: dict, normalize: bool = False) -> np.ndarray:
    """EditState からボーカル最終波形を得る（プレビュー・書き出しで共有）。"""
    notes = notes_from_json(es.get("notes", []))
    master_gain_db = float(es.get("masterGainDb", 0.0))
    return render_master(sess.analysis, notes, master_gain_db=master_gain_db,
                         reverb=es.get("reverb"), normalize=normalize)


@app.post("/api/render")
def render(req: RenderRequest):
    sess = SESSIONS.get(req.sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません（再アップロードしてください）")

    # プレビューも書き出しと同一のマスター段（トゥルーピーク・リミッター込み）を通す。
    # これによりプレビューと target=vocal の書き出しがサンプル単位で一致する（AC-16）。
    y = _render_vocal(sess, req.editState or {}, normalize=False)

    buf = io.BytesIO()
    sf.write(buf, y.astype(np.float32), sess.analysis.sample_rate,
             format="WAV", subtype="FLOAT")   # 書き出し既定(32bit float)と一致させる
    return Response(content=buf.getvalue(), media_type="audio/wav")


# --------------------------------------------------------------------------
# POST /api/export — 書き出し（13章）
# --------------------------------------------------------------------------

class ExportRequest(BaseModel):
    sessionId: str
    editState: dict
    target: str = "vocal"        # "vocal" | "mix"（mix は伴奏 Phase 6 で対応）
    format: str = "wav"          # "wav" | "flac" | "mp3"
    bitDepth: int = 24           # 16 | 24 | 32（wav/flac）
    mp3Bitrate: int = 256
    normalize: bool = False
    fileName: str = ""           # 省略時はサーバー側で自動命名

_WAV_SUBTYPE = {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}
_FLAC_SUBTYPE = {16: "PCM_16", 24: "PCM_24"}
_MEDIA = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg"}


@app.post("/api/export")
def export(req: ExportRequest):
    sess = SESSIONS.get(req.sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません（再アップロードしてください）")

    sr = sess.analysis.sample_rate
    es = req.editState or {}
    if req.target == "mix" and sess.backing is not None:
        # ミックス: ボーカル（リミッター前）+ 伴奏 → 加算 → 出力段でリミッター（13.2）。
        notes = notes_from_json(es.get("notes", []))
        vocal = render_output(sess.analysis, notes,
                              master_gain_db=float(es.get("masterGainDb", 0.0)),
                              reverb=es.get("reverb"))
        b = es.get("backing", {}) or {}
        y = mix_vocal_backing(
            vocal, sess.backing.pcm, float(b.get("offsetSec", 0.0)), sr,
            backing_gain_db=float(b.get("gainDb", 0.0)), backing_mute=bool(b.get("mute", False)))
        y = normalize_true_peak(y) if req.normalize else true_peak_limit(y)
    else:
        # ボーカルのみ（フル解像度・全区間一括。プレビューの間引きは使わない・13.2）。
        y = _render_vocal(sess, es, normalize=req.normalize)
    y = y.astype(np.float32)

    fmt = req.format.lower()
    buf = io.BytesIO()
    ext = fmt
    if fmt == "wav":
        sub = _WAV_SUBTYPE.get(req.bitDepth, "PCM_24")
        sf.write(buf, y, sr, format="WAV", subtype=sub)
    elif fmt == "flac":
        sub = _FLAC_SUBTYPE.get(req.bitDepth, "PCM_24")
        sf.write(buf, y, sr, format="FLAC", subtype=sub)
    elif fmt == "mp3":
        try:
            sf.write(buf, y, sr, format="MP3")   # 新しめの libsndfile が必要
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                501, f"MP3 書き出しに未対応の環境です（WAV/FLAC を使用してください）: {exc}")
    else:
        raise HTTPException(400, f"未知の形式: {req.format}")

    stem = req.fileName.strip() or f"{sess.file_name}_tuned_{datetime.now():%Y%m%d-%H%M}"
    filename = f"{stem}.{ext}"
    return Response(
        content=buf.getvalue(),
        media_type=_MEDIA.get(fmt, "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/session/{sid}")
def delete_session(sid: str):
    SESSIONS.pop(sid, None)
    return {"ok": True}


# --------------------------------------------------------------------------
# POST /api/backing — 伴奏をアップロード（解析しない・ステレオ保持・12章）
# --------------------------------------------------------------------------

def _compute_peaks(pcm: np.ndarray, max_points: int = 4000) -> np.ndarray:
    """波形表示用に間引いたピーク列（各窓の最大絶対値、L/R の大きい方）。"""
    mono = np.max(np.abs(pcm), axis=1) if pcm.ndim == 2 else np.abs(pcm)
    n = len(mono)
    w = max(1, n // max_points)
    trimmed = mono[: (n // w) * w].reshape(-1, w)
    return trimmed.max(axis=1).astype(np.float32) if trimmed.size else mono.astype(np.float32)


@app.post("/api/backing")
async def upload_backing(sessionId: str = Form(...), audio: UploadFile = File(...)):
    sess = SESSIONS.get(sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません")
    raw = await audio.read()
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)  # ステレオ保持
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"伴奏を読み込めませんでした: {exc}")

    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)   # モノ伴奏はステレオ化

    vocal_sr = sess.analysis.sample_rate
    if sr != vocal_sr:
        # 伴奏側だけをボーカルの SR に合わせる（ボーカルは絶対にリサンプルしない・12.1）。
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(vocal_sr), int(sr))
        data = resample_poly(data, vocal_sr // g, sr // g, axis=0).astype(np.float32)
        sr = vocal_sr

    dur = data.shape[0] / sr
    sess.backing = Backing(pcm=np.ascontiguousarray(data), sample_rate=sr,
                           duration_sec=dur, channels=2)
    return {
        "backingId": sessionId,          # セッションに1本（キーはセッションID）
        "sampleRate": sr,
        "durationSec": dur,
        "channels": 2,
        "peaks": f32_to_b64(_compute_peaks(data)),
    }


@app.get("/api/backing/{sid}/audio")
def backing_audio(sid: str):
    """伴奏の再生用ストリーム（ステレオ float32 WAV）。"""
    sess = SESSIONS.get(sid)
    if sess is None or sess.backing is None:
        raise HTTPException(404, "伴奏がありません")
    buf = io.BytesIO()
    sf.write(buf, sess.backing.pcm, sess.backing.sample_rate, format="WAV", subtype="FLOAT")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.delete("/api/backing/{sid}")
def delete_backing(sid: str):
    sess = SESSIONS.get(sid)
    if sess:
        sess.backing = None
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
