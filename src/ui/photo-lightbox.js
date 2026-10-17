// Foto groß anzeigen — ein einziges, wiederverwendetes Overlay für Logbuch
// und Editor-Galerie. Übernimmt bewusst das Muster des Reise-Pickers
// (abgedunkelter, durchscheinender Hintergrund + ein klar umrandetes Panel)
// statt eines eigenen Vollbild-Screens. Zeigt bei Fotos aus dem Logbuch im
// Panel-Kopf eine echte App-Karte mit allen Details der zugehörigen Notiz/
// des Orts (journal.js baut diese Karte mit denselben Bausteinen wie die
// normale Logbuch-Karte); die Foto-Bühne darunter bleibt dunkel (übliche,
// für Fotos vorteilhafte Bühne), aber klar per Trennlinie abgesetzt statt
// nur durch Abstand. Vor/Zurück blättert über eine ganze Reihe von Fotos
// hinweg (auch über mehrere Notizen/Orte eines Tages hinweg, siehe
// journal.js). Bekommt fertige Bild-URLs übergeben und kennt selbst keinen
// Unterschied zwischen Eigentümer und Gast.
import { el, render } from "../dom.js";

const SWIPE_MIN_PX = 40; // kürzere Wische zählen als Antippen, nicht als Geste
const BUEHNE_PAD_X = 16; // muss zu .lightbox-stage { padding: 0 16px } in styles.css passen

let overlay = null;
let stage = null;
let img = null;
let infoBox = null;
let infoBody = null;
let counter = null;
let prevBtn = null;
let nextBtn = null;
let slides = [];
let index = 0;

function schliessen() {
  overlay.hidden = true;
  img.src = "";
}

function zeichne() {
  const s = slides[index] || {};
  infoBox.style.maxWidth = ""; // zurück auf die feste CSS-Vorgabe, bis das neue Foto geladen ist
  img.src = s.url || "";
  render(infoBody, s.info ? [s.info] : []);
  counter.textContent = slides.length > 1 ? `${index + 1} / ${slides.length}` : "";
  prevBtn.hidden = slides.length < 2;
  nextBtn.hidden = slides.length < 2;
}

/**
 * Die Bildunterschrift darf das Panel nie breiter machen als das Foto
 * tatsächlich gerendert wird — sonst bleibt ein schwarzer Rand in der
 * Bühne (siehe CSS-Kommentar bei .lightbox-info). Wie breit ein Foto
 * wirklich wird, hängt aber nicht nur vom Gerät, sondern auch von der
 * verfügbaren Bildschirmhöhe ab (max-height:62dvh) — die unterscheidet
 * sich zwischen installierter App (Vollbild) und Browser-Tab (mit
 * Adressleiste) auf demselben Gerät. Ein fester CSS-Wert kann das nicht
 * für jeden Fall treffen, daher hier die reale, bereits von der
 * height-Vorgabe begrenzte Bildbreite nachmessen und exakt übernehmen.
 * Die Bühne legt links/rechts noch etwas Innenabstand um das Foto (siehe
 * CSS) — der zählt mit, sonst wäre die Notiz-Spalte am Ende schmaler als
 * die gepolsterte Bühne und beide Ränder würden wieder auseinanderlaufen.
 */
function passtBreiteAn() {
  if (overlay.hidden || !img.naturalWidth) return;
  infoBox.style.maxWidth = img.getBoundingClientRect().width + 2 * BUEHNE_PAD_X + "px";
}

function springe(delta) {
  if (slides.length < 2) return;
  index = (index + delta + slides.length) % slides.length;
  zeichne();
}

/** Wischgesten auf der Bildfläche: links/rechts blättert, nach unten
 * schließt — die übliche Bedienung aus Fotos-Apps. Kurze Bewegungen (Tipp)
 * lösen nichts aus, siehe SWIPE_MIN_PX. */
function wireSwipe() {
  let startX = 0, startY = 0, tracking = false;
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
    const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
    if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) return; // war ein Tipp
    if (Math.abs(dy) > Math.abs(dx) * 1.3) {
      if (dy > 0) schliessen(); // nach unten wischen = schließen
    } else {
      springe(dx < 0 ? 1 : -1); // links = weiter, rechts = zurück
    }
  }, { passive: true });
}

function bauen() {
  img = el("img", { alt: "" });
  infoBody = el("div.lightbox-info-body");
  counter = el("span.lightbox-count");
  prevBtn = el("button.lightbox-nav.prev", { "aria-label": "Vorheriges Foto", text: "‹", on: { click: (e) => { e.stopPropagation(); springe(-1); } } });
  nextBtn = el("button.lightbox-nav.next", { "aria-label": "Nächstes Foto", text: "›", on: { click: (e) => { e.stopPropagation(); springe(1); } } });
  stage = el("div.lightbox-stage", { on: { click: (e) => { if (e.target === stage) schliessen(); } } }, [prevBtn, img, nextBtn, counter]);
  infoBox = el("div.lightbox-info", {}, [
    el("button.lightbox-close", { "aria-label": "Schließen", text: "✕", on: { click: schliessen } }),
    infoBody,
  ]);
  const panel = el("div.lightbox-panel", {}, [infoBox, stage]);
  overlay = el("div.lightbox", {
    hidden: true,
    on: { click: (e) => { if (e.target === overlay) schliessen(); } },
  }, [panel]);
  document.body.appendChild(overlay);
  wireSwipe();
  img.addEventListener("load", passtBreiteAn);
  window.addEventListener("resize", passtBreiteAn); // z. B. Adressleiste ein-/ausblenden auf iOS Safari
  document.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") schliessen();
    else if (e.key === "ArrowLeft") springe(-1);
    else if (e.key === "ArrowRight") springe(1);
  });
}

/**
 * Öffnet eine Foto-Reihe. `alleSlides`: [{url, info?: HTMLElement}].
 * `startIndex`: womit begonnen wird (das angetippte Foto).
 */
export function zeigeFoto(alleSlides, startIndex = 0) {
  if (!overlay) bauen();
  slides = alleSlides;
  index = startIndex;
  zeichne();
  overlay.hidden = false;
}
