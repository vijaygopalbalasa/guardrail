// STUB (red phase): the old innerHTML rendering.
export function renderError(doc, box, msg) { box.innerHTML = `<p class="err">${msg}</p>`; }
export function renderFeed(doc, box, decisions) { box.innerHTML = decisions.map((d) => `<div>${d.slot} ${d.rule} ${d.reason}</div>`).join(""); }
export function renderLastRefusal(doc, box, lr) { box.innerHTML = `<div>${lr.rule} ${lr.reason} ${lr.slot}</div>`; }
