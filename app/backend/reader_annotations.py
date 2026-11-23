"""
Shared text-annotation bridge for library article iframes.

Every reader (UWorld, AMBOSS, UpToDate) renders the vendor article inside an
iframe served by this backend, so the React host cannot touch the article DOM
directly. This module injects a small script into the article document that:

  * reports the user's text selection to the host (quote + prefix/suffix +
    character offsets + viewport rect),
  * applies / clears highlight ranges sent back by the host,
  * reports clicks on an existing highlight.

All storage and UI live in the React host (authenticated through /api/custom),
so the iframe never needs credentials. Offsets are relative to the article's
plain text, which is stable because the vendor payload is static; the
prefix/suffix pair is kept as a fallback if an article is re-rendered.
"""
from __future__ import annotations

import json

_SCRIPT = r"""
(function () {
  var SOURCE = __SOURCE__;
  var REF = __REF__;
  if (window.__medosAnnotationBridge) return;
  window.__medosAnnotationBridge = true;

  var COLORS = {
    yellow: "rgba(253, 230, 138, 0.75)",
    green:  "rgba(187, 247, 208, 0.85)",
    blue:   "rgba(191, 219, 254, 0.85)",
    pink:   "rgba(251, 207, 232, 0.85)",
    purple: "rgba(221, 214, 254, 0.85)"
  };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SVG: 1, MARK: 0 };

  function post(msg) {
    try {
      msg.source = SOURCE;
      msg.refId = REF;
      window.parent.postMessage(msg, "*");
    } catch (e) {}
  }

  function bodyReady() {
    return document.body && document.body.nodeType === 1;
  }

  function textNodes() {
    var out = [];
    if (!bodyReady()) return out;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        var parent = node.parentNode;
        while (parent && parent !== document.body) {
          if (SKIP[parent.nodeName] === 1) return NodeFilter.FILTER_REJECT;
          parent = parent.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  function totalText() {
    var nodes = textNodes(), text = "";
    for (var i = 0; i < nodes.length; i++) text += nodes[i].nodeValue;
    return text;
  }

  function offsetOf(container, offset) {
    var nodes = textNodes(), acc = 0, i;
    // Fast path: the boundary sits inside a text node (the usual selection case).
    if (container && container.nodeType === 3) {
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i] === container) return acc + offset;
        acc += nodes[i].nodeValue.length;
      }
    }
    // Element boundary: count only text this bridge indexes, so script/style
    // content in the article body never shifts the offsets.
    try {
      var range = document.createRange();
      range.selectNodeContents(document.body);
      range.setEnd(container, offset);
      acc = 0;
      for (i = 0; i < nodes.length; i++) {
        var node = nodes[i], len = node.nodeValue.length;
        if (range.comparePoint(node, len) === 0) {
          acc += len;
        } else if (range.comparePoint(node, 0) === 0) {
          var low = 0, high = len;
          while (low < high) {
            var mid = Math.ceil((low + high) / 2);
            if (range.comparePoint(node, mid) === 0) low = mid; else high = mid - 1;
          }
          return acc + low;
        } else {
          break;
        }
      }
      return acc;
    } catch (e) {
      return -1;
    }
  }

  function rangeFromOffsets(start, end) {
    if (!(start >= 0) || !(end > start)) return null;
    var nodes = textNodes(), acc = 0, range = document.createRange(), started = false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.nodeValue.length;
      if (!started && start < acc + len) {
        range.setStart(node, start - acc);
        started = true;
      }
      if (started && end <= acc + len) {
        range.setEnd(node, end - acc);
        return range;
      }
      acc += len;
    }
    return null;
  }

  function findQuote(quote, prefix, suffix) {
    if (!quote) return -1;
    var text = totalText(), from = 0, idx, weak = -1;
    while ((idx = text.indexOf(quote, from)) !== -1) {
      var preOk = !prefix || text.slice(Math.max(0, idx - prefix.length), idx) === prefix;
      var sufOk = !suffix || text.slice(idx + quote.length, idx + quote.length + suffix.length) === suffix;
      if (preOk && sufOk) return idx;
      if (weak < 0 && (preOk || sufOk)) weak = idx;
      from = idx + 1;
    }
    return weak;
  }

  function clearMarks() {
    var marks = document.querySelectorAll("mark.medos-annotation");
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i], parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      if (parent.normalize) parent.normalize();
    }
  }

  function makeMark(item) {
    var mark = document.createElement("mark");
    mark.className = "medos-annotation";
    mark.setAttribute("data-annotation-id", String(item.id || ""));
    mark.style.backgroundColor = COLORS[item.color] || COLORS.yellow;
    if (item.note) mark.title = item.note;
    return mark;
  }

  function wrapRange(range, item) {
    if (!range) return;
    if (range.collapsed) return;
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      try { range.surroundContents(makeMark(item)); } catch (e) {}
      return;
    }
    var nodes = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) nodes.push(node);
    }
    for (var i = 0; i < nodes.length; i++) {
      var textNode = nodes[i];
      var start = textNode === range.startContainer ? range.startOffset : 0;
      var end = textNode === range.endContainer ? range.endOffset : textNode.nodeValue.length;
      if (end <= start) continue;
      try {
        var piece = document.createRange();
        piece.setStart(textNode, start);
        piece.setEnd(textNode, end);
        piece.surroundContents(makeMark(item));
      } catch (e) {}
    }
  }

  function applyAnnotations(items) {
    if (!bodyReady()) return;
    clearMarks();
    if (!items || !items.length) return;
    var prepared = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var range = rangeFromOffsets(item.start, item.end);
      if (!range || range.toString() !== item.quote) {
        var found = findQuote(item.quote, item.prefix, item.suffix);
        range = found >= 0 ? rangeFromOffsets(found, found + item.quote.length) : null;
      }
      if (range) prepared.push({ item: item, range: range });
    }
    for (var j = 0; j < prepared.length; j++) wrapRange(prepared[j].range, prepared[j].item);
  }

  function captureSelection() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    if (!bodyReady() || !document.body.contains(range.commonAncestorContainer)) return;
    var quote = range.toString();
    if (!quote || !quote.trim()) return;
    if (quote.length > 4000) quote = quote.slice(0, 4000);
    var start = offsetOf(range.startContainer, range.startOffset);
    var end = offsetOf(range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return;
    var text = totalText();
    var rect = range.getBoundingClientRect();
    post({
      type: "medos_annotation_selection",
      quote: quote,
      prefix: text.slice(Math.max(0, start - 48), start),
      suffix: text.slice(end, end + 48),
      start: start,
      end: end,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    });
  }

  function scheduleCapture() {
    setTimeout(captureSelection, 20);
  }

  document.addEventListener("mouseup", scheduleCapture, true);
  document.addEventListener("touchend", function () { setTimeout(captureSelection, 80); }, true);
  document.addEventListener("keyup", function (event) {
    if (event.key === "Shift" || event.key === "ArrowLeft" || event.key === "ArrowRight") scheduleCapture();
  }, true);

  document.addEventListener("click", function (event) {
    var mark = event.target && event.target.closest ? event.target.closest("mark.medos-annotation") : null;
    if (!mark) return;
    var rect = mark.getBoundingClientRect();
    post({
      type: "medos_annotation_click",
      id: mark.getAttribute("data-annotation-id") || "",
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    });
  }, true);

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "medos_apply_annotations") {
      if (data.source && data.source !== SOURCE) return;
      if (data.refId && String(data.refId) !== String(REF)) return;
      applyAnnotations(data.items || []);
    } else if (data.type === "medos_clear_selection") {
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  });

  window.addEventListener("load", function () {
    post({ type: "medos_annotation_ready" });
  });
  if (document.readyState === "complete") {
    post({ type: "medos_annotation_ready" });
  }

  window.__medosApplyAnnotations = applyAnnotations;
})();
"""

_STYLE = """
<style id="medos-annotation-style">
mark.medos-annotation {
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
  cursor: pointer;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
mark.medos-annotation:hover {
  outline: 1px solid rgba(0, 0, 0, 0.22);
}
</style>
"""


def annotation_bridge(source: str, ref_id: object) -> str:
    """Return the markup to inject into one reader article document."""
    script = _SCRIPT.replace("__SOURCE__", json.dumps(str(source))).replace(
        "__REF__", json.dumps(str(ref_id))
    )
    return _STYLE + "<script>" + script + "</script>"
