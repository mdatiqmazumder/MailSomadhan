"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { THEME_KEY } from "@/lib/theme";
import { Menu, MenuItem } from "./ui";

type Theme = "light" | "dark" | "system";
const KEY = THEME_KEY;

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY);
      if (t === "light" || t === "dark") setTheme(t);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const choose = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Menu
      trigger={(toggle) => (
        <button onClick={toggle} aria-label="Theme" title="Theme" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-text">
          <Icon className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <>
          {(["light", "dark", "system"] as Theme[]).map((t) => (
            <MenuItem key={t} active={theme === t} onClick={() => { choose(t); close(); }}>
              {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
