import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// React 19.2's DEVELOPMENT build records every component render on the browser's Performance
// timeline (performance.measure), attaching a diff of the props that changed. The browser keeps
// those entries until something clears them, and props holding tens of thousands of cells make
// each render megabytes: painting in Projector Demo Draw mode grew the tab by ~7 MB per brush
// event (1.5 GB in 15 s) until it ran out of memory. Nothing in this app reads the timeline, so in
// development measures are cleared as soon as they arrive. Chrome's Performance panel records
// React's tracks through tracing, not this buffer, so profiling still works. Production builds
// do not record them at all.
if (import.meta.env.DEV && typeof PerformanceObserver !== 'undefined' && performance.clearMeasures) {
  try {
    new PerformanceObserver(() => performance.clearMeasures()).observe({ entryTypes: ['measure'] })
  } catch {
    // No PerformanceObserver support for 'measure': nothing is recorded to clear either.
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
