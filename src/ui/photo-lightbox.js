// Show a photo large — one reused overlay for the logbook and the editor
// gallery. It follows the pattern of the trip picker (a dimmed, translucent
// background and a clearly framed panel) instead of a full-screen view of its
// own. For photos from the logbook the panel head shows a real app card with
// the details of the note or place (journal.js builds it from the same parts as
// the logbook card); the photo stage below stays dark (a good stage for photos)
// but is set apart by a divider. Previous/next pages through a whole row of
// photos (also across several notes and places of a day, see journal.js). It
// gets finished image URLs and knows no difference between owner and guest.
import { el, render } from "../dom.js";

const SWIPE_MIN_PX = 40; // shorter swipes count as a tap, not a gesture
const STAGE_PAD_X = 16; // must match .lightbox-stage { padding: 0 16px } in styles.css

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

function close() {
  overlay.hidden = true;
  img.src = "";
}

function draw() {
  const s = slides[index] || {};
  infoBox.style.maxWidth = ""; // back to the fixed CSS value until the new photo has loaded
  img.src = s.url || "";
  render(infoBody, s.info ? [s.info] : []);
  counter.textContent = slides.length > 1 ? `${index + 1} / ${slides.length}` : "";
  prevBtn.hidden = slides.length < 2;
  nextBtn.hidden = slides.length < 2;
}

/**
 * The caption must never make the panel wider than the photo is actually drawn —
 * otherwise a black border stays in the stage (see the CSS comment at
 * .lightbox-info). How wide a photo really gets depends not only on the device
 * but also on the available screen height (max-height: 62dvh), which differs
 * between the installed app (full screen) and a browser tab (with address bar)
 * on the same device. A fixed CSS value cannot hit every case, so the real image
 * width, already limited by the height, is measured and taken over exactly. The
 * stage pads the photo left and right (see CSS) — that counts too, otherwise the
 * note column would end narrower than the padded stage.
 */
function fitWidth() {
  if (overlay.hidden || !img.naturalWidth) return;
  infoBox.style.maxWidth = img.getBoundingClientRect().width + 2 * STAGE_PAD_X + "px";
}

function step(delta) {
  if (slides.length < 2) return;
  index = (index + delta + slides.length) % slides.length;
  draw();
}

/** Swipe gestures on the image: left/right pages, down closes — the usual
 * handling from photo apps. Short movements (a tap) do nothing, see SWIPE_MIN_PX. */
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
    if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) return; // it was a tap
    if (Math.abs(dy) > Math.abs(dx) * 1.3) {
      if (dy > 0) close(); // swipe down = close
    } else {
      step(dx < 0 ? 1 : -1); // left = next, right = previous
    }
  }, { passive: true });
}

function build() {
  img = el("img", { alt: "" });
  infoBody = el("div.lightbox-info-body");
  counter = el("span.lightbox-count");
  prevBtn = el("button.lightbox-nav.prev", { "aria-label": "Vorheriges Foto", text: "‹", on: { click: (e) => { e.stopPropagation(); step(-1); } } });
  nextBtn = el("button.lightbox-nav.next", { "aria-label": "Nächstes Foto", text: "›", on: { click: (e) => { e.stopPropagation(); step(1); } } });
  stage = el("div.lightbox-stage", { on: { click: (e) => { if (e.target === stage) close(); } } }, [prevBtn, img, nextBtn, counter]);
  infoBox = el("div.lightbox-info", {}, [
    el("button.lightbox-close", { "aria-label": "Schließen", text: "✕", on: { click: close } }),
    infoBody,
  ]);
  const panel = el("div.lightbox-panel", {}, [infoBox, stage]);
  overlay = el("div.lightbox", {
    hidden: true,
    on: { click: (e) => { if (e.target === overlay) close(); } },
  }, [panel]);
  document.body.appendChild(overlay);
  wireSwipe();
  img.addEventListener("load", fitWidth);
  window.addEventListener("resize", fitWidth); // e.g. the address bar showing or hiding on iOS Safari
  document.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
}

/**
 * Opens a row of photos. `allSlides`: [{ url, info?: HTMLElement }].
 * `startIndex`: where to start (the photo that was tapped).
 */
export function showPhotos(allSlides, startIndex = 0) {
  if (!overlay) build();
  slides = allSlides;
  index = startIndex;
  draw();
  overlay.hidden = false;
}
