"use client";

import { useRef, useState } from "react";

type Props = {
  accept?: string;
  disabled?: boolean;
  label: string;
  hint?: string;
  selectedFileName?: string;
  onFileSelect: (file: File | null) => void;
  className?: string;
};

function CloudUploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M7 19h9a4 4 0 0 0 1-7.88A6 6 0 0 0 5.5 9.5 3.5 3.5 0 0 0 7 19Z" />
      <path d="M12 14V8m0 0-2.5 2.5M12 8l2.5 2.5" />
    </svg>
  );
}

export default function FileDropzone({
  accept,
  disabled,
  label,
  hint,
  selectedFileName,
  onFileSelect,
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const pickFile = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const onDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (disabled) return;
    onFileSelect(event.dataTransfer.files?.[0] ?? null);
  };

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          onFileSelect(event.target.files?.[0] ?? null);
          event.currentTarget.value = "";
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={pickFile}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragActive(false);
        }}
        onDrop={onDrop}
        disabled={disabled}
        className={`w-full rounded-xl border-2 border-dashed px-3 py-3 text-left transition ${
          dragActive
            ? "border-[var(--md-primary)] bg-[var(--md-primary-container)]"
            : "border-slate-300 bg-slate-50 hover:border-[var(--md-primary)] hover:bg-white"
        } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
      >
        <span className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <CloudUploadIcon />
          {label}
        </span>
        <span className="block text-xs text-slate-500">
          {selectedFileName ? `Selected: ${selectedFileName}` : hint || "Drag & drop, or click to browse"}
        </span>
      </button>
    </div>
  );
}
