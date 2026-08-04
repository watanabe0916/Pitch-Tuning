"""連続な F0 曲線・ゲイン包絡線の生成と WORLD 再合成。

CLAUDE.md 3章・4章の中核。設計原則 P1-P3 に従い、波形は一切切らず、
編集は F0 曲線とゲイン包絡線という「連続関数」への変換として表現する。

renderF0() と renderGain() は **同じ smoothstep 補間ロジック** を共有する
（9章の指示）。共通ヘルパ ``build_frame_curve`` が
「セグメント配列 + 遷移長 → フレーム単位の連続曲線」を生成し、
ピッチ(cent)とゲイン(dB)の両方をそれで作る。
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import pyworld as pw

from .analysis import Analysis
from .pitchmath import hz_to_cents, cents_to_hz

# ミュートは -inf ではなく -80dB として扱う（3.5-2、dB 補間の発散回避）。
MUTE_DB = -80.0

# 連続性の上限（3.4 / 3.6）。これを満たすよう遷移長を自動延長する。
MAX_SLOPE_CENTS_PER_5MS = 20.0     # ピッチ: 20 cent / 5ms
MAX_GAIN_SLOPE_DB_PER_SEC = 1000.0  # ゲイン: 最速 1000 dB/s
MIN_GAIN_TRANS_SEC = 0.010          # ゲイン遷移は最低 10ms（3.6 の経験則）
# smoothstep w=u^2(3-2u) の 1階微分の最大値（u=0.5 で 1.5）。
_SMOOTHSTEP_PEAK_SLOPE = 1.5


@dataclass
class _FlatSeg:
    """時刻順にフラット化したセグメント（描画順の内部表現）。"""
    start_sec: float
    end_sec: float
    base_cents: float
    offset_cents: float
    strength: float
    vib_scale: float
    pitch_trans_sec: float
    gain_db: float
    gain_trans_sec: float
    fade_in_sec: float
    fade_out_sec: float
    note_index: int          # 同じノートに属するか判定するための ID


def _flatten(notes) -> list:
    """Note[] を時刻順の _FlatSeg[] へ。ノート境界の識別子も持たせる。"""
    flat = []
    for ni, note in enumerate(notes):
        for s in note.segments:
            db = MUTE_DB if s.mute else s.gain_db
            flat.append(_FlatSeg(
                start_sec=s.start_sec, end_sec=s.end_sec,
                base_cents=s.base_cents, offset_cents=s.pitch_offset_cents,
                strength=s.correct_strength, vib_scale=s.vibrato_scale,
                pitch_trans_sec=s.transition_in_ms / 1000.0,
                gain_db=db, gain_trans_sec=s.gain_transition_ms / 1000.0,
                fade_in_sec=s.fade_in_ms / 1000.0,
                fade_out_sec=s.fade_out_ms / 1000.0,
                note_index=ni,
            ))
    flat.sort(key=lambda s: s.start_sec)
    return flat


def build_frame_curve(
    frame_times: np.ndarray,
    seg_values: np.ndarray,
    seg_starts: np.ndarray,
    seg_ends: np.ndarray,
    transitions: np.ndarray,
    connected: np.ndarray,
    mode: str = "smoothstep",
) -> np.ndarray:
    """セグメント定数値 + 境界遷移長 → フレーム単位の連続曲線。

    renderF0()/renderGain() が共有する中核ヘルパ。

    - seg_values[k]  : セグメント k の定数値（cent / dB / strength ...）
    - seg_starts/ends: セグメント k の [start,end) 秒
    - transitions[k] : セグメント k とその直前(k-1)との境界の遷移長 [秒]
    - connected[k]   : k と k-1 の境界で遷移を適用するか（False なら段差のまま）
    - mode           : "smoothstep"（速度が両端で 0）か "linear"

    セグメント間は各境界の中点まで定数を延ばし（階段関数）、
    接続境界では中点を中心に ±τ/2 の窓で補間する。τ は隣接セグメント長で
    クランプする（3.2）。
    """
    F = len(frame_times)
    n = len(seg_values)
    curve = np.empty(F, dtype=np.float64)
    if n == 0:
        curve.fill(0.0)
        return curve

    # --- 1) 階段関数を作る: 各セグメントを隣との中点まで延ばす ---
    # 境界(中点)時刻。region k = [bound[k], bound[k+1])
    mids = np.empty(n + 1, dtype=np.float64)
    mids[0] = -np.inf
    mids[n] = np.inf
    for k in range(n - 1):
        mids[k + 1] = 0.5 * (seg_ends[k] + seg_starts[k + 1])
    # 各フレームがどの region に属するか
    region = np.clip(np.searchsorted(mids, frame_times, side="right") - 1, 0, n - 1)
    curve[:] = seg_values[region]

    # --- 2) 接続境界を smoothstep / linear で補間 ---
    for k in range(1, n):
        if not connected[k]:
            continue
        tb = 0.5 * (seg_ends[k - 1] + seg_starts[k])
        prev_len = seg_ends[k - 1] - seg_starts[k - 1]
        next_len = seg_ends[k] - seg_starts[k]
        tau = min(transitions[k], prev_len, next_len)   # 3.2 のクランプ
        if tau <= 0:
            continue
        lo, hi = tb - tau / 2.0, tb + tau / 2.0
        idx = np.flatnonzero((frame_times >= lo) & (frame_times < hi))
        if idx.size == 0:
            continue
        u = (frame_times[idx] - lo) / tau
        if mode == "smoothstep":
            w = u * u * (3.0 - 2.0 * u)   # 1階微分が両端で 0
        else:
            w = u                          # 線形
        curve[idx] = seg_values[k - 1] * (1.0 - w) + seg_values[k] * w

    return curve


def _extend_transitions(
    seg_values, seg_starts, seg_ends, transitions, connected,
    peak_slope_per_sec, hop_sec,
):
    """境界の値ジャンプが傾き上限を超えないよう遷移長を自動延長する（3.4/3.6）。

    smoothstep のピーク傾き = Δ * 1.5 / τ [値/秒]。これが上限を超えないよう
    τ_required = Δ * 1.5 / peak_slope_per_sec を確保する。安全率 1.5 を掛け、
    residual/ビブラートによる追加傾きにも余裕を持たせる。

    セグメント長でクランプ（3.2）した結果 τ が required に満たない場合は警告する。
    戻り値: 延長後の transitions 配列。
    """
    eff = np.array(transitions, dtype=np.float64)
    n = len(seg_values)
    for k in range(1, n):
        if not connected[k]:
            continue
        delta = abs(seg_values[k] - seg_values[k - 1])
        required = delta * _SMOOTHSTEP_PEAK_SLOPE / peak_slope_per_sec * 1.5
        eff[k] = max(eff[k], required)
        # セグメント長によるクランプ後に required を満たせるか確認。
        prev_len = seg_ends[k - 1] - seg_starts[k - 1]
        next_len = seg_ends[k] - seg_starts[k]
        clamped = min(eff[k], prev_len, next_len)
        if clamped + 1e-9 < required:
            warnings.warn(
                f"境界 {k}: 傾き上限を満たすには遷移長 {required*1000:.0f}ms 必要ですが、"
                f"隣接セグメント長により {clamped*1000:.0f}ms に制限されます。"
                "セグメントを長くするか変化量を小さくしてください（3.4）。",
                stacklevel=3,
            )
    return eff


# --------------------------------------------------------------------------
# renderF0: 連続な目標 F0 曲線（3.1-3.4）
# --------------------------------------------------------------------------

def render_f0(analysis: Analysis, notes) -> np.ndarray:
    """編集後の目標 F0 曲線 [Hz] をフレーム単位で生成する。

    無声フレームは 0Hz のまま（3.3 の不変条件）。
    """
    flat = _flatten(notes)
    times = analysis.times
    F = len(times)
    f0 = analysis.f0_hz
    voiced = analysis.voiced.astype(bool)

    if not flat:
        return f0.copy()

    starts = np.array([s.start_sec for s in flat])
    ends = np.array([s.end_sec for s in flat])
    base_vals = np.array([s.base_cents for s in flat])
    center_vals = np.array([s.base_cents + s.offset_cents for s in flat])
    strength_vals = np.array([s.strength for s in flat])
    vib_vals = np.array([s.vib_scale for s in flat])
    pitch_trans = np.array([s.pitch_trans_sec for s in flat])
    # ピッチ遷移は「同じノート内で隣接する」境界のみ適用する。
    # ノートをまたぐ境界は無声区間を挟むため補間しない。
    note_idx = np.array([s.note_index for s in flat])
    connected = np.zeros(len(flat), dtype=bool)
    connected[1:] = note_idx[1:] == note_idx[:-1]

    # 傾き上限（20cent/5ms）を満たすよう遷移長を自動延長（3.4）。
    # center(base+offset) のジャンプ量を基準にする。base/offset/strength/vib は
    # すべて同一の遷移長を使う（曲線間の整合を保つため）。
    peak_slope_cents_per_sec = MAX_SLOPE_CENTS_PER_5MS / 0.005
    pitch_trans = _extend_transitions(
        center_vals, starts, ends, pitch_trans, connected,
        peak_slope_cents_per_sec, analysis.hop_sec,
    )

    # center は base+offset を smoothstep 補間。
    center = build_frame_curve(times, center_vals, starts, ends,
                               pitch_trans, connected, mode="smoothstep")
    # base も同じ smoothstep で補間する。こうすると residual = f0-base が
    # 境界で連続になり、strength<1 でもピッチが折れない（3.4 対策）。
    base = build_frame_curve(times, base_vals, starts, ends,
                             pitch_trans, connected, mode="smoothstep")
    strength = build_frame_curve(times, strength_vals, starts, ends,
                                 pitch_trans, connected, mode="linear")
    vib = build_frame_curve(times, vib_vals, starts, ends,
                            pitch_trans, connected, mode="linear")

    f0_cents = hz_to_cents(f0, unvoiced_value=np.nan)
    residual = np.where(voiced, f0_cents - base, 0.0)   # 原音の揺らぎ・ビブラート
    out_cents = center + residual * (1.0 - strength) * vib

    out_f0 = cents_to_hz(out_cents)
    out_f0 = np.where(voiced, out_f0, 0.0)   # 無声は 0Hz（有声化を防ぐ）
    return np.ascontiguousarray(out_f0, dtype=np.float64)


# --------------------------------------------------------------------------
# renderGain: 連続なゲイン包絡線（3.5-3.6）
# --------------------------------------------------------------------------

def render_gain(analysis: Analysis, notes, num_samples: int) -> np.ndarray:
    """サンプル単位の線形ゲイン包絡 gainLin[n]（長さ num_samples）を生成する。

    3.5 の思想: dB 領域で smoothstep 補間 → フレーム→サンプルへ線形補間 →
    10^(dB/20)。全境界（ノート跨ぎ含む）で遷移を適用する。
    """
    flat = _flatten(notes)
    times = analysis.times
    sr = analysis.sample_rate

    if not flat:
        return np.ones(num_samples, dtype=np.float64)

    starts = np.array([s.start_sec for s in flat])
    ends = np.array([s.end_sec for s in flat])
    gain_vals = np.array([s.gain_db for s in flat])
    gain_trans = np.array([s.gain_trans_sec for s in flat])
    # ゲインは全境界で遷移（段差でクリックが出るため。禁止事項参照）。
    connected = np.ones(len(flat), dtype=bool)
    connected[0] = False

    # 最低 10ms を確保しつつ、dB ジャンプが 1000dB/s を超えないよう自動延長（3.6）。
    gain_trans = np.maximum(gain_trans, MIN_GAIN_TRANS_SEC)
    gain_trans = _extend_transitions(
        gain_vals, starts, ends, gain_trans, connected,
        MAX_GAIN_SLOPE_DB_PER_SEC, analysis.hop_sec,
    )

    # 1) フレーム単位の dB 曲線（dB 領域で smoothstep）
    gain_db_frame = build_frame_curve(times, gain_vals, starts, ends,
                                      gain_trans, connected, mode="smoothstep")

    # 2) フレーム → サンプルへ線形補間（dB のまま）
    sample_times = np.arange(num_samples, dtype=np.float64) / sr
    gain_db_sample = np.interp(sample_times, times, gain_db_frame)

    # 3) 線形振幅へ
    gain_lin = np.power(10.0, gain_db_sample / 20.0)

    # 4) セグメント内フェード（任意、既定 0）
    _apply_fades(gain_lin, flat, sr)

    return gain_lin


def _apply_fades(gain_lin: np.ndarray, flat: list, sr: int):
    """各セグメントの fadeIn/fadeOut を線形振幅に乗算する（既定 0 なら無処理）。"""
    n = len(gain_lin)
    for s in flat:
        if s.fade_in_sec > 0:
            a = int(round(s.start_sec * sr))
            w = max(1, int(round(s.fade_in_sec * sr)))
            b = min(n, a + w)
            if b > a:
                gain_lin[a:b] *= np.linspace(0.0, 1.0, b - a)
        if s.fade_out_sec > 0:
            b = int(round(s.end_sec * sr))
            w = max(1, int(round(s.fade_out_sec * sr)))
            a = max(0, b - w)
            b = min(n, b)
            if b > a:
                gain_lin[a:b] *= np.linspace(1.0, 0.0, b - a)


# --------------------------------------------------------------------------
# 再合成と信号チェーン（4.1-4.2）
# --------------------------------------------------------------------------

def synthesize(analysis: Analysis, out_f0: np.ndarray) -> np.ndarray:
    """WORLD で全区間を一括合成する（P2）。sp/ap は原音のまま f0 のみ差し替え。"""
    if analysis.spectral_envelope is None or analysis.aperiodicity is None:
        raise ValueError("synthesize には analyze() で得た sp/ap が必要です。")
    sp = np.ascontiguousarray(analysis.spectral_envelope, dtype=np.float64)
    ap = np.ascontiguousarray(analysis.aperiodicity, dtype=np.float64)
    f0 = np.ascontiguousarray(out_f0, dtype=np.float64)
    y = pw.synthesize(f0, sp, ap, analysis.sample_rate, analysis.frame_period_ms)
    return np.asarray(y, dtype=np.float64)


def _butter(x: np.ndarray, sample_rate: int, kind: str, cutoff, order: int = 2) -> np.ndarray:
    """バターワースフィルタ（IR の整形用）。位相は問わないので sosfilt で十分。"""
    from scipy.signal import butter, sosfilt
    nyq = sample_rate * 0.5
    if kind in ("low", "high"):
        if cutoff <= 0 or cutoff >= nyq:
            return x
    sos = butter(order, cutoff, btype=kind, fs=sample_rate, output="sos")
    return sosfilt(sos, x)


# 残響の既定パラメータ。声に対して「籠らない」ことを最優先に選んである。
REVERB_PREDELAY_SEC = 0.022   # 直接音と残響を聴感上分離する（22ms ≒ 7m 先の壁）
REVERB_HPF_HZ = 190.0         # 残響側の低域を落とす。ここを残すと確実に濁る
REVERB_LPF_HZ = 7500.0        # 空気吸収に相当。高すぎる残響は不自然にシャリつく
REVERB_DAMPING = 0.6          # 高域ほど速く減衰させる度合い（0=減衰差なし, 1=最大）
REVERB_WET_AT_FULL = 0.6      # mix=1.0 のときの wet ゲイン（送り量）


@lru_cache(maxsize=8)
def make_reverb_ir(sample_rate: int, decay_sec: float = 1.2,
                   predelay_sec: float = REVERB_PREDELAY_SEC,
                   damping: float = REVERB_DAMPING) -> np.ndarray:
    """合成インパルス応答（アルゴリズミック・リバーブ相当）。

    単純な「指数減衰させた白色雑音」は、密度は出るが**部屋には聴こえない**。
    直接音と同時に全帯域の残響が立ち上がるため、声が箱に入ったように籠る。
    実際の部屋の応答に近づけるため、次の4点を入れている。

    1. **プリディレイ**: 直接音のあとに残響が来る。これがないと直接音と混ざり、
       輪郭が溶けて籠って聴こえる。
    2. **初期反射**: 拡散した尾の前に、まばらな反射音を数個置く。部屋の広さの手がかり。
    3. **周波数別の減衰**: 高域ほど速く減衰させる（壁と空気による吸収）。
       全帯域が同じ長さで残ると金属的・人工的になる。
    4. **低域を落とす**: 声の基音帯（〜200Hz）に長い残響が付くと確実に濁る。
       残響側だけハイパスするのは、ボーカルのミックスでは定石。

    決定的にするため固定シードを使う（プレビューと書き出しで同一結果・AC-16）。
    """
    sr = sample_rate
    decay_sec = max(0.05, float(decay_sec))
    # -60dB で切ると尾の末端が段差になるので、1.4倍まで伸ばして自然に消しきる
    n = max(2, int(decay_sec * 1.4 * sr))
    t = np.arange(n) / sr
    rng = np.random.default_rng(1234)                 # 決定的
    noise = rng.standard_normal(n)

    # --- 3帯域に分け、高域ほど短い減衰を与える ---
    d = max(0.0, min(1.0, float(damping)))
    low = _butter(noise, sr, "low", 500.0)
    high = _butter(noise, sr, "high", 3500.0)
    mid = noise - low - high                          # 残り = 中域
    # 低域は中域よりやや短く（ベースレシオ<1）。実際のホールは低域が長く残るが、
    # 声に付けると濁るだけなので、板リバーブ同様に低域を抑えた配分にする。
    env = lambda k: np.exp(-6.9077 * t / (decay_sec * k))   # -60dB @ decay*k
    tail = (low * env(0.75)
            + mid * env(1.0 - 0.30 * d)
            + high * env(1.0 - 0.72 * d))

    # --- 立ち上がり: 密度が徐々に上がるように 12ms かけてフェードイン ---
    ramp = np.clip(t / 0.012, 0.0, 1.0)
    tail *= ramp

    # --- 初期反射: 拡散音の前に置くまばらなタップ ---
    er = np.zeros(n)
    er_rng = np.random.default_rng(4321)
    for k in range(9):
        # 6ms〜48ms に不等間隔（等間隔だと櫛形になって色付く）で配置
        delay = 0.006 + 0.042 * (k / 8.0) ** 1.25 + float(er_rng.uniform(-0.002, 0.002))
        i = int(delay * sr)
        if 0 <= i < n:
            er[i] += (0.62 ** k) * (1.0 if k % 2 == 0 else -1.0)
    er = _butter(er, sr, "low", 4000.0)               # 反射面の吸収で高域は丸まる

    ir = er * 0.6 + tail
    # --- 帯域整形: 低域を落として濁りを断ち、超高域も少し落とす ---
    ir = _butter(ir, sr, "high", REVERB_HPF_HZ, order=4)   # 急峻に切る（12dB/oct では残る）
    ir = _butter(ir, sr, "low", min(REVERB_LPF_HZ, sr * 0.45), order=2)

    pre = max(0, int(predelay_sec * sr))
    if pre:
        ir = np.concatenate([np.zeros(pre), ir])
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-12            # エネルギー正規化
    ir.setflags(write=False)      # キャッシュを共有するので書き換え不可にする
    return ir


def apply_reverb(x: np.ndarray, sample_rate: int, reverb: dict) -> np.ndarray:
    """畳み込みリバーブ。mix は「送り量」として扱う。残響の尾は出力長に含める。

    dry を減らさず wet を足す（センド方式）。dry/wet のクロスフェードにすると、
    残響を増やすほど元の声が引っ込み、輪郭が失われて籠って聴こえるため。
    mix=0 のときは入力をそのまま返す（AC-4 の恒等性を保つ）。
    """
    if not reverb:
        return x
    mix = float(reverb.get("mix", 0.0))
    if mix <= 0.0:
        return x
    from scipy.signal import fftconvolve
    decay = float(reverb.get("decaySec", 1.2))
    ir = make_reverb_ir(sample_rate, decay,
                        predelay_sec=float(reverb.get("predelaySec", REVERB_PREDELAY_SEC)),
                        damping=float(reverb.get("damping", REVERB_DAMPING)))
    wet = fftconvolve(x, ir)                          # len = len(x)+len(ir)-1（尾を含む）
    out = np.zeros(len(wet), dtype=np.float64)
    out[: len(x)] += x                                # dry はそのまま
    out += (REVERB_WET_AT_FULL * min(1.0, mix)) * wet  # wet を足す
    return out


def render_gate_envelope(analysis: Analysis, notes, num_samples: int,
                         edge_sec: float = 0.008) -> np.ndarray:
    """セグメントの占める区間だけ 1、区間外は 0 のゲート包絡（端は smoothstep）。

    ハモリ等の副ボイスは、コピー元の区間だけを鳴らし他は無音にするために使う。
    端をなだらかにして境界のクリックを防ぐ。
    """
    sr = analysis.sample_rate
    env = np.zeros(num_samples, dtype=np.float64)
    for note in notes:
        for s in note.segments:
            a = max(0, int(round(s.start_sec * sr)))
            b = min(num_samples, int(round(s.end_sec * sr)))
            if b > a:
                env[a:b] = 1.0
    w = max(2, int(edge_sec * sr))
    if w > 1 and env.any():
        from scipy.signal import fftconvolve
        k = np.hanning(w); k = k / k.sum()
        env = np.clip(fftconvolve(env, k, mode="same"), 0.0, 1.0)
    return env


def render_output(analysis: Analysis, notes, master_gain_db: float = 0.0,
                  reverb: dict = None, gate: bool = False) -> np.ndarray:
    """編集後のボーカル波形を生成する（信号チェーン 4.2、リミッター前まで）。

    renderF0 → synthesize → renderGain（★リバーブ前段）→ [gate] → リバーブ → マスターゲイン。
    セグメントゲインは必ずリバーブより前（AC-10）。マスターゲインはリバーブより後（4.2）。
    gate=True: セグメント区間外を無音化する（ハモリ等の副ボイス用）。
    """
    out_f0 = render_f0(analysis, notes)
    y = synthesize(analysis, out_f0)
    gain_lin = render_gain(analysis, notes, len(y))
    y = y * gain_lin                              # セグメントゲイン（★リバーブ前）
    if gate:
        y = y * render_gate_envelope(analysis, notes, len(y))   # 区間外を無音化
    y = apply_reverb(y, analysis.sample_rate, reverb)   # リバーブ
    y = y * (10.0 ** (master_gain_db / 20.0))     # マスターゲイン（リバーブ後）
    return y


# --------------------------------------------------------------------------
# トゥルーピーク・リミッター / マスター段（4.2 / 13.2）
# --------------------------------------------------------------------------

DEFAULT_CEILING_DBTP = -1.0


def true_peak_db(x: np.ndarray, oversample: int = 4) -> float:
    """トゥルーピーク [dBTP]。4倍オーバーサンプルしてサンプル間ピークを捉える。"""
    from scipy.signal import resample_poly
    if len(x) == 0:
        return -np.inf
    up = resample_poly(x, oversample, 1)
    peak = float(np.max(np.abs(up)))
    return 20.0 * np.log10(peak + 1e-12)


def true_peak_limit(x: np.ndarray, ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
                    oversample: int = 4) -> np.ndarray:
    """ルックアヘッド・リミッター（4.2）。天井を超える箇所だけ時間可変ゲインで抑える。

    以前は「超過したら全体を一律に縮める」方式だったが、それだとマスターを
    上げても縮小で打ち消されて音量がほとんど変わらない。ピーク近傍だけを
    抑える方式なら、ブースト分が実際のラウドネスに反映される。

    実装: 64 サンプルブロックごとの必要ゲイン（天井/ピーク）を求め、
    - ルックアヘッド: 直後 6 ブロックの最小値（ピーク到来前から下げ始める）
    - リリース: 回復速度をブロックあたり 0.5dB に制限（急復帰のポンピング防止）
    を掛けた包絡をサンプルへ線形補間して乗算する。決定的（プレビュー=書き出し・AC-16）。
    最後にトゥルーピークを実測し、まだ超えていれば全体を微調整して天井を保証する（AC-21）。
    """
    if not len(x):
        return x
    ceil_lin = 10.0 ** (ceiling_dbtp / 20.0)
    sample_peak = float(np.max(np.abs(x))) + 1e-12
    # サンプルピークが天井より 1dB 以上低ければ、トゥルーピークも超えない前提で省略。
    if 20.0 * np.log10(sample_peak) < ceiling_dbtp - 1.0:
        return x

    B, LA = 64, 6                       # ブロック長 / ルックアヘッド（≈8ms @48kHz）
    # ステレオ（mix 書き出し）は両chの大きい方でゲインを決め、同じ包絡を両chへ掛ける
    mono = np.max(np.abs(x), axis=1) if x.ndim == 2 else np.abs(x)
    n = len(mono)
    nb = (n + B - 1) // B
    a = np.concatenate([mono, np.zeros(nb * B - n)]).reshape(nb, B).max(axis=1)
    req = np.minimum(1.0, ceil_lin / np.maximum(a, 1e-12))
    # ルックアヘッド: req'[i] = min(req[i..i+LA-1])
    padded = np.concatenate([req, np.full(LA - 1, 1.0)])
    req = np.min(np.stack([padded[k:k + nb] for k in range(LA)]), axis=0)
    # リリース制限を対数領域の running max で一括計算:
    #   env[i] = exp(-max_{j<=i}(l[j] - c*(i-j)))、l = -log(req)、c = 回復量/ブロック
    c = 0.5 / 20.0 * np.log(10.0)       # 0.5dB/ブロック
    j = np.arange(nb)
    l = -np.log(np.maximum(req, 1e-12))
    env_l = np.maximum(np.maximum.accumulate(l + c * j) - c * j, 0.0)
    env = np.exp(-env_l)
    genv = np.interp(np.arange(n), j * B + B / 2.0, env)
    y = x * (genv[:, None] if x.ndim == 2 else genv)

    # トゥルーピークの最終保証（サンプル間ピークの取り残しを全体微調整で抑える）
    from scipy.signal import resample_poly
    up = resample_poly(y, oversample, 1)
    tp = float(np.max(np.abs(up))) + 1e-12
    if tp > ceil_lin:
        y = y * (ceil_lin / tp)
    return y


def normalize_true_peak(x: np.ndarray, ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
                        oversample: int = 4) -> np.ndarray:
    """トゥルーピークが天井ちょうどになるよう全体をスケールする（normalize=true 用）。"""
    from scipy.signal import resample_poly
    if len(x) == 0:
        return x
    up = resample_poly(x, oversample, 1)
    tp = float(np.max(np.abs(up))) + 1e-12
    ceil_lin = 10.0 ** (ceiling_dbtp / 20.0)
    return x * (ceil_lin / tp)


def mix_vocal_backing(vocal: np.ndarray, backing: np.ndarray, offset_sec: float,
                      sample_rate: int, backing_gain_db: float = 0.0,
                      backing_mute: bool = False) -> np.ndarray:
    """モノラルのボーカルとステレオ伴奏を加算してステレオを返す（13.2）。

    ボーカルはセンター配置（L=R）。伴奏は offset_sec だけずらして重ねる。
    offset_sec > 0: 伴奏を遅らせる（先頭に無音）。< 0: 伴奏の先頭を切り詰める。
    出力長 = max(ボーカル長, 伴奏長 + offset)（13.2）。
    """
    vocal = np.asarray(vocal, dtype=np.float64).reshape(-1)
    backing = np.asarray(backing, dtype=np.float64)
    if backing.ndim == 1:
        backing = np.stack([backing, backing], axis=1)   # モノ伴奏はステレオ化

    off = int(round(offset_sec * sample_rate))
    vlen = len(vocal)
    b_out_start = max(0, off)         # 出力上の伴奏開始サンプル
    b_src_start = max(0, -off)        # 伴奏バッファの読み出し開始（負offsetで先頭切り）
    b_avail = backing.shape[0] - b_src_start
    total = max(vlen, b_out_start + max(0, b_avail))

    out = np.zeros((total, 2), dtype=np.float64)
    out[:vlen, 0] += vocal            # ボーカル → センター
    out[:vlen, 1] += vocal
    if not backing_mute and b_avail > 0:
        g = 10.0 ** (backing_gain_db / 20.0)
        seg = backing[b_src_start:b_src_start + (total - b_out_start)]
        out[b_out_start:b_out_start + len(seg), :] += seg * g
    return out


def render_master(analysis: Analysis, notes, master_gain_db: float = 0.0,
                  reverb: dict = None,
                  ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
                  normalize: bool = False) -> np.ndarray:
    """出力段まで通した最終ボーカル波形。**プレビューと書き出しで共有する**。

    render_output（gain→リバーブ→master）→ トゥルーピーク処理（リミッター/正規化）。
    プレビュー(/api/render)と書き出し(/api/export, target=vocal)は同一の
    引数でこの関数を呼ぶため、既定条件で出力がサンプル単位で一致する（AC-16）。
    """
    y = render_output(analysis, notes, master_gain_db, reverb=reverb)
    if normalize:
        return normalize_true_peak(y, ceiling_dbtp)
    return true_peak_limit(y, ceiling_dbtp)
