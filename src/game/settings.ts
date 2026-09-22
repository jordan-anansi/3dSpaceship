import fs from 'fs';
import path from 'path';

export interface ServerSettings {
  maxSpeed: number;
  thrustAccel: number;
  drag: number;
  dashImpulse: number;
  baseHull: number;
  botCount: number;
  enemyFireSounds: boolean;
  reticleCoolingColor: string;
  reticleReadyColor: string;
  explosionInheritVelocity: boolean;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  maxSpeed: 70,
  thrustAccel: 0.18,
  drag: 0.15,
  dashImpulse: 38,
  baseHull: 100,
  botCount: 4,
  enemyFireSounds: false,
  reticleCoolingColor: '#6ec387',
  reticleReadyColor: '#00ff66',
  explosionInheritVelocity: true,
};

const SETTINGS_FILE_PATH = path.resolve(__dirname, '../../server-settings.json');

/**
 * Load server settings from server-settings.json.
 * Falls back to DEFAULT_SERVER_SETTINGS if the file does not exist or fails to parse.
 */
export function loadServerSettings(): ServerSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const data = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      return { ...DEFAULT_SERVER_SETTINGS, ...parsed };
    }
  } catch (err) {
    console.warn('[settings] Failed to load server-settings.json, using defaults:', err);
  }
  return { ...DEFAULT_SERVER_SETTINGS };
}

/**
 * Persist current settings to server-settings.json on disk.
 * Promotes the supplied settings to be the new permanent defaults.
 */
export function saveServerSettings(settings: Partial<ServerSettings>): ServerSettings {
  const current = loadServerSettings();
  const updated: ServerSettings = {
    ...current,
    ...settings,
  };

  try {
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    console.log('[settings] Successfully promoted active settings to server-settings.json');
  } catch (err) {
    console.error('[settings] Failed to write server-settings.json:', err);
  }
  return updated;
}

/**
 * Watch server-settings.json for changes made on disk (e.g. by an external editor),
 * invoking callback with the updated settings whenever the file is modified.
 * Returns an unwatch cleanup function.
 */
export function watchServerSettingsFile(callback: (newSettings: ServerSettings) => void): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;

  try {
    const watcher = fs.watch(SETTINGS_FILE_PATH, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log('[settings] Detected disk update to server-settings.json, reloading...');
          const reloaded = loadServerSettings();
          callback(reloaded);
        }, 150);
      }
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  } catch (err) {
    console.warn('[settings] Could not watch server-settings.json:', err);
    return () => {};
  }
}
