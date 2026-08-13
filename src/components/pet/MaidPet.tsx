import { useState, useEffect, useRef } from "react";

const OUTFITS = [
  { id: "classic", name: "经典女仆", dress: "#1a1a2e", apron: "#f0f0f0", trim: "#e94560", ribbon: "#e94560" },
  { id: "cyan", name: "赛博女仆", dress: "#0a0e27", apron: "#00f5ff", trim: "#00f5ff", ribbon: "#00f5ff" },
  { id: "pink", name: "樱花女仆", dress: "#2d1b2e", apron: "#ffb3d9", trim: "#ff6b9d", ribbon: "#ff6b9d" },
  { id: "green", name: "薄荷女仆", dress: "#1a2e1a", apron: "#90ee90", trim: "#00ff94", ribbon: "#00ff94" },
];

const ACTIONS = ["wave", "heart", "wink", "spin", "bow", "sleepy"];

export default function MaidPet() {
  const [outfitIdx, setOutfitIdx] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const [showOutfits, setShowOutfits] = useState(false);
  const [blink, setBlink] = useState(false);
  const [floatPhase, setFloatPhase] = useState(0);
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const outfit = OUTFITS[outfitIdx];

  // Blinking animation
  useEffect(() => {
    const interval = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 150);
    }, 3000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, []);

  // Floating animation
  useEffect(() => {
    const interval = setInterval(() => setFloatPhase((p) => (p + 1) % 360), 50);
    return () => clearInterval(interval);
  }, []);

  // Random idle actions
  useEffect(() => {
    const idleTimer = setInterval(() => {
      if (!action && Math.random() > 0.7) {
        const phrases = ["主人好~", "嘿嘿~", "今天也要加油呢", "喵~", "欢迎回来~"];
        setBubbleText(phrases[Math.floor(Math.random() * phrases.length)]);
        setTimeout(() => setBubbleText(null), 2500);
      }
    }, 8000);
    return () => clearInterval(idleTimer);
  }, [action]);

  const handleClick = () => {
    const randomAction = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    setAction(randomAction);
    const phrases: Record<string, string> = {
      wave: "主人你好呀~", heart: "心动了~", wink: "眨眼~", spin: "转圈圈~", bow: "请多关照~", sleepy: "好困...",
    };
    setBubbleText(phrases[randomAction] || "喵~");
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => {
      setAction(null);
      setBubbleText(null);
    }, 2500);
  };

  const floatY = Math.sin(floatPhase * 0.03) * 4;

  return (
    <div className="fixed bottom-4 right-4 z-40 select-none" style={{ pointerEvents: "auto" }}>
      {/* Speech bubble */}
      {bubbleText && (
        <div className="absolute bottom-24 right-0 pl-glass-strong rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap pl-fade-in"
          style={{ animation: "pl-bounce-in 0.3s ease both" }}>
          {bubbleText}
        </div>
      )}

      {/* Outfit selector */}
      {showOutfits && (
        <div className="absolute bottom-20 right-0 pl-glass-strong rounded-xl p-2 flex flex-col gap-1" style={{ animation: "pl-fade-in 0.2s ease both" }}>
          {OUTFITS.map((o, i) => (
            <button key={o.id} onClick={() => { setOutfitIdx(i); setShowOutfits(false); setBubbleText("换装完成~"); setTimeout(() => setBubbleText(null), 1500); }}
              className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-all ${i === outfitIdx ? "bg-cyan-500/20 pl-text-cyan" : "hover:bg-white/5 pl-text-dim"}`}>
              {o.name}
            </button>
          ))}
        </div>
      )}

      {/* The maid character */}
      <div className="relative cursor-pointer" style={{ transform: `translateY(${floatY}px)` }} onClick={handleClick}>
        <svg width="80" height="100" viewBox="0 0 80 100" style={{ filter: `drop-shadow(0 4px 8px ${outfit.trim}33)` }}>
          {/* Action-based transforms */}
          <g style={{
            transformOrigin: "40px 50px",
            transition: "transform 0.3s ease",
            ...(action === "spin" ? { animation: "pl-maid-spin 1s linear" } : {}),
            ...(action === "bow" ? { transform: "rotateX(30deg)" } : {}),
            ...(action === "sleepy" ? { transform: "rotate(-10deg) translateY(5px)" } : {}),
          }}>
            {/* Dress/body */}
            <path d="M25 45 Q25 40 30 38 L50 38 Q55 40 55 45 L60 85 Q60 92 55 95 L25 95 Q20 92 20 85 Z"
              fill={outfit.dress} stroke={outfit.trim} strokeWidth="1" />
            {/* Apron */}
            <path d="M30 42 L50 42 L52 88 L28 88 Z" fill={outfit.apron} opacity="0.85" />
            {/* Apron trim */}
            <path d="M28 88 Q30 85 32 88 Q34 85 36 88 Q38 85 40 88 Q42 85 44 88 Q46 85 48 88 Q50 85 52 88"
              fill="none" stroke={outfit.trim} strokeWidth="1.5" />
            {/* Arms */}
            {(action === "wave" || action === "heart") ? (
              <path d={action === "wave"
                ? "M50 48 Q60 35 62 25 Q63 20 58 20 Q55 22 52 30"
                : "M25 48 Q18 40 22 35 Q28 33 30 40 M55 48 Q62 40 58 35 Q52 33 50 40"}
                fill={outfit.dress} stroke={outfit.trim} strokeWidth="1" />
            ) : (
              <>
                <path d="M25 45 Q20 55 22 68" fill="none" stroke={outfit.dress} strokeWidth="6" strokeLinecap="round" />
                <path d="M55 45 Q60 55 58 68" fill="none" stroke={outfit.dress} strokeWidth="6" strokeLinecap="round" />
              </>
            )}
            {/* Head */}
            <circle cx="40" cy="28" r="14" fill="#ffe0d0" stroke="#e8c0a0" strokeWidth="0.5" />
            {/* Hair back */}
            <path d="M26 25 Q24 18 30 14 Q35 10 40 12 Q45 10 50 14 Q56 18 54 25 Q54 30 52 32 L28 32 Q26 30 26 25 Z"
              fill={outfit.dress} opacity="0.9" />
            {/* Maid headband */}
            <path d="M28 18 Q40 14 52 18 L52 22 Q40 19 28 22 Z" fill={outfit.apron} />
            <path d="M28 18 Q40 14 52 18" fill="none" stroke={outfit.trim} strokeWidth="1" />
            {/* Ribbon */}
            <path d="M37 16 L40 12 L43 16 L40 18 Z" fill={outfit.ribbon} />
            <circle cx="40" cy="15" r="2" fill={outfit.ribbon} />
            {/* Eyes */}
            {action === "wink" ? (
              <>
                <ellipse cx="35" cy="27" rx="2" ry="2.5" fill="#333" />
                <path d="M43 27 Q45 26 47 27" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
              </>
            ) : action === "sleepy" || blink ? (
              <>
                <path d="M33 27 Q35 28 37 27" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M43 27 Q45 28 47 27" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="35" cy="27" rx="2" ry="3" fill="#333" />
                <ellipse cx="45" cy="27" rx="2" ry="3" fill="#333" />
                <circle cx="35.5" cy="26" r="0.8" fill="white" />
                <circle cx="45.5" cy="26" r="0.8" fill="white" />
              </>
            )}
            {/* Blush */}
            <circle cx="32" cy="31" r="2" fill="#ffb3c1" opacity="0.4" />
            <circle cx="48" cy="31" r="2" fill="#ffb3c1" opacity="0.4" />
            {/* Mouth */}
            {action === "heart" ? (
              <path d="M38 33 Q40 36 42 33 Q44 31 42 30 Q40 29 38 30 Q36 31 38 33" fill="#ff6b9d" />
            ) : action === "sleepy" ? (
              <ellipse cx="40" cy="33" rx="1.5" ry="1" fill="#e88" opacity="0.5" />
            ) : (
              <path d="M38 32 Q40 34 42 32" fill="none" stroke="#c66" strokeWidth="1" strokeLinecap="round" />
            )}
            {/* Heart for heart action */}
            {action === "heart" && (
              <text x="56" y="20" fontSize="10" style={{ animation: "pl-float-up 1s ease-out forwards" }}>❤️</text>
            )}
            {/* Zzz for sleepy */}
            {action === "sleepy" && (
              <>
                <text x="54" y="18" fontSize="8" opacity="0.6" style={{ animation: "pl-float-up 2s ease-in-out infinite" }}>z</text>
                <text x="58" y="14" fontSize="6" opacity="0.4" style={{ animation: "pl-float-up 2s ease-in-out 0.5s infinite" }}>z</text>
              </>
            )}
          </g>
        </svg>
        {/* Outfit change button */}
        <button onClick={(e) => { e.stopPropagation(); setShowOutfits(!showOutfits); }}
          className="absolute -top-1 -left-1 w-5 h-5 rounded-full pl-glass-strong flex items-center justify-center text-xs hover:scale-110 transition-transform"
          title="换装">
          <span className="text-[10px]">👗</span>
        </button>
      </div>
    </div>
  );
}
