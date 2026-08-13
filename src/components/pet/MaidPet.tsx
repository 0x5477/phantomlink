import { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";

// Character designs based on Cells at Work (工作细胞) prototypes:
// 红细胞 AE3803 / 白细胞 U-1146 / 血小板.
const OUTFITS = [
  {
    id: "rbc", name: "红细胞酱 AE3803",
    hair: "#E23B3B", hairDark: "#B5272E", ahoge: "#F04A4A",
    cap: "#E23B3B", capDark: "#B5272E", capEdge: "#8F1D24",
    uniform: "#E23B3B", shirt: "#FDF6F0", collar: "#FFFFFF", skirt: "#C32D34",
    sleeve: "#FDF6F0", boots: "#B5272E",
    eye: "#7A4A2B", eyeLight: "#3A2413",
    hatLabel: "赤", hatLabelColor: "#FFFFFF",
  },
  {
    id: "wbc", name: "白细胞君 U-1146",
    hair: "#E8ECF2", hairDark: "#B9C2CE", ahoge: "#F4F7FB",
    cap: "#FFFFFF", capDark: "#C6CFDA", capEdge: "#93A0B0",
    uniform: "#F2F5F9", shirt: "#FFFFFF", collar: "#5A6472", skirt: "#D7DEE8",
    sleeve: "#FFFFFF", boots: "#5A6472",
    eye: "#4A5568", eyeLight: "#2B3240",
    hatLabel: "白", hatLabelColor: "#5A6472",
  },
  {
    id: "plt", name: "血小板酱",
    hair: "#C9A17E", hairDark: "#A8825F", ahoge: "#D9B48F",
    cap: "#BFD9EE", capDark: "#8FB4D6", capEdge: "#6E96BE",
    uniform: "#DCEBF7", shirt: "#FFFFFF", collar: "#7FB0D8", skirt: "#BFD9EE",
    sleeve: "#FFFFFF", boots: "#8FB4D6",
    eye: "#5A7FA8", eyeLight: "#33506E",
    hatLabel: "板", hatLabelColor: "#4C7FA8",
  },
];

const ACTIONS = ["wave", "heart", "wink", "spin", "bow", "sleepy"];
const DEFAULT_RIGHT = 16;
const DEFAULT_BOTTOM = 16;
const PET_W = 96;
const PET_H = 132;

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

  // Sync position from settings when they load.
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
    api.setSetting("pet_x", String(finalRight)).catch(() => {});
    api.setSetting("pet_y", String(finalBottom)).catch(() => {});
  };

  if (!settings.pet_enabled) return null;

  const floatY = dragging ? 0 : Math.sin(floatPhase * 0.03) * 4;
  const o = outfit;

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
        <div className="absolute bottom-[116px] right-2 pl-glass-strong rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap pl-fade-in z-10"
          style={{ animation: "pl-bounce-in 0.3s ease both", pointerEvents: "none" }}>
          {bubbleText}
        </div>
      )}

      {/* Outfit selector */}
      {showOutfits && (
        <div className="absolute bottom-[106px] right-0 pl-glass-strong rounded-xl p-2 flex flex-col gap-1 z-10"
          style={{ animation: "pl-fade-in 0.2s ease both", pointerEvents: "auto" }}>
          {OUTFITS.map((out, i) => (
            <button key={out.id} onClick={(e) => { e.stopPropagation(); setOutfitIdx(i); setShowOutfits(false); showBubble("换装完成~"); }}
              className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-all ${i === outfitIdx ? "bg-cyan-500/20 pl-text-cyan" : "hover:bg-white/5 pl-text-dim"}`}>
              {out.name}
            </button>
          ))}
        </div>
      )}

      {/* The character (Cells at Work style) */}
      <div className="relative" style={{ transform: `translateY(${floatY}px)`, pointerEvents: dragging ? "none" : "auto" }} onClick={handleClick}>
        <svg width={PET_W} height={PET_H} viewBox="0 0 100 138" style={{ filter: `drop-shadow(0 4px 10px ${o.uniform}55)` }}>
          <g style={{
            transformOrigin: "50px 70px",
            transition: "transform 0.3s ease",
            ...(action === "spin" ? { animation: "pl-maid-spin 1s linear" } : {}),
            ...(action === "bow" ? { transform: "rotateX(28deg)" } : {}),
            ...(action === "sleepy" ? { transform: "rotate(-10deg) translateY(5px)" } : {}),
          }}>
            {/* Ground shadow */}
            <ellipse cx="50" cy="134" rx="24" ry="3.5" fill="#000" opacity="0.13" />

            {/* ===== Body: red work uniform (红细胞制服) ===== */}
            {/* Skirt */}
            <path d="M28 100 Q50 110 72 100 L70 120 Q50 128 30 120 Z" fill={o.skirt} stroke={o.uniform} strokeWidth="1" />
            {/* Torso / outer coat */}
            <path d="M32 58 Q32 53 38 51 L62 51 Q68 53 68 58 L73 100 Q73 104 68 106 L32 106 Q27 104 27 100 Z"
              fill={o.uniform} stroke={o.capDark} strokeWidth="1.2" />
            {/* White shirt V-neck */}
            <path d="M38 51 L43 64 L50 53 L57 64 L62 51 Q50 47 38 51 Z" fill={o.shirt} stroke={o.capDark} strokeWidth="0.7" />
            {/* Collar / tie */}
            <path d="M50 53 L46 66 L50 70 L54 66 Z" fill={o.collar} stroke={o.capDark} strokeWidth="0.6" />
            {/* Buttons */}
            <circle cx="50" cy="78" r="1.7" fill={o.shirt} stroke={o.capDark} strokeWidth="0.6" />
            <circle cx="50" cy="86" r="1.7" fill={o.shirt} stroke={o.capDark} strokeWidth="0.6" />

            {/* Arms with white sleeves */}
            {(action === "wave" || action === "heart") ? (
              <path d={action === "wave"
                ? "M66 60 Q78 44 82 30 Q83 24 77 24 Q72 26 68 38"
                : "M34 60 Q24 48 28 41 Q35 38 39 46 M66 60 Q76 48 72 41 Q65 38 61 46"}
                fill={o.uniform} stroke={o.capDark} strokeWidth="1.2" />
            ) : (
              <>
                <path d="M32 58 Q24 70 27 86" fill="none" stroke={o.uniform} strokeWidth="7" strokeLinecap="round" />
                <path d="M68 58 Q76 70 73 86" fill="none" stroke={o.uniform} strokeWidth="7" strokeLinecap="round" />
                <path d="M32 58 Q24 70 27 86" fill="none" stroke={o.sleeve} strokeWidth="4" strokeLinecap="round" strokeDasharray="0.1 4" />
                <path d="M68 58 Q76 70 73 86" fill="none" stroke={o.sleeve} strokeWidth="4" strokeLinecap="round" strokeDasharray="0.1 4" />
              </>
            )}
            {/* Hands */}
            <circle cx="27" cy="88" r="3.4" fill="#FFE3D0" />
            <circle cx="73" cy="88" r="3.4" fill="#FFE3D0" />

            {/* Boots */}
            <path d="M34 120 Q34 126 39 127 L43 127 Q46 124 45 120 Z" fill={o.boots} />
            <path d="M55 120 Q54 124 57 127 L61 127 Q66 126 66 120 Z" fill={o.boots} />

            {/* ===== Head ===== */}
            <circle cx="50" cy="36" r="19" fill="#FFE3D0" stroke="#EEC3A0" strokeWidth="0.7" />

            {/* Red short hair */}
            <path d="M31 34 Q29 19 38 13 Q44 9 50 11 Q56 9 62 13 Q71 19 69 34 Q69 40 67 44 L33 44 Q31 40 31 34 Z"
              fill={o.hair} stroke={o.hairDark} strokeWidth="0.9" />
            {/* Side locks */}
            <path d="M32 36 Q27 48 30 60 Q32 65 35 60 Q37 50 36 40 Z" fill={o.hairDark} />
            <path d="M68 36 Q73 48 70 60 Q68 65 65 60 Q63 50 64 40 Z" fill={o.hairDark} />
            {/* Ahoge (呆毛) */}
            <path d="M50 12 Q54 4 63 3 Q66 3 64 6 Q58 8 55 13 Z" fill={o.ahoge} />

            {/* Red blood cell work cap (biconcave disc) */}
            <g transform="translate(50 18) rotate(-6)">
              {/* disc body */}
              <ellipse cx="0" cy="0" rx="20" ry="10.5" fill={o.cap} stroke={o.capEdge} strokeWidth="1.3" />
              {/* concave dimple */}
              <ellipse cx="0" cy="0" rx="9" ry="5" fill={o.capDark} opacity="0.55" />
              <ellipse cx="0" cy="-1.5" rx="7" ry="3.4" fill={o.hair} opacity="0.5" />
              {/* highlight */}
              <ellipse cx="-9" cy="-5" rx="5" ry="2.4" fill="#FFFFFF" opacity="0.5" />
              {/* label */}
              <text x="0" y="2.6" textAnchor="middle" fontSize="7" fontWeight="bold" fill={o.hatLabelColor}>{o.hatLabel}</text>
            </g>

            {/* ===== Face ===== */}
            {/* Eyes (large anime style) */}
            {action === "wink" ? (
              <>
                <ellipse cx="42" cy="37" rx="3.2" ry="4" fill={o.eyeLight} />
                <path d="M54 35 Q56.5 33.5 59 35" fill="none" stroke={o.eyeLight} strokeWidth="1.8" strokeLinecap="round" />
              </>
            ) : action === "sleepy" || blink ? (
              <>
                <path d="M39 37 Q42 38.5 45 37" fill="none" stroke={o.eyeLight} strokeWidth="1.8" strokeLinecap="round" />
                <path d="M55 37 Q58 38.5 61 37" fill="none" stroke={o.eyeLight} strokeWidth="1.8" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="42" cy="37" rx="3.6" ry="4.6" fill={o.eye} />
                <ellipse cx="58" cy="37" rx="3.6" ry="4.6" fill={o.eye} />
                <circle cx="43" cy="35" r="1.5" fill="#FFFFFF" />
                <circle cx="59" cy="35" r="1.5" fill="#FFFFFF" />
                <circle cx="41" cy="38.5" r="0.8" fill="#FFFFFF" opacity="0.8" />
                <circle cx="57" cy="38.5" r="0.8" fill="#FFFFFF" opacity="0.8" />
                <path d="M45 42 Q50 44 55 42" fill="none" stroke={o.eyeLight} strokeWidth="1" opacity="0.35" />
              </>
            )}
            {/* Blush */}
            <circle cx="37" cy="43" r="3" fill="#FF8FA3" opacity="0.5" />
            <circle cx="63" cy="43" r="3" fill="#FF8FA3" opacity="0.5" />
            {/* Mouth */}
            {action === "heart" ? (
              <path d="M47 47 Q50 51 53 47 Q55.5 44 53 43 Q50 41.5 47 43 Q44.5 44 47 47" fill="#FF6B9D" />
            ) : action === "sleepy" ? (
              <ellipse cx="50" cy="47" rx="2.2" ry="1.3" fill="#E88" opacity="0.5" />
            ) : (
              <path d="M46 46 Q50 50 54 46" fill="none" stroke="#C66" strokeWidth="1.3" strokeLinecap="round" />
            )}

            {/* Heart for heart action */}
            {action === "heart" && (
              <text x="74" y="24" fontSize="13" style={{ animation: "pl-float-up 1s ease-out forwards" }}>❤️</text>
            )}
            {/* Zzz for sleepy */}
            {action === "sleepy" && (
              <>
                <text x="72" y="20" fontSize="10" opacity="0.6" style={{ animation: "pl-float-up 2s ease-in-out infinite" }}>z</text>
                <text x="78" y="14" fontSize="7" opacity="0.4" style={{ animation: "pl-float-up 2s ease-in-out 0.5s infinite" }}>z</text>
              </>
            )}
          </g>
        </svg>

        {/* Dressing button */}
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
