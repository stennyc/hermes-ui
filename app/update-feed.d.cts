// Web/PWA stub declaration for update-feed.cjs
interface DarwinFeed { directory: string; channel: string; fileName: string; allowPrerelease: boolean }
declare function darwinFeed(channel: string, light?: boolean): DarwinFeed
declare function feedBaseUrl(raw: string | undefined): string | undefined
declare const contract: { darwinFeed: typeof darwinFeed; feedBaseUrl: typeof feedBaseUrl }
export = contract
