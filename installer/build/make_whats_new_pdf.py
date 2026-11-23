# Generates a visual "What's New" PDF for MedOS 1.1.5 using PyMuPDF.
# All facts and figures come from the verified installer manifest, logs and tests.
from pathlib import Path
import fitz

OUT = Path(r"C:\MedOS\docs\MedOS-WhatsNew-1.1.5.pdf")
COPY = Path(r"D:\MedOS-installer-dist\MedOS-WhatsNew-1.1.5.pdf")

W, H = 595, 842


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


NAVY = rgb("#0B1220")
NAVY2 = rgb("#132238")
WHITE = rgb("#FFFFFF")
BG = rgb("#F6F8FC")
CARD = rgb("#FFFFFF")
BORDER = rgb("#DDE5F0")
TEXT = rgb("#0F172A")
MUTED = rgb("#64748B")
TEAL = rgb("#0D9488")
TEAL_L = rgb("#E6FAF6")
BLUE = rgb("#2563EB")
BLUE_L = rgb("#EAF1FF")
AMBER = rgb("#D97706")
AMBER_L = rgb("#FFF5E6")
RED = rgb("#DC2626")
RED_L = rgb("#FEECEC")
GREEN = rgb("#15803D")
GREEN_L = rgb("#EAF8EF")
SOFT = rgb("#EEF3FA")

HELV = "helv"
HEBO = "hebo"


def R(x, y, w, h):
    return fitz.Rect(x, y, x + w, y + h)


def box(page, x, y, w, h, fill=CARD, border=BORDER, radius=12, width=1):
    # PyMuPDF expects the corner radius as a fraction of the smaller side.
    frac = min(0.5, radius / max(1.0, float(min(w, h))))
    page.draw_rect(R(x, y, w, h), color=border, fill=fill, width=width, radius=frac)


def txt(page, x, y, s, size=10, color=TEXT, bold=False):
    page.insert_text((x, y), s, fontsize=size, fontname=HEBO if bold else HELV, color=color)


def para(page, x, y, w, h, s, size=10, color=TEXT, bold=False, lineheight=1.34, align=0):
    spare = page.insert_textbox(
        R(x, y, w, h), s, fontsize=size, fontname=HEBO if bold else HELV,
        color=color, lineheight=lineheight, align=align,
    )
    if spare < -1:
        print(f"  WARN text overflow ({size}pt): {s[:48]!r} spare={spare:.1f}")
    return spare


def tw(s, size=10, bold=False):
    return fitz.get_text_length(s, fontname=HEBO if bold else HELV, fontsize=size)


def pill(page, x, y, s, fg=TEAL, bg=TEAL_L, size=9):
    w = tw(s, size, True) + 18
    box(page, x, y, w, 20, fill=bg, border=bg, radius=10)
    txt(page, x + 9, y + 14, s, size=size, color=fg, bold=True)
    return w


def arrow(page, x1, y1, x2, y2, color=TEAL, width=2, head=6):
    page.draw_line((x1, y1), (x2, y2), color=color, width=width)
    if abs(x2 - x1) >= abs(y2 - y1):
        sign = 1 if x2 >= x1 else -1
        pts = [(x2, y2), (x2 - sign * head, y2 - head * 0.6),
               (x2 - sign * head, y2 + head * 0.6)]
    else:
        sign = 1 if y2 >= y1 else -1
        pts = [(x2, y2), (x2 - head * 0.6, y2 - sign * head),
               (x2 + head * 0.6, y2 - sign * head)]
    page.draw_polyline(pts, color=color, fill=color, width=0.5, closePath=True)


def check(page, x, y, color=GREEN, s=7):
    page.draw_line((x, y), (x + s * 0.45, y + s), color=color, width=2)
    page.draw_line((x + s * 0.45, y + s), (x + s * 1.5, y - s * 0.6), color=color, width=2)


def new_page(doc, dark=False):
    p = doc.new_page(width=W, height=H)
    p.draw_rect(p.rect, color=None, fill=NAVY if dark else BG)
    return p


def header(page, kicker, title, subtitle, n):
    txt(page, 36, 43, "MedOS 1.1.5", 9, TEAL, True)
    txt(page, 559 - tw("WHAT'S NEW", 9, True), 43, "WHAT'S NEW", 9, MUTED, True)
    page.draw_line((36, 54), (559, 54), color=BORDER, width=1)
    txt(page, 36, 88, kicker, 9, TEAL, True)
    txt(page, 36, 116, title, 23, TEXT, True)
    txt(page, 36, 138, subtitle, 10.5, MUTED)
    txt(page, 545, 812, f"{n:02d}", 9, MUTED, True)


def footer(page, note=None):
    page.draw_line((36, 796), (559, 796), color=BORDER, width=1)
    if note:
        txt(page, 36, 812, note, 8.5, MUTED)
    else:
        txt(page, 36, 812, "Generated 18 Nov 2026 - verified against installer manifest and tests", 8.5, MUTED)


def flow_box(page, x, y, w, h, title, sub="", fill=CARD, border=BORDER, title_color=TEXT, size=10):
    box(page, x, y, w, h, fill=fill, border=border, radius=10)
    if sub:
        txt(page, x + 10, y + 19, title, size, title_color, True)
        para(page, x + 10, y + 33, w - 20, h - 36, sub, size=8.5, color=MUTED)
    else:
        ymid = y + h / 2 + 3
        txt(page, x + (w - tw(title, size, True)) / 2, ymid, title, size, title_color, True)


doc = fitz.open()

# ---------------------------------------------------------------- 1. COVER
p = new_page(doc, dark=True)
p.draw_rect(R(0, 0, W, 8), color=None, fill=TEAL)
pill(p, 44, 52, "RELEASE NOTES", fg=NAVY, bg=TEAL, size=9)
txt(p, 44, 190, "MedOS 1.1.5", 38, WHITE, True)
txt(p, 44, 226, "What's New - Visual Guide", 19, rgb("#99E9DC"))
txt(p, 44, 254, "18 November 2026  |  Portable, single-file, portable-safe", 10, rgb("#94A3B8"))
para(p, 44, 282, 470, 46,
     "This release focuses on reliability: one installer file, updates that never touch your "
     "content, exports that always produce an archive, and startup problems that explain themselves.",
     size=11, color=rgb("#CBD5E1"))

chips = [
    ("One-file installer", "510.7 MB EXE, no extra parts"),
    ("Safe updates", "Content, settings and progress kept"),
    ("Startup self-heals", "Token check + one automatic retry"),
    ("Exports always finish", "Single and split volumes both found"),
    ("Shortcut protected", "Uninstaller only removes its own"),
    ("UpToDate transferable", "7.2 GB cache moves via Content Manager"),
]
for i, (t, s) in enumerate(chips):
    col, row = i % 2, i // 2
    x, y = 44 + col * 253, 348 + row * 66
    box(p, x, y, 238, 56, fill=NAVY2, border=rgb("#29405C"), radius=10)
    p.draw_circle((x + 20, y + 28), 8, color=None, fill=TEAL)
    txt(p, x + 11, y + 32, str(i + 1), 9, NAVY, True)
    txt(p, x + 38, y + 23, t, 10.5, WHITE, True)
    txt(p, x + 38, y + 39, s, 8.5, rgb("#94A3B8"))

box(p, 44, 566, 507, 176, fill=NAVY2, border=rgb("#29405C"), radius=14)
txt(p, 64, 596, "SINGLE INSTALLER FILE", 9, TEAL, True)
txt(p, 64, 630, "510.7 MB", 27, WHITE, True)
txt(p, 194, 630, "of 1.94 GB allowed", 11, rgb("#94A3B8"))
bar_x, bar_y, bar_w = 64, 650, 467
p.draw_rect(R(bar_x, bar_y, bar_w, 12), color=None, fill=rgb("#243851"), radius=0.5)
p.draw_rect(R(bar_x, bar_y, bar_w * 535494543 / 1940000000, 12), color=None, fill=TEAL, radius=0.5)
txt(p, 64, 690, "535,494,543 bytes", 10, WHITE, True)
txt(p, 64, 708, "SHA-256  a29b8226...110d3  |  payload checksum verified", 9, rgb("#94A3B8"))
txt(p, 44, 806, "Program files only - data, models, exports and .env are never bundled.", 9, rgb("#64748B"))

# ---------------------------------------------------------------- 2. INSTALL
p = new_page(doc)
header(p, "01  INSTALL & UPDATE", "One EXE. Two clear choices.",
       "The desktop icon launches a small chooser before anything is changed.", 2)

flow_box(p, 36, 176, 120, 62, "Desktop icon", "MedOS.lnk -> launch.vbs -> START.ps1", fill=BLUE_L, border=rgb("#BFD4FF"))
arrow(p, 158, 207, 186, 207)
flow_box(p, 188, 176, 176, 62, "Choose an action", "Download update  /  New install", fill=TEAL_L, border=rgb("#A7E8DC"))
arrow(p, 366, 207, 394, 207)
flow_box(p, 396, 176, 163, 62, "Installer engine", "Verify payload -> staging -> swap", fill=AMBER_L, border=rgb("#F3D6A6"))

box(p, 36, 262, 523, 104)
txt(p, 54, 286, "WHY A SINGLE FILE MATTERS", 9, TEAL, True)
facts = [
    ("No external manifest needed", "payload hash lives in a 60-byte footer"),
    ("No admin rights", "HKCU only; default C:\\MedOS, fallback LocalAppData"),
    ("Silent install supported", "/silent /new | /update /dir=<path>"),
]
for i, (a, b) in enumerate(facts):
    x = 54 + i * 168
    p.draw_circle((x + 6, 315), 4, color=None, fill=TEAL)
    txt(p, x + 18, 314, a, 9.5, TEXT, True)
    para(p, x + 18, 328, 145, 30, b, 8.5, MUTED)

box(p, 36, 386, 523, 116)
txt(p, 54, 410, "WHAT IS NEVER INSIDE THE EXE", 9, RED, True)
excluded = [
    ("data/", "content packs, Q-Bank state, notes"),
    ("models/", "large model files"),
    ("exports/", "your archives"),
    (".env", "secrets and local settings"),
    ("caches / logs", "derived, machine-specific data"),
]
for i, (a, b) in enumerate(excluded):
    x = 54 + (i % 3) * 168
    y = 432 + (i // 3) * 32
    pill(p, x, y - 13, a, fg=RED, bg=RED_L, size=8.5)
    txt(p, x + tw(a, 8.5, True) + 26, y - 3, b, 8.3, MUTED)

box(p, 36, 522, 523, 154, fill=WHITE)
txt(p, 54, 548, "SIZE BUDGET", 9, TEAL, True)
p.draw_rect(R(54, 566, 487, 18), color=None, fill=SOFT, radius=0.5)
p.draw_rect(R(54, 566, 487 * 535494543 / 1940000000, 18), color=None, fill=TEAL, radius=0.5)
txt(p, 54, 606, "Installer: 535,494,543 bytes", 11, TEXT, True)
txt(p, 54, 626, "Limit: 1,940,000,000 bytes", 10, MUTED)
txt(p, 54, 650, "Headroom: 1,404,505,457 bytes (72.4% unused)", 10, GREEN, True)
footer(p)

# ---------------------------------------------------------------- 3. UPDATE
p = new_page(doc)
header(p, "02  UPDATE SAFETY", "Your progress survives an update.",
       "Program files are replaced; your data is moved back, not rewritten.", 3)

box(p, 36, 172, 523, 196)
txt(p, 54, 196, "HOW THE SWAP WORKS", 9, TEAL, True)
steps = [
    ("1", "Old tree", "program + data", BLUE_L, BLUE),
    ("2", "Move aside", "old program folder", AMBER_L, AMBER),
    ("3", "Extract new", "verified payload", TEAL_L, TEAL),
    ("4", "Restore data", "copy preserved items", GREEN_L, GREEN),
]
for i, (n, t, s, f, c) in enumerate(steps):
    x = 54 + i * 122
    box(p, x, 222, 106, 92, fill=f, border=c, radius=10)
    p.draw_circle((x + 16, 244), 9, color=None, fill=c)
    txt(p, x + 12.7, 248, n, 9, WHITE, True)
    txt(p, x + 12, 274, t, 10.5, TEXT, True)
    txt(p, x + 12, 290, s, 8.5, MUTED)
    if i < 3:
        arrow(p, x + 108, 268, x + 120, 268, color=MUTED, width=1.5, head=5)
p.draw_line((54, 336), (541, 336), color=BORDER)
txt(p, 54, 356, "If any step fails, the old tree is moved back automatically (rollback).", 9.5, RED, True)

box(p, 36, 388, 253, 184)
txt(p, 54, 412, "MOVED BACK ON UPDATE", 9, GREEN, True)
for i, s in enumerate(["data/  (all content + progress)", "models/", "exports/", "app/.env", "app/backend/.env", "uploads/"]):
    check(p, 56, 438 + i * 21, GREEN, 6)
    txt(p, 70, 445 + i * 21, s, 9.3, TEXT)

box(p, 305, 388, 254, 184)
txt(p, 323, 412, "WHERE PROGRESS LIVES", 9, BLUE, True)
para(p, 323, 434, 218, 60,
     "Q-Bank state is stored in data\\qbank_state.sqlite3. Because the whole data folder is "
     "preserved, used/marked questions, notes and saved items carry over unchanged.",
     size=9.5, color=TEXT)
pill(p, 323, 506, "Same folder = safe", fg=GREEN, bg=GREEN_L, size=9)
para(p, 323, 534, 218, 36,
     "A different folder leaves old data where it was - the new copy looks empty, but nothing is deleted.",
     size=8.5, color=MUTED)

box(p, 36, 592, 523, 92, fill=TEAL_L, border=rgb("#A7E8DC"))
txt(p, 54, 616, "THE IN-APP UPDATER IS SAFE TOO", 9, TEAL, True)
para(p, 54, 636, 486, 34,
     "apply_update.py only writes a whitelist of program files. It explicitly rejects any path containing 'data' or '.env', keeps a rollback copy, and refuses to run if free disk space is insufficient.",
     size=9.5, color=TEXT)
footer(p)

# ---------------------------------------------------------------- 4. STARTUP
p = new_page(doc)
header(p, "03  STARTUP", "No more mysterious npm errors.",
       "npm was only the messenger; the frontend now explains why it stopped.", 4)

box(p, 36, 172, 523, 74, fill=RED_L, border=rgb("#F3C7C7"))
txt(p, 54, 196, "BEFORE", 9, RED, True)
para(p, 54, 212, 486, 32,
     "frontend.err showed only an npm log path; the real exception was swallowed by a blanket catch.",
     size=9.2, color=TEXT)

box(p, 36, 266, 523, 210)
txt(p, 54, 290, "AFTER - THE LAUNCH SEQUENCE", 9, TEAL, True)
seq = [
    ("START.ps1", "generate / validate 64-hex token", BLUE_L, BLUE),
    ("Backend + status", "start with the same token", BLUE_L, BLUE),
    ("npm start", "node medos_server.mjs --production", AMBER_L, AMBER),
    ("Poll port 3000", "up to 12 seconds", TEAL_L, TEAL),
    ("Retry once", "only if it exited without binding", TEAL_L, TEAL),
    ("Listening", "frontend.log confirms :3000", GREEN_L, GREEN),
]
for i, (t, s, f, c) in enumerate(seq):
    x = 54 + (i % 3) * 166
    y = 312 + (i // 3) * 76
    flow_box(p, x, y, 150, 62, t, s, fill=f, border=c)
    if i % 3 != 2:
        arrow(p, x + 152, y + 31, x + 164, y + 31, color=MUTED, width=1.4, head=4)
arrow(p, 129, 376, 129, 388, color=MUTED, width=1.4, head=4)

box(p, 36, 496, 523, 104)
txt(p, 54, 520, "WHAT YOU SEE IF IT STILL FAILS", 9, TEAL, True)
p.draw_rect(R(54, 534, 487, 50), color=rgb("#29405C"), fill=NAVY, radius=0.22)
txt(p, 66, 552, "MedOS frontend could not start safely:", 9.5, rgb("#99E9DC"), True)
txt(p, 66, 569, "Error: MedOS internal forwarding token is unavailable  (with stack trace)", 8.6, rgb("#CBD5E1"))
para(p, 54, 594, 486, 16, "The real reason is written to C:\\MedOS\\app\\frontend.err instead of being hidden.", size=9, color=MUTED)

box(p, 36, 620, 523, 64, fill=GREEN_L, border=rgb("#B7E4C7"))
txt(p, 54, 644, "VERIFIED", 9, GREEN, True)
txt(p, 54, 666, "Ports 8002 / 3000 / 4321 listening  |  frontend.err empty  |  token-less test shows exact cause", 9.5, TEXT)
footer(p)

# ---------------------------------------------------------------- 5. EXPORT
p = new_page(doc)
header(p, "04  TRANSFER & BACKUP", "Exports always finish.",
       "The archive was being created; the app just looked for the wrong filename.", 5)

box(p, 36, 172, 523, 76, fill=RED_L, border=rgb("#F3C7C7"))
txt(p, 54, 196, "THE BUG", 9, RED, True)
para(p, 54, 212, 486, 32,
     "Split was requested, but the compressed data fitted one volume. WinRAR wrote name.rar; the app searched only name.part*.rar - then deleted staging.",
     size=9.1, color=TEXT)

box(p, 36, 268, 523, 168)
txt(p, 54, 292, "THE FIX", 9, TEAL, True)
flow_box(p, 54, 312, 132, 72, "Stage content", "manifest + selected items", fill=BLUE_L, border=rgb("#BFD4FF"))
arrow(p, 188, 348, 208, 348)
flow_box(p, 210, 312, 132, 72, "Run archiver", "WinRAR or 7-Zip", fill=AMBER_L, border=rgb("#F3D6A6"))
arrow(p, 344, 348, 364, 348)
flow_box(p, 366, 312, 176, 72, "Accept either shape", "name.rar OR name.partN.rar; name.7z OR .7z.001", fill=GREEN_L, border=rgb("#B7E4C7"))
txt(p, 54, 410, "Legacy .r00/.r01 volume names are recognised too; failures now list the exact patterns checked.", 9.2, MUTED)

box(p, 36, 456, 253, 140)
txt(p, 54, 480, "TESTED CASES", 9, BLUE, True)
for i, s in enumerate(["RAR - one volume", "RAR - split volumes", "7-Zip - one volume", "7-Zip - split volumes", "Live export + Rar.exe t = OK"]):
    check(p, 56, 504 + i * 18, GREEN, 5.5)
    txt(p, 69, 509 + i * 18, s, 9.2, TEXT)

box(p, 305, 456, 254, 152)
txt(p, 323, 480, "SPLIT SIZE TIP", 9, AMBER, True)
para(p, 323, 502, 218, 54,
     "The UI value is multiplied by 1024 x 1024. For parts strictly under 1,940,000,000 bytes, enter 1850 MB or less.",
     size=9.5, color=TEXT)
pill(p, 323, 562, "1945.5 MB = 2.04 GB", fg=AMBER, bg=AMBER_L, size=8.5)
para(p, 323, 590, 218, 18, "So the 2.4 GB export fitted in one 2.04 GB volume.", size=8.5, color=MUTED)

box(p, 36, 616, 523, 60, fill=TEAL_L, border=rgb("#A7E8DC"))
txt(p, 54, 640, "Result: a real export with a split setting completed and produced a valid .rar archive.", 10, TEXT, True)
txt(p, 54, 660, "If you had a failed export, simply run it again - its staging copy was already cleaned up.", 9, MUTED)
footer(p)

# ---------------------------------------------------------------- 6. SHORTCUT
p = new_page(doc)
header(p, "05  DESTRUCTIVE ACTIONS", "Nothing else gets deleted.",
       "The uninstaller and the test suite can no longer remove another install's shortcut.", 6)

box(p, 36, 172, 523, 190)
txt(p, 54, 196, "UNINSTALLER OWNERSHIP CHECK", 9, TEAL, True)
flow_box(p, 54, 220, 150, 70, "Read shortcut", "working dir + launch.vbs path", fill=BLUE_L, border=rgb("#BFD4FF"))
arrow(p, 206, 255, 226, 255)
flow_box(p, 228, 220, 140, 70, "Compare", "to this install folder", fill=AMBER_L, border=rgb("#F3D6A6"))
arrow(p, 370, 255, 390, 255)
flow_box(p, 392, 220, 150, 70, "Own? remove", "Other? keep it", fill=GREEN_L, border=rgb("#B7E4C7"))
para(p, 54, 312, 486, 38,
     "The same check covers the Start Menu entry and the HKCU InstallDir registry value. A scratch or second MedOS copy can no longer strip a working install's icon.",
     size=9.5, color=TEXT)

box(p, 36, 382, 253, 150)
txt(p, 54, 406, "TEST SUITE SAFETY", 9, BLUE, True)
para(p, 54, 428, 217, 70,
     "Before installing a fake payload, the suite snapshots the real shortcut, Start Menu folder and HKCU keys. A finally block restores them even if a check fails.",
     size=9.4, color=TEXT)
pill(p, 54, 502, "ALL CHECKS PASSED", fg=GREEN, bg=GREEN_L, size=8.7)

box(p, 305, 382, 254, 150)
txt(p, 323, 406, "PROOF", 9, GREEN, True)
for i, s in enumerate([
    "Shortcut bytes identical before/after",
    "Fake install removed completely",
    "Real icon survived uninstall test",
    "SHA prefix 90AE76D9 unchanged",
]):
    check(p, 325, 430 + i * 24, GREEN, 6)
    txt(p, 339, 436 + i * 24, s, 9, TEXT)

box(p, 36, 552, 523, 128)
txt(p, 54, 576, "SHORTCUT DETAILS (RESTORED EXACTLY)", 9, TEAL, True)
rows = [
    ("Target", "C:\\Windows\\System32\\wscript.exe"),
    ("Arguments", "\"C:\\MedOS\\launch.vbs\""),
    ("Working dir", "C:\\MedOS"),
    ("Icon", "C:\\MedOS\\medos.ico,0"),
]
for i, (k, v) in enumerate(rows):
    y = 596 + i * 20
    txt(p, 54, y, k, 9, MUTED, True)
    txt(p, 150, y, v, 9, TEXT)
footer(p)

# ---------------------------------------------------------------- 7. CONTENT
p = new_page(doc)
header(p, "06  CONTENT MANAGER", "Transfer what you need - not everything.",
       "Content and extras are selected in Content Manager; the installer carries program files only.", 7)

box(p, 36, 172, 523, 82, fill=TEAL_L, border=rgb("#A7E8DC"))
txt(p, 54, 196, "TWO SEPARATE THINGS", 9, TEAL, True)
txt(p, 54, 220, "Installer = program + runtimes", 10.5, TEXT, True)
txt(p, 300, 220, "Content Manager = your content + extras", 10.5, TEXT, True)
arrow(p, 278, 217, 296, 217, color=TEAL, width=1.5, head=5)

box(p, 36, 274, 523, 176)
txt(p, 54, 298, "UP T O DATE ARTICLE CACHE - OPTIONAL ROW", 9, BLUE, True)
cols = [("Files", 62), ("Size", 190), ("Role", 300)]
for label, x in cols:
    txt(p, x, 320, label, 9, MUTED, True)
p.draw_line((54, 328), (541, 328), color=BORDER)
rows = [
    ("utdasset_decrypted.sqlite", "5.89 GB", "22,376 readable topics"),
    ("fsearch.db / fcontentsearch.db", "1.2 GB", "search indexes"),
    ("utd_index.sqlite", "0.1 GB", "topic index"),
    ("TOTAL", "7.2 GB", "4 files, transferable"),
]
for i, (a, b, c) in enumerate(rows):
    y = 350 + i * 24
    if i == 3:
        p.draw_rect(R(54, y - 14, 487, 22), color=None, fill=BLUE_L, radius=0.35)
    txt(p, 62, y, a, 9.2, TEXT, i == 3)
    txt(p, 190, y, b, 9.2, TEXT, i == 3)
    txt(p, 300, y, c, 9.2, TEXT, i == 3)

box(p, 36, 470, 253, 142)
txt(p, 54, 494, "HEALTH CHECKS", 9, GREEN, True)
for i, s in enumerate(["bundle_ok: true", "decrypted_db_ok: true", "key_configured: true", "article fetch: ~400 ms", "search + graphics: OK"]):
    check(p, 56, 516 + i * 19, GREEN, 5.5)
    txt(p, 69, 521 + i * 19, s, 9, TEXT)

box(p, 305, 470, 254, 142)
txt(p, 323, 494, "PORTABLE BY DESIGN", 9, BLUE, True)
para(p, 323, 516, 218, 76,
     "The cache is derived/local data, so it is excluded from the EXE. Move it between machines from Content Manager; if a bundle is absent, set UTD_PASSWORD in app\\backend\\.env.",
     size=9.4, color=TEXT)

box(p, 36, 632, 523, 48, fill=AMBER_L, border=rgb("#F3D6A6"))
txt(p, 54, 656, "Prepare UpToDate is optional - the app works without the cache row.", 10, TEXT, True)
footer(p)

# ---------------------------------------------------------------- 8. SUMMARY
p = new_page(doc)
header(p, "07  AT A GLANCE", "Everything verified, in one page.",
       "Final state of the 1.1.5 installer build and the fixes shipped in it.", 8)

box(p, 36, 172, 253, 244)
txt(p, 54, 196, "SHIPPED FIXES", 9, TEAL, True)
items = [
    "Installer dialog clipping fixed",
    "Hardened uninstaller + test suite",
    "UpToDate card text corrected",
    "Frontend error logging + token guard",
    "One retry when port 3000 is missed",
    "Export single/split recognition",
]
for i, s in enumerate(items):
    check(p, 56, 222 + i * 30, GREEN, 6.5)
    txt(p, 72, 228 + i * 30, s, 9.4, TEXT)

box(p, 305, 172, 254, 244)
txt(p, 323, 196, "VERIFICATION", 9, BLUE, True)
items2 = [
    "Installer regression suite: PASS",
    "All 3 ports listening after relaunch",
    "Shortcut byte-identical after tests",
    "Payload checksum + manifest match",
    "Archive files match disk exactly",
    "Live export + integrity test OK",
]
for i, s in enumerate(items2):
    check(p, 325, 222 + i * 30, GREEN, 6.5)
    txt(p, 341, 228 + i * 30, s, 9.1, TEXT)

box(p, 36, 436, 523, 140, fill=NAVY, border=NAVY)
txt(p, 54, 460, "INSTALLER FINGERPRINT", 9, TEAL, True)
txt(p, 54, 486, "D:\\MedOS-installer-dist\\MedOS-Setup.exe", 10, WHITE, True)
txt(p, 54, 510, "535,494,543 bytes", 9.5, rgb("#CBD5E1"))
txt(p, 54, 530, "SHA-256", 9, rgb("#94A3B8"), True)
txt(p, 116, 530, "a29b82266da93f79ca1238d7c4fbd2cbfe76892ffa58c1cb7683801edb4dea4f", 8.6, WHITE)
txt(p, 54, 552, "payload", 9, rgb("#94A3B8"), True)
txt(p, 116, 552, "d3640751b1f905f4b3e0635eee62383a1dcb51a1232ee591453e59b00d0e2dd3", 8.6, WHITE)

box(p, 36, 596, 523, 76)
txt(p, 54, 620, "STILL PENDING", 9, AMBER, True)
para(p, 54, 642, 486, 22,
     "APK / emulator work remains on hold pending explicit go-ahead; no Android toolchain is bundled in the installer.",
     size=9.5, color=TEXT)
footer(p)

OUT.parent.mkdir(parents=True, exist_ok=True)
doc.set_metadata({
    "title": "MedOS 1.1.5 - What's New",
    "author": "MedOS",
    "subject": "Visual guide to the latest MedOS fixes and features",
    "keywords": "MedOS, installer, update, export, startup, Content Manager",
})
doc.save(str(OUT), garbage=4, deflate=True)
doc.close()
COPY.parent.mkdir(parents=True, exist_ok=True)
COPY.write_bytes(OUT.read_bytes())
print("PDF:", OUT)
print("size:", OUT.stat().st_size)
print("copy:", COPY)
