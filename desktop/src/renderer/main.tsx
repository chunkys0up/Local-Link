import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/inter/wght-italic.css'
import './index.css'
import App from './App.tsx'
import { Pip } from './Pip.tsx'

// The same page serves the picture-in-picture window, at #pip.
const pip = window.location.hash === '#pip'

createRoot(document.getElementById('root')!).render(<StrictMode>{pip ? <Pip /> : <App />}</StrictMode>)
