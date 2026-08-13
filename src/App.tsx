import { useEffect } from "react";
import { useStore } from "./store";
import SetupScreen from "./components/lock/SetupScreen";
import LockScreen from "./components/lock/LockScreen";
import MainApp from "./components/MainApp";

export default function App() {
  const view = useStore((s) => s.view);
  const init = useStore((s) => s.init);
  const settings = useStore((s) => s.settings);
  const theme = settings.theme || "dark";

  useEffect(() => {
    init();
  }, [init]);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Idle auto-lock: only locks after no user activity for the configured timeout.
  // Window blur does NOT lock; user must be idle.
  useEffect(() => {
    if (view !== "main") return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      const timeoutMs = settings.lock_timeout_minutes * 60 * 1000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          useStore.getState().lock();
        }, timeoutMs);
      }
    };

    resetTimer();
    const events: Array<keyof WindowEventMap> = ["mousemove", "keydown", "click", "wheel", "touchstart"];
    const handlers = events.map((ev) => {
      const h = () => resetTimer();
      window.addEventListener(ev, h);
      return { ev, h };
    });

    return () => {
      if (timer) clearTimeout(timer);
      handlers.forEach(({ ev, h }) => window.removeEventListener(ev, h));
    };
  }, [view, settings.lock_timeout_minutes]);

  return (
    <div className="space-bg h-screen w-screen overflow-hidden">
      {view === "setup" && <SetupScreen />}
      {view === "unlock" && <LockScreen mode="unlock" />}
      {view === "locked" && <LockScreen mode="unlock" />}
      {view === "main" && <MainApp />}
    </div>
  );
}
