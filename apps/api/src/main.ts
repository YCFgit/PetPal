import { loadConfig } from './config.ts';
import { BookingService } from './domain/booking-service.ts';
import { emptyState } from './domain/models.ts';
import { demoState } from './development/demo-data.ts';
import { createApplication } from './http/application.ts';
import { createApiServer } from './http/server.ts';
import { MemoryBookingStore } from './storage/memory-store.ts';

const config = loadConfig(process.env);
const state = config.demoData ? demoState(config.userId) : emptyState();
const bookings = new BookingService(new MemoryBookingStore(state));
const application = createApplication(bookings, { token: config.token, userId: config.userId });
const server = createApiServer(application);
const expiryTimer = setInterval(() => {
  void bookings.expireUnsubmittedOrders().catch(() => {
    console.error(JSON.stringify({ event: 'reservation-expiry-failed', level: 'error' }));
  });
}, 30_000);
expiryTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'development-api-started', host: config.host, port: config.port,
    storage: 'volatile-memory', demoData: config.demoData, paymentsEnabled: false }));
});
server.on('error', () => {
  console.error(JSON.stringify({ event: 'api-listen-failed', level: 'error' }));
  clearInterval(expiryTimer);
  process.exitCode = 1;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(expiryTimer);
  server.close(() => { process.exitCode = 0; });
  const deadline = setTimeout(() => { server.closeAllConnections(); }, 5_000);
  deadline.unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
