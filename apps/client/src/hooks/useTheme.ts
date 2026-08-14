import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

// V0.9.2: themes are family × mode. "sunstone" is the original Bridge
// baseline; "apple" is an independent Apple-HIG family. Neither family reads
// a token from the other, so they can evolve separately.
export type ThemeFamily = "sunstone" | "apple";

export interface ThemeControl {
  theme: Theme;
  family: ThemeFamily;
  setTheme(theme: Theme): void;
  setFamily(family: ThemeFamily): void;
  toggleTheme(): void;
}

const THEME_KEY = "bridge-theme";
const FAMILY_KEY = "bridge-theme-family";

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // V0.8.0: dark is the flagship theme (Sunstone baseline); returning users
  // keep their stored choice, new users land on dark.
  return "dark";
}

function initialFamily(): ThemeFamily {
  const stored = localStorage.getItem(FAMILY_KEY);
  if (stored === "sunstone" || stored === "apple") return stored;
  return "sunstone";
}

// Safari chrome / task-switcher tint per family × mode.
const META_THEME_COLOR: Record<ThemeFamily, Record<Theme, string>> = {
  sunstone: { light: "#f6f4f0", dark: "#000000" },
  apple: { light: "#f2f2f7", dark: "#000000" },
};

export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [family, setFamily] = useState<ThemeFamily>(initialFamily);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themeFamily = family;
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(FAMILY_KEY, family);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_THEME_COLOR[family][theme]);
  }, [theme, family]);
  const toggleTheme = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);
  return { theme, family, setTheme, setFamily, toggleTheme };
}
