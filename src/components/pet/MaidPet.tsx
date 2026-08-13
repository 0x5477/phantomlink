import { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";

// Character designs inspired by Cells at Work (工作细胞) prototypes:
// red blood cell, white blood cell and platelet style chibi maid.
const OUTFITS = [
  {
    id: "rbc", name: "红细胞酱",
    hair: "#E63946", hairDark: "#C1121F", cap: "#E63946", capDark: "#C1121F",
    uniform: "#FDF6F0", trim: "#E63946", collar: "#E63946", skirt: "#FDF6F0",
    hatText: "赤", hatTextColor: "#FFFFFF",
  },
  {
    id: "wbc", name: "白细胞君",
    hair: "#5A6472", hairDark: "#3D4550", cap: "#F2F4F7", capDark: "#CBD2DC",
    uniform: "#FFFFFF", trim: "#5A6472", collar: "#4A90D9", skirt: "#E8ECF2",
    hatText: "白", hatTextColor: "#4A90D9",
  },
  {
    id: "plt", name: "血小板酱",
    hair: "#B08968", hairDark: "#8F6B4C", cap: "#DCEBF7", capDark: "#A9C9E3",
    uniform: "#FDF6F0", trim: "#7FB5D8", collar: "#7FB5D8", skirt: "#DCEBF7",
    hatText: "板", hatTextColor: "#5A9BD5",
  },
];

const ACTIONS = ["wave", "heart", "wink", "spin", "bow", "sleepy"];
const DEFAULT_RIGHT = 16;
const DEFAULT_BOTTOM = 16;
const PET_W = 92;
const PET_H = 120;

export default function MaidPet() {
  const settings = useStore((s) => s.settings);
  const [outfitIdx, setOutfitIdx] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const [showOutfits, setShowOutfits] = useState(false);
  const [blink, setBlink] = useState(false);
  const [floatPhase, setFloatPhase] = useState(0);
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({
    right: settings.pet_x > 0 ? settings.pet_x : DEFAULT_RIGHT,
    bottom: settings.pet_y > 0 ? settings.pet_y : DEFAULT_BOTTOM,
  });
  const [dragging, setDragging] = useState(false);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; right: number; bottom: number } | null>(null);
  const petRef = useRef<HTMLDivElement | null>(null);

  const outfit = OUTFITS[outfitIdx];

  // Sync position from settings when they load (e.g. first mount / reload).
  useEffect(() => {
    if (settings.pet_x > 0 || settings.pet_y > 0) {
      setPos({
        right: settings.pet_x > 0 ? settings.pet_x : DEFAULT_RIGHT,
        bottom: settings.pet_y > 0 ? settings.pet_y : DEFAULT_BOTTOM,
      });
    }
  }, [settings.pet_x, settings.pet_y]);

  // Blinking animation
  useEffect(() => {
    const interval = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 150);
    }, 3000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, []);

  // Floating animation (disabled while dragging)
  useEffect(() => {
    if (dragging) return;
    const interval = setInterval(() => setFloatPhase((p) => (p + 1) % 360), 50);
    return () => clearInterval(interval);
  }, [dragging]);

  // Random idle actions
  useEffect(() => {
    const idleTimer = setInterval(() => {
      if (!action && !dragging && Math.random() > 0.7) {
        const phrases = ["主人好~", "嘿嘿~", "今天也要加油呢", "喵~", "欢迎回来~"];
        setBubbleText(phrases[Math.floor(Math.random() * phrases.length)]);
        setTimeout(() => setBubbleText(null), 2500);
      }
    }, 8000);
    return () => clearInterval(idleTimer);
  }, [action, dragging]);

  const showBubble = useCallback((text: string, ms = 2500) => {
    setBubbleText(text);
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => setBubbleText(null), ms);
  }, []);

  const handleClick = () => {
    if (dragging) return;
    const randomAction = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    setAction(randomAction);
    const phrases: Record<string, string> = {
      wave: "主人你好呀~", heart: "心动了~", wink: "眨眼~", spin: "转圈圈~", bow: "请多关照~", sleepy: "好困...",
    };
    showBubble(phrases[randomAction] || "喵~");
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => {
      setAction(null);
      setBubbleText(null);
    }, 2500);
  };

  // Drag to move
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, right: pos.right, bottom: pos.bottom };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const nextRight = Math.max(4, Math.min(window.innerWidth - PET_W - 4, drag.right - dx));
    const nextBottom = Math.max(4, Math.min(window.innerHeight - PET_H - 4, drag.bottom - dy));
    setPos({ right: nextRight, bottom: nextBottom });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const finalRight = Math.max(4, Math.min(window.innerWidth - PET_W - 4, drag.right - dx));
    const finalBottom = Math.max(4, Math.min(window.innerHeight - PET_H - 4, drag.bottom - dy));
    dragRef.current = null;
    setDragging(false);
    setPos({ right: finalRight, bottom: finalBottom });
    // Persist the new position
    api.setSetting("pet_x", String(finalRight)).catch(() => {});
    api.setSetting("pet_y", String(finalBottom)).catch(() => {});
  };

  if (!settings.pet_enabled) return null;

  const floatY = dragging ? 0 : Math.sin(floatPhase * 0.03) * 4;
  const capIcon = outfit.hatText;

  return (
    <div
      ref={petRef}
      className="fixed z-40 select-none"
      style={{ right: pos.right, bottom: pos.bottom, touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Speech bubble */}
      {bubbleText && (
        <div className="absolute bottom-[104px] right-2 pl-glass-strong rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap pl-fade-in z-10"
          style={{ animation: "pl-bounce-in 0.3s ease both", pointerEvents: "none" }}>
          {bubbleText}
        </div>
      )}

      {/* Outfit selector */}
      {showOutfits && (
        <div className="absolute bottom-[96px] right-0 pl-glass-strong rounded-xl p-2 flex flex-col gap-1 z-10"
          style={{ animation: "pl-fade-in 0.2s ease both", pointerEvents: "auto" }}>
          {OUTFITS.map((o, i) => (
            <button key={o.id} onClick={(e) => { e.stopPropagation(); setOutfitIdx(i); setShowOutfits(false); showBubble("换装完成~"); }}
              className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-all ${i === outfitIdx ? "bg-cyan-500/20 pl-text-cyan" : "hover:bg-white/5 pl-text-dim"}`}>
              {o.name}
            </button>
          ))}
        </div>
      )}

      {/* The character */}
      <div className="relative" style={{ transform: `translateY(${floatY}px)`, pointerEvents: dragging ? "none" : "auto" }} onClick={handleClick}>
        <svg width={PET_W} height={PET_H} viewBox="0 0 92 120" style={{ filter: `drop-shadow(0 4px 8px ${outfit.trim}44)` }}>
          {/* Action transforms */}
          <g style={{
            transformOrigin: "46px 62px",
            transition: "transform 0.3s ease",
            ...(action === "spin" ? { animation: "pl-maid-spin 1s linear" } : {}),
            ...(action === "bow" ? { transform: "rotateX(28deg)" } : {}),
            ...(action === "sleepy" ? { transform: "rotate(-10deg) translateY(5px)" } : {}),
          }}>
            {/* Shadow */}
            <ellipse cx="46" cy="116" rx="20" ry="3" fill="#000" opacity="0.12" />

            {/* Body / uniform */}
            <path d="M30 56 Q30 51 36 49 L56 49 Q62 51 62 56 L68 96 Q68 104 62 108 L30 108 Q24 104 24 96 Z"
              fill={outfit.uniform} stroke={outfit.trim} strokeWidth="1.2" />
            {/* Skirt */}
            <path d="M24 92 Q46 100 68 92 L66 108 Q46 114 26 108 Z" fill={outfit.skirt} stroke={outfit.trim} strokeWidth="1" opacity="0.95" />
            {/* Collar */}
            <path d="M36 49 L40 62 L46 50 L52 62 L56 49 Z" fill={outfit.collar} stroke={outfit.trim} strokeWidth="0.8" />
            {/* Buttons */}
            <circle cx="46" cy="70" r="1.6" fill={outfit.trim} />
            <circle cx="46" cy="78" r="1.6" fill={outfit.trim} />
            {/* Arms */}
            {(action === "wave" || action === "heart") ? (
              <path d={action === "wave"
                ? "M58 58 Q70 44 73 32 Q74 26 68 26 Q64 28 60 38"
                : "M32 58 Q24 48 28 42 Q34 39 37 46 M60 58 Q68 48 64 42 Q58 39 55 46"}
                fill={outfit.uniform} stroke={outfit.trim} strokeWidth="1.2" />
            ) : (
              <>
                <path d="M30 56 Q24 66 26 80" fill="none" stroke={outfit.trim} strokeWidth="5.5" strokeLinecap="round" />
                <path d="M62 56 Q68 66 66 80" fill="none" stroke={outfit.trim} strokeWidth="5.5" strokeLinecap="round" />
              </>
            )}
            {/* Hands */}
            <circle cx="26" cy="82" r="3" fill="#FFE3D0" />
            <circle cx="66" cy="82" r="3" fill="#FFE3D0" />

            {/* Head */}
            <circle cx="46" cy="32" r="17" fill="#FFE3D0" stroke="#EEC3A0" strokeWidth="0.6" />
            {/* Hair */}
            <path d="M29 30 Q27 18 35 13 Q41 10 46 12 Q51 10 57 13 Q65 18 63 30 Q63 36 61 39 L31 39 Q29 36 29 30 Z"
              fill={outfit.hair} stroke={outfit.hairDark} strokeWidth="0.8" />
            {/* Hair side locks */}
            <path d="M30 32 Q26 42 28 52 Q30 56 32 52 Q33 44 33 36 Z" fill={outfit.hairDark} />
            <path d="M62 32 Q66 42 64 52 Q62 56 60 52 Q59 44 59 36 Z" fill={outfit.hairDark} />

            {/* Red-blood-cell cap (biconcave disc) */}
            <g transform="translate(46 15)">
              <ellipse cx="0" cy="0" rx="17" ry="9" fill={outfit.cap} stroke={outfit.capDark} strokeWidth="1" />
              <ellipse cx="0" cy="0" rx="7" ry="4.5" fill={outfit.hair} opacity="0.55" />
              <text x="0" y="2.5" textAnchor="middle" fontSize="6.5" fontWeight="bold" fill={outfit.hatTextColor}>{capIcon}</text>
            </g>

            {/* Eyes */}
            {action === "wink" ? (
              <>
                <ellipse cx="40" cy="32" rx="2.4" ry="3" fill="#2B1B12" />
                <path d="M49 31 Q51 30 53 31" fill="none" stroke="#2B1B12" strokeWidth="1.6" strokeLinecap="round" />
              </>
            ) : action === "sleepy" || blink ? (
              <>
                <path d="M38 32 Q40 33 42 32" fill="none" stroke="#2B1B12" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M50 32 Q52 33 54 32" fill="none" stroke="#2B1B12" strokeWidth="1.6" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="40" cy="32" rx="2.6" ry="3.4" fill="#2B1B12" />
                <ellipse cx="52" cy="32" rx="2.6" ry="3.4" fill="#2B1B12" />
                <circle cx="40.8" cy="30.8" r="1" fill="white" />
                <circle cx="52.8" cy="30.8" r="1" fill="white" />
              </>
            )}
            {/* Blush */}
            <circle cx="36" cy="37" r="2.4" fill="#FF8FA3" opacity="0.45" />
            <circle cx="56" cy="37" r="2.4" fill="#FF8FA3" opacity="0.45" />
            {/* Mouth */}
            {action === "heart" ? (
              <path d="M43 40 Q45 43 47 40 Q49 38 47 37 Q45 36 43 37 Q41 38 43 40" fill="#FF6B9D" />
            ) : action === "sleepy" ? (
              <ellipse cx="46" cy="40" rx="1.8" ry="1.1" fill="#E88" opacity="0.5" />
            ) : (
              <path d="M43 39 Q46 42 49 39" fill="none" stroke="#C66" strokeWidth="1.2" strokeLinecap="round" />
            )}

            {/* Heart for heart action */}
            {action === "heart" && (
              <text x="68" y="22" fontSize="12" style={{ animation: "pl-float-up 1s ease-out forwards" }}>❤️</text>
            )}
            {/* Zzz for sleepy */}
            {action === "sleepy" && (
              <>
                <text x="66" y="18" fontSize="9" opacity="0.6" style={{ animation: "pl-float-up 2s ease-in-out infinite" }}>z</text>
                <text x="71" y="13" fontSize="7" opacity="0.4" style={{ animation: "pl-float-up 2s ease-in-out 0.5s infinite" }}>z</text>
              </>
            )}
          </g>
        </svg>

        {/* Outfit / dressing button */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setShowOutfits(!showOutfits); }}
          className="absolute -top-1 -left-1 w-5 h-5 rounded-full pl-glass-strong flex items-center justify-center text-xs hover:scale-110 transition-transform"
          title="换装"
          style={{ pointerEvents: "auto" }}
        >
          <span className="text-[10px]">👗</span>
        </button>
      </div>
    </div>
  );
}
