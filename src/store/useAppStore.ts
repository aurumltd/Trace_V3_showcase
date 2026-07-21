import { create } from 'zustand';
import dataService, { type AppSettings } from '../services/dataService';

interface AppState {
  initialized: boolean;
  settingsLoadFailed: boolean;
  settings: AppSettings;
  initialize: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
  clearAllData: () => Promise<void>;
}

export const useAppStore = create<AppState>()((set, get) => ({
  initialized: false,
  settingsLoadFailed: false,
  settings: dataService.getDefaultSettings(),

  initialize: async () => {
    if (get().initialized && !get().settingsLoadFailed) return;
    let settings = dataService.getDefaultSettings();
    let timeoutId: number | undefined;
    let failed = false;
    try {
      settings = await Promise.race([
        dataService.getSettings(),
        new Promise<AppSettings>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('读取设置超时')), 3000);
        }),
      ]);
    } catch (error) {
      failed = true;
      console.error('[Trace] settings initialization failed', error);
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    set({ settings, initialized: true, settingsLoadFailed: failed });

    if (failed) {
      window.setTimeout(() => {
        void get().refreshSettings();
      }, 1500);
    }
  },

  refreshSettings: async () => {
    try {
      const settings = await dataService.getSettings();
      document.documentElement.classList.toggle('dark', settings.theme === 'dark');
      set({ settings, initialized: true, settingsLoadFailed: false });
    } catch (error) {
      console.error('[Trace] settings refresh failed', error);
    }
  },

  updateSettings: async (settingsUpdate) => {
    const settings = await dataService.updateSettings(settingsUpdate);
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    set({ settings, settingsLoadFailed: false });
  },

  clearAllData: async () => {
    await dataService.clearAllData();
  },
}));

export default useAppStore;
