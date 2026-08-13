import { useState } from "react";
import { Shield, Lock } from "lucide-react";
import { useStore } from "../../store";

export default function SetupScreen() {
  const setup = useStore((s) => s.setup);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const strength = checkStrength(password);
  const canSubmit =
    name.trim().length >= 1 &&
    password.length >= 12 &&
    password === confirm;

  const handleSubmit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError("");
    try {
      await setup(password, name.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-10 w-[440px] max-w-[90vw] pl-fade-in">
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <div className="w-20 h-20 rounded-full pl-glass pl-glow-cyan flex items-center justify-center">
              <Shield size={36} className="pl-text-cyan" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold pl-glow-text-cyan tracking-wide">
            PhantomLink
          </h1>
          <p className="pl-text-dim text-sm mt-1">初始化加密通信节点</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs pl-text-dim mb-1.5 tracking-wide">
              设备名称
            </label>
            <input
              className="pl-input w-full px-4 py-3"
              placeholder="例如：MacBook Pro"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
            />
          </div>

          <div>
            <label className="block text-xs pl-text-dim mb-1.5 tracking-wide">
              主密码 (至少12位)
            </label>
            <input
              type="password"
              className="pl-input w-full px-4 py-3"
              placeholder="设置主密码..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            {password.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${strength.score * 25}%`,
                      background:
                        strength.score >= 3
                          ? "var(--pl-green)"
                          : strength.score >= 2
                            ? "var(--pl-cyan)"
                            : "#FF6B7A",
                    }}
                  />
                </div>
                <span className="text-xs pl-text-dim">{strength.label}</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs pl-text-dim mb-1.5 tracking-wide">
              确认密码
            </label>
            <input
              type="password"
              className="pl-input w-full px-4 py-3"
              placeholder="再次输入..."
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            {confirm.length > 0 && password !== confirm && (
              <p className="text-xs text-red-400 mt-1">两次密码不一致</p>
            )}
          </div>

          <div className="pl-glass rounded-lg p-3 text-xs pl-text-dim leading-relaxed">
            <Lock size={12} className="inline mr-1 pl-text-cyan" />
            主密码用于加密所有聊天记录。忘记密码将无法恢复数据，请妥善保管。
          </div>

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}

          <button
            className="pl-btn-primary w-full py-3 rounded-lg font-medium tracking-wide disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
          >
            {busy ? "创建中..." : "创建加密节点"}
          </button>
        </div>
      </div>
    </div>
  );
}

function checkStrength(pwd: string): { score: number; label: string } {
  let score = 0;
  if (pwd.length >= 12) score++;
  if (pwd.length >= 16) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/\d/.test(pwd) && /[^A-Za-z0-9]/.test(pwd)) score++;
  score = Math.min(score, 4);
  const labels = ["", "弱", "一般", "较强", "强"];
  return { score, label: labels[score] || "" };
}
