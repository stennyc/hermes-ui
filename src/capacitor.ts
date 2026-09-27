import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { CapacitorHttp } from '@capacitor/core';

// 配置状态栏
async function configureStatusBar() {
  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: '#111111' });
}

// 隐藏启动画面
async function hideSplash() {
  await SplashScreen.hide();
}

// 保存网关地址
export async function saveGatewayUrl(url: string): Promise<void> {
  await Preferences.set({ key: 'gateway_url', value: url });
}

// 获取保存的网关地址
export async function getSavedGatewayUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: 'gateway_url' });
  return value || null;
}

// 监听应用生命周期
export function setupAppLifecycle() {
  // 应用进入前台
  App.addListener('appStateChange', ({ active }) => {
    if (active) {
      console.log('[Capacitor] App resumed');
    } else {
      console.log('[Capacitor] App paused');
    }
  });

  // 处理深度链接
  App.addListener('appUrlOpen', (data) => {
    console.log('[Capacitor] Deep link:', data.url);
  });
}

// 初始化 Capacitor
export async function initCapacitor(): Promise<void> {
  await configureStatusBar();
  await hideSplash();
  setupAppLifecycle();
  
  console.log('[Capacitor] Capacitor environment detected');
}

// 检查是否是原生环境
export function isNativePlatform(): boolean {
  return typeof (window as any).Capacitor !== 'undefined';
}
