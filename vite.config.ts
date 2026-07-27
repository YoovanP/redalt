import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteRedditProxy } from './viteRedditProxy';

export default defineConfig({
  plugins: [react(), viteRedditProxy()],
});
