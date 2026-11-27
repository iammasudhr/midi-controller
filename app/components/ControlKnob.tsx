import React, { useState, useRef } from "react";

interface ControlKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  onChange: (value: number) => void;
  unit?: string;
  formatValue?: (val: number) => string;
}

const ControlKnob: React.FC<ControlKnobProps> = ({
  label,
  value,
  min,
  max,
  defaultValue,
  onChange,
  unit = "",
  formatValue,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const knobRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startValueRef = useRef(0);

  const clamped = Math.min(max, Math.max(min, value));
  const clampedRef = useRef(clamped);
  clampedRef.current = clamped;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  React.useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = (max - min) / 40;
      const direction = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(max, Math.max(min, clampedRef.current + direction * step));
      onChangeRef.current(next);
    };
    el.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => el.removeEventListener("wheel", onNativeWheel);
  }, [min, max]);
  const normalized = (clamped - min) / (max - min || 1);
  const rotation = normalized * 270 - 135; // -135deg to +135deg

  // SVG arc gauge calculations (270-degree sweep)
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * 0.75; // 270 deg
  const activeArc = arcLength * normalized;

  const displayText = formatValue
    ? formatValue(clamped)
    : max <= 1
      ? `${Math.round(clamped * 100)}${unit || "%"}`
      : max >= 1000
        ? `${Math.round(clamped)}${unit}`
        : `${clamped.toFixed(2)}${unit}`;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValueRef.current = clamped;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const deltaY = startYRef.current - e.clientY;
    const sensitivity = (max - min) / 140;
    const next = Math.min(max, Math.max(min, startValueRef.current + deltaY * sensitivity));
    onChange(next);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = (max - min) / 25;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      onChange(Math.min(max, clamped + step));
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      onChange(Math.max(min, clamped - step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(max);
    }
  };

  const handleDoubleClick = () => {
    if (defaultValue !== undefined) {
      onChange(defaultValue);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/80 bg-muted/40 p-3.5 transition-colors hover:border-primary/40">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </span>

      <div
        ref={knobRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(clamped.toFixed(2))}
        aria-valuetext={displayText}
        title="Drag vertically, scroll, or double-click to reset"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        onDoubleClick={handleDoubleClick}
        className="relative flex size-[78px] cursor-ns-resize items-center justify-center rounded-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* Radial Progress Track */}
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox="0 0 80 80"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`knob-grad-${label}`} x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#dc2626" />
              <stop offset="55%" stopColor="#ea580c" />
              <stop offset="100%" stopColor="#f97316" />
            </linearGradient>
          </defs>
          <circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
            transform="rotate(135 40 40)"
            className="text-border"
          />
          <circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke={`url(#knob-grad-${label})`}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${activeArc} ${circumference}`}
            transform="rotate(135 40 40)"
          />
        </svg>

        {/* Physical 3D Knob Cap */}
        <div
          className={`relative size-[52px] rounded-full border transition-shadow duration-150 ${
            isDragging
              ? "border-primary shadow-[0_0_0_4px_rgba(234,88,12,0.22),0_6px_14px_rgba(0,0,0,0.35)]"
              : "border-black/15 shadow-[inset_0_2px_3px_rgba(255,255,255,0.45),0_4px_10px_rgba(0,0,0,0.24)] dark:border-white/15"
          } bg-gradient-to-br from-[#ffffff] via-[#efe7e2] to-[#d6cbc4] dark:from-[#362d29] dark:via-[#231d1a] dark:to-[#130f0e]`}
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          {/* Red-Orange LED Indicator Notch */}
          <span className="absolute top-1.5 left-1/2 h-4 w-1.5 -translate-x-1/2 rounded-full bg-gradient-to-b from-[#dc2626] to-[#f97316] shadow-[0_0_8px_rgba(234,88,12,0.75)]" />
        </div>
      </div>

      <span className="rounded-md bg-background/90 px-2.5 py-0.5 font-mono text-xs font-semibold text-foreground shadow-xs ring-1 ring-border">
        {displayText}
      </span>
    </div>
  );
};

export default ControlKnob;
