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
from pitch.phrases import detect_phrases
from pitch.render import render_output, mix_vocal_backing, \
    true_peak_limit, normalize_true_peak, apply_reverb, \
    render_f0, synthesize, render_gain
from pitch.schema import (notes_to_json, notes_from_json, f32_to_b64,
                          note_to_dict, note_from_dict, segment_from_dict)

import copy
import hashlib
import json as _json

app = FastAPI(title="Vocal Pitch Editor")


@dataclass
class Backing:
    pcm: np.ndarray          # shape=(N, 2) float32、ボーカルと同一 SR（ステレオ保持）
    sample_rate: int
    duration_sec: float
    channels: int


@dataclass
class Phrase:
    """1 フレーズ = 独立した解析単位（10.4）。無音区間でのみ分割される。"""
    analysis: Analysis       # このフレーズだけの WORLD 解析（sp/ap）
    start_sample: int        # 元音声上の開始サンプル
    n_samples: int
    samples: np.ndarray = None      # 原音 PCM（float32）。無編集フレーズの原音パススルー用
    render_key: str = ""     # 直近レンダの入力ハッシュ（キャッシュ判定）
    render_out: np.ndarray = None   # 直近レンダ結果（master/limiter 適用前）


@dataclass
class Session:
    sample_rate: int
    total_samples: int
    duration_sec: float
    hop_sec: float
    file_name: str
    phrases: list             # list[Phrase]
    backing: Backing = None


SESSIONS: dict[str, Session] = {}


# --------------------------------------------------------------------------
# POST /api/session — アップロード → 無音でフレーズ分割 → 各フレーズを解析（10.4）
# --------------------------------------------------------------------------

@app.post("/api/session")
async def create_session(audio: UploadFile = File(...),
                         sampleRate: int = Form(None)):
    raw = await audio.read()
    try:
        la = load_audio_fileobj(io.BytesIO(raw), audio.filename or "")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"音声を読み込めませんでした: {exc}")

    x, sr = la.samples, la.sample_rate
    spans = detect_phrases(x, sr)          # 無音でのみ分割（有声区間は切らない）
    hop_sec = 0.005

    phrases, global_notes = [], []
    total_frames = int(round(la.duration_sec / hop_sec)) + 1
    f0_global = np.zeros(total_frames, dtype=np.float32)
    rms_global = np.full(total_frames, -120.0, dtype=np.float32)

    for (lo, hi) in spans:
        a = analyze(np.ascontiguousarray(x[lo:hi]), sr)   # フレーズ単位で解析
        start_sec = lo / sr
        phrases.append(Phrase(analysis=a, start_sample=lo, n_samples=hi - lo,
                              samples=np.asarray(x[lo:hi], dtype=np.float32)))
        # ノートをグローバル時間へオフセットして集約
        for note in segment_notes(a):
            for s in note.segments:
                s.start_sec += start_sec
                s.end_sec += start_sec
            global_notes.append(note)
        # 描画用の f0/rms をグローバル配列へ配置
        off = int(round(start_sec / hop_sec))
        n = min(len(a.f0_hz), total_frames - off)
        if n > 0:
            f0_global[off:off + n] = a.f0_hz[:n]
            rms_global[off:off + n] = a.rms_db[:n]

    sid = uuid.uuid4().hex
    stem = os.path.splitext(os.path.basename(audio.filename or "vocal"))[0]
    SESSIONS[sid] = Session(sample_rate=sr, total_samples=len(x),
                            duration_sec=la.duration_sec, hop_sec=hop_sec,
                            file_name=stem, phrases=phrases)

    return {
        "sessionId": sid,
        "sampleRate": sr,
        "durationSec": la.duration_sec,
        "hopSec": hop_sec,
        "f0Hz": f32_to_b64(f0_global),
        "rmsDb": f32_to_b64(rms_global),
        "notes": notes_to_json(global_notes),
        "phraseBounds": [p.start_sample / sr for p in phrases[1:]],   # 分割点（描画用）
        "numPhrases": len(phrases),
    }


# --------------------------------------------------------------------------
# POST /api/render — EditState を受けて全区間を再合成し WAV を返す
# --------------------------------------------------------------------------

class RenderRequest(BaseModel):
    sessionId: str
    editState: dict
    mode: str = "preview"


def _local_notes(global_notes, start_sec, end_sec):
    """[start_sec, end_sec) に始まるノートを抜き出し、フレーズ内ローカル時間へ移す。"""
    out = []
    for note in global_notes:
        if start_sec <= note.start_sec < end_sec:
            nn = copy.deepcopy(note)
            for s in nn.segments:
                s.start_sec -= start_sec
                s.end_sec -= start_sec
            out.append(nn)
    return out


def _is_identity_edit(notes) -> bool:
    """全セグメントが「無編集」（出力が原音 F0・ゲイン 1.0 になる）かを判定する。

    strength=0, vib=1 のとき out = center + (f0 - center) = f0 なので、
    offset=0 なら baseCents や分割位置に依らず F0 は原音と厳密に一致する（3.3）。
    全 gain=0dB なら包絡線は 1.0（AC-8）。この場合の再合成は
    「WORLD の分析合成をそのまま通すだけ」であり、原音より劣化するだけなので
    原音 PCM をパススルーする方が常に高品質になる。
    """
    for note in notes:
        for s in note.segments:
            if (s.pitch_offset_cents != 0 or s.correct_strength != 0
                    or s.vibrato_scale != 1 or s.gain_db != 0 or s.mute
                    or s.fade_in_ms != 0 or s.fade_out_ms != 0):
                return False
    return True


def _pitch_edited_spans(notes) -> list:
    """ピッチ編集された（＝再合成が必要な）セグメントの時間区間を返す。

    区間は隣接境界の遷移長の半分＋マージンだけ拡張する。境界の F0 グライドは
    [tb-τ/2, tb+τ/2] を占める（3.2）ため、そこまで含めて合成音を使わないと
    グライドが原音側に切り落とされて音程が跳ぶ。
    """
    spans = []
    for note in notes:
        segs = note.segments
        for i, s in enumerate(segs):
            if (s.pitch_offset_cents != 0 or s.correct_strength != 0
                    or s.vibrato_scale != 1):
                tin = (s.transition_in_ms or 40.0) / 1000.0
                tout = ((segs[i + 1].transition_in_ms or 40.0) / 1000.0
                        if i + 1 < len(segs) else 0.04)
                spans.append((s.start_sec - tin / 2 - 0.012,
                              s.end_sec + tout / 2 + 0.012))
    return spans


def _edit_gate(spans, sr: int, n: int, edge_sec: float = 0.012) -> np.ndarray:
    """編集区間で 1、それ以外で 0 の包絡（端は Hann でなだらか）。

    原音と合成音のブレンドに使う。ゲート端では合成音の F0 が原音の音高に
    一致している（グライド開始前）ため、混合しても音程の不連続は生じない。
    """
    from scipy.signal import fftconvolve
    env = np.zeros(n, dtype=np.float64)
    for a, b in spans:
        ia, ib = max(0, int(a * sr)), min(n, int(b * sr))
        if ib > ia:
            env[ia:ib] = 1.0
    w = max(2, int(edge_sec * sr))
    if env.any():
        k = np.hanning(w)
        env = np.clip(fftconvolve(env, k / k.sum(), mode="same"), 0.0, 1.0)
    return env


def _render_phrase(ph: Phrase, local) -> np.ndarray:
    """1 フレーズの主ボーカルを生成する（選択的再合成）。

    ボコーダー（WORLD）の質感変化を、実際にピッチ編集した区間だけに限定する:
    - ピッチ編集なし（音量/ミュートのみ）→ 原音にゲイン包絡を掛けるだけ
    - ピッチ編集あり → 全区間を一括合成（P2）した上で、編集区間＋遷移だけを
      合成音、他は原音とする包絡ブレンド。ゲート端では両者の音高が一致する。
    """
    orig = ph.samples
    if orig is None:                                   # 原音未保持（旧セッション）
        return render_output(ph.analysis, local, master_gain_db=0.0)
    sr = ph.analysis.sample_rate
    spans = _pitch_edited_spans(local)
    if not spans:
        # 音量・ミュート・フェードのみ → ボコーダー不要。原音 × ゲイン包絡。
        o = orig.astype(np.float64)
        return o * render_gain(ph.analysis, local, len(o))
    out_f0 = render_f0(ph.analysis, local)
    synth = synthesize(ph.analysis, out_f0)            # 全区間一括（P2）
    n = len(synth)
    o = np.zeros(n, dtype=np.float64)
    m = min(n, len(orig))
    o[:m] = orig[:m]
    g = _edit_gate(spans, sr, n)
    return (o * (1.0 - g) + synth * g) * render_gain(ph.analysis, local, n)


def _render_primary_parts(sess: Session, global_notes) -> list:
    """主ボーカルをフレーズ単位で生成（キャッシュあり）。[(start_sample, y), ...] を返す。

    無編集のフレーズは WORLD を通さず**原音 PCM をそのまま返す**。
    編集ありのフレーズも、合成音を使うのはピッチ編集した区間だけ（選択的再合成）。
    フレーズ境界は真の無音なので連結は安全（P2 / 10.4）。
    """
    parts = []
    sr = sess.sample_rate
    for ph in sess.phrases:
        start_sec = ph.start_sample / sr
        local = _local_notes(global_notes, start_sec, start_sec + ph.n_samples / sr)
        if ph.samples is not None and _is_identity_edit(local):
            parts.append((ph.start_sample, ph.samples.astype(np.float64)))
            continue
        key = hashlib.md5(
            _json.dumps([note_to_dict(n) for n in local], sort_keys=True).encode()).hexdigest()
        if ph.render_key == key and ph.render_out is not None:
            y = ph.render_out                         # キャッシュ命中
        else:
            y = _render_phrase(ph, local)             # reverb/master は全体後段
            ph.render_key, ph.render_out = key, y
        parts.append((ph.start_sample, y))
    return parts


def _render_harmony_parts(sess: Session, harmony_notes) -> list:
    """ハモリ副ボイスをフレーズ単位で合成（ゲートで区間外を無音化）。空フレーズはスキップ。"""
    parts = []
    sr = sess.sample_rate
    for ph in sess.phrases:
        start_sec = ph.start_sample / sr
        local = _local_notes(harmony_notes, start_sec, start_sec + ph.n_samples / sr)
        if not local:
            continue                                  # このフレーズにハモリの音はない
        y = render_output(ph.analysis, local, master_gain_db=0.0, gate=True)
        parts.append((ph.start_sample, y))
    return parts


def _render_vocal_signal(sess: Session, es: dict) -> np.ndarray:
    """主ボーカル + ハモリ副ボイスを合成・ミックスした波形（リミッター前）。

    フレーズ単位で再合成し元の時間軸へ加算配置（10.4）。主ボイスは入力ハッシュで
    キャッシュ。ハモリ(es['harmonies'])は同じ解析(sp/ap=音色)からピッチシフトで合成し、
    区間外はゲートで無音化して重ねる。リバーブ・マスターは全ボイス合算後に一括適用。
    """
    global_notes = notes_from_json(es.get("notes", []))
    master = float(es.get("masterGainDb", 0.0))

    parts = _render_primary_parts(sess, global_notes)
    for h in es.get("harmonies", []) or []:
        parts += _render_harmony_parts(sess, notes_from_json(h.get("notes", [])))

    total = max([sess.total_samples] + [s + len(y) for s, y in parts])
    out = np.zeros(total, dtype=np.float64)
    for s, y in parts:
        out[s:s + len(y)] += y                        # 元の位置へ加算配置
    out = apply_reverb(out, sess.sample_rate, es.get("reverb"))   # リバーブ（全ミックス後）
    out *= 10.0 ** (master / 20.0)                    # マスターゲイン
    return out


def _render_vocal(sess: Session, es: dict, normalize: bool = False) -> np.ndarray:
    """ボーカル最終波形（プレビュー・書き出しで共有）。出力段でトゥルーピーク処理。"""
    y = _render_vocal_signal(sess, es)
    return normalize_true_peak(y) if normalize else true_peak_limit(y)


@app.post("/api/render")
def render(req: RenderRequest):
    sess = SESSIONS.get(req.sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません（再アップロードしてください）")

    # プレビューも書き出しと同一のマスター段（トゥルーピーク・リミッター込み）を通す。
    # これによりプレビューと target=vocal の書き出しがサンプル単位で一致する（AC-16）。
    y = _render_vocal(sess, req.editState or {}, normalize=False)

    buf = io.BytesIO()
    sf.write(buf, y.astype(np.float32), sess.sample_rate,
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
    extraVocals: list = []       # 重ねどりレイヤー [{sessionId, editState}, ...]

_WAV_SUBTYPE = {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}
_FLAC_SUBTYPE = {16: "PCM_16", 24: "PCM_24"}
_MEDIA = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg"}


@app.post("/api/export")
def export(req: ExportRequest):
    sess = SESSIONS.get(req.sessionId)
    if sess is None:
        raise HTTPException(404, "セッションが見つかりません（再アップロードしてください）")

    sr = sess.sample_rate
    es = req.editState or {}

    vocal = _render_vocal_signal(sess, es)
    # 重ねどりレイヤー（別セッションの録音）をリミッター前に加算する。
    for ev in req.extraVocals or []:
        sub = SESSIONS.get(ev.get("sessionId"))
        if sub is None:
            continue
        y2 = _render_vocal_signal(sub, ev.get("editState") or {})
        n = max(len(vocal), len(y2))
        merged = np.zeros(n, dtype=np.float64)
        merged[:len(vocal)] += vocal
        merged[:len(y2)] += y2
        vocal = merged

    if req.target == "mix" and sess.backing is not None:
        # ミックス: ボーカル（フレーズ連結・リミッター前）+ 伴奏 → 加算 → 出力段でリミッター。
        b = es.get("backing", {}) or {}
        y = mix_vocal_backing(
            vocal, sess.backing.pcm, float(b.get("offsetSec", 0.0)), sr,
            backing_gain_db=float(b.get("gainDb", 0.0)), backing_mute=bool(b.get("mute", False)))
    else:
        # ボーカルのみ（フル解像度・全区間一括。プレビューの間引きは使わない・13.2）。
        y = vocal
    y = normalize_true_peak(y) if req.normalize else true_peak_limit(y)
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

    vocal_sr = sess.sample_rate
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
