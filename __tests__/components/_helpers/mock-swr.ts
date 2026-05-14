import { vi } from 'vitest'
import type { SWRResponse } from 'swr'

 
type AnySWRResponse = SWRResponse<any, any>

export function mockSWR<T>(
   
  partial: Partial<SWRResponse<T, any>>
): AnySWRResponse {
  return {
    mutate: vi.fn(),
    isLoading: false,
    error: undefined,
    isValidating: false,
    ...partial,
  } as unknown as AnySWRResponse
}
