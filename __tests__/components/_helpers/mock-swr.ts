import { vi } from "vitest";
import type { SWRResponse } from "swr";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySWRResponse = SWRResponse<any, any>;

export function mockSWR<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  partial: Partial<SWRResponse<T, any>>,
): AnySWRResponse {
  return {
    mutate: vi.fn(),
    isLoading: false,
    error: undefined,
    isValidating: false,
    ...partial,
  } as unknown as AnySWRResponse;
}
