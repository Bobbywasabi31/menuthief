import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The whole app ships as ONE html file (M1 demo build): Alex can open it
// straight from chat on his phone. Tiles + place data still load live from
// OpenStreetMap / Overpass at runtime.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { assetsInlineLimit: 100000000, chunkSizeWarningLimit: 2000 },
})
