(function () {
  function normalizeAppOrigin(input) {
    var raw = String(input || "").trim();
    if (!raw) {
      throw new Error("Cat Crawler docs config is missing appOrigin.");
    }

    var parsed = new URL(raw, window.location.href);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Cat Crawler docs config appOrigin must use http or https.");
    }

    return parsed.origin;
  }

  function createBookmarkletHref(appOrigin, pageUrl) {
    var scriptUrl = new URL("bookmarklet.js", pageUrl);
    scriptUrl.searchParams.set("appOrigin", appOrigin);
    var scriptSrcPrefix = scriptUrl.toString() + "&t=";
    var bookmarklet =
      '(function(){' +
      'var script=document.createElement("script");' +
      "script.src=" + JSON.stringify(scriptSrcPrefix) + "+Date.now();" +
      "document.body.appendChild(script);" +
      "})();";

    return "javascript:" + bookmarklet;
  }

  function installBookmarkletLink(doc, win) {
    var link = doc.getElementById("bookmarkletLink");
    if (!link) {
      return { ok: false, reason: "missing-link" };
    }

    var config = win.CAT_CRAWLER_PUBLIC_CONFIG || {};
    var appOrigin = normalizeAppOrigin(config.appOrigin);
    var href = createBookmarkletHref(appOrigin, win.location.href);
    link.setAttribute("href", href);

    return {
      ok: true,
      environment: String(config.environment || "").trim() || "unknown",
      appOrigin: appOrigin,
      href: href
    };
  }

  window.CAT_CRAWLER_DOCS_INSTALLER = Object.freeze({
    createBookmarkletHref: createBookmarkletHref,
    installBookmarkletLink: installBookmarkletLink
  });

  try {
    installBookmarkletLink(document, window);
  } catch (error) {
    console.error(error);
  }
})();
