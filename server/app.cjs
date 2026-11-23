// Startup file for hosts that load the app with require() — cPanel "Setup Node.js App"
// (Phusion Passenger), e.g. MilesWeb. Set "Application startup file" to: app.cjs
// The real app is an ES module, so it is loaded with import().
import('./src/app.js').catch(error => {
  console.error('YouTube AI Agent failed to start:', error);
  process.exit(1);
});
