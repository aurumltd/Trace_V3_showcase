import { isTauri } from '@tauri-apps/api/core';
import * as settingsIpc from './ipc/settingsIpc';

type Listener = (isTracking: boolean) => void;

function isDesktop(): boolean {
  return isTauri();
}

class TrackingService {
  private isTrackingValue = false;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.isTrackingValue);
    return () => this.listeners.delete(listener);
  }

  isTracking(): boolean {
    return this.isTrackingValue;
  }

  async sync(): Promise<boolean> {
    if (isDesktop()) {
      this.isTrackingValue = await settingsIpc.checkTrackingStatus();
      this.emit();
    }

    return this.isTrackingValue;
  }

  async setTracking(enabled: boolean): Promise<boolean> {
    if (isDesktop()) {
      this.isTrackingValue = await settingsIpc.toggleTracking(enabled);
    } else {
      this.isTrackingValue = enabled;
    }

    this.emit();
    return this.isTrackingValue;
  }

  async toggle(): Promise<boolean> {
    return this.setTracking(!this.isTrackingValue);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.isTrackingValue);
    }
  }
}

export const trackingService = new TrackingService();
