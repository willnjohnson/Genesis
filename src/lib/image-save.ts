// Use the plugin dialog JS entry that's present in node_modules
import { save } from '@tauri-apps/plugin-dialog';
// The core invoke implementation is available at @tauri-apps/api/core
import { invoke } from '@tauri-apps/api/core';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function setupImageSaveHandler() {
  window.addEventListener('contextmenu', async (ev) => {
    try {
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      // If the right-click was on an <img> or inside an element that contains an <img>, find it
      const img = (target.tagName === 'IMG') ? (target as HTMLImageElement) : target.closest('img') as HTMLImageElement | null;
      if (!img) return;

      ev.preventDefault();

      const suggested = img.src.split('/').pop() || 'image.png';
      const path = await save({ defaultPath: suggested });
      if (!path) return;

      // Fetch the image bytes
      const resp = await fetch(img.src);
      const arrayBuffer = await resp.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const base64 = uint8ArrayToBase64(bytes);

      await invoke('save_image', { path, contents_base64: base64 });
    } catch (e) {
      // swallow errors; this shouldn't crash the app
      console.error('save image failed', e);
    }
  });
}
