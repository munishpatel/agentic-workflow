import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { queryClient } from '@/lib/queryClient'
import App from './App'
import './index.css'

/**
 * MSW runs the whole API in the browser when VITE_USE_MOCKS=true, which is what
 * makes this app demoable with no backend. The worker must be ready before the
 * first render, or the initial queries race it and fall through to the network.
 */
async function startMocks() {
  if (import.meta.env.VITE_USE_MOCKS !== 'true') return
  const { worker } = await import('./mocks/browser')
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

void startMocks().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <TooltipProvider delayDuration={200}>
            <App />
            <Toaster position="bottom-right" richColors closeButton />
          </TooltipProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
})
