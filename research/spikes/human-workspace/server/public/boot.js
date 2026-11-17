// Bootstrap: the only script served without a session. Static and identical for every caller.
// Reads the capability token from the URL fragment (never sent to any server or proxy), removes
// it from the address bar and this history entry before doing anything else, and exchanges it
// for an HttpOnly cookie on this origin. The token is never written to storage.
(function () {
  "use strict";
  var status = document.getElementById("status");
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, "", location.pathname);
  function go() { location.replace("/"); }
  if (!m) {
    // No token: a reopen from the console in a browser that already holds the cookie. This
    // navigation is initiated by a same-site page, so the SameSite=Strict cookie is sent.
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
