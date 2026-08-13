import { useState } from "react";
import { Shield, Loader2 } from "lucide-react";
import { useStore } from "../../store";

export default function LockScreen({ mode: _mode }: { mode: string }) {
  const unlock = useStore((s) => s.unlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const handleUnlock = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      setUnlocking(true);
      await unlock(password);
      // The store will switch view; give animation time
      setTimeout(() => {
        setUnlocking(false);
        setPassword("");
      }, 800);
    } catch (e) {
      setUnlocking(false);
      setError(String(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center relative">
      {unlocking && (
        <div
          className="absolute w-32 h-32 rounded-full border-2 pl-unlock-wave"
          style={{ borderColor: "var(--pl-cyan)" }}
        />
      )}
      <div
        className={`pl-glass-strong pl-glow-cyan rounded-2xl p-10 w-[400px] max-w-[90vw] pl-fade-in ${unlocking ? "opacity-0 transition-opacity duration-500" : ""}`}
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 rounded-full pl-glass pl-glow-cyan flex items-center justify-center">
            <Shield size={36} className="pl-text-cyan" />
          </div>
          <h1 className="text-2xl font-semibold pl-glow-text-cyan tracking-wide mt-4">
            PhantomLink
          </h1>
          <p className="pl-text-dim text-sm mt-1">输入主密码解锁</p>
        </div>

        <div className="space-y-4">
          <input
            type="password"
            autoFocus
            className="pl-input w-full px-4 py-3 text-center tracking-widest"
            placeholder="主密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
          />

          {error && (
            <p className="text-sm text-red-400 text-center">
              {error.includes("locked") ? error : "密码错误"}
            </p>
          )}

          <button
            className="pl-btn-primary w-full py-3 rounded-lg font-medium tracking-wide disabled:opacity-30"
            onClick={handleUnlock}
            disabled={busy || !password}
          >
            {busy ? (
              <Loader2 size={18} className="animate-spin inline" />
            ) : (
              "解锁"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
