import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import SetupScreen from "./components/lock/SetupScreen";
import LockScreen from "./components/lock/LockScreen";
import MainApp from "./components/MainApp";

export default function App() {
 const view = useStore((s) => s.view);
 const init = useStore((s) => s.init);
 const settings = useStore((s) => s.settings);

  useEffect(() => {
    init();
  }, [init]);

  // Auto-lock on window blur
  useEffect(() => {
    if (view !== "main") return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          useStore.getState().lock();
        },
        settings.lock_timeout_minutes * 60 * 1000,
      );
    };

    const onBlur = () => {
      if (settings.blur_on_focus_loss) {
        useStore.getState().lock();
      }
    };

    const unlistenBlur = listen("window-blur", () => onBlur());

    resetTimer();
    const events: Array<keyof WindowEventMap> = ["mousemove", "keydown", "click", "wheel"];
    const handlers = events.map((ev) => {
      const h = () => resetTimer();
      window.addEventListener(ev, h);
      return { ev, h };
    });

    return () => {
      if (timer) clearTimeout(timer);
      handlers.forEach(({ ev, h }) => window.removeEventListener(ev, h));
      unlistenBlur.then((f) => f());
    };
  }, [view, settings.lock_timeout_minutes, settings.blur_on_focus_loss]);

  return (
    <div className="space-bg h-screen w-screen overflow-hidden">
      {view === "setup" && <SetupScreen />}
      {view === "unlock" && <LockScreen mode="unlock" />}
      {view === "locked" && <LockScreen mode="unlock" />}
      {view === "main" && <MainApp />}
    </div>
  );
}
