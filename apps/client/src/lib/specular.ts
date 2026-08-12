/**
 * Pointer-follow specular highlight for liquid-glass panels (V0.8.0).
 *
 * Writes --mx/--my custom properties on the glass panel under the pointer so
 * the panel's radial-gradient highlight tracks the cursor, like light across
 * thick glass. One delegated listener, rAF-throttled, decoration only:
 * disabled for coarse pointers, reduced-motion and reduced-transparency.
 */
const SPECULAR_SELECTOR = [
  ".confirm-dialog",
  ".create-session-dialog",
  ".provider-switch-dialog",
  ".session-configuration-dialog",
  ".permission-sheet",
  ".pairing-panel",
].join(", ");

export function installSpecularHighlight(): () => void {
  const fine = window.matchMedia("(pointer: fine)");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduceTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)");

  let raf = 0;
  let panel: HTMLElement | null = null;
  let pointerX = 0;
  let pointerY = 0;

  const flush = () => {
    raf = 0;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty("--mx", `${Math.round(pointerX - rect.left)}px`);
    panel.style.setProperty("--my", `${Math.round(pointerY - rect.top)}px`);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!fine.matches || reduceMotion.matches || reduceTransparency.matches) return;
    const hit = event.target instanceof Element ? event.target.closest(SPECULAR_SELECTOR) : null;
    if (!hit) {
      panel = null;
      return;
    }
    panel = hit as HTMLElement;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!raf) raf = window.requestAnimationFrame(flush);
  };

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  return () => {
    window.removeEventListener("pointermove", onPointerMove);
    if (raf) window.cancelAnimationFrame(raf);
  };
}
