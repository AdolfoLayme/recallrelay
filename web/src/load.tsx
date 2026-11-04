import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api } from "./api.ts";

type Load<T> = { value?: T; error?: string; loading: boolean };

export function useLoad<T>(path: string | undefined): [Load<T>, () => void] {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Load<T>>({ loading: true });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ loading: true });
    api<T>(path)
      .then((result) => {
        if (live) setState({ value: result.data, loading: false });
      })
      .catch((error) => {
        if (live) {
          setState({ error: error instanceof Error ? error.message : "Request failed", loading: false });
        }
      });
    return () => {
      live = false;
    };
  }, [path, tick]);
  return [state, () => setTick((value) => value + 1)];
}

export function Result<T>({ state, retry, children, empty = "Nothing to show yet." }: {
  state: Load<T>;
  retry: () => void;
  children: (value: T) => React.ReactNode;
  empty?: string;
}) {
  if (state.loading) {
    return (
      <div aria-label="Loading" className="skeleton-stack">
        <div />
        <div />
        <div />
        <div />
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="state-message" role="alert">
        <strong>Could not load this page.</strong>
        <p>{state.error}</p>
        <button className="secondary" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!state.value || (Array.isArray(state.value) && !state.value.length)) {
    return <div className="state-message">{empty}</div>;
  }
  return <>{children(state.value)}</>;
}

export function ErrorLine({ text }: { text: string }) {
  return text ? <p className="error-line" role="alert">{text}</p> : null;
}

export function BusyButton(
  { busy, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean },
) {
  return (
    <button {...props} disabled={busy || props.disabled}>
      {busy && <LoaderCircle size={16} className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
