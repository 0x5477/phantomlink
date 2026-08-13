import { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import corgiUrl from "../../assets/pet/corgi/spritesheet.webp";
import catUrl from "../../assets/pet/cat/spritesheet.webp";
import rabbitUrl from "../../assets/pet/rabbit/spritesheet.webp";

// Community-made Codex pet spritesheets (8x9 grid), source:
// https://github.com/Luyu2026/Codex-Pet-Skill (MIT code; pet assets generated
// with the codex-pet-maker workflow, non-commercial usage per upstream README).
const PETS = [
  { id: "corgi", name: "柯基", url: corgiUrl },
  { id: "cat", name: "橘猫", url: catUrl },
  { id: "rabbit", name: "小兔", url: rabbitUrl },
];

const FRAME_W = 192;
const FRAME_H = 208;
const COLS = 8;
// Row contract: 0 idle, 1 right, 2 left, 3 greet, 4 happy, 5 error, 6 progress, 7 front, 8 coding
const ACTION_ROWS = [3, 4, 5, 8];

const DEFAULT_RIGHT = 16;
const DEFAULT_BOTTOM = 16;
const SCALE = 0.52;
const VIEW_W = Math.round(FRAME_W * SCALE);
const VIEW_H = Math.round(FRAME_H * SCALE);

export default function MaidPet() {
  const settings = useStore((s) => s.settings);
  const [petIdx, setPetIdx] = useState(0);
  const [frame, setFrame] = useState(0);
  const [actionRow, setActionRow] = useState(0);
  const [actionUntil, setActionUntil] = useState(0);
  const [showPets, setShowPets] = useState(false);
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({
    right: settings.pet_x > 0 ? settings.pet_x : DEFAULT_RIGHT,
    bottom: settings.pet_y > 0 ? settings.pet_y : DEFAULT_BOTTOM,
  });
  const [dragging, setDragging] = useState(false);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; right: number; bottom: number } | null>(null);
  const petRef = useRef<HTMLDivElement | null>(null);

  const pet = PETS[petIdx];

  // Sync position from settings.
  useEffect(() => {
    if (settings.pet_x > 0 || settings.pet_y > 0) {
      setPos({
        right: settings.pet_x > 0 ? settings.pet_x : DEFAULT_RIGHT,
        bottom: settings.pet_y > 0 ? settings.pet_y : DEFAULT_BOTTOM,
      });
    }
  }, [settings.pet_x, settings.pet_y]);

  // Frame animation: 8 frames per row; idle loops forever, actions play one loop.
  useEffect(() => {
    if (dragging) return;
    const interval = setInterval(() => {
      setFrame((f) => {
        const now = Date.now();
        if (now < actionUntil) {
          // playing an action: one full loop then back to idle
          if (f >= COLS - 1) {
            setActionRow(0);
            setActionUntil(0);
            return 0;
          }
          return f + 1;
        }
        return (f + 1) % COLS;
      });
    }, 70);
    return () => clearInterval(interval);
  }, [dragging, actionUntil]);

  // Random idle speech
  useEffect(() => {
    const idleTimer = setInterval(() => {
      if (!bubbleText && !dragging && Math.random() > 0.75) {
        const phrases = ["主人好~", "嘿嘿~", "今天也要加油呢", "喵~", "加油鸭~"];
        setBubbleText(phrases[Math.floor(Math.random() * phrases.length)]);
        setTimeout(() => setBubbleText(null), 2500);
      }
    }, 8000);
    return () => clearInterval(idleTimer);
  }, [bubbleText, dragging]);

  const showBubble = useCallback((text: string, ms = 2500) => {
    setBubbleText(text);
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => setBubbleText(null), ms);
  }, []);

  const handleClick = () => {
    if (dragging) return;
    const phrases: Record<number, string> = { 3: "主人你好呀~", 4: "好开心~", 5: "咦？", 8: "陪你写代码~" };
    const row = ACTION_ROWS[Math.floor(Math.random() * ACTION_ROWS.length)];
    setActionRow(row);
    setFrame(0);
    setActionUntil(Date.now() + COLS * 70);
    showBubble(phrases[row] || "喵~");
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
    const nextRight = Math.max(4, Math.min(window.innerWidth - VIEW_W - 4, drag.right - dx));
    const nextBottom = Math.max(4, Math.min(window.innerHeight - VIEW_H - 4, drag.bottom - dy));
    setPos({ right: nextRight, bottom: nextBottom });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const finalRight = Math.max(4, Math.min(window.innerWidth - VIEW_W - 4, drag.right - dx));
    const finalBottom = Math.max(4, Math.min(window.innerHeight - VIEW_H - 4, drag.bottom - dy));
    dragRef.current = null;
    setDragging(false);
    setPos({ right: finalRight, bottom: finalBottom });
    api.setSetting("pet_x", String(finalRight)).catch(() => {});
    api.setSetting("pet_y", String(finalBottom)).catch(() => {});
  };

  if (!settings.pet_enabled) return null;

  const bgX = -frame * VIEW_W;
  const bgY = -actionRow * VIEW_H;

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

      {/* Pet selector */}
      {showPets && (
        <div className="absolute bottom-[108px] right-0 pl-glass-strong rounded-xl p-2 flex flex-col gap-1 z-10"
          style={{ animation: "pl-fade-in 0.2s ease both", pointerEvents: "auto" }}>
          {PETS.map((p, i) => (
            <button key={p.id} onClick={(e) => { e.stopPropagation(); setPetIdx(i); setShowPets(false); showBubble("换好啦~"); }}
              className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-all ${i === petIdx ? "bg-cyan-500/20 pl-text-cyan" : "hover:bg-white/5 pl-text-dim"}`}>
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Animated sprite */}
      <div className="relative" style={{ pointerEvents: dragging ? "none" : "auto" }} onClick={handleClick}>
        <div
          style={{
            width: VIEW_W,
            height: VIEW_H,
            backgroundImage: `url(${pet.url})`,
            backgroundSize: `${FRAME_W * COLS * SCALE}px ${FRAME_H * 9 * SCALE}px`,
            backgroundPosition: `${bgX}px ${bgY}px`,
            backgroundRepeat: "no-repeat",
          }}
        />
        {/* Pet selector button */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setShowPets(!showPets); }}
          className="absolute -top-1 -left-1 w-5 h-5 rounded-full pl-glass-strong flex items-center justify-center text-xs hover:scale-110 transition-transform"
          title="切换宠物"
          style={{ pointerEvents: "auto" }}
        >
          <span className="text-[10px]">🎀</span>
        </button>
      </div>
    </div>
  );
}
