// @ts-ignore
import { app } from "/scripts/app.js";

/**
 * ComfyUI Color Grading — Frontend (Stage 4b: Embedded Preview).
 *
 * Architecture (inspired by OlmLGG pattern, custom implementation):
 *   1. Python caches the input image & returns cache_key via "ui" field.
 *   2. JS fetches /colorgrading/api/preview/update with current widget values.
 *   3. Response is a base64 PNG drawn inside the node body via onDrawForeground.
 *
 * Slot labels are normalized via the standard ComfyUI extension hook
 * (beforeRegisterNodeDef) by setting input.label / output.label, the
 * same way plaguekind-nodes and cg-use-everywhere do it. No canvas
 * overlay is used for labels.
 */

const PREVIEW_PADDING = 15;
const FRAME_SLIDER_H = 28;
const FRAME_LABEL_H = 16;
// Fixed height for the widget area (same approach as Olm-LGG).
// With 21 widgets at ~28px each this is close to the real height;
// the preview starts below this fixed line, not below the computed sum.
const WIDGETS_AREA_HEIGHT = 620;

// User-defined minimum node size (measured by the user in the UI:
// 972.5 x 1678 -> rounded up to 973 x 1678).
// The node must not shrink below this in ANY state (any tab open/closed).
const CG_USER_MIN_W = 973;
const CG_USER_MIN_H = 1678;

// Factory defaults for the RESET ALL button. Must mirror the Python schema
// defaults in __init__.py (define_schema). frame_index is intentionally
// NOT reset — it is navigation, not a grading value.
const CG_DEFAULTS = {
    temperature: 0.0,
    tint: 0.0,
    brightness: 0.0,
    contrast: 0.0,
    vibrance: 0.0,
    curve_shadows: 0.0, curve_mids: 0.0, curve_lights: 0.0,
    highlight_rolloff: 0.0,
    shadow_open: 0.0,
    lift_r: 128, lift_g: 128, lift_b: 128, lift_lev: 0.03,
    gamma_r: 128, gamma_g: 128, gamma_b: 128, gamma_lev: 0.3,
    gain_r: 128, gain_g: 128, gain_b: 128, gain_lev: 0.3,
    offset_r: 128, offset_g: 128, offset_b: 128, offset_lev: 0.05,
    shadows_temp: 0.0, shadows_sat: 0.0,
    midtones_temp: 0.0, midtones_sat: 0.0,
    highlights_temp: 0.0, highlights_sat: 0.0,
    whites_temp: 0.0, whites_sat: 0.0,
    target_r: 0.0, target_g: 0.0, target_b: 0.0, sec_valid: 0.0,
    picked_tolerance: 0.5, picked_hue: 0.0, picked_saturation: 0.0, picked_luma: 0.0,
    film_grain: false,
    grain_strength: 0.284,
    grain_size: 0.0,
    grain_softness: 0.234,
};

// ── Э3: 4 wheels in ONE ROW — LIFT | GAMMA | GAIN | OFFSET ─────────
// DaVinci-style: angle = hue, radius = strength. Axial orientation:
// yellow at top (t=0 → hue 60°), blue at bottom (t=180° → hue 240°).
// hue(t) = (60 + t_deg) % 360, t = clockwise angle from top.
const WHEEL_D = 213;              // wheel diameter (px), user: 1.5x smaller than 320 (visual only)
const WHEEL_SEGS = 96;            // hue segments
const LEV_H = 10;                 // Lev slider bar height (px), scaled with the wheel
// Per-wheel LEV limits (user-confirmed empirically), step 0.001, default = max.
const LEV_MAX = { lift: 0.03, gamma: 0.3, gain: 0.3, offset: 0.05 };
const RGB_H = 14;                 // RGB readout row height (px), under the Lev bar, scaled with the wheel
// Wheel block: ONE ROW with 4 wheels (user request), each = label + wheel
// + LEV row + RGB row. The preview is placed BELOW the block — no overlap.
const WHEEL_ROW_H = 16 + WHEEL_D + 6 + LEV_H + 6 + RGB_H;
const WHEEL_COL_GAP = 24;
const WHEELS_BLOCK_H = PREVIEW_PADDING + 2 + WHEEL_ROW_H + 8;
const WHEELS_BLOCK_W = PREVIEW_PADDING + 4 * WHEEL_D + 3 * WHEEL_COL_GAP + PREVIEW_PADDING;
// ── Tabs (accordion, step 1): a tab row between the widget stack and the
// canvas blocks. One tab for now: WHEELS (default open — node._cgOpenTab
// self-heals from undefined to "wheels"; click toggles open/closed).
const TAB_ROW_H = 32;
const TAB_GAP = 4; // gap between the tab row and the canvas block below
const CG_TAB_ORDER = ["light", "grain", "curves", "color", "wheels", "secondary"];
const CG_TAB_LABELS = { light: "LIGHT", grain: "GRAIN", curves: "CURVES", color: "COLOR", wheels: "COLOR WHEELS", secondary: "ADJUST PICKED" };
// DOM slider rows owned by each accordion tab (wheels = canvas block, no
// rows). Bottom blocks (luma knobs, SEC strip) are NOT in tabs — user:
// «нижние под превью не трогай, они не мешают» (always visible).
const CG_SECTION_WIDGETS = {
    light: ["brightness", "contrast", "highlight_rolloff", "shadow_open"],
    grain: ["film_grain", "grain_strength", "grain_size", "grain_softness"],
    curves: ["curve_shadows", "curve_mids", "curve_lights"],
    color: ["temperature", "tint", "vibrance"],
    secondary: ["picked_tolerance", "picked_hue", "picked_saturation", "picked_luma"],
};
function cgSectionRows(section) {
    const g = CG_SECTION_WIDGETS[section];
    return g ? g.length : 0;
}
const WHEEL_ORDER = ["lift", "gamma", "gain", "offset"]; // ONE ROW: LIFT|GAMMA|GAIN|OFFSET
// Wheel labels (user-confirmed): name in caps, range in lowercase parens.
const WHEEL_LABELS = { lift: "LIFT (shadows)", gamma: "GAMMA (midtones)", gain: "GAIN (highlights)", offset: "OFFSET (all range)" };

// ── Э4: luma knobs — 2 rows BELOW the preview (anchored to node bottom) ──
// Row 1: Shadows Temp/Sat + Midtones Temp/Sat. Row 2: Highlights + Whites.
// knob angle = value: −135°…+135° ↔ −range…+range (0 = straight up), step 0.01,
// range from LUMA_KNOB_RANGE (shadows/midtones temp 0.3, sat 1.0; highlights/whites 2.0).
const LUMA_KNOB_R = 72; // user: knobs visually 1.5x bigger (was 48)
const LUMA_KNOB_ROWS = [
    ["shadows_temp", "shadows_sat", "midtones_temp", "midtones_sat"],
    ["highlights_temp", "highlights_sat", "whites_temp", "whites_sat"],
];
const LUMA_KNOB_LABELS = {
    shadows_temp: "Shadows Temp", shadows_sat: "Shadows Sat",
    midtones_temp: "Midtones Temp", midtones_sat: "Midtones Sat",
    highlights_temp: "Highlights Temp", highlights_sat: "Highlights Sat",
    whites_temp: "Whites Temp", whites_sat: "Whites Sat",
};
// Value range per knob: user-set maxes — shadows/midtones TEMP ±0.3, sats ±1.0,
// highlights/whites ±2.0 (user: max ×2).
const LUMA_KNOB_RANGE = {
    shadows_temp: 0.3, shadows_sat: 1, midtones_temp: 0.3, midtones_sat: 1,
    highlights_temp: 2, highlights_sat: 2, whites_temp: 2, whites_sat: 2,
};
// Drag step per knob — mirrors the schema step (shadows/midtones temp 0.005).
const LUMA_KNOB_STEP = {
    shadows_temp: 0.005, midtones_temp: 0.005,
    shadows_sat: 0.01, midtones_sat: 0.01,
    highlights_temp: 0.01, highlights_sat: 0.01,
    whites_temp: 0.01, whites_sat: 0.01,
};
const LUMA_ROW_H = 2 * LUMA_KNOB_R + 40; // knob + label row + value row
const LUMA_ROW_GAP = 8;
const LUMA_BLOCK_H = 8 + LUMA_ROW_H + LUMA_ROW_GAP + LUMA_ROW_H + 8; // two rows + margins

// ── E: Secondary (target color) — strip between preview and luma knobs ──
const SEC_STRIP_H = 44;   // swatch row height (px)
const SEC_SWATCH = 36;    // swatch square size (px)
const SEC_NAMES = ["picked_tolerance", "picked_hue", "picked_saturation", "picked_luma"]; // visible sliders (gray until pick)
const SEC_TARGET_NAMES = ["target_r", "target_g", "target_b", "sec_valid"]; // hidden state widgets

function hslToRgb255(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHue(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 0;
    const d = mx - mn;
    let h;
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

function widgetVal(node, name, dflt) {
    for (const w of node.widgets || []) if (w.name === name) return w.value;
    return dflt;
}

// E: gray out / enable the 4 secondary sliders by the picked-color state
// (user: inactive until a color is picked, active after; widget.disabled is
// honored by the v1.52 DOM-widget layer: gray + no interaction).
function cgSecSyncEnabled(node) {
    const valid = widgetVal(node, "sec_valid", 0) >= 0.5;
    for (const w of node.widgets || []) {
        if (SEC_NAMES.includes(w.name)) w.disabled = !valid;
    }
}

// E: click on the preview = pick the average color of a small region under
// the cursor. Sends normalized coords; the server averages the ORIGINAL
// cached frame (resolution-independent) and returns the sRGB color (0..1).
function cgPreviewClickPick(node, x, y) {
    const img = node._cgPreviewImage;
    if (!img || !img.complete || img.naturalWidth === 0) return false;
    // Recompute the preview rect EXACTLY like onDrawForeground does.
    const w = node.size[0];
    const h = node.size[1];
    const totalWidgetH = computeWidgetHeight(node);
    const contentTop = cgContentTop(node, totalWidgetH);
    const sliderH = (node._cgTotalFrames ?? 1) > 1 ? (FRAME_SLIDER_H + FRAME_LABEL_H + 4) : 0;
    const availW = w - PREVIEW_PADDING * 2;
    const availH = (h - contentTop - LUMA_BLOCK_H) - PREVIEW_PADDING * 2 - sliderH - SEC_STRIP_H;
    if (availW <= 10 || availH <= 10) return false;
    const imgAspect = img.naturalWidth / img.naturalHeight;
    let previewW, previewH;
    if (availW / availH > imgAspect) { previewH = availH; previewW = previewH * imgAspect; }
    else { previewW = availW; previewH = previewW / imgAspect; }
    const previewX = (w - previewW) / 2;
    const previewY = contentTop + PREVIEW_PADDING;
    if (x < previewX || x > previewX + previewW || y < previewY || y > previewY + previewH) return false;
    const u = (x - previewX) / previewW;
    const v = (y - previewY) / previewH;
    node._cgPickU = u; // crosshair position (normalized preview coords)
    node._cgPickV = v;
    node.setDirtyCanvas(true, true);
    const cache_key = node._cgCacheKey;
    if (!cache_key) {
        console.warn("[ColorGrading] pick: no cache_key yet — run Queue Prompt once first");
        return true;
    }
    fetch(`/colorgrading/api/preview/sample?key=${encodeURIComponent(cache_key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame_index: node._cgFrameIndex ?? 0, u: u, v: v }),
    }).then((r) => r.json()).then((data) => {
        if (data.status !== "success") { console.warn("[ColorGrading] sample:", data); return; }
        for (const wdg of node.widgets || []) {
            if (wdg.name === "target_r") wdg.value = data.r;
            else if (wdg.name === "target_g") wdg.value = data.g;
            else if (wdg.name === "target_b") wdg.value = data.b;
            else if (wdg.name === "sec_valid") wdg.value = 1.0;
        }
        cgSecSyncEnabled(node);
        node.setDirtyCanvas(true, true);
        if (node.widgets_values_changed) node.widgets_values_changed(); // live preview
    }).catch((e) => console.warn("[ColorGrading] sample failed:", e));
    return true;
}

// E: draw the secondary strip: swatch + RGB readout + status.
// Position: below the preview (and the video frame slider), above the luma
// knobs. Geometry derived from the same constants as onDrawForeground.
function drawSecStrip(ctx, node, previewH, sliderH) {
    const w = node.size[0];
    const totalWidgetH = computeWidgetHeight(node);
    const contentTop = cgContentTop(node, totalWidgetH);
    const stripY = contentTop + PREVIEW_PADDING + previewH + 4 + sliderH;
    const valid = widgetVal(node, "sec_valid", 0) >= 0.5;
    const r255 = Math.round(widgetVal(node, "target_r", 0) * 255);
    const g255 = Math.round(widgetVal(node, "target_g", 0) * 255);
    const b255 = Math.round(widgetVal(node, "target_b", 0) * 255);

    // Centered content: swatch + RGB boxes + status text
    const boxW = 35, boxH = 20, boxGap = 8;
    const rgbW = boxW * 3 + boxGap * 2;
    const textW = 230;
    const contentW = SEC_SWATCH + 12 + rgbW + 16 + textW;
    let sx = (w - contentW) / 2;
    const cy = stripY + SEC_STRIP_H / 2;

    // Swatch (real picked color / dashed placeholder)
    const swY = cy - SEC_SWATCH / 2;
    if (valid) {
        ctx.fillStyle = `rgb(${r255},${g255},${b255})`;
        ctx.fillRect(sx, swY, SEC_SWATCH, SEC_SWATCH);
    } else {
        ctx.fillStyle = "#1e1e1e";
        ctx.fillRect(sx, swY, SEC_SWATCH, SEC_SWATCH);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, swY + 0.5, SEC_SWATCH - 1, SEC_SWATCH - 1);
        ctx.setLineDash([]);
    }
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, swY + 0.5, SEC_SWATCH - 1, SEC_SWATCH - 1);
    sx += SEC_SWATCH + 12;

    // RGB readout boxes (same pattern as the wheels)
    const vals = [r255, g255, b255];
    const colors = ["#f88", "#8f8", "#88f"];
    const boxY = cy - boxH / 2;
    for (let i = 0; i < 3; i++) {
        const bx = sx + i * (boxW + boxGap);
        ctx.fillStyle = "#141414";
        ctx.fillRect(bx, boxY, boxW, boxH);
        ctx.strokeStyle = "#444";
        ctx.strokeRect(bx + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
        ctx.font = "12px monospace";
        ctx.fillStyle = valid ? colors[i] : "#555";
        ctx.textAlign = "center";
        ctx.fillText(valid ? String(vals[i]) : "–", bx + boxW / 2, boxY + boxH / 2 + 4);
    }
    sx += rgbW + 16;

    // Status text
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = valid ? "#7ab8f0" : "#777";
    ctx.fillText(valid ? "target locked — click preview to replace" : "click preview to pick color", sx, cy + 4);
}

// ── Tabs (accordion): state + geometry helpers — single source of truth ──
// Open accordion tab (self-heal: undefined → "wheels", default open).
function cgOpenTab(node) {
    if (node._cgOpenTab === undefined) node._cgOpenTab = "wheels"; // default: open
    return node._cgOpenTab;
}
function cgWheelsVisible(node) {
    return cgOpenTab(node) === "wheels";
}
// Top of the wheel block (right below the tab row).
function cgWheelBlockTop(node) {
    return computeWidgetHeight(node) + TAB_ROW_H + TAB_GAP;
}
// Top of the preview zone: below the wheel block ONLY while the tab is open.
function cgContentTop(node, totalWidgetH) {
    return totalWidgetH + TAB_ROW_H + TAB_GAP + (cgWheelsVisible(node) ? WHEELS_BLOCK_H : 0);
}

// Accordion: show the open tab's DOM slider rows, hide the other
// sections' rows. Pattern proven with the 28 hidden canvas-replacement
// widgets: hidden + computeSize [0,0]; values stay the single source of
// truth (POST / prompt / save). Idempotent — safe to call every frame.
function cgApplySectionVisibility(node) {
    const open = cgOpenTab(node);
    for (const section of Object.keys(CG_SECTION_WIDGETS)) {
        const show = (open === section);
        for (const name of CG_SECTION_WIDGETS[section]) {
            const w = (node.widgets || []).find(wd => wd.name === name);
            if (!w) continue;
            if (show && w.hidden) {
                w.hidden = false;
                w.computeSize = (w._cgSavedSize !== undefined) ? w._cgSavedSize : undefined;
                w._cgSavedSize = undefined;
            } else if (!show && !w.hidden) {
                w._cgSavedSize = w.computeSize;
                w.hidden = true;
                w.computeSize = () => [0, 0];
            }
        }
    }
}

// Draw the tab row (LIGHT | CURVES | COLOR | WHEELS | SECONDARY). Records
// each tab's rect on node._cgTabRects for mouse hit-testing — same
// single-source pattern as the wheel layout. Drawn in every state.
function drawTabRow(ctx, node, totalWidgetH) {
    const top = totalWidgetH + 2;
    let x = PREVIEW_PADDING;
    const tabH = TAB_ROW_H - 4;
    const open = cgOpenTab(node);
    node._cgTabRects = {};
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const section of CG_TAB_ORDER) {
        const label = CG_TAB_LABELS[section];
        const tabW = Math.ceil(ctx.measureText(label).width) + 26;
        node._cgTabRects[section] = { x: x, y: top, w: tabW, h: tabH };
        const active = (open === section);
        ctx.fillStyle = active ? "#2a4a6b" : "#1f2233";
        ctx.strokeStyle = active ? "#5b8dbe" : "#3a3f55";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, top, tabW, tabH, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = active ? "#fff" : "#9aa3b5";
        ctx.fillText(label, x + 10, top + tabH / 2 + 1);
        if (active) {
            ctx.fillStyle = "#7ab8f0";
            ctx.beginPath();
            ctx.arc(x + tabW - 11, top + tabH / 2, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        x += tabW + 6;
    }
    ctx.textBaseline = "alphabetic";
}

// Per-wheel layout for the ONE-ROW block — one source of truth for drawing
// AND mouse hit-testing, so they can never drift apart.
// Grid: ONE ROW — LIFT | GAMMA | GAIN | OFFSET (col = index).
function wheelLayout(node, name) {
    const R = WHEEL_D / 2;
    const idx = WHEEL_ORDER.indexOf(name);
    if (idx < 0) return null;
    const row = 0, col = idx;
    const blockTop = cgWheelBlockTop(node);
    const rowTop = blockTop;
    // Wheel row is horizontally CENTERED within the node width (the node
    // can be wider than the row after the 1.5x shrink).
    const rowW = 4 * WHEEL_D + 3 * WHEEL_COL_GAP;
    const blockLeft = Math.max(PREVIEW_PADDING, (node.size[0] - rowW) / 2);
    const cx = blockLeft + col * (WHEEL_D + WHEEL_COL_GAP) + R;
    const cy = rowTop + 16 + R; // 16px reserved for the label row
    const levY = cy + R + 6;
    const levW = 160; // scaled with the wheel (was 240)
    const groupW = 30 + 6 + levW + 6 + 34; // "LEV" label + bar + value
    const startX = cx - groupW / 2;
    const levX = startX + 36;
    return { R, topY: rowTop, cx, cy, levX, levY, levW };
}

// Pointer (x,y) on the wheel → (r,g,b) 0..255. Angle = hue, radius = strength.
function wheelPointToRgb(wl, x, y) {
    const dx = x - wl.cx, dy = y - wl.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const t = Math.atan2(dx, -dy); // 0 at top, clockwise
    const tDeg = ((t * 180 / Math.PI) % 360 + 360) % 360;
    const hue = (60 + tDeg) % 360;
    const rho = Math.max(0, Math.min(1, dist / wl.R));
    const c = hslToRgb255(hue, 1, 0.5);
    const to255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return [to255(128 + rho * (c[0] - 128)), to255(128 + rho * (c[1] - 128)), to255(128 + rho * (c[2] - 128))];
}

function wheelHitTest(node, x, y) {
    // Wheels live only while the WHEELS tab is open (accordion step 1);
    // the luma knobs below are always live (they are not inside the tab).
    if (cgWheelsVisible(node) && node.size[0] >= WHEEL_D + PREVIEW_PADDING * 2) {
        for (const name of WHEEL_ORDER) {
            const wl = wheelLayout(node, name);
            if (!wl) continue;
            const dx = x - wl.cx, dy = y - wl.cy;
            if (dx * dx + dy * dy <= wl.R * wl.R) return { kind: "wheel", wl, name };
            if (x >= wl.levX - 2 && x <= wl.levX + wl.levW + 2 &&
                y >= wl.levY - 3 && y <= wl.levY + LEV_H + 3) return { kind: "lev", wl, name };
        }
    }
    for (const kb of lumaKnobLayout(node)) {
        const dx = x - kb.cx, dy = y - kb.cy;
        if (dx * dx + dy * dy <= (kb.R + 4) * (kb.R + 4)) return { kind: "knob", knob: kb, name: kb.name };
    }
    return null;
}

// Luma knob block layout (2 rows × 4), anchored to the node bottom —
// single source of truth for drawing AND hit-testing (never drift apart).
function lumaKnobLayout(node) {
    const w = node.size[0], h = node.size[1];
    const R = LUMA_KNOB_R;
    const row1Top = h - LUMA_BLOCK_H + 8;
    const slotW = (w - PREVIEW_PADDING * 2) / 4;
    const out = [];
    for (let r = 0; r < 2; r++) {
        const rowTop = row1Top + r * (LUMA_ROW_H + LUMA_ROW_GAP);
        for (let c = 0; c < 4; c++) {
            const name = LUMA_KNOB_ROWS[r][c];
            out.push({ name: name, cx: PREVIEW_PADDING + (c + 0.5) * slotW, cy: rowTop + R, R: R });
        }
    }
    return out;
}

// Draw the 8 luma knobs (Э4). value → angle = v*135° (0 = up), 1:1 inverse
// of the drag mapping — dot always exactly at the value position.
function drawLumaKnobs(ctx, node) {
    const knobs = lumaKnobLayout(node);
    const T0 = 135 * Math.PI / 180; // canvas angle of knob angle −135°
    for (const kb of knobs) {
        const v = widgetVal(node, kb.name, 0);
        const range = LUMA_KNOB_RANGE[kb.name] || 1;
        const aKnob = Math.max(-135, Math.min(135, (v / range) * 135)); // knob angle for value v
        const active = Math.abs(v) >= 0.005;
        // Knob body
        ctx.beginPath();
        ctx.arc(kb.cx, kb.cy, kb.R, 0, Math.PI * 2);
        ctx.fillStyle = "#2a2a2a";
        ctx.fill();
        ctx.strokeStyle = "#3a3a3a";
        ctx.lineWidth = 1;
        ctx.stroke();
        // Track arc (knob angle −135°…+135°)
        ctx.beginPath();
        ctx.arc(kb.cx, kb.cy, kb.R, T0, 45 * Math.PI / 180);
        ctx.strokeStyle = "#4a4a4a";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.stroke();
        // Active arc from −135° to the value angle
        if (active) {
            const aEnd = (aKnob - 90) * Math.PI / 180;
            ctx.beginPath();
            ctx.arc(kb.cx, kb.cy, kb.R, T0, aEnd);
            ctx.strokeStyle = "#4a90d9";
            ctx.lineWidth = 4;
            ctx.stroke();
        }
        // Dot — exact inverse of the drag mapping (angle = aKnob)
        const aRad = aKnob * Math.PI / 180;
        const px = kb.cx + kb.R * Math.sin(aRad);
        const py = kb.cy - kb.R * Math.cos(aRad);
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 2;
        ctx.stroke();
        // Label + value below the knob
        ctx.font = "11px Arial, sans-serif";
        ctx.fillStyle = "#ccc";
        ctx.textAlign = "center";
        ctx.fillText(LUMA_KNOB_LABELS[kb.name] || kb.name, kb.cx, kb.cy + kb.R + 18);
        ctx.font = "12px monospace";
        ctx.fillStyle = active ? "#7ab8f0" : "#777";
        ctx.fillText(v.toFixed(3), kb.cx, kb.cy + kb.R + 36);
    }
    ctx.lineCap = "butt";
}

// Hover tooltip for canvas controls (wheels, LEV bars, luma knobs):
// "Slide to adjust" near the cursor. Drawn at the END of onDrawForeground
// (both the noimage and full-preview paths) so it sits on top of
// everything; shown while hovering, hidden on mouse-leave and while dragging.
function cgDrawHoverTip(ctx, node) {
    if (!node._cgHoverCtl || !node._cgHoverPos) return;
    const t = "Slide to adjust";
    ctx.font = "11px monospace";
    const tw = ctx.measureText(t).width + 12;
    const th = 18;
    const w = node.size[0], h = node.size[1];
    let x = node._cgHoverPos[0] + 14;
    let y = node._cgHoverPos[1] + 16;
    if (x + tw > w - 4) x = node._cgHoverPos[0] - tw - 10; // flip left of cursor
    if (y + th > h - 4) y = node._cgHoverPos[1] - th - 10; // flip above cursor
    ctx.fillStyle = "rgba(12, 16, 24, 0.92)";
    ctx.strokeStyle = "#3d5a7a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, tw, th, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#cfe8ff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(t, x + 6, y + th / 2 + 1);
}

// Write wheel/lev pointer result into that wheel's own widgets (values are
// the single source of truth), then refresh live preview via the debouncer.
function wheelApply(node, hit, x, y) {
    const findW = (name) => (node.widgets || []).find((w) => w.name === name);
    if (hit.kind === "wheel") {
        const [r, g, b] = wheelPointToRgb(hit.wl, x, y);
        const wr = findW(hit.name + "_r"), wg = findW(hit.name + "_g"), wb = findW(hit.name + "_b");
        if (wr) wr.value = r;
        if (wg) wg.value = g;
        if (wb) wb.value = b;
    } else if (hit.kind === "lev") {
        const t = Math.max(0, Math.min(1, (x - hit.wl.levX) / hit.wl.levW));
        const max = LEV_MAX[hit.name] ?? 0.03;
        const wv = findW(hit.name + "_lev");
        if (wv) wv.value = Math.min(max, Math.round(t * max * 1000) / 1000);
    } else { // knob (luma, Э4): angle −135°…+135° ↔ −range…+range, per-knob step
        const dx = x - hit.knob.cx, dy = y - hit.knob.cy;
        const aDeg = Math.max(-135, Math.min(135, Math.atan2(dx, -dy) * 180 / Math.PI));
        const range = LUMA_KNOB_RANGE[hit.name] || 1;
        const step = LUMA_KNOB_STEP[hit.name] || 0.01;
        const wv = findW(hit.name);
        if (wv) wv.value = parseFloat((Math.round((aDeg / 135) * range / step) * step).toFixed(3));
    }
    node.setDirtyCanvas(true, true);
    if (node.widgets_values_changed) node.widgets_values_changed();
}

// Draw ONE LIFT wheel (step-1 visual). Position: left side of the area
// below widgets (temporarily overlaps the preview until step-2 layout).
// Draw ALL FOUR wheels in ONE ROW: LIFT|GAMMA|GAIN|OFFSET. Each block:
// label, full hue disc, marker (true inverse of drag mapping), LEV bar,
// RGB readout row. Geometry from wheelLayout() — same source as hit-test.
function drawWheels(ctx, node) {
    if (node.size[0] < WHEEL_D + PREVIEW_PADDING * 2) return;
    for (const name of WHEEL_ORDER) {
        const wl = wheelLayout(node, name);
        if (!wl) continue;
        drawWheelBlock(ctx, node, name, wl);
    }
}

function drawWheelBlock(ctx, node, name, wl) {
    const R = wl.R, topY = wl.topY, cx = wl.cx, cy = wl.cy;
    const nW = node.size[0];
    if (cx - R > nW) return; // fully off-screen right (narrow node) — skip

    // Label (same font as the frame label): name in caps + range in lowercase
    ctx.font = "11px monospace";
    ctx.fillStyle = "#ccc";
    ctx.textAlign = "center";
    ctx.fillText(WHEEL_LABELS[name] || name.toUpperCase(), cx, topY + 10);

    // Full hue disc (user request: palette over the WHOLE circle, no gray
    // hole): 96 pie segments, clockwise from top, yellow → blue at bottom.
    for (let i = 0; i < WHEEL_SEGS; i++) {
        const a0 = (i / WHEEL_SEGS) * Math.PI * 2 - Math.PI / 2;
        const a1 = ((i + 1) / WHEEL_SEGS) * Math.PI * 2 - Math.PI / 2;
        const hue = (60 + (i / WHEEL_SEGS) * 360) % 360;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = "hsl(" + hue + ", 100%, 50%)";
        ctx.fill();
    }

    // Crisp edge
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Marker from <name>_r/g/b widget values (128 = neutral = center).
    // TRUE inverse of the drag forward-mapping (value = 128 + rho*(C-128)):
    // rho = |value-128| / |C-128|, so the point always lands EXACTLY where
    // the cursor produced the value — 1:1 follow while dragging, stays at
    // the release position, no lag, no center magnet (user requirement).
    const r = widgetVal(node, name + "_r", 128);
    const g = widgetVal(node, name + "_g", 128);
    const b = widgetVal(node, name + "_b", 128);
    const ox = (r - 128) / 128, oy = (g - 128) / 128, oz = (b - 128) / 128;
    const mag = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const hue = rgbToHue(r, g, b);
    const tDeg = (((hue - 60) % 360) + 360) % 360;
    const t = tDeg * Math.PI / 180;
    const c = hslToRgb255(hue, 1, 0.5);
    const dR = c[0] - 128, dG = c[1] - 128, dB = c[2] - 128;
    const len = Math.sqrt(dR * dR + dG * dG + dB * dB); // ≈221 for pure hues
    const rho = Math.min(1, (mag * 128) / len);
    const mx = cx + Math.sin(t) * rho * R;
    const my = cy - Math.cos(t) * rho * R;
    const neutral = mag < 0.008; // cosmetic only: gray dot when value ≈ 128
    ctx.beginPath();
    ctx.arc(mx, my, 7, 0, Math.PI * 2);
    ctx.fillStyle = neutral ? "#999" : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Lev slider row under the wheel (value = <name>_lev widget, 0..LEV_MAX[name])
    const lv = widgetVal(node, name + "_lev", LEV_MAX[name] ?? 0.03);
    ctx.fillStyle = "#1a1a2e";
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(wl.levX, wl.levY, wl.levW, LEV_H, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3a6ea5";
    ctx.beginPath();
    ctx.roundRect(wl.levX + 2, wl.levY + 2, Math.max(0, (wl.levW - 4) * Math.min(1, lv / (LEV_MAX[name] ?? 0.03))), LEV_H - 4, 2);
    ctx.fill();
    ctx.font = "11px monospace";
    ctx.fillStyle = "#ccc";
    ctx.textAlign = "right";
    ctx.fillText("LEV", wl.levX - 8, wl.levY + 11);
    ctx.textAlign = "left";
    ctx.fillText(lv.toFixed(3), wl.levX + wl.levW + 8, wl.levY + 11);

    // RGB readout row under the wheel (user request: see the point color as
    // numbers, e.g. |223|223|32|). Olm-LGG draws value fields below its wheel;
    // here: 3 boxed channels + a real-color swatch, live while dragging.
    const rgbY = wl.levY + LEV_H + 6;
    const boxW = 35, gap = 2; // scaled with the wheel (was 52)
    const rowW = 3 * boxW + 2 * gap; // 160
    const rowX = cx - rowW / 2;
    // Color swatch — the actual color of the wheel point.
    const swX = rowX - 8 - RGB_H;
    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    ctx.strokeStyle = "#666";
    ctx.lineWidth = 1;
    ctx.fillRect(swX, rgbY, RGB_H, RGB_H);
    ctx.strokeRect(swX, rgbY, RGB_H, RGB_H);
    const chanVals = [r, g, b];
    const chanColors = ["#f88", "#8f8", "#88f"];
    for (let i = 0; i < 3; i++) {
        const bx = rowX + i * (boxW + gap);
        ctx.fillStyle = "#1a1a2e";
        ctx.strokeStyle = "#555";
        ctx.beginPath();
        ctx.roundRect(bx, rgbY, boxW, RGB_H, 3);
        ctx.fill();
        ctx.stroke();
        ctx.font = "12px monospace";
        ctx.fillStyle = chanColors[i];
        ctx.textAlign = "center";
        ctx.fillText(String(chanVals[i]), bx + boxW / 2, rgbY + 14);
    }
}


/**
 * Get all current widget values from the node as a flat dict.
 */
function getWidgetValues(node) {
    const vals = {};
    for (const w of node.widgets || []) {
        if (w.type === "hidden") continue;
        vals[w.name] = w.value;
    }
    return vals;
}


/**
 * Create a debounced preview-updater for a node (pattern from Olm-LGG):
 * rapid widget changes coalesce into one request ~120ms after the last
 * change, so dragging a slider does not flood the backend with POSTs.
 * A request generation counter discards stale responses (last one wins),
 * so a slow old response can never paint over a newer image.
 */
function createPreviewUpdater(node) {
    let timer = null;
    let gen = 0;
    return function update() {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const cache_key = node._cgCacheKey;
            if (!cache_key) {
                return;
            }
            const myGen = ++gen;
            const params = getWidgetValues(node);
            params.frame_index = params.frame_index ?? 0;
            try {
                const resp = await fetch(
                    `/colorgrading/api/preview/update?key=${encodeURIComponent(cache_key)}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(params),
                    }
                );
                if (!resp.ok) return;
                const data = await resp.json();
                if (data.status !== "success") return;
                const img = await new Promise((resolve) => {
                    const im = new Image();
                    im.onload = () => resolve(im);
                    im.onerror = () => resolve(null);
                    im.src = data.preview_image;
                });
                // Drop stale responses: a newer request has already been made.
                if (img && myGen === gen) {
                    node._cgPreviewImage = img;
                    node.setDirtyCanvas(true, true);
                }
            } catch (e) {
                console.warn("[ColorGrading] preview update failed:", e);
            }
        }, 120);
    };
}


/**
 * Request a preview image from the backend API (one-shot, used by onExecuted).
 */
async function requestPreviewUpdate(node) {
    const cache_key = node._cgCacheKey;
    if (!cache_key) {
        return null;
    }

    const params = getWidgetValues(node);
    params.frame_index = params.frame_index ?? 0;

    try {
        const resp = await fetch(
            `/colorgrading/api/preview/update?key=${encodeURIComponent(cache_key)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            }
        );

        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.status !== "success") return null;

        // Load image from base64
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = data.preview_image;
        });

    } catch (e) {
        console.warn("[ColorGrading] Preview fetch failed:", e);
        return null;
    }
}

/**
 * Restore the server-side preview cache key when the JS side lost it
 * (browser reload, or the "execution cache skip" case: ComfyUI re-queues
 * an identical prompt → node SKIPPED → onExecuted never fires → no
 * cache_key → no preview). The server preview cache survives reloads, so
 * ask /colorgrading/api/preview/peek for THIS node's key, then fetch the
 * preview image. Fired at most once per transition into the "noimage"
 * draw state, only when an image is connected.
 */
async function cgRestorePreviewKey(node) {
    try {
        const resp = await fetch("/colorgrading/api/preview/peek", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: node.id }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.status !== "success") return;
        node._cgCacheKey = data.cache_key;
        node._cgTotalFrames = data.total_frames ?? 1;
        const img = await requestPreviewUpdate(node);
        if (img) {
            node._cgPreviewImage = img;
            node.setDirtyCanvas(true, true);
        }
    } catch (e) {
        /* restore failed: will retry on the next "noimage" transition */
    }
}


/**
 * Bottom of the visible widget stack (node-local px, onDrawForeground origin).
 *
 * Source of truth (verified with live diagnostics): the ComfyUI frontend
 * lays out the DOM widget rows itself — each visible widget gets w.y (row
 * top) and w.computedHeight (row pitch; observed 24 = NODE_WIDGET_HEIGHT+4).
 * The real bottom of the last row = max(w.y + w.computedHeight) over visible
 * widgets (measured: 17 rows, first y=46, pitch 24 → last bottom 454).
 *
 * The old implementation summed 30px per widget (w.computeSize fallback) —
 * the widgets carry no computeSize in this UI, so it overshot the real
 * stack and left a visible gap above the wheel block.
 *
 * Fallback (before the framework assigns row positions, e.g. the first
 * onNodeCreated tick): observed layout formula — first row top 46, pitch 24
 * → bottom of N rows = 46 + 24*N (equals the real value, no visual jump).
 */
function computeWidgetHeight(node) {
    let n = 0;
    let bottom = null;
    for (const w of node.widgets || []) {
        if (w.type === "hidden" || w.hidden) continue;
        n++;
        if (typeof w.y === "number" && w.y > 0) {
            const ch = (typeof w.computedHeight === "number" && w.computedHeight > 0) ? w.computedHeight : 24;
            const b = w.y + ch;
            if (bottom === null || b > bottom) bottom = b;
        }
    }
    if (bottom !== null) return bottom;
    return 46 + 24 * n;
}

/**
 * Resize the node body so the preview + frame slider fit inside it
 * (fixes defect B2: preview was drawn below the visible body edge).
 */
function ensurePreviewSize(node) {
    const img = node._cgPreviewImage;
    if (!img) return;
    const widgetH = computeWidgetHeight(node);
    const w = node.size[0];
    const availW = w - PREVIEW_PADDING * 2;
    const B = node._cgTotalFrames ?? 1;
    const sliderH = (B > 1) ? (FRAME_SLIDER_H + FRAME_LABEL_H + 4) : 0;
    // Ensure at least a reasonable preview height (e.g. 400px) plus slider.
    const targetPreviewH = 400;
    const neededH = widgetH + TAB_ROW_H + TAB_GAP + (cgWheelsVisible(node) ? WHEELS_BLOCK_H : 0) + LUMA_BLOCK_H + PREVIEW_PADDING * 2 + targetPreviewH + sliderH + SEC_STRIP_H;
    if (neededH > node.size[1]) {
        node.setSize([node.size[0], neededH]);
    }
}

/**
 * Draw the preview + frame slider inside the node body.
 */
function onDrawForeground(ctx, node) {
    if (node.flags && node.flags.collapsed) return;

    // ComfyUI v1.52: onDrawForeground ctx is ALREADY in node-local coords
    // (0,0 = top-left of node body). Do NOT translate — same as Olm-LGG.

    // Node inner dimensions
    const w = node.size[0];
    const h = node.size[1];

    // Accordion: apply the open tab's slider visibility (idempotent
    // self-heal, like cgHideWheelWidgets) BEFORE measuring the stack.
    cgApplySectionVisibility(node);

    // Real widget area height (title + all visible widgets).
    const totalWidgetH = computeWidgetHeight(node);

    // Tabs (accordion step 1): the WHEELS tab row is drawn in every state
    // (like the knobs) — it stays visible before/without the preview.
    drawTabRow(ctx, node, totalWidgetH);

    // Э3: 4 wheels in ONE ROW (LIFT|GAMMA|GAIN|OFFSET) in its OWN reserved
    // block — the preview is strictly below it, no overlap. Rendered only
    // while the WHEELS tab is open.
    if (cgWheelsVisible(node)) drawWheels(ctx, node);

    // Э4: two rows of luma knobs BELOW the preview (anchored to node bottom) —
    // drawn before the early-return so they exist even before the first Queue.
    drawLumaKnobs(ctx, node);

    const img = node._cgPreviewImage;
    if (!img || !img.complete || img.naturalWidth === 0) {
        // First Queue with default values (or after a browser reload)
        // ComfyUI may SKIP node execution (execution cache) → onExecuted
        // never fires → no cache_key → no preview. Restore the key from
        // the server-side preview cache once per transition here.
        if (node._cgDrawState !== "noimage") {
            node._cgDrawState = "noimage";
            if (node.inputs && node.inputs.length > 0 && node.inputs[0].link != null) {
                cgRestorePreviewKey(node);
            }
        }
        cgDrawHoverTip(ctx, node);
        return;
    }

    // Preview goes BELOW the tab row (+ the wheel block while the WHEELS
    // tab is open); the luma knobs go BELOW the preview (anchored to node
    // bottom) — reserve LUMA_BLOCK_H + slider.
    const contentTop = cgContentTop(node, totalWidgetH);
    const availW = w - PREVIEW_PADDING * 2;
    const sliderH = (node._cgTotalFrames ?? 1) > 1 ? (FRAME_SLIDER_H + FRAME_LABEL_H + 4) : 0;
    const availH = (h - contentTop - LUMA_BLOCK_H) - PREVIEW_PADDING * 2 - sliderH - SEC_STRIP_H;
    if (availW <= 10 || availH <= 10) return; // node too small to show preview
    
    // Image aspect ratio.
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const imgAspect = imgW / imgH;
    
    // Fit image into available space, preserving aspect ratio (like object-fit: contain).
    let previewW, previewH;
    if (availW / availH > imgAspect) {
        // Available space is wider than image → fit by height.
        previewH = availH;
        previewW = previewH * imgAspect;
    } else {
        // Available space is taller than image → fit by width.
        previewW = availW;
        previewH = previewW / imgAspect;
    }

    // Draw preview image, horizontally centered in the available space
    const previewX = (w - previewW) / 2;
    ctx.drawImage(img, previewX, contentTop + PREVIEW_PADDING, previewW, previewH);
    node._cgDrawState = "ok"; // preview visible: re-arms the noimage restore guard

    // Frame slider area (centered with the preview)
    const sliderY = contentTop + PREVIEW_PADDING + previewH + 4;
    const B = node._cgTotalFrames ?? 1;

    if (B > 1) {
        // Background bar
        ctx.fillStyle = "#1a1a2e";
        ctx.strokeStyle = "#444";
        ctx.lineWidth = 1;
        const barH = FRAME_SLIDER_H - 4;
        const barX = previewX;
        const barW = previewW;
        ctx.beginPath();
        ctx.roundRect(barX, sliderY, barW, barH, 4);
        ctx.fill();
        ctx.stroke();

        // Progress fill
        const progress = B > 1 ? (node._cgFrameIndex ?? 0) / (B - 1) : 0;
        ctx.fillStyle = "#3a6ea5";
        ctx.beginPath();
        ctx.roundRect(barX + 2, sliderY + 2, (barW - 4) * progress, barH - 4, 3);
        ctx.fill();

        // Thumb
        const thumbX = barX + 2 + (barW - 4) * progress;
        const thumbR = 6;
        ctx.beginPath();
        ctx.arc(thumbX, sliderY + barH / 2, thumbR, 0, Math.PI * 2);
        ctx.fillStyle = "#eee";
        ctx.fill();
        ctx.strokeStyle = "#3a6ea5";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Frame label
        ctx.font = "11px monospace";
        ctx.fillStyle = "#ccc";
        ctx.textAlign = "center";
        const frameText = `${node._cgFrameIndex ?? 0} / ${B - 1}`;
        ctx.fillText(frameText, barX + barW / 2, sliderY + barH + FRAME_LABEL_H);
    }

    // E: crosshair at the picked point (normalized preview coords)
    if (node._cgPickU != null && node._cgPickV != null) {
        const px = previewX + node._cgPickU * previewW;
        const py = contentTop + PREVIEW_PADDING + node._cgPickV * previewH;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px - 14, py); ctx.lineTo(px + 14, py);
        ctx.moveTo(px, py - 14); ctx.lineTo(px, py + 14);
        ctx.stroke();
    }

    // E: secondary strip (swatch + RGB readout + status)
    drawSecStrip(ctx, node, previewH, sliderH);

    // Hover tooltip "Slide to adjust" — topmost (full-preview path).
    cgDrawHoverTip(ctx, node);
}


/**
 * Mouse handling for the frame slider.
 */
function onSliderMouseDown(node, localPos) {
    const B = node._cgTotalFrames ?? 1;
    if (B <= 1) return false;

    const w = node.size[0];
    const previewW = w - PREVIEW_PADDING * 2;

    // Calculate slider position (real widget-stack bottom; also fixes the
    // known defect: slider hit-zone used the stale 30px/widget formula)
    const totalWidgetH = computeWidgetHeight(node);

    const img = node._cgPreviewImage;
    const previewH = img ? Math.min(img.height, (w / img.width) * previewW) : 200;
    const sliderY = cgContentTop(node, totalWidgetH) + PREVIEW_PADDING + previewH + 4;
    const barH = FRAME_SLIDER_H - 4;

    if (localPos[1] >= sliderY && localPos[1] <= sliderY + barH) {
        // Update frame_index widget
        const progress = Math.max(0, Math.min(1, (localPos[0] - PREVIEW_PADDING) / previewW));
        const newFrame = Math.round(progress * (B - 1));

        for (const w of node.widgets || []) {
            if (w.name === "frame_index") {
                w.value = newFrame;
                break;
            }
        }

        // Request updated preview
        requestPreviewUpdate(node).then(img => {
            if (img) {
                node._cgPreviewImage = img;
                node.setDirtyCanvas(true, true);
            }
        });

        return true;
    }
    return false;
}



// Hide the standard widgets replaced by canvas controls:
// 16 wheel widgets (r/g/b/lev × 4 wheels) + 8 luma widgets (Э4 knobs)
// + 4 secondary state widgets (E: target_r/g/b, sec_valid).
// HIDE, do not delete: values remain the single source of truth (POST preview
// / prompt / workflow save). w.type stays "number" — getWidgetValues() skips
// only type === "hidden". Retry-safe: if widgets are not ready yet (nothing
// hidden), do NOT set the flag.
function cgHideWheelWidgets(node) {
    if (node._cgWidgetsHidden) return;
    const lumaNames = LUMA_KNOB_ROWS[0].concat(LUMA_KNOB_ROWS[1]);
    let hiddenCount = 0;
    for (const w of node.widgets || []) {
        const isWheelWidget = WHEEL_ORDER.some((n) =>
            w.name === n + "_r" || w.name === n + "_g" || w.name === n + "_b" || w.name === n + "_lev");
        if (isWheelWidget || lumaNames.includes(w.name) || SEC_TARGET_NAMES.includes(w.name)) {
            w.hidden = true;
            w.computeSize = () => [0, 0];
            hiddenCount++;
        }
    }
    if (hiddenCount > 0) node._cgWidgetsHidden = true;
}

// ── Standard ComfyUI extension registration ─────────────────
// Pattern: single `beforeRegisterNodeDef` hook + prototype patch on
// onNodeCreated. Slot labels (IMAGE / AUDIO) are now set natively by
// the backend via io.Schema display_name (stage-5), so no JS label
// normalization is needed. This extension only handles the live
// preview: state init, onDrawForeground, onMouseDown, onExecuted,
// and widget-change refresh.

app.registerExtension({
    name: "color-grading.labels-and-preview",

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (!nodeData || nodeData.name !== "ColorGrading") return;

            // ── Hard minimum size (v1.53) ─────────────────────────────
            // The new frontend enforces the manual-resize floor via
            // computeSize() — called on every corner drag. This is the
            // mechanism Olm LGG uses (their node cannot be dragged to a
            // dot either). min_size / onResize are NOT honored in this
            // build. Floor = max(comfy auto size, content min, user min).
            const originalComputeSize = nodeType.prototype.computeSize;
            nodeType.prototype.computeSize = function (out) {
                let size;
                if (originalComputeSize) {
                    size = originalComputeSize.call(this, out);
                } else {
                    size = LiteGraph.LGraphNode.prototype.computeSize.call(this, out);
                }
                const mw = Math.max(this._cgMinSize ? this._cgMinSize[0] : 0, CG_USER_MIN_W);
                const mh = Math.max(this._cgMinSize ? this._cgMinSize[1] : 0, CG_USER_MIN_H);
                size[0] = Math.max(size[0], mw);
                size[1] = Math.max(size[1], mh);
                return size;
            };

            const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
            const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
            const originalOnExecuted = nodeType.prototype.onExecuted;
            const originalOnMouseDown = nodeType.prototype.onMouseDown;
            const originalOnMouseMove = nodeType.prototype.onMouseMove;
            const originalOnMouseUp = nodeType.prototype.onMouseUp;
            const originalOnMouseLeave = nodeType.prototype.onMouseLeave;

            // New node instance: set up state, override draw/execute/mouse.
            nodeType.prototype.onNodeCreated = function () {
                originalOnNodeCreated?.call(this);

                this._cgPreviewImage = null;
                this._cgCacheKey = null;
                this._cgTotalFrames = 1;
                this._cgFrameIndex = 0;
                this._cgHoverCtl = null;  // hover tooltip: control name or null
                this._cgHoverPos = null;  // hover tooltip: cursor pos (node-local)
                this._cgPreviewUpdater = createPreviewUpdater(this);

                // Hide the standard widgets replaced by canvas controls.
                cgHideWheelWidgets(this);
                cgSecSyncEnabled(this); // E: sec sliders start gray (no picked color)

                // Clean stale extra outputs (legacy second AUDIO slot).
                const expectedOutputs = 2;
                while ((this.outputs || []).length > expectedOutputs) {
                    this.removeOutput(this.outputs.length - 1);
                }

                // Drop orphaned loose links whose origin is this node.
                const cgCleanStaleLinks = () => {
                    try {
                        const graph = LiteGraph.instance?.canvas?.current_graph;
                        const links = graph && graph.links;
                        if (!links) return;
                        for (const linkId of Object.keys(links)) {
                            const l = links[linkId];
                            if (!l) continue;
                            if (Number(l.origin_slot) === -1 && !l.target_node_id && Number(l.origin_id) === Number(this.id)) {
                                delete links[linkId];
                            }
                        }
                    } catch (e) {
                        console.warn("[ColorGrading] stale link cleanup failed:", e);
                    }
                };
                cgCleanStaleLinks();
                setTimeout(cgCleanStaleLinks, 300);

                // Draw preview + frame slider (no label overlay).
                this.onDrawForeground = function (ctx) {
                    originalOnDrawForeground?.call(this, ctx);
                    cgHideWheelWidgets(this); // self-heal: also for loaded nodes
                    cgSecSyncEnabled(this); // E: slider enabled state (loaded nodes too)
                    onDrawForeground(ctx, this);
                };

                // Mouse: LIFT wheel / Lev bar — pattern from Olm-LGG
                // ColorWheelWidget (proven in this ComfyUI build):
                //   mousedown: hit → dragging=true + immediate apply, return true
                //   mousemove: event.buttons !== 1 → release (works even when
                //              the pointer leaves the node); else keep applying
                //   mouseup / mouseleave: safety release
                this.onMouseDown = function (event, localPos) {
                    // Tabs (accordion): click a tab → open it (others
                    // collapse); click the open tab → close it. Shrink/grow
                    // the node with the changed content (wheel canvas block
                    // and/or slider rows) so the preview stays in the user's
                    // field of view, and keep min_size in sync.
                    const rects = this._cgTabRects;
                    if (rects) {
                        for (const section of CG_TAB_ORDER) {
                            const tr = rects[section];
                            if (!tr) continue;
                            if (localPos[0] < tr.x || localPos[0] > tr.x + tr.w ||
                                localPos[1] < tr.y || localPos[1] > tr.y + tr.h) continue;
                            const was = cgOpenTab(this);
                            this._cgOpenTab = (was === section) ? null : section;
                            cgApplySectionVisibility(this);
                            const dH = (((this._cgOpenTab === "wheels") ? WHEELS_BLOCK_H : 0) -
                                       ((was === "wheels") ? WHEELS_BLOCK_H : 0)) +
                                       (cgSectionRows(this._cgOpenTab) - cgSectionRows(was)) * 24;
                            if (this._cgMinSize) {
                                // Stored min never drops below the user-set
                                // floor, regardless of tab open/close (dH +/-).
                                this._cgMinSize = [Math.max(this._cgMinSize[0], CG_USER_MIN_W),
                                                   Math.max(this._cgMinSize[1] + dH, CG_USER_MIN_H)];
                                this.min_size = [this._cgMinSize[0], this._cgMinSize[1]];
                            }
                            const cw = this.size[0], ch = this.size[1];
                            const newMinH = this._cgMinSize ? this._cgMinSize[1] : 0;
                            this.setSize([cw, Math.max(newMinH, ch + dH)]);
                            this.setDirtyCanvas(true, true);
                            return true;
                        }
                    }
                    const hit = wheelHitTest(this, localPos[0], localPos[1]);
                    if (hit) {
                        this._cgWheelDrag = hit;
                        wheelApply(this, hit, localPos[0], localPos[1]);
                        return true;
                    }
                    if (onSliderMouseDown(this, localPos)) return true;
                    // E: click on the preview = pick the color
                    if (cgPreviewClickPick(this, localPos[0], localPos[1])) return true;
                    if (originalOnMouseDown) return originalOnMouseDown.call(this, event, localPos);
                    return false;
                };

                this.onMouseMove = function (event, localPos) {
                    if (this._cgWheelDrag && localPos) {
                        if (event.buttons !== 1) {
                            this._cgWheelDrag = null; // button released
                        } else {
                            wheelApply(this, this._cgWheelDrag, localPos[0], localPos[1]);
                        }
                        // Dragging hides the hover tooltip.
                        if (this._cgHoverCtl) {
                            this._cgHoverCtl = null;
                            this._cgHoverPos = null;
                            this.setDirtyCanvas(true, true);
                        }
                    } else if (localPos) {
                        // Hover tooltip "Slide to adjust" over wheels / LEV
                        // bars / luma knobs. Redraw only on target change or
                        // cursor movement > 2 px (keeps it cheap).
                        const hit = wheelHitTest(this, localPos[0], localPos[1]);
                        if (hit) {
                            const prev = this._cgHoverPos;
                            if (hit.name !== this._cgHoverCtl || !prev ||
                                Math.abs(prev[0] - localPos[0]) > 2 ||
                                Math.abs(prev[1] - localPos[1]) > 2) {
                                this._cgHoverCtl = hit.name;
                                this._cgHoverPos = [localPos[0], localPos[1]];
                                this.setDirtyCanvas(true, true);
                            }
                        } else if (this._cgHoverCtl) {
                            this._cgHoverCtl = null;
                            this._cgHoverPos = null;
                            this.setDirtyCanvas(true, true);
                        }
                    }
                    if (originalOnMouseMove) return originalOnMouseMove.call(this, event, localPos);
                    return false;
                };

                this.onMouseUp = function (event, localPos) {
                    this._cgWheelDrag = null;
                    if (originalOnMouseUp) return originalOnMouseUp.call(this, event, localPos);
                    return false;
                };

                this.onMouseLeave = function (event, localPos) {
                    this._cgWheelDrag = null;
                    if (this._cgHoverCtl) {
                        this._cgHoverCtl = null;
                        this._cgHoverPos = null;
                        this.setDirtyCanvas(true, true);
                    }
                    if (originalOnMouseLeave) return originalOnMouseLeave.call(this, event, localPos);
                    return false;
                };

                // Clamp node size back to minimum after any manual resize.
                // v1.52 LiteGraph may not honor this.min_size on manual drag.
                const origOnResize = this.onResize;
                this.onResize = function (width, height) {
                    if (origOnResize) origOnResize.call(this, width, height);
                    // Floor = max(content min, user-set min): a manual resize
                    // can never shrink the node below the user's size.
                    const mw = Math.max(this._cgMinSize ? this._cgMinSize[0] : 0, CG_USER_MIN_W);
                    const mh = Math.max(this._cgMinSize ? this._cgMinSize[1] : 0, CG_USER_MIN_H);
                    if (width < mw || height < mh) {
                        this.setSize([Math.max(width, mw), Math.max(height, mh)]);
                    }
                };

                // Receive cache_key & total_frames after execution.
                this.onExecuted = async function (message) {
                    if (originalOnExecuted) await originalOnExecuted.call(this, message);

                    // ComfyUI v1.52: Python passes ui dict WITHOUT wrapping in "ui" key.
                    const cacheKey = message?.cache_key?.[0] ?? message?.ui?.cache_key?.[0];
                    if (!cacheKey) {
                        return;
                    }
                    if (cacheKey) {
                        this._cgCacheKey = cacheKey;
                        this._cgTotalFrames = message?.total_frames?.[0] ?? message?.ui?.total_frames?.[0] ?? 1;
                        this._cgFrameIndex = message?.frame_index?.[0] ?? message?.ui?.frame_index?.[0] ?? 0;

                        for (const w of this.widgets || []) {
                            if (w.name === "frame_index") {
                                w.value = this._cgFrameIndex;
                                break;
                            }
                        }

                        const img = await requestPreviewUpdate(this);
                        if (img) {
                            this._cgPreviewImage = img;
                            ensurePreviewSize(this);
                            // Enforce minimum node size so preview cannot be cropped.
                            const imgW = img.naturalWidth;
                            const imgH = img.naturalHeight;
                            const longSide = Math.max(imgW, imgH);
                            const scale = 768 / longSide; // = PREVIEW_MAX_SIZE (server downscale)
                            const previewW = imgW * scale;
                            const previewH = imgH * scale;
                            // Real widget-stack bottom (single source of truth).
                            const actualWidgetH = computeWidgetHeight(this);
                            const minNodeW = Math.max(previewW + PREVIEW_PADDING * 2, WHEELS_BLOCK_W, CG_USER_MIN_W);
                            const minNodeH = Math.max(actualWidgetH + TAB_ROW_H + TAB_GAP + (cgWheelsVisible(this) ? WHEELS_BLOCK_H : 0) + LUMA_BLOCK_H + PREVIEW_PADDING * 2 + previewH + (this._cgTotalFrames > 1 ? (FRAME_SLIDER_H + FRAME_LABEL_H + 4) : 0) + SEC_STRIP_H, CG_USER_MIN_H);
                            if (this.size[0] < minNodeW || this.size[1] < minNodeH) {
                                this.setSize([Math.max(this.size[0], minNodeW), Math.max(this.size[1], minNodeH)]);
                            }
                            // Set minimum size so user cannot shrink below preview.
                            this.min_size = [minNodeW, minNodeH];
                            this._cgMinSize = [minNodeW, minNodeH];
                            this.setDirtyCanvas(true, true);
                        }
                    }
                };

                // Live preview on widget changes: any widget change
                // (slider move, number edit, ...) re-renders the preview
                // from the cached frame WITHOUT re-running the graph.
                // Debounced ~120ms so dragging does not flood the backend.
                const nodeRef = this; // `this` = node here (we are inside onNodeCreated)
                this.widgets_values_changed = function () {
                    for (const w of this.widgets || []) {
                        if (w.name === "frame_index") {
                            this._cgFrameIndex = w.value;
                        }
                    }
                    if (!this._cgCacheKey) return;
                    this._cgPreviewUpdater();
                };

                // Hook widget.callback — the ACTUAL hook LiteGraph fires
                // on every value change (slider drag AND number input).
                // w.afterChange is only called on commit, not during drag,
                // so it cannot drive live preview (verified against
                // ComfyUI-EasyColorCorrector, which uses widget.callback).
                for (const w of this.widgets || []) {
                    const origCallback = w.callback;
                    // NOTE: w.callback is invoked as widget.callback(value) —
                    // `this` inside is the WIDGET, not the node. The node
                    // must be captured in a closure variable.
                    w.callback = function () {
                        if (origCallback) origCallback.apply(this, arguments);
                        nodeRef.widgets_values_changed();
                    };
                }

                // One-row wheel block layout: grow the node so block + preview fit.
                {
                    const widgetH = computeWidgetHeight(this);
                    const neededW = Math.max(this.size[0], WHEELS_BLOCK_W);
                    const neededH = widgetH + TAB_ROW_H + TAB_GAP + (cgWheelsVisible(this) ? WHEELS_BLOCK_H : 0) + LUMA_BLOCK_H + PREVIEW_PADDING * 2 + 400 + SEC_STRIP_H;
                    this.setSize([neededW, Math.max(this.size[1], neededH)]);
                }

                // RESET ALL button (Olm-LGG pattern: addWidget("button") +
                // restore defaults + refresh preview). NO confirm (user:
                // «нажал — сбросилось»). Button widgets are not sent to the
                // backend prompt payload.
                this.addWidget("button", "RESET ALL", 0, () => {
                    for (const w of nodeRef.widgets || []) {
                        if (Object.prototype.hasOwnProperty.call(CG_DEFAULTS, w.name)) {
                            w.value = CG_DEFAULTS[w.name];
                        }
                    }
                    nodeRef._cgPickU = null; // RESET clears the picked color too
                    nodeRef._cgPickV = null;
                    cgSecSyncEnabled(nodeRef);
                    nodeRef.setDirtyCanvas(true, true);
                    nodeRef.widgets_values_changed(); // debounce → preview POST
                });

                // E: CLEAR PICKED COLOR — un-pick the color (sliders keep
                // their values but go gray; crosshair is cleared).
                this.addWidget("button", "CLEAR PICKED COLOR", 0, () => {
                    for (const wdg of nodeRef.widgets || []) {
                        if (wdg.name === "sec_valid") wdg.value = 0;
                    }
                    nodeRef._cgPickU = null;
                    nodeRef._cgPickV = null;
                    cgSecSyncEnabled(nodeRef);
                    nodeRef.setDirtyCanvas(true, true);
                    nodeRef.widgets_values_changed(); // debounce → preview POST
                });
            };
        },
    });
