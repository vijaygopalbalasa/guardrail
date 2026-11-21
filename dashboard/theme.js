// Light and dark: follows the system until the viewer picks one; the choice is remembered when storage works.
export function themeToggle(button) {
  const root = document.documentElement;
  const sysDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
  const current = () => root.dataset.theme ?? (sysDark() ? "dark" : "light");
  const label = () => { button.textContent = current() === "dark" ? "Light" : "Dark"; };
  try { const t = localStorage.getItem("guardrail-theme"); if (t === "dark" || t === "light") root.dataset.theme = t; } catch { /* storage blocked */ }
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") root.dataset.theme = q;
  label();
  button.addEventListener("click", () => {
    root.dataset.theme = current() === "dark" ? "light" : "dark";
    try { localStorage.setItem("guardrail-theme", root.dataset.theme); } catch { /* storage blocked */ }
    label();
    window.dispatchEvent(new Event("themechange"));
  });
}
