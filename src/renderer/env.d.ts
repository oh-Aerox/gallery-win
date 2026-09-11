/// <reference types="vite/client" />
import type { GalleryApi } from '@shared/api.js'

declare global {
  interface Window {
    gallery: GalleryApi
  }
}

export {}
