// Ziehen eines Elements: auf dem Handy nach langem Drücken (damit normales
// Scrollen über dem Element weiter geht), mit der Maus sofort nach ein paar
// Pixeln. Das Modul meldet nur Positionen (clientX/clientY); was beim Ziehen
// angezeigt und beim Loslassen getan wird, entscheidet der Aufrufer.
//
//   ziehbar(knoten, { start(pos), bewegung(pos), ende(pos), abbruch() })
//
// Ein Tippen ohne Ziehen löst weiter ein normales "click" aus; nach einem Zug
// wird das folgende "click" unterdrückt.
const HALTEN_MS = 380;
const WACKELN_PX = 8;
const MAUS_SCHWELLE_PX = 5;

export function ziehbar(knoten, { start, bewegung, ende, abbruch = () => {} }) {
  let timer = null;
  let aktiv = false;
  let ursprung = null;
  let klickSperre = false;

  const los = (pos) => { aktiv = true; klickSperre = true; start(pos); };
  const pos = (t) => ({ x: t.clientX, y: t.clientY });

  // Das "click" nach einem Zug (Maus) nicht an den Knoten weitergeben.
  knoten.addEventListener("click", (e) => {
    if (!klickSperre) return;
    klickSperre = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  // Langes Drücken auf iOS/Android öffnet sonst das Bild-Menü.
  knoten.addEventListener("contextmenu", (e) => e.preventDefault());

  /* Berührung */
  knoten.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { clearTimeout(timer); timer = null; return; }
    ursprung = pos(e.touches[0]);
    klickSperre = false;
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(12); los(ursprung); }, HALTEN_MS);
  }, { passive: true });

  knoten.addEventListener("touchmove", (e) => {
    const p = pos(e.touches[0]);
    if (aktiv) { e.preventDefault(); bewegung(p); return; }
    if (timer && Math.hypot(p.x - ursprung.x, p.y - ursprung.y) > WACKELN_PX) { clearTimeout(timer); timer = null; }
  }, { passive: false });

  knoten.addEventListener("touchend", (e) => {
    clearTimeout(timer);
    timer = null;
    if (!aktiv) return;
    aktiv = false;
    e.preventDefault();   // kein "click" nach dem Zug
    klickSperre = false;
    ende(pos(e.changedTouches[0]));
  });

  knoten.addEventListener("touchcancel", () => {
    clearTimeout(timer);
    timer = null;
    if (!aktiv) return;
    aktiv = false;
    klickSperre = false;
    abbruch();
  });

  /* Maus */
  knoten.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    ursprung = pos(e);
    klickSperre = false;
    const bewegt = (ev) => {
      const p = pos(ev);
      if (!aktiv && Math.hypot(p.x - ursprung.x, p.y - ursprung.y) > MAUS_SCHWELLE_PX) los(p);
      if (aktiv) { ev.preventDefault(); bewegung(p); }
    };
    const losgelassen = (ev) => {
      document.removeEventListener("mousemove", bewegt);
      document.removeEventListener("mouseup", losgelassen);
      if (!aktiv) return;
      aktiv = false;
      ende(pos(ev));
    };
    document.addEventListener("mousemove", bewegt);
    document.addEventListener("mouseup", losgelassen);
  });
}
