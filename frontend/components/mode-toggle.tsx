"use client";

/**
 * The single user-facing visualization switch: exactly two options, 2D or 3D
 * (SDD §0 scope decision — no other mode toggles exposed).
 */
export type ViewMode = "2d" | "3d";

const OPTIONS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "2d", label: "2D" },
  { value: "3d", label: "3D" },
];

export default function ModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Visualization mode"
      className="inline-flex rounded-lg border border-slate-700 bg-slate-900 p-1"
    >
      {OPTIONS.map((option) => {
        const active = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-sky-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
