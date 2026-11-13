// Date picking with our own calendar instead of the tiny browser pop-ups
// (`<input type="date">` opens a mini calendar on the Mac that sticks out of the
// dialog). Three building blocks:
//   calendar()    – month view for choosing a time span or a single day
//   dateDialog()  – dialog with a calendar for a single date
//   dateField()   – button that behaves like an input field (.value, "input" event)
// The computation lives in ../calendar.js. Labels are UI and stay German.
import { el, $ } from "../dom.js";
import {
  MONTHS, WEEKDAYS, dateText, monthOf, shiftMonth, monthGrid, pickDay, roleInRange,
} from "../calendar.js";

/**
 * Month calendar. `mode: "range"` picks start and end, `"day"` exactly one day.
 * `onChange({ from, to })` is called on every tap on a day.
 */
export function calendar({ mode = "range", selection = {}, onChange = () => {}, now = () => new Date() } = {}) {
  let picked = { from: selection.from || null, to: selection.to || null };
  let month = monthOf(picked.from || picked.to, now());
  let view = "days";   // "days" | "months"
  const root = el("div.cal");

  const arrow = (text, label, delta, step = 1) => el("button.cal-arrow", {
    type: "button", "aria-label": label, text,
    on: { click: () => { month = shiftMonth(month, delta * step); draw(); } },
  });

  function daysView() {
    const grid = monthGrid(month, now());
    return [
      el("div.cal-head", {}, [
        arrow("‹", "Vorheriger Monat", -1),
        el("button.cal-title", { type: "button", text: grid.title, "aria-label": "Monat und Jahr wählen", on: { click: () => { view = "months"; draw(); } } }),
        arrow("›", "Nächster Monat", 1),
      ]),
      el("div.cal-week", { "aria-hidden": "true" }, WEEKDAYS.map((w) => el("span", { text: w }))),
      el("div.cal-grid", {}, grid.weeks.flat().map((day) => {
        const role = roleInRange(mode === "day" ? { from: picked.from, to: null } : picked, day.key);
        return el("button.cal-day", {
          type: "button",
          class: [!day.inMonth && "outside", day.today && "today", role && `role-${role}`].filter(Boolean).join(" "),
          dataset: { key: day.key },
          "aria-label": dateText(day.key),
          "aria-pressed": String(Boolean(role)),
          text: String(day.day),
          on: { click: () => tap(day.key) },
        });
      })),
    ];
  }

  function monthsView() {
    return [
      el("div.cal-head", {}, [
        arrow("‹", "Vorheriges Jahr", -1, 12),
        el("button.cal-title", { type: "button", text: String(month.year), "aria-label": "Zurück zu den Tagen", on: { click: () => { view = "days"; draw(); } } }),
        arrow("›", "Nächstes Jahr", 1, 12),
      ]),
      el("div.cal-months", {}, MONTHS.map((name, i) => el("button.cal-month", {
        type: "button", text: name.slice(0, 3),
        class: i === month.month ? "selected" : "",
        "aria-label": `${name} ${month.year}`,
        on: { click: () => { month = { year: month.year, month: i }; view = "days"; draw(); } },
      }))),
    ];
  }

  function draw() {
    root.replaceChildren(...(view === "days" ? daysView() : monthsView()));
  }

  function tap(key) {
    picked = mode === "day" ? { from: key, to: null } : pickDay(picked, key);
    // Tapping a day of the neighbouring month: page there.
    const m = monthOf(key, now());
    if (m.year !== month.year || m.month !== month.month) month = m;
    draw();
    onChange({ ...picked });
  }

  draw();
  return {
    node: root,
    selection: () => ({ ...picked }),
    /** Set the selection from outside (preset); the calendar pages to the end of the span. */
    set(next) {
      picked = { from: next.from || null, to: next.to || null };
      month = monthOf(picked.to || picked.from, now());
      view = "days";
      draw();
    },
  };
}

/**
 * Dialog for picking a single date. Resolves with `{ value }` (a day, or null
 * for "empty"), or `undefined` when cancelled.
 */
export function dateDialog({ title, value = "", emptyText = "" } = {}) {
  return new Promise((done) => {
    const screen = $(".screen") || document.body;
    const close = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      done(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(undefined); } };
    const cal = calendar({
      mode: "day", selection: { from: value || null },
      onChange: ({ from }) => close({ value: from }),
    });
    const overlay = el("div.trip-picker.cal-dialog", { on: { click: (e) => { if (e.target === overlay) close(undefined); } } }, [
      el("div.trip-picker-panel.cal-panel", { role: "dialog", "aria-modal": "true", "aria-label": title || "Datum wählen" }, [
        el("div.trip-picker-head", {}, [
          el("b", { text: title || "Datum wählen" }),
          el("button.iconbtn", { type: "button", "aria-label": "Schließen", text: "×", on: { click: () => close(undefined) } }),
        ]),
        el("div.cal-body", {}, [
          cal.node,
          emptyText ? el("button.btn.cal-empty", { type: "button", text: emptyText, on: { click: () => close({ value: null }) } }) : null,
        ]),
      ]),
    ]);
    document.addEventListener("keydown", onKey, true);
    screen.appendChild(overlay);
    overlay.querySelector(".cal-day.role-single, .cal-day.today, .cal-day")?.focus({ preventScroll: true });
  });
}

/**
 * Button that behaves like a date field: `.value` ("YYYY-MM-DD" or ""), `.value = …`
 * and an "input" event after every change. With `emptyText` the date can also be
 * cleared (e.g. "Läuft weiter" for the end of a trip).
 */
export function dateField({ id = "", value = "", title = "Datum wählen", emptyText = "", placeholder = "Datum wählen" } = {}) {
  const button = el(`button.date-field${id ? `#${id}` : ""}`, { type: "button", "aria-haspopup": "dialog" });
  let current = "";
  const show = () => {
    button.textContent = current ? dateText(current) : (emptyText || placeholder);
    button.classList.toggle("empty", !current);
  };
  Object.defineProperty(button, "value", {
    get: () => current,
    set: (v) => { current = v || ""; show(); },
  });
  button.value = value;
  button.addEventListener("click", async () => {
    const answer = await dateDialog({ title, value: current, emptyText });
    if (answer === undefined) return;
    button.value = answer.value || "";
    button.dispatchEvent(new Event("input", { bubbles: true }));
    button.focus({ preventScroll: true });
  });
  return button;
}
