/**
 * Minimal `electron` module type stub for the web build.
 * The upstream desktop renderer type-checks electron-side code against the real
 * electron package; the web build has no electron binary, but the type
 * declarations are still needed so tsc can resolve `from 'electron'` imports in
 * the few electron/adjacent source files that are included for type purposes.
 */
declare module 'electron' {
  export interface WebContents {
    on(event: string, listener: (...args: any[]) => void): void
    send(channel: string, ...args: any[]): void
    executeJavaScript(code: string): Promise<any>
    setAudioMuted(muted: boolean): void
    setWindowOpenHandler(
      handler: (details: any) =>
        | { action: string; url?: string; overrideBrowserWindowOptions?: Record<string, any> }
        | null,
    ): void
  }
  export interface BrowserWindow {
    on(event: string, listener: (...args: any[]) => void): void
    loadURL(url: string): Promise<void>
    webContents: WebContents
    hide(): void
    show(): void
    close(): void
    destroy(): void
    isDestroyed(): boolean
    setBounds(bounds: any): void
    setIgnoreMouseEvents(ignore: boolean): void
    setFocusable(focusable: boolean): void
    getBounds(): any
    isVisible(): boolean
    isMinimized(): boolean
    minimize(): void
    maximize(): void
    unmaximize(): void
    isMaximized(): boolean
    focus(): void
    blur(): void
    setTitle(title: string): void
    title: string
  }
  export interface BrowserWindowConstructorOptions {
    [key: string]: any
  }
  export interface Session {
    webRequest: {
      onHeadersReceived(filter: any, listener: (details: any, callback: (response: any) => void) => void): void
    }
    setPermissionRequestHandler(handler: (webContents: any, permission: string, callback: (granted: boolean) => void) => void): void
    setPermissionCheckHandler(handler: (webContents: any, permission: string, ...args: any[]) => boolean): void
    on(event: string, listener: (...args: any[]) => void): void
  }
  export const app: {
    getPath(name: string): string
    getName(): string
    getVersion(): string
    getLocale(): string
    on(event: string, listener: (...args: any[]) => void): void
    off(event: string, listener: (...args: any[]) => void): void
    requestSingleInstanceLock(): boolean
    focus(): void
    quit(): void
  }
  export const ipcMain: {
    handle(channel: string, listener: (...args: any[]) => any): void
    removeHandler(channel: string): void
    on(channel: string, listener: (event: any, ...args: any[]) => void): void
  }
  export const ipcRenderer: {
    send(channel: string, ...args: any[]): void
    invoke(channel: string, ...args: any[]): Promise<any>
    on(channel: string, listener: (event: any, ...args: any[]) => void): void
    removeAllListeners(channel: string): void
  }
  export const shell: {
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<string>
    showItemInFolder(path: string): void
  }
  export const nativeTheme: {
    readonly themeSource: 'light' | 'dark' | 'system'
    setThemeSource(source: 'light' | 'dark' | 'system'): void
    on(event: string, listener: (...args: any[]) => void): void
  }
  export const powerSaveBlocker: {
    startBlocking(type: string): boolean
    stopBlocking(id: number): void
    isBlocking(): boolean
  }
  export const powerMonitor: {
    on(event: string, listener: (...args: any[]) => void): void
  }
  export const Notification: {
    new (options?: any): any
    isSupported(): boolean
  }
  export const BrowserWindow: {
    new (options?: BrowserWindowConstructorOptions): BrowserWindow
    getAllWindows(): BrowserWindow[]
  }
}
