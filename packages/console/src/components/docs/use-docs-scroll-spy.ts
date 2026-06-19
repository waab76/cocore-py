"use client";

import { useEffect, useState } from "react";

function activeIdFromHash(ids: ReadonlyArray<string>): string | null {
  if (globalThis.window === undefined) return null;
  const hash = globalThis.location.hash.slice(1);
  return hash.length > 0 && ids.includes(hash) ? hash : null;
}

export function useDocsScrollSpy(ids: ReadonlyArray<string>): string | null {
  const [active, setActive] = useState<string | null>(
    () => activeIdFromHash(ids) ?? ids[0] ?? null,
  );
  const idsKey = ids.join("\0");

  useEffect(() => {
    if (globalThis.window === undefined || ids.length === 0) return;

    let observer: IntersectionObserver | undefined;
    let cancelled = false;
    let attempts = 0;

    const setup = () => {
      if (cancelled) return;

      const observed = ids
        .map((id) => document.querySelector(`#${CSS.escape(id)}`))
        .filter((el): el is HTMLElement => el != null);

      if (observed.length === 0) {
        if (attempts < 30) {
          attempts += 1;
          requestAnimationFrame(setup);
        }
        return;
      }

      const hashActive = activeIdFromHash(ids);
      if (hashActive) {
        setActive(hashActive);
      }

      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .toSorted((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible.length === 0) return;
          const next = visible[0]?.target.id ?? null;
          setActive((current) => (current === next ? current : next));
        },
        { rootMargin: "-12% 0px -70% 0px", threshold: 0 },
      );

      for (const element of observed) {
        observer.observe(element);
      }
    };

    const onHashChange = () => {
      const hashActive = activeIdFromHash(ids);
      if (hashActive) setActive(hashActive);
    };

    setup();
    globalThis.addEventListener("hashchange", onHashChange);

    return () => {
      cancelled = true;
      observer?.disconnect();
      globalThis.removeEventListener("hashchange", onHashChange);
    };
  }, [ids, idsKey]);

  return active;
}
