export const THEME_KEY = "ms.theme";

/** Inline <head> script: applies the saved theme before first paint (no flash). */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
