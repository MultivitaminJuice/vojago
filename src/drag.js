// Dragging an element: on a phone after a long press (so normal scrolling over
// the element still works), with the mouse right after a few pixels. The module
// only reports positions (clientX/clientY); what is shown while dragging and
// done on release is up to the caller.
//
//   draggable(node, { start(pos), move(pos), end(pos), cancel() })
//
// A tap without dragging still fires a normal "click"; after a drag the
// following "click" is suppressed.
const HOLD_MS = 380;
const WOBBLE_PX = 8;
const MOUSE_THRESHOLD_PX = 5;

export function draggable(node, { start, move, end, cancel = () => {} }) {
  let timer = null;
  let active = false;
  let origin = null;
  let blockClick = false;

  const begin = (pos) => { active = true; blockClick = true; start(pos); };
  const pos = (t) => ({ x: t.clientX, y: t.clientY });

  // Do not pass the "click" after a (mouse) drag on to the node.
  node.addEventListener("click", (e) => {
    if (!blockClick) return;
    blockClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  // A long press on iOS/Android would otherwise open the image menu.
  node.addEventListener("contextmenu", (e) => e.preventDefault());

  /* Touch */
  node.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { clearTimeout(timer); timer = null; return; }
    origin = pos(e.touches[0]);
    blockClick = false;
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(12); begin(origin); }, HOLD_MS);
  }, { passive: true });

  node.addEventListener("touchmove", (e) => {
    const p = pos(e.touches[0]);
    if (active) { e.preventDefault(); move(p); return; }
    if (timer && Math.hypot(p.x - origin.x, p.y - origin.y) > WOBBLE_PX) { clearTimeout(timer); timer = null; }
  }, { passive: false });

  node.addEventListener("touchend", (e) => {
    clearTimeout(timer);
    timer = null;
    if (!active) return;
    active = false;
    e.preventDefault();   // no "click" after the drag
    blockClick = false;
    end(pos(e.changedTouches[0]));
  });

  node.addEventListener("touchcancel", () => {
    clearTimeout(timer);
    timer = null;
    if (!active) return;
    active = false;
    blockClick = false;
    cancel();
  });

  /* Mouse */
  node.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    origin = pos(e);
    blockClick = false;
    const moved = (ev) => {
      const p = pos(ev);
      if (!active && Math.hypot(p.x - origin.x, p.y - origin.y) > MOUSE_THRESHOLD_PX) begin(p);
      if (active) { ev.preventDefault(); move(p); }
    };
    const released = (ev) => {
      document.removeEventListener("mousemove", moved);
      document.removeEventListener("mouseup", released);
      if (!active) return;
      active = false;
      end(pos(ev));
    };
    document.addEventListener("mousemove", moved);
    document.addEventListener("mouseup", released);
  });
}
