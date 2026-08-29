export const FOUNDATION_VERSION = '0.1' as const;

export function getFoundationStatus() {
  return {
    version: FOUNDATION_VERSION,
    runtimeImplemented: false,
  } as const;
}
