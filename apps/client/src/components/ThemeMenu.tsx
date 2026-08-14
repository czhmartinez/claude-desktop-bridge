import { useEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import type { Theme, ThemeControl, ThemeFamily } from "../hooks/useTheme.js";
import { IconButton } from "./IconButton.js";

const MODES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

const FAMILIES: Array<{ value: ThemeFamily; label: string; swatch: string }> = [
  { value: "sunstone", label: "Sunstone", swatch: "#d97757" },
  { value: "apple", label: "Apple", swatch: "#007aff" },
];

/**
 * V0.9.2 theme switcher: one popover carrying mode (light/dark) and family
 * (Sunstone/Apple) as two segmented controls. Rendered from the icon button
 * that used to toggle light/dark directly.
 */
export function ThemeMenu({
  control,
  side = "bottom",
  iconSize = 18,
}: {
  control: ThemeControl;
  /** "bottom" drops the panel under the trigger (top bars); "right" opens it beside the desktop rail. */
  side?: "bottom" | "right";
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`theme-menu-anchor theme-menu-anchor--${side}`} ref={anchorRef}>
      <IconButton
        label="主题与外观"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {control.theme === "dark" ? <Sun size={iconSize} /> : <Moon size={iconSize} />}
      </IconButton>
      {open && (
        <div className="theme-menu-panel" role="group" aria-label="主题与外观">
          <span className="theme-menu-label">外观</span>
          <div className="segmented">
            {MODES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className={control.theme === value ? "active" : ""}
                aria-pressed={control.theme === value}
                onClick={() => control.setTheme(value)}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <span className="theme-menu-label">风格</span>
          <div className="segmented">
            {FAMILIES.map(({ value, label, swatch }) => (
              <button
                key={value}
                type="button"
                className={control.family === value ? "active" : ""}
                aria-pressed={control.family === value}
                onClick={() => control.setFamily(value)}
              >
                <i className="theme-swatch" style={{ background: swatch }} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
