import '@testing-library/jest-dom/vitest';

class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this);
  }

  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: ImmediateIntersectionObserver,
});
Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  value: ImmediateIntersectionObserver,
});
