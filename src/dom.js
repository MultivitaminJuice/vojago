// DOM-Helfer. Grundsatz: Nutzertexte werden NIE per innerHTML eingesetzt,
// sondern immer als Textknoten — damit sind Titel, Notizen und Namen
// unabhängig vom Inhalt ungefährlich.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Element bauen.
 * @param {string} tag  z. B. "div.card.wide" oder "button#save"
 * @param {object} [attrs] Attribute; `text` setzt textContent, `style` nimmt ein Objekt,
 *                         `on` nimmt { click: fn }, `dataset` nimmt ein Objekt.
 * @param {Array|Node|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name || "div");
  for (const token of rest) {
    if (token[0] === ".") node.classList.add(token.slice(1));
    else if (token[0] === "#") node.id = token.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = v; // nur für eigene, konstante Markup-Schnipsel
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === "class") node.className += (node.className ? " " : "") + v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    parent.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Ersetzt den Inhalt eines Containers durch neue Kinder. */
export function render(node, children) {
  return append(clear(node), children);
}

/** Inline-SVG aus konstantem Pfad-Markup (nie mit Nutzerdaten aufgerufen). */
export function icon(paths, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.width = size + "px";
  svg.style.height = size + "px";
  svg.innerHTML = paths; // konstante Icon-Pfade aus icons.js
  return svg;
}

export function toast(message) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1900);
}
