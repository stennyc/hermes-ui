import { Plugins } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';

const { Device } = Plugins;

// 推送通知配置
export async function registerPushNotifications(): Promise<void> {
  // 请求权限
  const permissions = await PushNotifications.requestPermissions();
  
  if (permissions.receive === 'granted') {
    // 注册设备
    await PushNotifications.register();
    
    // 处理收到的推送
    PushNotifications.addListener('pushNotificationReceived', async (notification) => {
      console.log('[Push] Notification received:', notification);
      
      // 显示本地通知
      await LocalNotifications.schedule({
        notifications: [{
          title: notification.title || 'Hermes',
          body: notification.body || 'New message',
          sound: null,
          largeIcon: 'ic_notification',
        }]
      });
    });

    // 处理通知点击
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      console.log('[Push] Notification action:', action);
    });
  } else {
    console.log('[Push] Permission denied');
  }
}

// 测试本地通知
export async function testLocalNotification(): Promise<void> {
  await LocalNotifications.schedule({
    notifications: [{
      title: 'Hermes UI',
      body: 'Capacitor wrapper is working!',
      id: 1,
      sound: null,
      largeIcon: 'ic_notification',
      badge: 1,
    }]
  });
}

// 获取设备信息
export async function getDeviceInfo(): Promise<any> {
  const info = await Device.getInfo();
  return info;
}

// 保存通知令牌到服务器
export async function saveDeviceToken(token: string): Promise<void> {
  await Preferences.set({ key: 'device_token', value: token });
  // TODO: 发送到后端服务器
  console.log('[Push] Device token saved:', token);
}
