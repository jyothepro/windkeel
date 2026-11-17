// The terminal client. The session cookie rides on the WebSocket upgrade automatically
// (same-origin); this script never sees it (HttpOnly) and never sees the token.
(function () {
  "use strict";
  var status = document.getElementById("status");
  var term = new window.Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  fit.fit();
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var ws = new WebSocket(proto + "//" + location.host + "/__windkeel/pty");
  ws.binaryType = "arraybuffer";
  var pending = {}, seq = 0;
  function resize() {
    fit.fit();
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "resize", rows: term.rows, cols: term.cols }));
  }
  ws.onopen = function () { status.textContent = "connected"; resize(); setInterval(ping, 5000); };
  ws.onmessage = function (e) {
    if (typeof e.data !== "string") { term.write(new Uint8Array(e.data)); return; }
    var msg = JSON.parse(e.data);
    if (msg.t === "pong" && pending[msg.id]) {
      status.textContent = "connected · rtt " + Math.round(performance.now() - pending[msg.id]) + " ms";
      delete pending[msg.id];
    } else if (msg.t === "exit") {
      term.write("\r\n[shell exited " + msg.code + "]\r\n");
    }
  };
  ws.onclose = function (e) {
    status.textContent = "disconnected (" + e.code + (e.reason ? " " + e.reason : "") + ") — reopen from the console";
  };
  function ping() {
    if (ws.readyState !== 1) return;
    var id = ++seq; pending[id] = performance.now();
    ws.send(JSON.stringify({ t: "ping", id: id }));
  }
  term.onData(function (d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "in", d: d })); });
  window.addEventListener("resize", resize);
  document.getElementById("end").onclick = function () {
    fetch("/__windkeel/revoke", { method: "POST", credentials: "same-origin" }).then(function () { ws.close(); });
  };
})();
