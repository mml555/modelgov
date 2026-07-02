/*
 * Ai-Guard RAG support widget — drop-in, dependency-free.
 * Embed on ANY site:
 *   <script src="https://your-host/widget.js" data-endpoint="https://your-host/api/chat"></script>
 * It renders a floating chat bubble that talks to the grounded /api/chat
 * endpoint and shows the gateway "receipt" (grounded?, model, cost) per reply.
 */
(function () {
  var script = document.currentScript;
  var endpoint =
    (script && script.getAttribute("data-endpoint")) ||
    (script && new URL(script.src).origin + "/api/chat") ||
    "/api/chat";
  var title = (script && script.getAttribute("data-title")) || "Support";

  // Stable per-browser session id so per-visitor budgets are meaningful.
  var sessionId = localStorage.getItem("aiguard_sid");
  if (!sessionId) {
    sessionId = "web-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("aiguard_sid", sessionId);
  }

  var css =
    ".agw-btn{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#4f46e5;color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000}" +
    ".agw-panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".agw-panel.open{display:flex}" +
    ".agw-head{background:#4f46e5;color:#fff;padding:12px 16px;font-weight:600;font-size:15px}" +
    ".agw-log{flex:1;overflow-y:auto;padding:14px;background:#f7f7fb}" +
    ".agw-msg{margin:0 0 12px;max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".agw-user{margin-left:auto;background:#4f46e5;color:#fff;border-bottom-right-radius:3px}" +
    ".agw-bot{background:#fff;border:1px solid #e5e7eb;color:#111;border-bottom-left-radius:3px}" +
    ".agw-meta{font-size:11px;color:#6b7280;margin:-6px 0 12px}" +
    ".agw-meta .ok{color:#059669;font-weight:600}.agw-meta .no{color:#b45309;font-weight:600}" +
    ".agw-src{font-size:11px;color:#6b7280;margin:-6px 0 12px}" +
    ".agw-in{display:flex;border-top:1px solid #e5e7eb}" +
    ".agw-in input{flex:1;border:none;padding:12px 14px;font-size:14px;outline:none}" +
    ".agw-in button{border:none;background:#4f46e5;color:#fff;padding:0 16px;cursor:pointer;font-size:14px}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "agw-btn";
  btn.setAttribute("aria-label", "Open support chat");
  btn.textContent = "💬";

  var panel = document.createElement("div");
  panel.className = "agw-panel";
  panel.innerHTML =
    '<div class="agw-head">' + esc(title) + "</div>" +
    '<div class="agw-log" id="agw-log"></div>' +
    '<form class="agw-in" id="agw-form"><input id="agw-input" placeholder="Ask a question…" autocomplete="off"/><button type="submit">Send</button></form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var log = panel.querySelector("#agw-log");
  var form = panel.querySelector("#agw-form");
  var input = panel.querySelector("#agw-input");

  btn.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      if (!log.hasChildNodes()) addBot("Hi! Ask me anything about your account, billing, or plans. I only answer from our help docs.");
      input.focus();
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    addUser(q);
    input.value = "";
    var thinking = addBot("…");
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: q, sessionId: sessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        thinking.remove();
        addBot(data.answer || "(no answer)");
        renderReceipt(data);
      })
      .catch(function () {
        thinking.remove();
        addBot("Sorry — I couldn't reach the assistant.");
      });
  });

  function renderReceipt(data) {
    if (data.blocked) {
      addMeta('<span class="no">⛔ ' + esc(data.code || "blocked") + "</span>");
      return;
    }
    var c = (data.receipt && data.receipt.chat) || {};
    var g = data.grounded === true ? '<span class="ok">grounded ✓</span>'
      : data.grounded === false ? '<span class="no">not grounded — refused</span>'
      : "grounded ?";
    var cost = typeof c.costUsd === "number" ? " · $" + c.costUsd.toFixed(5) : "";
    addMeta(g + " · " + esc(c.model || "?") + " (" + esc(c.decision || "?") + ")" + cost);
    if (data.sources && data.sources.length) {
      addSrc("sources: " + data.sources.map(function (s) { return esc(s.source); }).join(", "));
    }
  }

  function addUser(t) { return append("agw-msg agw-user", t); }
  function addBot(t) { return append("agw-msg agw-bot", t); }
  function append(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function addMeta(html) { appendHtml("agw-meta", html); }
  function addSrc(html) { appendHtml("agw-src", html); }
  function appendHtml(cls, html) {
    var d = document.createElement("div");
    d.className = cls;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }
})();
