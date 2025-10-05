// vite.config.ts
import { defineConfig } from "file:///home/alex/projects/terraphim/atomic-server/browser/node_modules/.pnpm/vite@5.4.10_@types+node@20.17.0_terser@5.43.1/node_modules/vite/dist/node/index.js";
import react from "file:///home/alex/projects/terraphim/atomic-server/browser/node_modules/.pnpm/@vitejs+plugin-react@4.3.4_vite@5.4.10_@types+node@20.17.0_terser@5.43.1_/node_modules/@vitejs/plugin-react/dist/index.mjs";
import { VitePWA } from "file:///home/alex/projects/terraphim/atomic-server/browser/node_modules/.pnpm/vite-plugin-pwa@0.20.5_vite@5.4.10_@types+node@20.17.0_terser@5.43.1__workbox-build@7.1_ff288cd84d864414228a38d2d7a5c30c/node_modules/vite-plugin-pwa/dist/index.js";
import webfontDownload from "file:///home/alex/projects/terraphim/atomic-server/browser/node_modules/.pnpm/vite-plugin-webfont-dl@3.9.5_vite@5.4.10_@types+node@20.17.0_terser@5.43.1_/node_modules/vite-plugin-webfont-dl/dist/index.mjs";
import prismjs from "file:///home/alex/projects/terraphim/atomic-server/browser/node_modules/.pnpm/vite-plugin-prismjs@0.0.11_prismjs@1.29.0/node_modules/vite-plugin-prismjs/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [
    webfontDownload(),
    react({
      babel: {
        plugins: [
          [
            "babel-plugin-react-compiler",
            {
              logger: {
                logEvent(filename, event) {
                  if (event.kind === "CompileError") {
                    console.error(`
Compilation failed: ${filename}`);
                    console.error(`Reason: ${event.detail.reason}`);
                    if (event.detail.description) {
                      console.error(`Details: ${event.detail.description}`);
                    }
                    if (event.detail.loc) {
                      const { line, column } = event.detail.loc.start;
                      console.error(`Location: Line ${line}, Column ${column}`);
                    }
                    if (event.detail.suggestions) {
                      console.error("Suggestions:", event.detail.suggestions);
                    }
                  }
                }
              }
            }
          ],
          "babel-plugin-styled-components"
        ]
      }
    }),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "Atomic Data Browser",
        short_name: "Atomic",
        description: "The easiest way to create, share and model Linked Atomic Data.",
        theme_color: "#ffffff",
        icons: [
          {
            src: "app_data/images/android-chrome-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "app_data/images/android-chrome-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "app_data/images/maskable_icon.png",
            sizes: "1024x1024",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "app_data/images/maskable_icon_x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "app_data/images/maskable_icon_x384.png",
            sizes: "384x384",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "app_data/images/maskable_icon_x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "app_data/images/maskable_icon_x128.png",
            sizes: "128x128",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        // See https://github.com/atomicdata-dev/atomic-data-browser/issues/294
        globIgnores: ["**/index.html"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
                // <== 365 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https?:\/\/.*\.(?:png|jpg|jpeg|gif|bmp|svg|webp|ico)/i,
            handler: "CacheFirst",
            options: {
              cacheName: "images-cache",
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30
                // <== 30 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gstatic-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
                // <== 365 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    }),
    prismjs({
      languages: ["typescript"],
      css: true,
      theme: "default"
    })
  ],
  optimizeDeps: {
    // this may help when linking + HMR is not working
    // exclude: ['@tomic/lib', '@tomic/react'],
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/chunk_[name]-[hash].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
  server: {
    strictPort: true,
    host: true,
    hmr: {
      // Fixes an issue with HMR
      port: 5174
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9hbGV4L3Byb2plY3RzL3RlcnJhcGhpbS9hdG9taWMtc2VydmVyL2Jyb3dzZXIvZGF0YS1icm93c2VyXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvaG9tZS9hbGV4L3Byb2plY3RzL3RlcnJhcGhpbS9hdG9taWMtc2VydmVyL2Jyb3dzZXIvZGF0YS1icm93c2VyL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9ob21lL2FsZXgvcHJvamVjdHMvdGVycmFwaGltL2F0b21pYy1zZXJ2ZXIvYnJvd3Nlci9kYXRhLWJyb3dzZXIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJztcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCc7XG5pbXBvcnQgeyBWaXRlUFdBIH0gZnJvbSAndml0ZS1wbHVnaW4tcHdhJztcbmltcG9ydCB3ZWJmb250RG93bmxvYWQgZnJvbSAndml0ZS1wbHVnaW4td2ViZm9udC1kbCc7XG5pbXBvcnQgcHJpc21qcyBmcm9tICd2aXRlLXBsdWdpbi1wcmlzbWpzJztcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICB3ZWJmb250RG93bmxvYWQoKSxcbiAgICByZWFjdCh7XG4gICAgICBiYWJlbDoge1xuICAgICAgICBwbHVnaW5zOiBbXG4gICAgICAgICAgW1xuICAgICAgICAgICAgJ2JhYmVsLXBsdWdpbi1yZWFjdC1jb21waWxlcicsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGxvZ2dlcjoge1xuICAgICAgICAgICAgICAgIGxvZ0V2ZW50KGZpbGVuYW1lLCBldmVudCkge1xuICAgICAgICAgICAgICAgICAgaWYgKGV2ZW50LmtpbmQgPT09ICdDb21waWxlRXJyb3InKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFxcbkNvbXBpbGF0aW9uIGZhaWxlZDogJHtmaWxlbmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgUmVhc29uOiAke2V2ZW50LmRldGFpbC5yZWFzb259YCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV2ZW50LmRldGFpbC5kZXNjcmlwdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYERldGFpbHM6ICR7ZXZlbnQuZGV0YWlsLmRlc2NyaXB0aW9ufWApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV2ZW50LmRldGFpbC5sb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgICBjb25zdCB7IGxpbmUsIGNvbHVtbiB9ID0gZXZlbnQuZGV0YWlsLmxvYy5zdGFydDtcbiAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBMb2NhdGlvbjogTGluZSAke2xpbmV9LCBDb2x1bW4gJHtjb2x1bW59YCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXZlbnQuZGV0YWlsLnN1Z2dlc3Rpb25zKSB7XG4gICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcignU3VnZ2VzdGlvbnM6JywgZXZlbnQuZGV0YWlsLnN1Z2dlc3Rpb25zKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgICAgJ2JhYmVsLXBsdWdpbi1zdHlsZWQtY29tcG9uZW50cycsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pLFxuICAgIFZpdGVQV0Eoe1xuICAgICAgcmVnaXN0ZXJUeXBlOiAnYXV0b1VwZGF0ZScsXG4gICAgICBpbmplY3RSZWdpc3RlcjogJ2F1dG8nLFxuICAgICAgbWFuaWZlc3Q6IHtcbiAgICAgICAgbmFtZTogJ0F0b21pYyBEYXRhIEJyb3dzZXInLFxuICAgICAgICBzaG9ydF9uYW1lOiAnQXRvbWljJyxcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ1RoZSBlYXNpZXN0IHdheSB0byBjcmVhdGUsIHNoYXJlIGFuZCBtb2RlbCBMaW5rZWQgQXRvbWljIERhdGEuJyxcbiAgICAgICAgdGhlbWVfY29sb3I6ICcjZmZmZmZmJyxcbiAgICAgICAgaWNvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzcmM6ICdhcHBfZGF0YS9pbWFnZXMvYW5kcm9pZC1jaHJvbWUtMTkyeDE5Mi5wbmcnLFxuICAgICAgICAgICAgc2l6ZXM6ICcxOTJ4MTkyJyxcbiAgICAgICAgICAgIHR5cGU6ICdpbWFnZS9wbmcnLFxuICAgICAgICAgICAgcHVycG9zZTogJ2FueScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzcmM6ICdhcHBfZGF0YS9pbWFnZXMvYW5kcm9pZC1jaHJvbWUtNTEyeDUxMi5wbmcnLFxuICAgICAgICAgICAgc2l6ZXM6ICc1MTJ4NTEyJyxcbiAgICAgICAgICAgIHR5cGU6ICdpbWFnZS9wbmcnLFxuICAgICAgICAgICAgcHVycG9zZTogJ2FueScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzcmM6ICdhcHBfZGF0YS9pbWFnZXMvbWFza2FibGVfaWNvbi5wbmcnLFxuICAgICAgICAgICAgc2l6ZXM6ICcxMDI0eDEwMjQnLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnbWFza2FibGUnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnYXBwX2RhdGEvaW1hZ2VzL21hc2thYmxlX2ljb25feDUxMi5wbmcnLFxuICAgICAgICAgICAgc2l6ZXM6ICc1MTJ4NTEyJyxcbiAgICAgICAgICAgIHR5cGU6ICdpbWFnZS9wbmcnLFxuICAgICAgICAgICAgcHVycG9zZTogJ21hc2thYmxlJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNyYzogJ2FwcF9kYXRhL2ltYWdlcy9tYXNrYWJsZV9pY29uX3gzODQucG5nJyxcbiAgICAgICAgICAgIHNpemVzOiAnMzg0eDM4NCcsXG4gICAgICAgICAgICB0eXBlOiAnaW1hZ2UvcG5nJyxcbiAgICAgICAgICAgIHB1cnBvc2U6ICdtYXNrYWJsZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzcmM6ICdhcHBfZGF0YS9pbWFnZXMvbWFza2FibGVfaWNvbl94MTkyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzE5MngxOTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnbWFza2FibGUnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnYXBwX2RhdGEvaW1hZ2VzL21hc2thYmxlX2ljb25feDEyOC5wbmcnLFxuICAgICAgICAgICAgc2l6ZXM6ICcxMjh4MTI4JyxcbiAgICAgICAgICAgIHR5cGU6ICdpbWFnZS9wbmcnLFxuICAgICAgICAgICAgcHVycG9zZTogJ21hc2thYmxlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIHdvcmtib3g6IHtcbiAgICAgICAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9hdG9taWNkYXRhLWRldi9hdG9taWMtZGF0YS1icm93c2VyL2lzc3Vlcy8yOTRcbiAgICAgICAgZ2xvYklnbm9yZXM6IFsnKiovaW5kZXguaHRtbCddLFxuICAgICAgICBydW50aW1lQ2FjaGluZzogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVybFBhdHRlcm46IC9eaHR0cHM6XFwvXFwvZm9udHNcXC5nb29nbGVhcGlzXFwuY29tXFwvLiovaSxcbiAgICAgICAgICAgIGhhbmRsZXI6ICdDYWNoZUZpcnN0JyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiAnZ29vZ2xlLWZvbnRzLWNhY2hlJyxcbiAgICAgICAgICAgICAgZXhwaXJhdGlvbjoge1xuICAgICAgICAgICAgICAgIG1heEVudHJpZXM6IDEwLFxuICAgICAgICAgICAgICAgIG1heEFnZVNlY29uZHM6IDYwICogNjAgKiAyNCAqIDM2NSwgLy8gPD09IDM2NSBkYXlzXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGNhY2hlYWJsZVJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgc3RhdHVzZXM6IFswLCAyMDBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVybFBhdHRlcm46XG4gICAgICAgICAgICAgIC9eaHR0cHM/OlxcL1xcLy4qXFwuKD86cG5nfGpwZ3xqcGVnfGdpZnxibXB8c3ZnfHdlYnB8aWNvKS9pLFxuICAgICAgICAgICAgaGFuZGxlcjogJ0NhY2hlRmlyc3QnLFxuICAgICAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgICAgICBjYWNoZU5hbWU6ICdpbWFnZXMtY2FjaGUnLFxuICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7XG4gICAgICAgICAgICAgICAgbWF4RW50cmllczogMTAwLFxuICAgICAgICAgICAgICAgIG1heEFnZVNlY29uZHM6IDYwICogNjAgKiAyNCAqIDMwLCAvLyA8PT0gMzAgZGF5c1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBjYWNoZWFibGVSZXNwb25zZToge1xuICAgICAgICAgICAgICAgIHN0YXR1c2VzOiBbMCwgMjAwXSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1cmxQYXR0ZXJuOiAvXmh0dHBzOlxcL1xcL2ZvbnRzXFwuZ3N0YXRpY1xcLmNvbVxcLy4qL2ksXG4gICAgICAgICAgICBoYW5kbGVyOiAnQ2FjaGVGaXJzdCcsXG4gICAgICAgICAgICBvcHRpb25zOiB7XG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogJ2dzdGF0aWMtZm9udHMtY2FjaGUnLFxuICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7XG4gICAgICAgICAgICAgICAgbWF4RW50cmllczogMTAsXG4gICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0ICogMzY1LCAvLyA8PT0gMzY1IGRheXNcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgY2FjaGVhYmxlUmVzcG9uc2U6IHtcbiAgICAgICAgICAgICAgICBzdGF0dXNlczogWzAsIDIwMF0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pLFxuICAgIHByaXNtanMoe1xuICAgICAgbGFuZ3VhZ2VzOiBbJ3R5cGVzY3JpcHQnXSxcbiAgICAgIGNzczogdHJ1ZSxcbiAgICAgIHRoZW1lOiAnZGVmYXVsdCcsXG4gICAgfSksXG4gIF0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIC8vIHRoaXMgbWF5IGhlbHAgd2hlbiBsaW5raW5nICsgSE1SIGlzIG5vdCB3b3JraW5nXG4gICAgLy8gZXhjbHVkZTogWydAdG9taWMvbGliJywgJ0B0b21pYy9yZWFjdCddLFxuICB9LFxuICBidWlsZDoge1xuICAgIHNvdXJjZW1hcDogdHJ1ZSxcbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgZW50cnlGaWxlTmFtZXM6IGBhc3NldHMvW25hbWVdLVtoYXNoXS5qc2AsXG4gICAgICAgIGNodW5rRmlsZU5hbWVzOiBgYXNzZXRzL2NodW5rX1tuYW1lXS1baGFzaF0uanNgLFxuICAgICAgICBhc3NldEZpbGVOYW1lczogYGFzc2V0cy9bbmFtZV0uW2V4dF1gLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxuICBzZXJ2ZXI6IHtcbiAgICBzdHJpY3RQb3J0OiB0cnVlLFxuICAgIGhvc3Q6IHRydWUsXG4gICAgaG1yOiB7XG4gICAgICAvLyBGaXhlcyBhbiBpc3N1ZSB3aXRoIEhNUlxuICAgICAgcG9ydDogNTE3NCxcbiAgICB9LFxuICB9LFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWtYLFNBQVMsb0JBQW9CO0FBQy9ZLE9BQU8sV0FBVztBQUNsQixTQUFTLGVBQWU7QUFDeEIsT0FBTyxxQkFBcUI7QUFDNUIsT0FBTyxhQUFhO0FBQ3BCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQLGdCQUFnQjtBQUFBLElBQ2hCLE1BQU07QUFBQSxNQUNKLE9BQU87QUFBQSxRQUNMLFNBQVM7QUFBQSxVQUNQO0FBQUEsWUFDRTtBQUFBLFlBQ0E7QUFBQSxjQUNFLFFBQVE7QUFBQSxnQkFDTixTQUFTLFVBQVUsT0FBTztBQUN4QixzQkFBSSxNQUFNLFNBQVMsZ0JBQWdCO0FBQ2pDLDRCQUFRLE1BQU07QUFBQSxzQkFBeUIsUUFBUSxFQUFFO0FBQ2pELDRCQUFRLE1BQU0sV0FBVyxNQUFNLE9BQU8sTUFBTSxFQUFFO0FBRTlDLHdCQUFJLE1BQU0sT0FBTyxhQUFhO0FBQzVCLDhCQUFRLE1BQU0sWUFBWSxNQUFNLE9BQU8sV0FBVyxFQUFFO0FBQUEsb0JBQ3REO0FBRUEsd0JBQUksTUFBTSxPQUFPLEtBQUs7QUFDcEIsNEJBQU0sRUFBRSxNQUFNLE9BQU8sSUFBSSxNQUFNLE9BQU8sSUFBSTtBQUMxQyw4QkFBUSxNQUFNLGtCQUFrQixJQUFJLFlBQVksTUFBTSxFQUFFO0FBQUEsb0JBQzFEO0FBRUEsd0JBQUks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
