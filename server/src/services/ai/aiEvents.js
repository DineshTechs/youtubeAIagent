// Progress events from AI providers (attempts, retries, timeouts), so a running
// job can show them in its log instead of looking frozen while an AI call waits.
import {EventEmitter} from 'node:events';
export const aiEvents = new EventEmitter();
aiEvents.setMaxListeners(20);
export function aiProgress(message, extra = {}) { aiEvents.emit('progress', {message: String(message || ''), at: new Date(), ...extra}); }
