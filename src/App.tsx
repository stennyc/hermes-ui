import { useEffect } from 'react'
import { initCapacitor, isNativePlatform } from './capacitor'
import { registerPushNotifications } from './push-notifications'

function App() {
  useEffect(() => {
    if (isNativePlatform()) {
      // 初始化 Capacitor
      initCapacitor().then(() => {
        // 注册推送通知
        registerPushNotifications().catch(console.error);
      });
    }
  }, [])

  return (
    <div className="App">
      <h1>Hermes UI</h1>
      <p>{isNativePlatform() ? 'Running in Capacitor' : 'Running in browser'}</p>
    </div>
  )
}

export default App
