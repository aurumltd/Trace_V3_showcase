import React, { createContext, useContext, useCallback, useState, useRef, useEffect } from 'react';

/* ---------- types ---------- */

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

/* ---------- context ---------- */

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

/* ---------- config ---------- */

const AUTO_DISMISS_MS = 3000;

const typeConfig: Record<ToastType, { color: string; icon: JSX.Element }> = {
  success: {
    color: 'var(--color-success)',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="9" r="8" opacity="0.3" />
        <path d="M6 9.5l2 2 4-4.5" />
      </svg>
    ),
  },
  error: {
    color: '#ef4444',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="9" cy="9" r="8" opacity="0.3" />
        <path d="M6.5 6.5l5 5M11.5 6.5l-5 5" />
      </svg>
    ),
  },
  info: {
    color: '#3b82f6',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="9" cy="9" r="8" opacity="0.3" />
        <path d="M9 8v4M9 6v.01" />
      </svg>
    ),
  },
  warning: {
    color: '#f59e0b',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 2l7.5 13H1.5L9 2z" opacity="0.3" />
        <path d="M9 7.5v3M9 13v.01" />
      </svg>
    ),
  },
};

/* ---------- provider ---------- */

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `toast-${++counter}`;
    setToasts((prev) => [...prev, { id, type, message, createdAt: Date.now() }]);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* toast container */}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm w-full pointer-events-none"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- single toast ---------- */

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const cfg = typeConfig[item.type];
  const [progress, setProgress] = useState(100);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const start = Date.now();
    const tick = () => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / AUTO_DISMISS_MS) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        onDismiss(item.id);
      } else {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [item.id, onDismiss]);

  return (
    <div
      className={[
        'pointer-events-auto relative overflow-hidden',
        'bg-[var(--color-bg-surface-1)] rounded-xl shadow-xl',
        'border border-[var(--color-border-subtle)]/40',
        'animate-[slideInRight_250ms_ease-out]',
      ].join(' ')}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Icon */}
        <span className="flex-shrink-0 mt-0.5" style={{ color: cfg.color }}>
          {cfg.icon}
        </span>

        {/* Message */}
        <p className="flex-1 text-sm text-[var(--color-text-primary)] leading-snug">
          {item.message}
        </p>

        {/* Close */}
        <button
          onClick={() => onDismiss(item.id)}
          className="flex-shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors duration-150 cursor-pointer"
          aria-label="Dismiss"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-transparent">
        <div
          className="h-full transition-none"
          style={{
            width: `${progress}%`,
            backgroundColor: cfg.color,
            opacity: 0.6,
          }}
        />
      </div>

      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(100%); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
