#!/usr/bin/env python3
"""Contrast checker — WCAG 2.x ratio + APCA Lc. No dependencies.

Accepts hex (#rrggbb / #rgb), rgb(), and oklch() colors.

Usage:
  contrast.py "#111827" "#ffffff"                 # one pair
  contrast.py --pair fg=#6b7280 bg=#ffffff --pair fg=#fff bg=oklch(0.58 0.19 264)
  contrast.py --tokens tokens.json                # {"text":"#111","bg":"#fff",...} -> matrix
  contrast.py --css packages/web/src/index.css    # extract --color-* tokens -> matrix

Exit code 1 if any checked pair fails WCAG AA body text (4.5:1).

Targets:
  WCAG AA  4.5:1 body / 3:1 large text + UI boundaries    (compliance floor)
  APCA     Lc 75 body / 60 content / 45 large / 30 non-text (design target)
"""

import argparse
import json
import math
import re
import sys

# ---------- parsing ----------


def _srgb_from_hex(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 8:
        s = s[:6]
    if len(s) != 6:
        raise ValueError(f"bad hex: {s}")
    return tuple(int(s[i : i + 2], 16) / 255 for i in (0, 2, 4))


def _oklch_to_srgb(L, C, H):
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def enc(c):
        c = max(0.0, min(1.0, c))
        return 1.055 * (c ** (1 / 2.4)) - 0.055 if c > 0.0031308 else 12.92 * c

    return (enc(r), enc(g), enc(bl))


def parse_color(text):
    """-> (r,g,b) in 0..1 sRGB."""
    t = text.strip().lower()
    if t.startswith("#"):
        return _srgb_from_hex(t)
    m = re.match(r"oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)", t)
    if m:
        L = float(m.group(1).rstrip("%")) / (100 if "%" in m.group(1) else 1)
        C = float(m.group(2).rstrip("%")) / (100 if "%" in m.group(2) else 1) * (0.4 if "%" in m.group(2) else 1)
        return _oklch_to_srgb(L, C, float(m.group(3)))
    m = re.match(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)", t)
    if m:
        v = [float(m.group(i)) for i in (1, 2, 3)]
        return tuple(x / 255 if max(v) > 1 else x for x in v)
    if re.fullmatch(r"[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8}", t):
        return _srgb_from_hex(t)
    raise ValueError(f"unrecognized color: {text!r}")


# ---------- WCAG 2.x ----------


def rel_luminance(rgb):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def wcag_ratio(fg, bg):
    a, b = rel_luminance(fg), rel_luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


# ---------- APCA (0.1.9 core) ----------

_S_TRC, _R, _G, _B = 2.4, 0.2126729, 0.7151522, 0.0721750
_N_BG, _N_TX, _R_BG, _R_TX = 0.56, 0.57, 0.62, 0.65
_B_CLIP, _B_THRSH, _SCALE_BOW, _SCALE_WOB = 1.414, 0.022, 1.14, 1.14
_LO_CLIP, _DELTA_LO = 0.1, 0.027


def _apca_y(rgb):
    r, g, b = rgb
    return _R * (r**_S_TRC) + _G * (g**_S_TRC) + _B * (b**_S_TRC)


def apca_lc(fg, bg):
    """Lightness contrast, -108..108. Sign shows polarity (positive = dark text on light bg)."""
    txt, bgd = _apca_y(fg), _apca_y(bg)
    txt = 0.0 if txt < 0 else txt
    bgd = 0.0 if bgd < 0 else bgd
    txt = txt + (_B_THRSH - txt) ** _B_CLIP if txt < _B_THRSH else txt
    bgd = bgd + (_B_THRSH - bgd) ** _B_CLIP if bgd < _B_THRSH else bgd
    if abs(bgd - txt) < 0.0005:
        return 0.0
    if bgd > txt:  # dark text on light bg
        c = (bgd**_N_BG - txt**_N_TX) * _SCALE_BOW
        out = 0.0 if c < _LO_CLIP else c - _DELTA_LO
    else:  # light text on dark bg
        c = (bgd**_R_BG - txt**_R_TX) * _SCALE_WOB
        out = 0.0 if c > -_LO_CLIP else c + _DELTA_LO
    return out * 100


# ---------- reporting ----------


def apca_band(lc):
    a = abs(lc)
    if a >= 90:
        return "any text"
    if a >= 75:
        return "body text"
    if a >= 60:
        return "content text"
    if a >= 45:
        return "large text only"
    if a >= 30:
        return "non-text only"
    return "INVISIBLE"


def verdict(ratio, lc, kind):
    """kind: 'text' -> 4.5:1 required. 'ui' -> 3:1 required. 'info' -> reported only."""
    if kind == "info":
        # decorative dividers have no floor; but if used as a control border it needs 3:1
        return ("ok as divider" if ratio >= 3.0 else "divider only (<3:1)"), apca_band(lc), True, True
    floor = 3.0 if kind == "ui" else 4.5
    passes = ratio >= floor
    if kind == "ui":
        w = "AA (UI 3:1)" if passes else "FAIL (needs 3:1)"
        near = ratio >= 2.5
    else:
        if ratio >= 7.0:
            w = "AAA body"
        elif ratio >= 4.5:
            w = "AA body"
        elif ratio >= 3.0:
            w = "large text only"
        else:
            w = "FAIL"
        near = ratio >= 3.0
    return w, apca_band(lc), passes, near


def report(pairs):
    """pairs: list of (label, fg_str, bg_str[, kind])"""
    failures = 0
    w = max((len(p[0]) for p in pairs), default=10)
    print(f"  {'pair'.ljust(w)}  {'WCAG':>8}  {'APCA':>7}  {'need':>4}  {'verdict':<17}  apca ok for")
    print("-" * (w + 56))
    for p in pairs:
        label, fgs, bgs = p[0], p[1], p[2]
        kind = p[3] if len(p) > 3 else "text"
        try:
            fg, bg = parse_color(fgs), parse_color(bgs)
        except ValueError as e:
            print(f"X {label.ljust(w)}  {e}")
            failures += 1
            continue
        r, lc = wcag_ratio(fg, bg), apca_lc(fg, bg)
        v, ap, ok, near = verdict(r, lc, kind)
        mark = "  " if ok else ("! " if near else "X ")
        need = {"ui": "3:1", "info": "—"}.get(kind, "4.5:1")
        print(f"{mark}{label.ljust(w)}  {r:6.2f}:1  {lc:+7.1f}  {need:>5}  {v:<17}  {ap}")
        if not ok:
            failures += 1
    print()
    print("X = fails its WCAG floor   ! = close but under (within one band)")
    print("floors: text 4.5:1 · large text & UI boundaries/icons/focus 3:1 · plain dividers: no floor")
    print("NOTE: if a 'divider only' colour is used as an INPUT or control border, it must reach 3:1.")
    print("APCA design targets: Lc 75 body · 60 content · 45 large · 30 non-text")
    if failures:
        print(f"\n{failures} pair(s) FAILING — fix before shipping.")
    return failures


# Roles that sit ON a surface, vs the surfaces themselves. Used to build only
# meaningful pairs instead of a nonsense cross product.
SURFACE_KEYS = ("bg", "background", "canvas", "surface", "card", "panel", "base")
TEXT_ROLE_KEYS = ("text", "muted", "label", "placeholder", "heading", "foreground")
# 3:1 required — these bound or indicate an interactive control
UI_ROLE_KEYS = ("border-strong", "outline", "ring", "focus", "icon", "control")
# reported for information only — a purely decorative divider has no WCAG floor,
# but if you use it as an INPUT border it must clear 3:1, so look at the number.
INFO_ROLE_KEYS = ("border", "divider", "separator", "rule")
# fill -> its own foreground token (checked as a dedicated pair)
FILL_FG = {
    "accent": "accent-fg",
    "accent-hover": "accent-fg",
    "accent-active": "accent-fg",
    "success": "success-fg",
    "warning": "warning-fg",
    "danger": "danger-fg",
    "error": "error-fg",
    "info": "info-fg",
    "primary": "primary-fg",
    "destructive": "destructive-fg",
}


def _is(name, keys):
    return any(k in name for k in keys)


def matrix_pairs(tokens, scope=""):
    """Build only pairs that can actually appear in UI.

    Returns (label, fg, bg, kind) where kind is 'text' (4.5:1 floor) or 'ui' (3:1 floor).
    """
    tag = f"[{scope}] " if scope else ""

    # -subtle tokens are tinted BACKGROUNDS, not foregrounds
    surfaces = {
        k: v
        for k, v in tokens.items()
        if (_is(k, SURFACE_KEYS) or k.endswith("-subtle")) and not k.endswith("-fg")
    }
    texts = {k: v for k, v in tokens.items() if _is(k, TEXT_ROLE_KEYS) and k not in surfaces and not k.endswith("-fg")}
    uis = {k: v for k, v in tokens.items() if _is(k, UI_ROLE_KEYS) and k not in surfaces}
    infos = {
        k: v
        for k, v in tokens.items()
        if _is(k, INFO_ROLE_KEYS) and k not in surfaces and k not in uis
    }

    if not surfaces or not (texts or uis or infos):
        keys = list(tokens)
        return [(f"{tag}{a} on {b}", tokens[a], tokens[b], "text") for a in keys for b in keys if a != b]

    plain = {k: v for k, v in surfaces.items() if not k.endswith("-subtle")}
    pairs = []

    for group, kind in ((texts, "text"), (uis, "ui"), (infos, "info")):
        for f, fv in group.items():
            for b, bv in plain.items():
                pairs.append((f"{tag}{f} on {b}", fv, bv, kind))
    # fill + its own foreground (buttons, badges) — the pair everyone forgets
    for fill, fg in FILL_FG.items():
        if fill in tokens and fg in tokens:
            pairs.append((f"{tag}{fg} on {fill}", tokens[fg], tokens[fill], "text"))
    # tinted backgrounds (accent-subtle, danger-subtle): what actually sits on them.
    # Skip tints of surface/text roles — "bg on bg-subtle" is not a real pair.
    skip_stems = set(plain) | set(texts) | set(infos)
    for k, kv in surfaces.items():
        if not k.endswith("-subtle"):
            continue
        stem = k[: -len("-subtle")]
        if stem in skip_stems:
            continue
        for cand, kind in ((f"{stem}-text", "text"), (stem, "ui"), ("text", "text")):
            if cand in tokens and cand != k:
                pairs.append((f"{tag}{cand} on {k}", tokens[cand], kv, kind))
                break
    return pairs


_VAR_RE = re.compile(r"var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)")


def _resolve(name, raw, seen=None):
    """Resolve a var() chain to a literal color, or None."""
    seen = seen or set()
    if name in seen:
        return None
    seen.add(name)
    val = (raw.get(name) or "").strip()
    if not val:
        return None
    m = _VAR_RE.fullmatch(val)
    if m:
        return _resolve(m.group(1), raw, seen)
    try:
        parse_color(val)
    except ValueError:
        return None
    return val


def tokens_from_css(path):
    """Return {scope: {role: literal_color}} for the light (:root/@theme) and .dark scopes.

    Scopes matter: mixing light-mode surfaces with dark-mode text produces garbage results.
    """
    src = open(path, encoding="utf-8").read()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)

    # split into (scope_label, body) chunks by brace depth, tracking .dark selectors
    scopes = {"light": {}, "dark": {}}
    depth, i, n = 0, 0, len(src)
    stack = []
    buf_start = 0
    current = "light"
    chunks = []
    while i < n:
        c = src[i]
        if c == "{":
            selector = src[buf_start:i].strip().split("\n")[-1].strip()
            stack.append(current)
            if re.search(r"(^|[\s,])(\.dark|\[data-theme=[\"']?dark)", selector) or "prefers-color-scheme: dark" in selector:
                current = "dark"
            depth += 1
            buf_start = i + 1
        elif c == "}":
            chunks.append((current, src[buf_start:i]))
            current = stack.pop() if stack else "light"
            depth -= 1
            buf_start = i + 1
        i += 1
    chunks.append((current, src[buf_start:]))

    raw_all, scope_of = {}, {}
    for scope, body in chunks:
        for name, val in re.findall(r"(--[\w-]+)\s*:\s*([^;{}]+);", body):
            key = (scope, name)
            raw_all[key] = val.strip()
            scope_of.setdefault(name, set()).add(scope)

    for scope in ("light", "dark"):
        # a scope sees its own declarations, falling back to light
        raw = {n: v for (s, n), v in raw_all.items() if s == "light"}
        if scope == "dark":
            raw.update({n: v for (s, n), v in raw_all.items() if s == "dark"})
        for name in raw:
            if not name.startswith("--color-"):
                continue
            lit = _resolve(name, raw)
            if lit:
                scopes[scope][name[len("--color-"):]] = lit

    if scopes["light"] == scopes["dark"]:
        scopes.pop("dark")
    return {k: v for k, v in scopes.items() if v}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("colors", nargs="*", help="FG BG (one pair)")
    ap.add_argument("--pair", action="append", default=[], metavar="fg=X bg=Y", nargs="+")
    ap.add_argument("--tokens", help="JSON file of {name: color}")
    ap.add_argument("--css", help="CSS file — extracts --color-* tokens (light + .dark scopes)")
    ap.add_argument("--ui", action="store_true", help="check ad-hoc pairs at the 3:1 UI floor instead of 4.5:1")
    a = ap.parse_args()

    pairs = []
    kind = "ui" if a.ui else "text"
    if len(a.colors) >= 2:
        pairs.append((f"{a.colors[0]} on {a.colors[1]}", a.colors[0], a.colors[1], kind))
    for group in a.pair:
        kv = dict(part.split("=", 1) for part in group if "=" in part)
        if "fg" in kv and "bg" in kv:
            pairs.append((f"{kv['fg']} on {kv['bg']}", kv["fg"], kv["bg"], kv.get("kind", kind)))
    if a.tokens:
        pairs += matrix_pairs(json.load(open(a.tokens)))
    if a.css:
        scopes = tokens_from_css(a.css)
        if not scopes:
            print(f"no resolvable --color-* tokens found in {a.css}", file=sys.stderr)
        for scope, toks in scopes.items():
            pairs += matrix_pairs(toks, scope=scope if len(scopes) > 1 else "")

    if not pairs:
        ap.print_help()
        return 2
    return 1 if report(pairs) else 0


if __name__ == "__main__":
    sys.exit(main())
