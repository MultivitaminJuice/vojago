// Datumsauswahl als eigener Kalender statt der winzigen Browser-Popups
// (`<input type="date">` öffnet am Mac ein Mini-Kalenderchen, das aus dem Dialog
// ragt). Drei Bausteine:
//   kalender()     – Monatsansicht zum Wählen eines Zeitraums oder eines Tages
//   datumDialog()  – Dialog mit einem Kalender für ein einzelnes Datum
//   datumFeld()    – Knopf, der sich wie ein Eingabefeld verhält (.value, "input"-Ereignis)
// Die Rechnerei steckt in ../kalender.js.
import { el, $ } from "../dom.js";
import {
  MONATE, WOCHENTAGE, datumText, monatVon, verschiebeMonat, monatsRaster, waehleTag, rolleImBereich,
} from "../kalender.js";

/**
 * Monatskalender. `modus: "bereich"` wählt Anfang und Ende, `"tag"` genau einen Tag.
 * `onChange({ von, bis })` kommt bei jedem Tippen auf einen Tag.
 */
export function kalender({ modus = "bereich", auswahl = {}, onChange = () => {}, jetzt = () => new Date() } = {}) {
  let wahl = { von: auswahl.von || null, bis: auswahl.bis || null };
  let monat = monatVon(wahl.von || wahl.bis, jetzt());
  let ansicht = "tage";   // "tage" | "monate"
  const wurzel = el("div.kal");

  const pfeil = (text, label, delta, schritt = 1) => el("button.kal-pfeil", {
    type: "button", "aria-label": label, text,
    on: { click: () => { monat = verschiebeMonat(monat, delta * schritt); zeichne(); } },
  });

  function tageAnsicht() {
    const raster = monatsRaster(monat, jetzt());
    return [
      el("div.kal-kopf", {}, [
        pfeil("‹", "Vorheriger Monat", -1),
        el("button.kal-titel", { type: "button", text: raster.titel, "aria-label": "Monat und Jahr wählen", on: { click: () => { ansicht = "monate"; zeichne(); } } }),
        pfeil("›", "Nächster Monat", 1),
      ]),
      el("div.kal-woche", { "aria-hidden": "true" }, WOCHENTAGE.map((w) => el("span", { text: w }))),
      el("div.kal-raster", {}, raster.wochen.flat().map((tag) => {
        const rolle = rolleImBereich(modus === "tag" ? { von: wahl.von, bis: null } : wahl, tag.key);
        return el("button.kal-tag", {
          type: "button",
          class: [!tag.imMonat && "aussen", tag.heute && "heute", rolle && `rolle-${rolle}`].filter(Boolean).join(" "),
          dataset: { key: tag.key },
          "aria-label": datumText(tag.key),
          "aria-pressed": String(Boolean(rolle)),
          text: String(tag.tag),
          on: { click: () => tippe(tag.key) },
        });
      })),
    ];
  }

  function monateAnsicht() {
    return [
      el("div.kal-kopf", {}, [
        pfeil("‹", "Vorheriges Jahr", -1, 12),
        el("button.kal-titel", { type: "button", text: String(monat.jahr), "aria-label": "Zurück zu den Tagen", on: { click: () => { ansicht = "tage"; zeichne(); } } }),
        pfeil("›", "Nächstes Jahr", 1, 12),
      ]),
      el("div.kal-monate", {}, MONATE.map((name, i) => el("button.kal-monat", {
        type: "button", text: name.slice(0, 3),
        class: i === monat.monat ? "gewaehlt" : "",
        "aria-label": `${name} ${monat.jahr}`,
        on: { click: () => { monat = { jahr: monat.jahr, monat: i }; ansicht = "tage"; zeichne(); } },
      }))),
    ];
  }

  function zeichne() {
    wurzel.replaceChildren(...(ansicht === "tage" ? tageAnsicht() : monateAnsicht()));
  }

  function tippe(key) {
    wahl = modus === "tag" ? { von: key, bis: null } : waehleTag(wahl, key);
    // Ein Tag aus dem Nachbarmonat tippen: dorthin blättern.
    const m = monatVon(key, jetzt());
    if (m.jahr !== monat.jahr || m.monat !== monat.monat) monat = m;
    zeichne();
    onChange({ ...wahl });
  }

  zeichne();
  return {
    knoten: wurzel,
    auswahl: () => ({ ...wahl }),
    /** Auswahl von außen setzen (Voreinstellung); der Kalender blättert zum Ende des Zeitraums. */
    setze(neu) {
      wahl = { von: neu.von || null, bis: neu.bis || null };
      monat = monatVon(wahl.bis || wahl.von, jetzt());
      ansicht = "tage";
      zeichne();
    },
  };
}

/**
 * Dialog zum Wählen eines einzelnen Datums. Antwortet mit `{ wert }` (Tag oder null
 * für "leer"), oder `undefined`, wenn abgebrochen wurde.
 */
export function datumDialog({ titel, wert = "", leerText = "" } = {}) {
  return new Promise((fertig) => {
    const bildschirm = $(".screen") || document.body;
    const schliessen = (antwort) => {
      document.removeEventListener("keydown", taste, true);
      overlay.remove();
      fertig(antwort);
    };
    const taste = (e) => { if (e.key === "Escape") { e.stopPropagation(); schliessen(undefined); } };
    const kal = kalender({
      modus: "tag", auswahl: { von: wert || null },
      onChange: ({ von }) => schliessen({ wert: von }),
    });
    const overlay = el("div.trip-picker.kal-dialog", { on: { click: (e) => { if (e.target === overlay) schliessen(undefined); } } }, [
      el("div.trip-picker-panel.kal-panel", { role: "dialog", "aria-modal": "true", "aria-label": titel || "Datum wählen" }, [
        el("div.trip-picker-head", {}, [
          el("b", { text: titel || "Datum wählen" }),
          el("button.iconbtn", { type: "button", "aria-label": "Schließen", text: "×", on: { click: () => schliessen(undefined) } }),
        ]),
        el("div.kal-body", {}, [
          kal.knoten,
          leerText ? el("button.btn.kal-leer", { type: "button", text: leerText, on: { click: () => schliessen({ wert: null }) } }) : null,
        ]),
      ]),
    ]);
    document.addEventListener("keydown", taste, true);
    bildschirm.appendChild(overlay);
    overlay.querySelector(".kal-tag.rolle-einzel, .kal-tag.heute, .kal-tag")?.focus({ preventScroll: true });
  });
}

/**
 * Knopf, der sich wie ein Datumsfeld benimmt: `.value` ("JJJJ-MM-TT" oder ""), `.value = …`
 * und ein "input"-Ereignis nach jeder Änderung. Mit `leerText` kann man das Datum auch leeren
 * (z. B. "Läuft weiter" beim Ende einer Reise).
 */
export function datumFeld({ id = "", wert = "", titel = "Datum wählen", leerText = "", platzhalter = "Datum wählen" } = {}) {
  const knopf = el(`button.datum-feld${id ? `#${id}` : ""}`, { type: "button", "aria-haspopup": "dialog" });
  let aktuell = "";
  const zeige = () => {
    knopf.textContent = aktuell ? datumText(aktuell) : (leerText || platzhalter);
    knopf.classList.toggle("leer", !aktuell);
  };
  Object.defineProperty(knopf, "value", {
    get: () => aktuell,
    set: (v) => { aktuell = v || ""; zeige(); },
  });
  knopf.value = wert;
  knopf.addEventListener("click", async () => {
    const antwort = await datumDialog({ titel, wert: aktuell, leerText });
    if (antwort === undefined) return;
    knopf.value = antwort.wert || "";
    knopf.dispatchEvent(new Event("input", { bubbles: true }));
    knopf.focus({ preventScroll: true });
  });
  return knopf;
}
