import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

function initialTheme(): Theme {
  const stored = localStorage.getItem("bridge-theme");
  if (stored === "light" || stored === "dark") return stored;
  // V0.8.0: dark is the flagship theme (Sunstone baseline); returning users
  // keep their stored choice, new users land on dark.
  return "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("bridge-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#000000" : "#f6f4f0");
  }, [theme]);
  return [theme, () => setTheme((value) => value === "dark" ? "light" : "dark")];
}
