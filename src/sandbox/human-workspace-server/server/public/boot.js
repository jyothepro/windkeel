(function () {
  "use strict";
  var status = document.getElementById("status");
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, "", location.pathname);
  function go() { location.replace("/"); }
  if (!m) {
    go();
    return;
  }
  fetch("/__windkeel/session", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: m[1] }),
  }).then(function (r) {
    if (r.status === 204) return go();
    return r.text().then(function (t) { status.textContent = t; });
  }, function (e) { status.textContent = "Could not reach the workspace: " + e; });
})();
