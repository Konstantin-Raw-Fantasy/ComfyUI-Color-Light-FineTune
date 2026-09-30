"""ComfyUI Color Grading — Stage 4b: Embedded Preview + Frame Slider."""

import torch
import os
from collections import OrderedDict
from aiohttp import web
from server import PromptServer
import base64
import json
from io import BytesIO
from PIL import Image
from comfy_api.latest import io

NODE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Preview cache (per-node, max 10 entries) ────────────────
preview_cache = OrderedDict()
MAX_CACHE_ITEMS = 10
PREVIEW_MAX_SIZE = 768


def prune_node_cache(workflow_id, node_id):
    prefix = f"cg_{workflow_id}_{node_id}"
    for key in list(preview_cache.keys()):
        if key.startswith(prefix):
            del preview_cache[key]


# ── sRGB ↔ Linear RGB ──────────────────────────────────────
def srgb_to_linear(img):
    """sRGB [0,1] → linear light [0,1]."""
    return torch.where(
        img <= 0.04045,
        img / 12.92,
        torch.pow((img + 0.055) / 1.055, 2.4),
    )


def linear_to_srgb(img):
    """Linear light [0,1] → sRGB [0,1]."""
    return torch.where(
        img <= 0.0031308,
        img * 12.92,
        1.055 * torch.pow(img, 1.0 / 2.4) - 0.055,
    )


# ── Temperature / Tint (linear RGB) ────────────────────────
def apply_temperature_tint(img, temperature, tint):
    B, H, W, C = img.shape
    if C < 3:
        return img

    temp_r = 1.0 + temperature * 0.75
    temp_b = 1.0 - temperature * 0.75
    tint_g = 1.0 + tint * 0.6

    r_mult = temp_r * (1.0 + tint * 0.15)
    g_mult = tint_g
    b_mult = temp_b * (1.0 - tint * 0.15)

    result = img.clone()
    result[..., 0] *= r_mult
    result[..., 1] *= g_mult
    result[..., 2] *= b_mult
    return result


# ── Contrast (linear RGB) ──────────────────────────────────
# Pivot = middle gray: the LINEAR value of sRGB 0.5 (display mid-gray,
# ≈0.2140), not linear 0.5 (= sRGB 0.735). Pivoting at linear 0.5 made
# +contrast darken almost the whole image — perceptual anchors live in
# the sRGB/display domain (same lesson as the luma-mask fix).
MID_GRAY_LINEAR = ((0.5 + 0.055) / 1.055) ** 2.4


def apply_contrast(img, contrast):
    centered = img - MID_GRAY_LINEAR
    factor = 1.0 + contrast * 0.75
    result = MID_GRAY_LINEAR + centered * factor
    return result


# ── Vibrance (smart saturation) ────────────────────────────
def apply_vibrance(img, amount):
    """Vibrance: saturation that protects already-saturated pixels.

    img: [B,H,W,C] linear RGB [0,1]
    amount: -1..1 (0 = identity)
    Works on per-pixel saturation S in the sRGB/HSV display domain
    (H and V kept fixed, so each pixel's hue and brightness are
    preserved — the standard vibrance definition):
      +: S' = S + amt * (1 - S)  -> faded pixels get the full push,
         already-saturated ones barely move (no color blow-out)
      -: S' = S * (1 + amt)      -> most saturated desaturated first,
         gray ones untouched
    Saturation is measured in the sRGB (display) domain — same
    perceptual-domain lesson as the luma zones.
    """
    amt = float(amount)
    srgb_now = linear_to_srgb(img.clamp(0.0, 1.0))
    hsv = srgb_to_hsv(srgb_now)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    if amt >= 0.0:
        s2 = s + amt * (1.0 - s)
    else:
        s2 = s * (1.0 + amt)
    s2 = torch.where(s > 1e-6, s2, s)  # pure gray: no hue info, keep as-is
    s2 = torch.clamp(s2, 0.0, 1.0)
    return srgb_to_linear(hsv_to_srgb(torch.stack([h, s2, v], dim=-1)))


# ── Color Wheels (ASC CDL standard) ────────────────────────
def apply_wheel(img, r_shift, g_shift, b_shift, lev, wheel_type):
    B, H, W, C = img.shape
    if C < 3:
        return img

    result = img.clone()
    shifts = torch.tensor((float(r_shift) * float(lev), float(g_shift) * float(lev), float(b_shift) * float(lev)),
                          dtype=torch.float32).to(device=img.device, dtype=img.dtype)[:C]

    if wheel_type == 'gain':
        slopes = 1.0 + shifts
        result *= slopes
    elif wheel_type == 'lift':
        result = result * (1.0 - shifts) + shifts
    elif wheel_type == 'gamma':
        clamped = torch.clamp(result, min=0.0, max=1.0)
        powers = 1.0 / (1.0 + shifts)
        result = torch.pow(clamped, powers)
    else:  # offset
        result += shifts

    return result


def apply_color_wheels(img, lift_rgb, gamma_rgb, gain_rgb, offset_rgb,
                       lift_lev, gamma_lev, gain_lev, offset_lev):
    img = apply_wheel(img, gain_rgb[0], gain_rgb[1], gain_rgb[2], gain_lev, 'gain')
    img = apply_wheel(img, lift_rgb[0], lift_rgb[1], lift_rgb[2], lift_lev, 'lift')
    img = apply_wheel(img, gamma_rgb[0], gamma_rgb[1], gamma_rgb[2], gamma_lev, 'gamma')
    img = apply_wheel(img, offset_rgb[0], offset_rgb[1], offset_rgb[2], offset_lev, 'offset')
    return img


# ── Luma-based Correction (Shadows/Midtones/Highlights/Whites) ──────────
def apply_luma_correction(img,
                          shadows_temp=0, shadows_sat=0,
                          midtones_temp=0, midtones_sat=0,
                          highlights_temp=0, highlights_sat=0,
                          whites_temp=0, whites_sat=0):
    """
    Apply luma-based color correction in linear RGB.
    
    img: [B,H,W,C] linear RGB [0,1]
    *_temp: temperature shift (-1..+1) for each luma range
    *_sat: saturation shift (-1..+1) for each luma range
    
    Returns: corrected linear RGB
    """
    # Tonal-range masks use LUMA in the sRGB (display) domain: Y' = Rec.709
    # weights on gamma-compressed components (the same way video tools select
    # shadows/mids/highlights/whites). Masks computed on linear values put
    # 'highlights' at ~0.87+ sRGB and 'whites' at ~0.99 sRGB, so almost no
    # pixels matched and those knobs barely changed the image.
    srgb_now = linear_to_srgb(img)
    luma = 0.2126 * srgb_now[..., 0] + 0.7152 * srgb_now[..., 1] + 0.0722 * srgb_now[..., 2]

    # Partition-of-unity masks: 3 sigmoid ramps at the zone boundaries
    # (shadows ≤0.30, midtones ≤0.60, highlights ≤0.85, whites > 0.85).
    # Fixes the old per-range Gaussians: (1) plateaus at the range edges —
    # pure black now gets ~full shadow correction, pure white ~full whites
    # (Gaussians peaked OFF-center at 0.15/0.95 and decayed toward 0/1);
    # (2) exact normalization — the 4 masks sum to 1 everywhere, so
    # neighboring ranges never double-count in the overlap zones.
    def ramp_below(edge, softness=0.05):
        """Weight of 'luma below edge' — smooth 1→0 sigmoid ramp."""
        return torch.sigmoid((edge - luma) / softness)

    below_s = ramp_below(0.30)   # weight of "tone below 0.30" (shadows)
    below_m = ramp_below(0.60)   # "below 0.60" (shadows + midtones)
    below_h = ramp_below(0.85)   # "below 0.85" (+ highlights; rest = whites)

    shadow_mask = below_s
    midtone_mask = below_m - below_s
    highlight_mask = below_h - below_m
    whites_mask = 1.0 - below_h

    # Saturation direction stays in linear light (same domain as img).
    luma_lin = 0.2126 * img[..., 0] + 0.7152 * img[..., 1] + 0.0722 * img[..., 2]
    luma_lin_bcast = luma_lin.unsqueeze(-1)  # [B,H,W,1]
    
    # Apply temperature shift per range
    def temp_shift(img, temp, mask):
        if abs(temp) < 0.001:
            return img
        # Temperature: +temp = warmer (more red/yellow), -temp = cooler (more blue)
        t = float(temp)
        r_shift = t * 0.3
        b_shift = -t * 0.3
        shift = torch.tensor((r_shift, 0.0, b_shift), dtype=torch.float32).to(device=img.device, dtype=img.dtype)
        return img + mask.unsqueeze(-1) * shift
    
    # Apply saturation shift per range
    def sat_shift(img, sat, mask):
        if abs(sat) < 0.001:
            return img
        # Desaturate: move toward luma; Saturate: move away from luma
        return img + mask.unsqueeze(-1) * float(sat) * (img - luma_lin_bcast)
    
    # Apply all corrections
    img = temp_shift(img, shadows_temp, shadow_mask)
    img = sat_shift(img, shadows_sat, shadow_mask)
    
    img = temp_shift(img, midtones_temp, midtone_mask)
    img = sat_shift(img, midtones_sat, midtone_mask)
    
    img = temp_shift(img, highlights_temp, highlight_mask)
    img = sat_shift(img, highlights_sat, highlight_mask)
    
    img = temp_shift(img, whites_temp, whites_mask)
    img = sat_shift(img, whites_sat, whites_mask)
    
    return img.clamp(0.0, 1.0)


# ── Secondary (target-color) correction — step E ─────────────
def srgb_to_lab(srgb):
    """Vectorized sRGB [0,1] -> CIE L*a*b* (D65), [...,3]."""
    lo = srgb / 12.92
    hi = ((srgb + 0.055) / 1.055) ** 2.4
    lin = torch.where(srgb <= 0.04045, lo, hi)
    x = 0.4124564 * lin[..., 0] + 0.3575761 * lin[..., 1] + 0.1804375 * lin[..., 2]
    y = 0.2126729 * lin[..., 0] + 0.7151522 * lin[..., 1] + 0.0721750 * lin[..., 2]
    z = 0.0193339 * lin[..., 0] + 0.1191920 * lin[..., 1] + 0.9503041 * lin[..., 2]
    xn, yn, zn = x / 0.95047, y / 1.00000, z / 1.08883
    def f(t):
        e = 216.0 / 24389.0
        k = (29.0 / 6.0) ** 3
        return torch.where(t > e, t ** (1.0 / 3.0), (k * t + 16.0) / 116.0)
    fx, fy, fz = f(xn), f(yn), f(zn)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return torch.stack([L, a, b], dim=-1)


def srgb_to_hsv(srgb):
    """Vectorized sRGB [0,1] -> HSV [0..1, 0..1, 0..1], [...,3]."""
    r, g, b = srgb[..., 0], srgb[..., 1], srgb[..., 2]
    cmax = torch.maximum(torch.maximum(r, g), b)
    cmin = torch.minimum(torch.minimum(r, g), b)
    d = cmax - cmin
    nz = d > 1e-8
    h = torch.zeros_like(d)
    h = torch.where((cmax == r) & nz, ((g - b) / d) % 6.0, h)
    h = torch.where((cmax == g) & nz, ((b - r) / d) + 2.0, h)
    h = torch.where((cmax == b) & nz, ((r - g) / d) + 4.0, h)
    h = (h / 6.0) % 1.0
    s = torch.where(cmax > 1e-8, d / cmax, torch.zeros_like(d))
    return torch.stack([h, s, cmax], dim=-1)


def hsv_to_srgb(hsv):
    """Vectorized HSV [0..1] -> sRGB [0..1], [...,3]."""
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    h6 = (h * 6.0) % 6.0
    i = torch.floor(h6).long() % 6
    f = h6 - torch.floor(h6)
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    rt = torch.stack([v, q, p, p, t, v], dim=0)
    gt = torch.stack([t, v, v, q, p, p], dim=0)
    bt = torch.stack([p, p, t, v, v, q], dim=0)
    idx = i.unsqueeze(0)  # [1, ...] — gather along dim 0 (keeps pixel shape)
    r = torch.gather(rt, 0, idx).squeeze(0)
    g = torch.gather(gt, 0, idx).squeeze(0)
    b = torch.gather(bt, 0, idx).squeeze(0)
    return torch.stack([r, g, b], dim=-1)


def apply_secondary(img, target_rgb, tol, hue, sat, lum):
    """Target-color (secondary) correction.

    img: [B,H,W,C] linear RGB [0,1]
    target_rgb: (r,g,b) float 0..1 — picked color (sRGB values)
    tol: 0..1 match width; hue: -1..1 (±1 = ±90°); sat, lum: -1..1

    Mask = Gaussian falloff of the LAB distance between each pixel's sRGB
    color and the target (perceptually uniform — same lesson as the luma
    fix: selection happens in the display/perceptual domain). Stage order
    per spec: Hue -> Sat -> Lum.
    """
    tr, tg, tb = float(target_rgb[0]), float(target_rgb[1]), float(target_rgb[2])
    target = torch.tensor((tr, tg, tb), dtype=torch.float32, device=img.device).to(img.dtype)

    # 1) color-match mask (sRGB / Lab domain)
    srgb_now = linear_to_srgb(img)
    lab_img = srgb_to_lab(srgb_now)
    lab_t = srgb_to_lab(target.view(1, 1, 1, 3))
    d = (lab_img - lab_t).norm(dim=-1)  # [B,H,W]
    sigma = 2.0 + float(tol) * 40.0  # Lab units; tol=0 near-exact, tol=1 wide
    w = torch.exp(-0.5 * (d / sigma) ** 2)
    w3 = w.unsqueeze(-1)  # [B,H,W,1]

    out = img
    # 2) Hue: rotate in sRGB/HSV (perceptual), blend by w
    if abs(float(hue)) > 0.001:
        delta = float(hue) * 90.0 / 360.0  # ±1 -> ±90°
        hsv = srgb_to_hsv(srgb_now)
        hsv2 = torch.stack([(hsv[..., 0] + delta) % 1.0, hsv[..., 1], hsv[..., 2]], dim=-1)
        shifted = srgb_to_linear(hsv_to_srgb(hsv2))
        out = out * (1.0 - w3) + shifted * w3
    # 3) Sat: toward/away from linear luma (same formula as luma Sat) × w
    if abs(float(sat)) > 0.001:
        luma_lin = 0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2]
        out = out + w3 * float(sat) * (out - luma_lin.unsqueeze(-1))
    # 4) Lum: additive shift × 0.3 (same scale as brightness) × w
    if abs(float(lum)) > 0.001:
        out = out + w3 * float(lum) * 0.3

    return out.clamp(0.0, 1.0)


# ── Highlight roll-off (soft ceiling) & shadow open (soft floor) ────
def apply_highlight_rolloff(img, roll):
    """Highlight Ceiling — ACES-style exponential soft shoulder.

    img: [B,H,W,C] linear RGB (may contain values > 1 from previous stages)
    roll: 0..0.4 = how early the shoulder starts: knee = 1 - roll
    (roll=0.2 -> knee 0.8). Above the knee values bend toward 1.0 and can
    NEVER exceed it, so genuine blowouts (brightness/contrast pushing
    linear 1.2+) settle into the shoulder instead of hard-clipping into
    dead white. Slope 1 at the knee (C1), monotone, identity below.
    """
    r = float(roll)
    if r <= 0.001:
        return img
    knee = 1.0 - r
    return torch.where(
        img > knee,
        knee + (1.0 - knee) * (1.0 - torch.exp(-(img - knee) / (1.0 - knee))),
        img,
    )


def apply_shadow_open(img, open_amt):
    """Toe lift: raise the black point. out = v + open*(1-v)^2 (linear).
    Black rises to `open`, the lift decays toward white (white stays
    fixed), monotone for open < 0.5. 0 = identity.
    """
    o = float(open_amt)
    if o <= 0.001:
        return img
    return img + o * (1.0 - img) ** 2


def apply_tone_curve(img, s_shadows, s_mids, s_lights):
    """Parametric 3-point tone curve on display (sRGB) luma.

    Anchors at fixed positions x = 0.25 (shadows) / 0.50 (mids) / 0.75
    (lights), each moved vertically by its slider (+ brighter, - darker).
    Endpoints (0,0) and (1,1) are nailed down: pure black and pure white
    can never clip - that is the point of this control (a Curve without
    the curve editor). Segments are Fritsch-Carlson monotone cubic
    (Photoshop-smooth, no overshoot). The mapped gain multiplies linear
    RGB uniformly per pixel, so hue is preserved.
    The midtone anchor is the pivot: shadow/light anchors are clamped to
    it, so knots can never invert - monotone for any slider combination.
    """
    s1, s2, s3 = float(s_shadows), float(s_mids), float(s_lights)
    if max(abs(s1), abs(s2), abs(s3)) < 0.001:
        return img

    y2 = max(0.0, min(1.0, 0.50 + s2))
    y1 = max(0.0, min(y2, 0.25 + s1))            # shadows <= mids anchor
    y3 = max(y2, min(1.0, 0.75 + s3))            # lights >= mids anchor
    ys = [0.0, y1, y2, y3, 1.0]

    d = [(ys[k + 1] - ys[k]) / 0.25 for k in range(4)]    # secants (>= 0)
    m = [0.0] * 5
    for k in range(1, 4):                                 # interior tangents
        if d[k - 1] * d[k] > 0.0:
            m[k] = 2.0 * d[k - 1] * d[k] / (d[k - 1] + d[k])   # harmonic mean
    m[0] = max(0.0, 0.5 * (3.0 * d[0] - d[1]))            # FC end tangents
    m[4] = max(0.0, 0.5 * (3.0 * d[3] - d[2]))

    # Evaluate the monotone cubic directly per pixel (exact at knots; a
    # 256-point LUT leaked neighbor-segment values across knot boundaries).
    disp = linear_to_srgb(img)                            # display-space RGB
    l = disp[..., 0] * 0.2126 + disp[..., 1] * 0.7152 + disp[..., 2] * 0.0722
    lc = l.clamp(0.0, 1.0)
    k = torch.clamp((lc / 0.25).long(), 0, 3)             # segment index
    t = (lc - k * 0.25) / 0.25
    ys_t, m_t = torch.tensor(ys), torch.tensor(m)
    yk, yk1 = ys_t[k], ys_t[k + 1]
    mk, mk1 = m_t[k], m_t[k + 1]
    y = ((2 * t ** 3 - 3 * t ** 2 + 1) * yk + (t ** 3 - 2 * t ** 2 + t) * 0.25 * mk
         + (-2 * t ** 3 + 3 * t ** 2) * yk1 + (t ** 3 - t ** 2) * 0.25 * mk1)

    # Gain in LINEAR domain: s2l(curve(l)) / s2l(l). A display-domain gain
    # (curve(l)/l) gets damped ~2x at midtones by the sRGB gamma (gray 0.5
    # with curve->0.7 landed 0.58 instead). The linear ratio maps near-
    # neutral pixels exactly through the curve and preserves CIE hue.
    # Pure blacks (l~0) and blowouts (l>1) pass through unchanged.
    l_over = torch.where(l > 1e-5, l, torch.ones_like(l))
    l_gain = torch.where(
        (l > 1e-5) & (l <= 1.001),
        srgb_to_linear(y) / srgb_to_linear(l_over),
        torch.ones_like(l),
    )
    return img * l_gain.unsqueeze(-1)


# ── Full pipeline (used by both execute() and preview API) ──
def apply_color_grading(image, temperature, tint, brightness, contrast,
                        lift_rgb, gamma_rgb, gain_rgb, offset_rgb,
                        lift_lev, gamma_lev, gain_lev, offset_lev,
                        vibrance=0.0,
                        curve_shadows=0.0, curve_mids=0.0, curve_lights=0.0,
                        highlight_rolloff=0.0, shadow_open=0.0,
                        shadows_temp=0, shadows_sat=0,
                        midtones_temp=0, midtones_sat=0,
                        highlights_temp=0, highlights_sat=0,
                        whites_temp=0, whites_sat=0,
                        target_r=0.0, target_g=0.0, target_b=0.0, sec_valid=0.0,
                        picked_tolerance=0.5, picked_hue=0.0, picked_saturation=0.0, picked_luma=0.0,
                        film_grain=False, grain_seed_offset=0,
                        grain_strength=0.284, grain_size=0.0, grain_softness=0.234):
    """Apply full color grading pipeline."""
    linear_img = srgb_to_linear(image)

    if abs(temperature) > 0.001 or abs(tint) > 0.001:
        linear_img = apply_temperature_tint(linear_img, temperature, tint)

    # Brightness: global additive shift for all channels, linear light.
    if abs(brightness) > 0.001:
        linear_img = linear_img + float(brightness) * 0.3

    wheels_active = (lift_lev > 0.0 and lift_rgb != (0.0, 0.0, 0.0) or
                     gamma_lev > 0.0 and gamma_rgb != (0.0, 0.0, 0.0) or
                     gain_lev > 0.0 and gain_rgb != (0.0, 0.0, 0.0) or
                     offset_lev > 0.0 and offset_rgb != (0.0, 0.0, 0.0))

    if wheels_active:
        linear_img = apply_color_wheels(
            linear_img, lift_rgb, gamma_rgb, gain_rgb, offset_rgb,
            float(lift_lev), float(gamma_lev), float(gain_lev), float(offset_lev),
        )

    # Luma-based correction (after wheels, before contrast)
    luma_active = (abs(shadows_temp) > 0.001 or abs(shadows_sat) > 0.001 or
                   abs(midtones_temp) > 0.001 or abs(midtones_sat) > 0.001 or
                   abs(highlights_temp) > 0.001 or abs(highlights_sat) > 0.001 or
                   abs(whites_temp) > 0.001 or abs(whites_sat) > 0.001)

    if luma_active:
        linear_img = apply_luma_correction(
            linear_img,
            shadows_temp=shadows_temp, shadows_sat=shadows_sat,
            midtones_temp=midtones_temp, midtones_sat=midtones_sat,
            highlights_temp=highlights_temp, highlights_sat=highlights_sat,
            whites_temp=whites_temp, whites_sat=whites_sat,
        )

    # Vibrance: smart saturation — after luma, before contrast.
    # Per-pixel saturation S is measured on the graded image at this
    # point; contrast barely changes per-pixel saturation, so order
    # relative to it is not critical.
    if abs(float(vibrance)) > 0.001:
        linear_img = apply_vibrance(linear_img, vibrance)

    if abs(contrast) > 0.001:
        linear_img = apply_contrast(linear_img, contrast)

    # Parametric 3-point tone curve (display luma, hue-preserving) —
    # global light shaping with nailed 0/1 endpoints. Before secondary so
    # picked_luma works on the final tonal shape; Ceiling/Floor stay last word.
    if max(abs(float(curve_shadows)), abs(float(curve_mids)), abs(float(curve_lights))) > 0.001:
        linear_img = apply_tone_curve(linear_img, curve_shadows, curve_mids, curve_lights)

    # Secondary (target-color) correction — LAST stage (per spec order).
    if sec_valid >= 0.5 and (abs(picked_hue) > 0.001 or abs(picked_saturation) > 0.001 or abs(picked_luma) > 0.001):
        linear_img = apply_secondary(
            linear_img, (target_r, target_g, target_b),
            picked_tolerance, picked_hue, picked_saturation, picked_luma,
        )

    # Highlight roll-off + shadow open — FINAL stages: the ceiling and
    # the floor are the last word (whatever contrast/secondary did, the
    # ceiling stays soft and the black point stays lifted).
    if highlight_rolloff > 0.001:
        linear_img = apply_highlight_rolloff(linear_img, highlight_rolloff)
    if shadow_open > 0.001:
        linear_img = apply_shadow_open(linear_img, shadow_open)

    srgb_img = linear_to_srgb(linear_img).clamp(0.0, 1.0)
    # Film grain — ABSOLUTE last stage, sRGB display domain (after the
    # ceiling/floor): the checkbox applies the reference grain look with the
    # GRAIN-tab Strength/Size/Softness knobs.
    if film_grain:
        srgb_img = apply_film_grain(srgb_img, grain_strength, grain_size,
                                    grain_softness, grain_seed_offset)
    return srgb_img


# ── Film grain (GRAIN tab: checkbox + Strength/Size/Softness sliders) ──
# Reference film-grain preset (values from the user's screenshot):
# opacity 0.713, texture 0.750 (fine+coarse mix), size 0 (small blobs),
# symmetry 0.5 (balanced), offset 0.5 (neutral), and saturation 0
# (monochrome grain — no color dots) stay BAKED-IN constants.
# Strength (0.284), Size (0.0) and Softness (0.234) are USER knobs on the
# GRAIN tab; the schema defaults mirror the screenshot values.
GRAIN_PRESET = {
    "opacity": 0.713,
    "texture": 0.750,
}
GRAIN_SEED_BASE = 0x5EED  # fixed base seed → deterministic grain
# The reference strength→amplitude mapping is not public, so this is the
# calibrated constant: the reference preset should give ~0.025 sRGB (~6/255)
# grain sigma in midtones (classic, subtle film grain). If the user says
# "stronger/weaker", tune ONLY this value.
GRAIN_AMP_SCALE = 0.19


def apply_film_grain(img, grain_strength=0.284, grain_size=0.0, grain_softness=0.234, start_index=0):
    """Film grain, sRGB display domain (applied last, after all corrections).

    Deterministic: frame i gets seed GRAIN_SEED_BASE + start_index + i, so
    the same frame always gets the same grain (preview / re-queue / final
    render), while video frames differ from each other — like real film.
    Applied as an overlay composite with an opacity blend:
        out = (1-op)*B + op*overlay(B, 0.5 + s*grain)
    Overlay tapers the grain toward pure black/white (delta = 2*min(B,1-B)*d*op)
    — the key part of the filmic look (pure additive grain looked like
    white noise, especially in blacks).

    User knobs (GRAIN tab):
        grain_strength — 0 = no grain, default 0.284 = the screenshot look.
        grain_size     — scales the coarse blobs: 0 = ~4px (screenshot look),
                         1 = ~32px chunky film. Only the coarse component grows.
        grain_softness — soft knee: higher = fewer spikes, quieter grain
                         (slider 0 = hard/spiky); default 0.234 = verified look.
    CPU: torch.randn without device (user: node is CPU-only for now).
    """
    strength = max(0.0, min(1.0, float(grain_strength)))
    t = GRAIN_PRESET["texture"]
    soft = max(0.0, min(1.0, float(grain_softness)))
    s = strength * GRAIN_AMP_SCALE  # midtone grain delta, 1 sigma (calibrated)
    if s <= 1e-5:  # zero strength → overlay is identity; skip the randn work
        return img
    op = GRAIN_PRESET["opacity"]

    coarse_div = 4 + int(round(max(0.0, min(1.0, float(grain_size))) * 28))  # 4..32

    B, H, W, C = img.shape
    out = img.clone()
    for i in range(B):
        g = torch.Generator().manual_seed(GRAIN_SEED_BASE + int(start_index) + i)
        # Monochrome grain (saturation 0): one value for all 3 channels.
        fine = torch.randn(1, H, W, 1, generator=g, dtype=torch.float32)
        if t > 0.001:
            # Texture: an INDEPENDENT coarse field (coarse_div-resolution,
            # repeated back) blended with the fine one, energy-normalized
            # (texture changes the grain character, not its strength);
            # grain_size scales the coarse blobs.
            g2 = torch.Generator().manual_seed(GRAIN_SEED_BASE + 1000003 + int(start_index) + i)
            coarse = torch.randn(1, max(1, H // coarse_div), max(1, W // coarse_div), 1, generator=g2, dtype=torch.float32)
            # Bilinear upscaling: smooth inter-grain correlation (organic
            # film look), no hard 4x4 blocks.
            coarse = torch.nn.functional.interpolate(
                coarse.permute(0, 3, 1, 2), size=(H, W),
                mode="bilinear", align_corners=False
            ).permute(0, 2, 3, 1)
            grain = ((1.0 - t) * fine + t * coarse) / ((1.0 - t) ** 2 + t ** 2) ** 0.5
        else:
            grain = fine
        grain = grain - grain.mean()  # pure texture: zero per-frame mean
        # Softness: soft knee. Pre-gain DECREASES with softness (1.468 at
        # slider 0 → 0.468 at 1); slider default 0.234 → gain 1.234, which
        # is bit-exact the pre-slider tanh(grain*(1+soft)) look. tanh
        # saturates the tail, so higher softness = fewer spikes = quieter,
        # gentler grain (lower tail fraction); 0 = hard, spiky grain.
        grain = torch.tanh(grain * (1.468 - soft))
        # Overlay composite + opacity: neutral grain (G≈0.5) leaves the
        # image untouched; effect tapers toward black and white.
        G = (0.5 + s * grain).clamp(0.0, 1.0)
        overlay = torch.where(img[i] < 0.5,
                              2.0 * img[i] * G,
                              1.0 - 2.0 * (1.0 - img[i]) * (1.0 - G))
        out[i] = ((1.0 - op) * img[i] + op * overlay).clamp(0.0, 1.0)
    return out


# ── Preview helpers ────────────────────────────────────────
def downscale_for_preview(tensor):
    """Downscale tensor to max PREVIEW_MAX_SIZE on longer side."""
    if tensor.dim() == 3:
        tensor = tensor.unsqueeze(0)
    B, H, W, C = tensor.shape

    if H >= W:
        new_h = PREVIEW_MAX_SIZE
        new_w = round(W * PREVIEW_MAX_SIZE / H)
    else:
        new_w = PREVIEW_MAX_SIZE
        new_h = round(H * PREVIEW_MAX_SIZE / W)

    resized = torch.nn.functional.interpolate(
        tensor.permute(0, 3, 1, 2),
        size=(new_h, new_w),
        mode='bilinear',
        align_corners=False
    ).permute(0, 2, 3, 1)

    return resized.squeeze(0)


def tensor_to_base64(tensor):
    """Convert [H,W,C] or [B,H,W,C] tensor to base64 PNG string."""
    t = tensor.clamp(0, 1).cpu().numpy()
    if t.ndim == 4:
        t = t[0]
    img = Image.fromarray((t * 255).astype("uint8"))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# ── API endpoint for live preview updates ──────────────────
@PromptServer.instance.routes.post("/colorgrading/api/preview/update")
async def handle_preview_update(request):
    try:
        data = await request.json()

        key = request.query.get("key")
        if not key:
            return web.json_response({"status": "error", "message": "Missing cache key"}, status=400)

        cached = preview_cache.get(key)
        if cached is None:
            return web.json_response({"status": "error", "message": "No cached image"}, status=404)

        # Extract frame
        frame_idx = data.get("frame_index", 0)
        B = cached.shape[0]
        frame_idx = max(0, min(frame_idx, B - 1))
        frame = cached[frame_idx:frame_idx + 1]  # [1,H,W,C]

        # Downscale for preview
        frame = downscale_for_preview(frame)  # [H',W',C]

        # Normalize RGB from [0..255] to [-1..+1]
        def rgb_to_shift(r, g, b):
            return ((r - 128) / 64.0, (g - 128) / 64.0, (b - 128) / 64.0)

        lift_rgb = rgb_to_shift(data.get("lift_r", 128), data.get("lift_g", 128), data.get("lift_b", 128))
        gamma_rgb = rgb_to_shift(data.get("gamma_r", 128), data.get("gamma_g", 128), data.get("gamma_b", 128))
        gain_rgb = rgb_to_shift(data.get("gain_r", 128), data.get("gain_g", 128), data.get("gain_b", 128))
        offset_rgb = rgb_to_shift(data.get("offset_r", 128), data.get("offset_g", 128), data.get("offset_b", 128))

        # Apply full pipeline to preview frame
        result = apply_color_grading(
            frame.unsqueeze(0),
            temperature=data.get("temperature", 0.0),
            tint=data.get("tint", 0.0),
            brightness=data.get("brightness", 0.0),
            contrast=data.get("contrast", 0.0),
            vibrance=data.get("vibrance", 0.0),
            curve_shadows=data.get("curve_shadows", 0.0),
            curve_mids=data.get("curve_mids", 0.0),
            curve_lights=data.get("curve_lights", 0.0),
            highlight_rolloff=data.get("highlight_rolloff", 0.0),
            shadow_open=data.get("shadow_open", 0.0),
            lift_rgb=lift_rgb, gamma_rgb=gamma_rgb, gain_rgb=gain_rgb, offset_rgb=offset_rgb,
            lift_lev=data.get("lift_lev", 0.03),
            gamma_lev=data.get("gamma_lev", 0.3),
            gain_lev=data.get("gain_lev", 0.3),
            offset_lev=data.get("offset_lev", 0.05),
            shadows_temp=data.get("shadows_temp", 0.0),
            shadows_sat=data.get("shadows_sat", 0.0),
            midtones_temp=data.get("midtones_temp", 0.0),
            midtones_sat=data.get("midtones_sat", 0.0),
            highlights_temp=data.get("highlights_temp", 0.0),
            highlights_sat=data.get("highlights_sat", 0.0),
            whites_temp=data.get("whites_temp", 0.0),
            whites_sat=data.get("whites_sat", 0.0),
            target_r=data.get("target_r", 0.0),
            target_g=data.get("target_g", 0.0),
            target_b=data.get("target_b", 0.0),
            sec_valid=data.get("sec_valid", 0.0),
            picked_tolerance=data.get("picked_tolerance", 0.5),
            picked_hue=data.get("picked_hue", 0.0),
            picked_saturation=data.get("picked_saturation", 0.0),
            picked_luma=data.get("picked_luma", 0.0),
            film_grain=bool(data.get("film_grain", False)),
            grain_strength=float(data.get("grain_strength", 0.284)),
            grain_size=float(data.get("grain_size", 0.0)),
            grain_softness=float(data.get("grain_softness", 0.234)),
            grain_seed_offset=frame_idx,
        )

        img_str = tensor_to_base64(result.squeeze(0))

        return web.json_response({
            "status": "success",
            "preview_image": f"data:image/png;base64,{img_str}",
            "total_frames": B,
            "frame_index": frame_idx,
        })

    except Exception as e:
        print(f"[ColorGrading] Preview error: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=400)


@PromptServer.instance.routes.post("/colorgrading/api/preview/sample")
async def handle_preview_sample(request):
    """Sample the average color of a small region on the cached ORIGINAL frame.

    Body: {frame_index, u, v} — u,v = normalized click position (0..1) in
    the displayed preview image. Response: {status, r, g, b} in 0..1 sRGB.
    """
    try:
        data = await request.json()
        key = request.query.get("key")
        if not key:
            return web.json_response({"status": "error", "message": "Missing cache key"}, status=400)
        cached = preview_cache.get(key)
        if cached is None:
            return web.json_response({"status": "error", "message": "No cached image"}, status=404)

        frame_idx = int(data.get("frame_index", 0))
        B, H, W, C = cached.shape
        frame_idx = max(0, min(frame_idx, B - 1))
        frame = cached[frame_idx]  # [H,W,C] original sRGB 0..1, full res

        u = max(0.0, min(1.0, float(data.get("u", 0.5))))
        v = max(0.0, min(1.0, float(data.get("v", 0.5))))
        px = int(u * (W - 1))
        py = int(v * (H - 1))

        # Region side: ~16 px in 1024-preview space (scales with resolution)
        side = max(4, round(W / 64.0))
        half = side // 2
        x0, x1 = max(0, px - half), min(W, px + half)
        y0, y1 = max(0, py - half), min(H, py + half)
        region = frame[y0:y1, x0:x1]  # [h,w,C]
        avg = region.mean(dim=(0, 1))  # [C]
        r = float(avg[0].clamp(0.0, 1.0))
        g = float(avg[1].clamp(0.0, 1.0))
        b = float(avg[2].clamp(0.0, 1.0))
        return web.json_response({"status": "success", "r": r, "g": g, "b": b})
    except Exception as e:
        print(f"[ColorGrading] Sample error: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=400)


@PromptServer.instance.routes.post("/colorgrading/api/preview/peek")
async def handle_preview_peek(request):
    """Find this node's cached preview frame by node_id (cache keys are
    cg_{workflow_id}_{node_id}, so match the last "_<node_id>" segment).

    Needed because ComfyUI's execution cache SKIPS re-executing a node when
    the prompt is identical — then onExecuted never reaches the frontend and
    the JS side has no cache_key (fresh after a browser reload). The server
    preview cache survives browser reloads, so the frontend can restore the
    key and show the preview without another Queue.
    """
    try:
        data = await request.json()
        node_id = str(data.get("node_id", "")).strip()
        if not node_id:
            return web.json_response({"status": "error", "message": "Missing node_id"}, status=400)
        suffix = "_" + node_id
        for key in preview_cache.keys():
            if key.endswith(suffix):
                return web.json_response({
                    "status": "success",
                    "cache_key": key,
                    "total_frames": int(preview_cache[key].shape[0]),
                })
        return web.json_response({"status": "not_found"})
    except Exception as e:
        print(f"[ColorGrading] Peek error: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=400)


# ── Video batch progress (ComfyUI terminal) ─────────────────
PROGRESS_CHUNK = 16  # frames per progress report step


def _report_progress(done, total):
    """Report video-batch frame progress to the ComfyUI terminal.

    One line per PROGRESS_CHUNK of frames (the final line reads
    total/total); the natural chunk cadence keeps the rate sane.
    """
    print(f"[ColorGrading] Progress: {int(done)}/{int(total)} frames")


# ── Node class ──────────────────────────────────────────────
class ColorGrading(io.ComfyNode):
    """Color & light grading node with embedded preview."""

    @classmethod
    def define_schema(cls):
        wheel_int = lambda name: io.Int.Input(name, default=128, min=0, max=255, step=1)
        # Per-wheel LEV limits (user-confirmed empirically); default = max.
        LEV_LIMITS = {"lift": 0.03, "gamma": 0.3, "gain": 0.3, "offset": 0.05}
        def wheel_lev(name):
            limit = LEV_LIMITS[name.split("_")[0]]
            return io.Float.Input(name, default=limit, min=0.0, max=limit, step=0.001)
        return io.Schema(
            node_id="ColorGrading",
            display_name="\U0001f3a8 Color-Light-FineTune",
            category="\U0001f3a8 Color-Light-FineTune",
            description="Color & light grading with live preview. Works on CPU with image batches and audio passthrough.",
            inputs=[
                io.Image.Input("image", display_name="IMAGE", tooltip="Input image batch [B,H,W,C] sRGB 0..1."),
                io.Int.Input("frame_index", display_name="frame_index", default=0, min=0, max=9999, step=1,
                             tooltip="Frame index to show in preview (does not affect output)."),
                io.Float.Input("temperature", display_name="temperature", default=0.0, min=-1.0, max=1.0, step=0.01),
                io.Float.Input("tint", display_name="tint", default=0.0, min=-1.0, max=1.0, step=0.01),
                io.Float.Input("brightness", display_name="brightness", default=0.0, min=-0.5, max=0.5, step=0.005,
                               tooltip="Global brightness (additive shift, linear light)."),
                io.Float.Input("contrast", display_name="contrast", default=0.0, min=-0.5, max=0.5, step=0.005),
                io.Float.Input("curve_shadows", display_name="Curve Shadows", default=0.0, min=-0.25, max=0.25, step=0.005,
                               tooltip="Tone curve, shadows anchor (display tone 0.25): + lifts darks, - sinks them; black point stays 0, midtone anchor is the pivot."),
                io.Float.Input("curve_mids", display_name="Curve Mids", default=0.0, min=-0.25, max=0.25, step=0.005,
                               tooltip="Tone curve, midtone anchor (display tone 0.5): lightness of midtones; black and white points untouched."),
                io.Float.Input("curve_lights", display_name="Curve Lights", default=0.0, min=-0.25, max=0.25, step=0.005,
                               tooltip="Tone curve, lights anchor (display tone 0.75): + brightens light tones, - dims them; white point stays 1."),
                io.Float.Input("vibrance", display_name="vibrance", default=0.0, min=-1.0, max=1.0, step=0.005,
                               tooltip="Smart saturation: boosts faded colors, protects already-saturated ones."),
                io.Float.Input("highlight_rolloff", display_name="Highlight Ceiling", default=0.0, min=0.0, max=0.4, step=0.005,
                               tooltip="Soft ceiling (0 = off): the higher, the earlier the shoulder starts - blown highlights bend toward white instead of clipping dead. Use with brightness +."),
                io.Float.Input("shadow_open", display_name="Shadow Floor", default=0.0, min=0.0, max=0.12, step=0.005,
                               tooltip="Soft floor (0 = off): lifts the black point so darkening keeps shadow texture; whites stay put. Use with brightness -."),
                io.Boolean.Input("film_grain", display_name="film_grain", default=False,
                                 tooltip="Film grain (built-in preset parameters): tick to apply the built-in grain look as the final stage."),
                io.Float.Input("grain_strength", display_name="Grain Strength", default=0.284, min=0.0, max=1.0, step=0.005,
                               tooltip="Grain strength: 0 = no grain, 0.284 = the reference preset look (~6/255 sRGB in midtones), higher = coarser, noisier grain."),
                io.Float.Input("grain_size", display_name="Grain Size", default=0.0, min=0.0, max=1.0, step=0.01,
                               tooltip="Grain blob size: 0 = small blobs (the screenshot look), 1 = chunky large-grain film; only the coarse component grows."),
                io.Float.Input("grain_softness", display_name="Grain Softness", default=0.234, min=0.0, max=1.0, step=0.005,
                               tooltip="Grain softness: higher = fewer spikes, quieter grain; 0 = hard, spiky grain; 0.234 = the reference preset look."),
                wheel_int("lift_r"), wheel_int("lift_g"), wheel_int("lift_b"), wheel_lev("lift_lev"),
                wheel_int("gamma_r"), wheel_int("gamma_g"), wheel_int("gamma_b"), wheel_lev("gamma_lev"),
                wheel_int("gain_r"), wheel_int("gain_g"), wheel_int("gain_b"), wheel_lev("gain_lev"),
                wheel_int("offset_r"), wheel_int("offset_g"), wheel_int("offset_b"), wheel_lev("offset_lev"),
                io.Float.Input("shadows_temp", display_name="Shadows Temp", default=0.0, min=-0.3, max=0.3, step=0.005),
                io.Float.Input("shadows_sat", display_name="Shadows Sat", default=0.0, min=-1.0, max=1.0, step=0.01),
                io.Float.Input("midtones_temp", display_name="Midtones Temp", default=0.0, min=-0.3, max=0.3, step=0.005),
                io.Float.Input("midtones_sat", display_name="Midtones Sat", default=0.0, min=-1.0, max=1.0, step=0.01),
                io.Float.Input("highlights_temp", display_name="Highlights Temp", default=0.0, min=-2.0, max=2.0, step=0.01),
                io.Float.Input("highlights_sat", display_name="Highlights Sat", default=0.0, min=-2.0, max=2.0, step=0.01),
                io.Float.Input("whites_temp", display_name="Whites Temp", default=0.0, min=-2.0, max=2.0, step=0.01),
                io.Float.Input("whites_sat", display_name="Whites Sat", default=0.0, min=-2.0, max=2.0, step=0.01),
                # ── Secondary (target-color) correction — step E ──
                io.Float.Input("target_r", display_name="target_r", default=0.0, min=0.0, max=1.0, step=0.001),
                io.Float.Input("target_g", display_name="target_g", default=0.0, min=0.0, max=1.0, step=0.001),
                io.Float.Input("target_b", display_name="target_b", default=0.0, min=0.0, max=1.0, step=0.001),
                io.Float.Input("sec_valid", display_name="sec_valid", default=0.0, min=0.0, max=1.0, step=1,
                               tooltip="1 = picked color is active, 0 = inactive."),
                io.Float.Input("picked_tolerance", display_name="picked_tolerance", default=0.5, min=0.0, max=1.0, step=0.01,
                               tooltip="Color-match width: 0 = near-exact color only, 1 = all similar tones."),
                io.Float.Input("picked_hue", display_name="picked_hue", default=0.0, min=-1.0, max=1.0, step=0.005),
                io.Float.Input("picked_saturation", display_name="picked_saturation", default=0.0, min=-1.0, max=1.0, step=0.005),
                io.Float.Input("picked_luma", display_name="picked_luma", default=0.0, min=-1.0, max=1.0, step=0.005),
                io.Audio.Input("audio", display_name="AUDIO", optional=True,
                               tooltip="Optional audio passthrough {waveform, sample_rate}."),
            ],
            outputs=[
                io.Image.Output(display_name="IMAGE", tooltip="Graded image batch [B,H,W,C] sRGB 0..1."),
                io.Audio.Output(display_name="AUDIO", tooltip="Audio passthrough (placeholder if no input)."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image, frame_index=0, audio=None, temperature=0.0, tint=0.0, brightness=0.0, contrast=0.0,
                vibrance=0.0,
                curve_shadows=0.0, curve_mids=0.0, curve_lights=0.0,
                highlight_rolloff=0.0, shadow_open=0.0,
                lift_r=128, lift_g=128, lift_b=128, lift_lev=0.03,
                gamma_r=128, gamma_g=128, gamma_b=128, gamma_lev=0.3,
                gain_r=128, gain_g=128, gain_b=128, gain_lev=0.3,
                offset_r=128, offset_g=128, offset_b=128, offset_lev=0.05,
                shadows_temp=0.0, shadows_sat=0.0,
                midtones_temp=0.0, midtones_sat=0.0,
                highlights_temp=0.0, highlights_sat=0.0,
                whites_temp=0.0, whites_sat=0.0,
                target_r=0.0, target_g=0.0, target_b=0.0, sec_valid=0.0,
                picked_tolerance=0.5, picked_hue=0.0, picked_saturation=0.0, picked_luma=0.0,
                film_grain=False,
                grain_strength=0.284, grain_size=0.0, grain_softness=0.234):

        # Clamp inputs
        temperature = max(-1.0, min(1.0, float(temperature)))
        tint = max(-1.0, min(1.0, float(tint)))
        brightness = max(-0.5, min(0.5, float(brightness)))
        contrast = max(-0.5, min(0.5, float(contrast)))
        curve_shadows = max(-0.25, min(0.25, float(curve_shadows)))
        curve_mids = max(-0.25, min(0.25, float(curve_mids)))
        curve_lights = max(-0.25, min(0.25, float(curve_lights)))
        vibrance = max(-1.0, min(1.0, float(vibrance)))
        highlight_rolloff = max(0.0, min(0.4, float(highlight_rolloff)))
        shadow_open = max(0.0, min(0.12, float(shadow_open)))
        target_r = max(0.0, min(1.0, float(target_r)))
        target_g = max(0.0, min(1.0, float(target_g)))
        target_b = max(0.0, min(1.0, float(target_b)))
        sec_valid = max(0.0, min(1.0, float(sec_valid)))
        picked_tolerance = max(0.0, min(1.0, float(picked_tolerance)))
        picked_hue = max(-1.0, min(1.0, float(picked_hue)))
        picked_saturation = max(-1.0, min(1.0, float(picked_saturation)))
        picked_luma = max(-1.0, min(1.0, float(picked_luma)))
        film_grain = bool(film_grain)
        grain_strength = max(0.0, min(1.0, float(grain_strength)))
        grain_size = max(0.0, min(1.0, float(grain_size)))
        grain_softness = max(0.0, min(1.0, float(grain_softness)))

        B = image.shape[0] if image.dim() == 4 else 1
        frame_index = max(0, min(frame_index, B - 1))

        # Normalize RGB
        def rgb_to_shift(r, g, b):
            return ((r - 128) / 64.0, (g - 128) / 64.0, (b - 128) / 64.0)

        lift_rgb = rgb_to_shift(lift_r, lift_g, lift_b)
        gamma_rgb = rgb_to_shift(gamma_r, gamma_g, gamma_b)
        gain_rgb = rgb_to_shift(gain_r, gain_g, gain_b)
        offset_rgb = rgb_to_shift(offset_r, offset_g, offset_b)

        # Check if anything is non-neutral
        wheels_active = (lift_lev > 0.0 and lift_rgb != (0.0, 0.0, 0.0) or
                         gamma_lev > 0.0 and gamma_rgb != (0.0, 0.0, 0.0) or
                         gain_lev > 0.0 and gain_rgb != (0.0, 0.0, 0.0) or
                         offset_lev > 0.0 and offset_rgb != (0.0, 0.0, 0.0))

        luma_active = (abs(shadows_temp) > 0.001 or abs(shadows_sat) > 0.001 or
                       abs(midtones_temp) > 0.001 or abs(midtones_sat) > 0.001 or
                       abs(highlights_temp) > 0.001 or abs(highlights_sat) > 0.001 or
                       abs(whites_temp) > 0.001 or abs(whites_sat) > 0.001)

        sec_active = (sec_valid >= 0.5 and
                      (abs(picked_hue) > 0.001 or abs(picked_saturation) > 0.001 or abs(picked_luma) > 0.001))

        if (abs(temperature) < 0.001 and abs(tint) < 0.001 and abs(brightness) < 0.001 and abs(contrast) < 0.001 and 
            abs(vibrance) < 0.001 and abs(curve_shadows) < 0.001 and abs(curve_mids) < 0.001
            and abs(curve_lights) < 0.001 and highlight_rolloff <= 0.001 and shadow_open <= 0.001
            and not wheels_active and not luma_active and not sec_active
            and (not film_grain or grain_strength <= 0.001)):
            out_image = image.clone()
        else:
            def _grade(chunk, seed_offset):
                return apply_color_grading(
                    chunk, temperature, tint, brightness, contrast,
                    lift_rgb, gamma_rgb, gain_rgb, offset_rgb,
                    float(lift_lev), float(gamma_lev), float(gain_lev), float(offset_lev),
                    vibrance=vibrance,
                    curve_shadows=curve_shadows, curve_mids=curve_mids, curve_lights=curve_lights,
                    highlight_rolloff=highlight_rolloff, shadow_open=shadow_open,
                    shadows_temp=shadows_temp, shadows_sat=shadows_sat,
                    midtones_temp=midtones_temp, midtones_sat=midtones_sat,
                    highlights_temp=highlights_temp, highlights_sat=highlights_sat,
                    whites_temp=whites_temp, whites_sat=whites_sat,
                    target_r=target_r, target_g=target_g, target_b=target_b,
                    sec_valid=sec_valid, picked_tolerance=picked_tolerance,
                    picked_hue=picked_hue, picked_saturation=picked_saturation, picked_luma=picked_luma,
                    film_grain=bool(film_grain), grain_seed_offset=seed_offset,
                    grain_strength=grain_strength, grain_size=grain_size,
                    grain_softness=grain_softness,
                )

            if B > 1:
                # Video: process in PROGRESS_CHUNK-frame slices and report
                # done/total to the ComfyUI terminal after each chunk.
                _outs = []
                for _start in range(0, B, PROGRESS_CHUNK):
                    _outs.append(_grade(image[_start:_start + PROGRESS_CHUNK], _start))
                    _report_progress(min(_start + PROGRESS_CHUNK, B), B)
                out_image = torch.cat(_outs, dim=0)
            else:
                out_image = _grade(image, 0)

        # Audio passthrough — AUDIO format is {'waveform': tensor, 'sample_rate': int}
        if audio is None:
            out_audio = {
                "waveform": torch.zeros(1, 2, 1, device=image.device),
                "sample_rate": 48000,
            }
        else:
            out_audio = audio

        # Cache original input for live preview (per node)
        # Hidden inputs in V3 API are NOT kwargs — read from cls.hidden (HiddenHolder).
        extra_pnginfo = cls.hidden.extra_pnginfo if cls.hidden else None
        node_id = cls.hidden.unique_id if cls.hidden else None
        workflow_id = None
        if extra_pnginfo and "workflow" in extra_pnginfo:
            workflow_id = extra_pnginfo["workflow"].get("id", "unknown")
        if node_id is None:
            node_id = "x"
        cache_key = f"cg_{workflow_id}_{node_id}"

        prune_node_cache(workflow_id, node_id)
        preview_cache[cache_key] = image.clone().detach()
        preview_cache.move_to_end(cache_key)

        while len(preview_cache) > MAX_CACHE_ITEMS:
            oldest_key, _ = preview_cache.popitem(last=False)

        return io.NodeOutput(
            out_image,
            out_audio,
            ui={
                "cache_key": [cache_key],
                "total_frames": [B],
                "frame_index": [frame_index],
            },
        )


WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "ColorGrading": ColorGrading,
}

__all__ = ["NODE_CLASS_MAPPINGS"]
