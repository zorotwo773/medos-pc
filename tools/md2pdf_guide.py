"""Minimal Markdown -> PDF renderer for the MedOS user guide (reportlab only)."""
import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    HRFlowable, ListFlowable, ListItem, Paragraph, Preformatted,
    SimpleDocTemplate, Spacer, Table, TableStyle,
)

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC = sys.argv[1] if len(sys.argv) > 1 else str(_PROJECT_ROOT / "MedOS_USER_GUIDE.md")
OUT = sys.argv[2] if len(sys.argv) > 2 else str(_PROJECT_ROOT / "MedOS_USER_GUIDE.pdf")

# Emoji / symbol -> plain text so the base PDF fonts don't render tofu boxes.
EMOJI_MAP = {
    "🔵": "[blue]", "🟢": "[green]", "🟡": "[yellow]", "🟠": "[orange]",
    "⚪": "[gray]", "🟥": "[red]", "🟦": "[teal]", "🔴": "[red]",
    "🟣": "[purple]", "🎓": "", "⏱️": "", "⏱": "", "⚠️": "(!)", "⚠": "(!)",
    "🔧": "", "📋": "", "✓": "(check)", "⌘": "[Cmd]", "↗": "->", "→": "->",
    "↑": "^", "·": "-",
}
EMOJI_RE = re.compile(
    "[" "\U0001F300-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF" "\U0000FE0F" "]", flags=re.UNICODE,
)


def strip_emoji(text):
    for k, v in EMOJI_MAP.items():
        text = text.replace(k, v)
    return EMOJI_RE.sub("", text)


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(text):
    """Convert inline markdown to reportlab mini-markup."""
    text = strip_emoji(text)
    text = esc(text)
    # inline code `x`
    text = re.sub(r"`([^`]+)`",
                  r'<font face="Courier" backColor="#eef0f3">\1</font>', text)
    # bold **x**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    # links [text](url): keep text, link out only for http(s)
    def _link(m):
        label, url = m.group(1), m.group(2)
        if url.startswith("http"):
            return f'<link href="{url}"><font color="#1d4ed8">{label}</font></link>'
        return label
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link, text)
    return text


styles = getSampleStyleSheet()
BODY = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9.5,
                      leading=14, spaceAfter=5, alignment=TA_LEFT)
H1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=20, leading=24,
                    spaceBefore=10, spaceAfter=8, textColor=colors.HexColor("#0f172a"))
H2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=15, leading=19,
                    spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#1e3a5f"))
H3 = ParagraphStyle("h3", parent=styles["Heading3"], fontSize=12, leading=16,
                    spaceBefore=10, spaceAfter=4, textColor=colors.HexColor("#334155"))
QUOTE = ParagraphStyle("quote", parent=BODY, leftIndent=12, textColor=colors.HexColor("#475569"),
                       backColor=colors.HexColor("#f1f5f9"), borderColor=colors.HexColor("#cbd5e1"),
                       borderWidth=0, spaceBefore=4, spaceAfter=6)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=8.5, leading=11, spaceAfter=0)
CELLH = ParagraphStyle("cellh", parent=CELL, textColor=colors.white, fontName="Helvetica-Bold")
CODE = ParagraphStyle("code", parent=styles["Code"], fontSize=8, leading=11,
                      backColor=colors.HexColor("#f6f8fa"), textColor=colors.HexColor("#1f2937"),
                      borderPadding=6, spaceBefore=4, spaceAfter=8)

story = []


def flush_list(buf, ordered):
    if not buf:
        return
    items = [ListItem(Paragraph(inline(x), BODY), leftIndent=14) for x in buf]
    story.append(ListFlowable(items, bulletType="1" if ordered else "bullet",
                              bulletFontSize=8, leftIndent=14, spaceBefore=2, spaceAfter=6))
    buf.clear()


def render_table(rows):
    # rows: list of list[str]; first row header, drop separator row
    header, body = rows[0], rows[2:] if len(rows) > 1 else []
    data = [[Paragraph(inline(c), CELLH) for c in header]]
    for r in body:
        data.append([Paragraph(inline(c), CELL) for c in r])
    ncol = len(header)
    avail = A4[0] - 3 * cm
    t = Table(data, colWidths=[avail / ncol] * ncol, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(t)
    story.append(Spacer(1, 8))


with open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")

i = 0
list_buf = []
list_ordered = False
n = len(lines)
while i < n:
    line = lines[i].rstrip("\n")
    stripped = line.strip()

    # fenced code block
    if stripped.startswith("```"):
        block = []
        i += 1
        while i < n and not lines[i].strip().startswith("```"):
            block.append(lines[i])
            i += 1
        i += 1
        flush_list(list_buf, list_ordered)
        story.append(Preformatted(strip_emoji("\n".join(block)) or " ", CODE))
        continue

    # table (line with pipes + next line is separator)
    if "|" in line and i + 1 < n and re.match(r"^\s*\|?[\s:|-]+\|[\s:|-]*$", lines[i + 1]):
        flush_list(list_buf, list_ordered)
        tbl = []
        while i < n and "|" in lines[i]:
            cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            tbl.append(cells)
            i += 1
        render_table(tbl)
        continue

    if not stripped:
        flush_list(list_buf, list_ordered)
        i += 1
        continue

    if stripped.startswith("#"):
        flush_list(list_buf, list_ordered)
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        level, txt = len(m.group(1)), m.group(2)
        style = H1 if level == 1 else H2 if level == 2 else H3
        story.append(Paragraph(inline(txt), style))
        i += 1
        continue

    if re.match(r"^(---+|\*\*\*+)$", stripped):
        flush_list(list_buf, list_ordered)
        story.append(HRFlowable(width="100%", thickness=0.6,
                                color=colors.HexColor("#cbd5e1"), spaceBefore=6, spaceAfter=8))
        i += 1
        continue

    if stripped.startswith(">"):
        flush_list(list_buf, list_ordered)
        story.append(Paragraph(inline(stripped.lstrip("> ").strip()), QUOTE))
        i += 1
        continue

    om = re.match(r"^(\d+)\.\s+(.*)$", stripped)
    um = re.match(r"^[-*]\s+(.*)$", stripped)
    if om:
        if not list_ordered:
            flush_list(list_buf, list_ordered)
        list_ordered = True
        list_buf.append(om.group(2))
        i += 1
        continue
    if um:
        if list_ordered:
            flush_list(list_buf, list_ordered)
        list_ordered = False
        list_buf.append(um.group(1))
        i += 1
        continue

    # plain paragraph
    flush_list(list_buf, list_ordered)
    story.append(Paragraph(inline(stripped), BODY))
    i += 1

flush_list(list_buf, list_ordered)

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=1.5 * cm, rightMargin=1.5 * cm,
                        topMargin=1.4 * cm, bottomMargin=1.4 * cm,
                        title="MedOS User Guide")
doc.build(story)
print(f"Wrote {OUT}")
