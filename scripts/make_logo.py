import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from pathlib import Path

font = TTFont(sys.argv[1]); out = Path(sys.argv[2])
gs = font.getGlyphSet(); cmap = font.getBestCmap(); upm = font["head"].unitsPerEm

# Pulse mark in a 64x64 box: flat run, a sharp peak, a deep dip, a rounded crest settling right; a dot over the peak
MARK = ("M4 40H16.5C18.6 40 19.6 38.9 20.4 36.7L25.2 23.6C26.3 20.6 28.6 20.9 29.3 24.1"
        "L33.6 45.2C34.6 50 37.2 50.3 39.2 46.1C42.2 39.7 45.3 35.6 50.2 35.6C54.6 35.6 57 38.1 60 39.4")
# Wider version for the lockups: longer flat run on the left and a longer tail, as in the chosen sketch
MARK_WIDE = "M-6 40H16.5" + MARK[MARK.index("C18.6"):] + "C63.5 40.8 67 41.2 72 41.2"
def mark(colour, sw=5.2, wide=False):
    d = MARK_WIDE if wide else MARK
    return (f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="26.6" cy="10.4" r="5.4" fill="{colour}"/>')

def word(text, size, x, baseline, colour, tracking=0.01):
    pen = SVGPathPen(gs); s = size / upm; cx = 0; parts = []
    for ch in text:
        name = cmap[ord(ch)]
        p = SVGPathPen(gs)
        gs[name].draw(TransformPen(p, (s, 0, 0, -s, x + cx, baseline)))
        parts.append(p.getCommands())
        cx += gs[name].width * s + tracking * size
    return f'<path fill="{colour}" d="{" ".join(parts)}"/>', cx - tracking * size

def svg(w, h, body, bg=None, title="GeoPulse"):
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{rect}{body}</svg>\n')

CYAN, NIGHT, WHITE, CYAN_DARK = "#22D3EE", "#0E1B26", "#E6EEF3", "#0891B2"

# Icon only (transparent) and favicon (on a rounded night tile)
(out / "geopulse-mark.svg").write_text(svg(64, 64, mark(CYAN), title="GeoPulse mark"))
(out / "favicon.svg").write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="{NIGHT}"/>'
    f'<g transform="translate(4 6) scale(0.875)">{mark(CYAN, 6.4)}</g></svg>\n')

# Horizontal lockups: mark 64 high, wordmark cap height ~ matched
def lockup(word_colour, mark_colour, bg, name):
    size = 72; wpath, wwidth = word("GeoPulse", size, 111, 54, word_colour)
    w = int(111 + wwidth + 2); h = 58
    body = f'<g transform="translate(12 -2) scale(1.08)">{mark(mark_colour, 5.2, True)}</g>{wpath}'
    pad = 24 if bg else 0
    inner = f'<g transform="translate({pad} {pad})">{body}</g>'
    (out / name).write_text(svg(w + 2 * pad, h + 2 * pad, inner, bg))
lockup(WHITE, CYAN, None, "geopulse-logo-on-dark.svg")      # transparent, for dark pages
lockup(NIGHT, CYAN_DARK, None, "geopulse-logo-on-light.svg") # transparent, for light pages
lockup(WHITE, CYAN, NIGHT, "geopulse-logo-dark-tile.svg")    # with its own background

# Social preview 1280x640 (GitHub repository card)
wpath, wwidth = word("GeoPulse", 132, 0, 0, WHITE)
tag, tw = word("Geospatial risk intelligence for Ghana", 40, 0, 0, "#9FB3C2", 0.005)
total = 150 + 28 + wwidth; x0 = (1280 - total) / 2
body = (f'<g transform="translate({x0 + 12} 236) scale(1.9)">{mark(CYAN, 5.2, True)}</g>'
        f'<g transform="translate({x0 + 178} 352)">{wpath}</g>'
        f'<g transform="translate({(1280 - tw) / 2} 470)">{tag}</g>')
(out / "social-preview.svg").write_text(svg(1280, 640, body, NIGHT))
print("ok", wwidth, tw)
