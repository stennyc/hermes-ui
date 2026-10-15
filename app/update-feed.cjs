// Web/PWA placeholder for the Electron updater feed contract.
// The real update-feed.cjs is an Electron-only runtime file; web builds
// never import it at runtime, so a shape-preserving stub is sufficient
// for typechecking.
function darwinFeed(channel, light) {
  throw new Error('darwinFeed is not available in web builds')
}
function feedBaseUrl() {
  return undefined
}
module.exports = { darwinFeed, feedBaseUrl }
