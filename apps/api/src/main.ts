import { loadConfig } from './config.ts';
import { BookingService } from './domain/booking-service.ts';
import { ProfileService } from './domain/profile-service.ts';
import { emptyState } from './domain/models.ts';
import { demoState } from './development/demo-data.ts';
import { createApplication } from './http/application.ts';
import { createApiServer } from './http/server.ts';
import { MemoryBookingStore } from './storage/memory-store.ts';
import { MysqlBookingStore, mysqlPool } from './storage/mysql-store.ts';

const config = loadConfig(process.env);
const state = config.demoData ? demoState(config.userId) : emptyState();
const mysqlStore = config.mysql ? new MysqlBookingStore(mysqlPool(config.mysql)) : null;
if (mysqlStore) {
  await mysqlStore.ready();
  if (config.demoData) await mysqlStore.seed(state, config.userId);
}
const store = mysqlStore ?? new MemoryBookingStore(state);
const bookings = new BookingService(store);
const application = createApplication(bookings, new ProfileService(store), {
  token: config.token, userId: config.userId, storage: config.storage === 'mysql' ? 'mysql' : 'volatile-memory',
});
const server = createApiServer(application);
const expiryTimer = setInterval(() => {
  void bookings.expireUnsubmittedOrders().catch(() => {
    console.error(JSON.stringify({ event: 'reservation-expiry-failed', level: 'error' }));
  });
}, 30_000);
expiryTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'development-api-started', host: config.host, port: config.port,
    storage: config.storage, demoData: config.demoData, paymentsEnabled: false }));
});
server.on('error', () => {
  console.error(JSON.stringify({ event: 'api-listen-failed', level: 'error' }));
  clearInterval(expiryTimer);
  if (!mysqlStore) {
    process.exitCode = 1;
    return;
  }
  void mysqlStore.close().finally(() => { process.exitCode = 1; });
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(expiryTimer);
  server.close(() => {
    if (!mysqlStore) {
      process.exitCode = 0;
      return;
    }
    void mysqlStore.close().finally(() => { process.exitCode = 0; });
  });
  const deadline = setTimeout(() => { server.closeAllConnections(); }, 5_000);
  deadline.unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
