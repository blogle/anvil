(() => {
  const themes = ["bark", "fieldnotes", "folio"];
  const page = document.body.dataset.page;
  const root = document.documentElement;
  let current = root.dataset.theme || "bark";

  document.querySelectorAll("nav a[data-page]").forEach((link) => {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
  });

  const saveTheme = (theme) => {
    try { localStorage.setItem("anvil-docs-theme", theme); } catch (_) { /* storage can be unavailable */ }
  };

  const setTheme = (theme, persist = true) => {
    if (!themes.includes(theme)) theme = "bark";
    current = theme;
    root.dataset.theme = theme;
    if (persist) saveTheme(theme);
    document.querySelectorAll(".theme-switcher button[data-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.theme === theme));
    });
  };

  setTheme(current, false);
  document.querySelectorAll(".theme-switcher button[data-theme]").forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.theme));
  });
  document.querySelectorAll("[data-year]").forEach((node) => { node.textContent = new Date().getFullYear(); });
})();
