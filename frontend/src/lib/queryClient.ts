import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/client'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 4xx are contract or state problems — retrying them just delays the error
      // the user needs to see. Retry once for anything else (5xx, network).
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 1
      },
    },
    mutations: { retry: false },
  },
})
