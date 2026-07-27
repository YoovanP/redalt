import { useEffect, useRef, useState } from 'react';

export function useNearViewport(enabled = true, rootMargin = '600px 0px') {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isNear, setIsNear] = useState(true);

  useEffect(() => {
    const target = ref.current;

    if (!enabled || !target) {
      setIsNear(enabled);
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setIsNear(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsNear(entry.isIntersecting),
      { rootMargin, threshold: 0.01 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return { ref, isNear };
}
