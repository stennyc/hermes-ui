/**
 * Capacitor 环境初始化
 * 
 * 在原生环境中禁用 PWA Service Worker，配置网关连接。
 */

// 标记 Capacitor 原生环境
if (typeof (window as any).Capacitor !== 'undefined') {
  (window as any).__CAPACITOR__ = true;
}

// 从 Preferences 加载保存的网关地址
async function loadSavedGateway(): Promise<string | null> {
  if (!window.Capacitor) return null;
  
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: 'gateway_url' });
    return value || null;
  } catch {
    return null;
  }
}

// 将网关地址注入到全局变量，供应用使用
async function initCapacitor() {
  const gatewayUrl = await loadSavedGateway();
  if (gatewayUrl) {
    (window as any).__HERMES_SAVED_GATEWAY__ = gatewayUrl;
  }
  
  // 延迟注入，确保 DOM 已加载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[Capacitor] Initialized with gateway:', gatewayUrl);
    });
  }
}

initCapacitor();
